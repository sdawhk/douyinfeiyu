// 人格记忆清理 / 退群清理。
//
// 三条原则（与用户约定）：
// 1) 最高优先级豁免：凡是和机器人私聊过的人，一律永不清理。
//    判定口径（任一成立即算“私聊过”）：
//      a. 存在 persona-relations/p<QQ>.json 关系文件；
//      b. social-v2.json 里存在 private:<QQ> 会话。
//    豁免覆盖关系文件、openLoops/selfNotes/currentFocus 的桶、群印象淘汰、会话归档；
//    被豁免的只打一行 skip(exempt-private)，不动数据。
// 2) 退群即删：机器人不在的群，群作用域记忆全部删除（state 桶 / 关系文件 / social 会话 + 印象）。
//    私聊记忆 p<QQ> 不受影响。删除前把被删内容追加进 state/persona-archive/group-deletions.ndjson
//    （只追加、不被任何代码回读，不是可回注的活数据），并打 delete-group 日志。
// 3) 宁保留勿误删：所有清理前先备份；每个动作幂等；拿不准的进归档而不是静默消失。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const DEFAULT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));

// 与 persona-runtime.mjs 的 TTL 保持一致（那边是记忆写入侧，这里只读判断是否过期）。
const OPEN_LOOP_TTL_MS = 7 * 24 * 60 * 60_000;
const SELF_NOTE_TTL_MS = 6 * 60 * 60_000;
const FOCUS_TTL_MS = 6 * 60 * 60_000;

export const WEEKLY_STATE_MIN_BYTES = 512 * 1024;      // persona-state.json 超过 512 KB 才触发周清理
export const RELATION_STALE_MS = 90 * 24 * 60 * 60_000; // 关系文件 90 天无新内容
export const SOCIAL_IDLE_MS = 60 * 24 * 60 * 60_000;    // social 会话 60 天无活动
export const IMPRESSION_STALE_MS = 90 * 24 * 60 * 60_000; // 群印象 90 天没见
export const MAINTENANCE_CHECK_INTERVAL_MS = 6 * 60 * 60_000; // 6 小时检查一次
export const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const MONTHLY_INTERVAL_MS = 30 * 24 * 60 * 60_000;

const STATE_FILE = 'persona-state.json';
const SOCIAL_FILE = 'social-v2.json';
const RELATIONS_DIR = 'persona-relations';
const SCHEDULE_FILE = 'persona-maintenance.json';
const NAMES_FILE = 'persona-member-names.json';
const ARCHIVE_DIR = 'persona-archive';
const GROUP_DELETION_LOG = 'group-deletions.ndjson';
const BRIDGE_PORT = 3100;

// 永不自动清理的桶：_unclaimed 是迁移时认不出归属的人工待定区，_legacy 是旧格式只读区。
const PROTECTED_SCOPES = new Set(['_unclaimed', '_legacy']);

const stateDir = () => process.env.DSH_PERSONA_STATE_DIR || DEFAULT_STATE_DIR;

function stampOf(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function readJsonFile(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback;
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch { return fallback; }
}

function writeJsonFile(file, value, compact = false) {
  mkdirSync(dirname(file), { recursive: true });
  const body = compact ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, file);
  return Buffer.byteLength(body, 'utf8');
}

function fileBytes(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 备份一次文件为 <file>.bak-<stamp>；同一天重跑不覆盖已有备份（保留最早那份）。 */
export function backupOnce(file, stamp) {
  if (!existsSync(file)) return null;
  const target = `${file}.bak-${stamp}`;
  if (existsSync(target)) return target;
  copyFileSync(file, target);
  return target;
}

/**
 * 是否“私聊过”。
 * 口径：persona-relations/p<QQ>.json 存在，或 social-v2 里有 private:<QQ> 会话，任一成立即算。
 * 这是最高优先级豁免：命中后所有清理动作都不得改动这个 QQ 的数据。
 */
export function isPrivateChatQQ(qq, socialDoc = null) {
  const id = String(qq ?? '').trim();
  if (!/^\d+$/.test(id)) return false;
  if (existsSync(join(stateDir(), RELATIONS_DIR, `p${id}.json`))) return true;
  const doc = socialDoc ?? readJsonFile(join(stateDir(), SOCIAL_FILE), null);
  return Boolean(doc?.conversations?.[`private:${id}`]);
}

/** 探测 bridge.js（3100）是否在跑：它在内存里持有 social-v2 副本，运行时改文件会被回写覆盖。 */
export function isBridgeRunning(timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: BRIDGE_PORT });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function relationNames() {
  const dir = join(stateDir(), RELATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^[gp]\d+(?:-\d+)?\.json$/.test(name)).sort();
}

function scopesOfGroup(groupId) {
  const re = new RegExp(`^g${groupId}(?:-|$)`);
  return (scope) => re.test(String(scope ?? ''));
}

function filesOfGroup(groupId) {
  const dir = join(stateDir(), RELATIONS_DIR);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^g${groupId}(?:-\\d+)?\\.json(?:\\.bak-[\\d-]+)?$`);
  return readdirSync(dir).filter((name) => re.test(name)).sort();
}

function groupIdsFromLocalMemory(socialDoc) {
  const ids = new Set();
  const dir = join(stateDir(), RELATIONS_DIR);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const name of names) {
    const m = /^g(\d+)(?:-\d+)?\.json/.exec(name);
    if (m) ids.add(m[1]);
  }
  const state = readJsonFile(join(stateDir(), STATE_FILE), null) ?? {};
  for (const kind of ['openLoops', 'selfNotes', 'currentFocus']) {
    const buckets = state[kind];
    if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) continue;
    for (const scope of Object.keys(buckets)) {
      const m = /^g(\d+)/.exec(scope);
      if (m) ids.add(m[1]);
    }
  }
  for (const key of Object.keys(socialDoc?.conversations ?? {})) {
    if (key.startsWith('group:')) ids.add(key.slice(6));
  }
  return [...ids].sort();
}

function lastActivityOf(conv) {
  const messages = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
  const lastMessageAt = messages.reduce((max, msg) => Math.max(max, Number(msg?.time) || 0), 0);
  return Math.max(lastMessageAt,
    Number(conv?.lastIncomingAt) || 0,
    Number(conv?.lastActionAt) || 0,
    Number(conv?.lastAiReplyAt) || 0);
}

function relationFreshness(doc) {
  const traits = (Array.isArray(doc?.traits) ? doc.traits : []).filter(Boolean);
  const recent = (Array.isArray(doc?.recent) ? doc.recent : []).filter((item) => item && item.text);
  const lastAt = recent.reduce((max, item) => Math.max(max, Number(item?.at) || 0), 0);
  return { traits, recent, lastAt, empty: traits.length === 0 };
}

function loadSchedule() {
  return readJsonFile(join(stateDir(), SCHEDULE_FILE), null) ?? {};
}

function saveSchedule(patch) {
  const next = { ...loadSchedule(), ...patch };
  writeJsonFile(join(stateDir(), SCHEDULE_FILE), next);
  return next;
}

/**
 * 执行一次清理。apply=false 时只出计划（dry-run），不改任何文件。
 *
 * @param {object} opts
 * @param {boolean} opts.apply             true 才真正落盘
 * @param {number}  opts.now               当前时间
 * @param {string[]} opts.ownerQQs         主人 QQ（永远豁免）
 * @param {string[]|null} opts.currentGroupIds 机器人当前真实群列表；null/空 表示本次跳过退群对账
 * @param {boolean} opts.bridgeRunning     bridge.js 是否在跑；在跑就跳过所有 social 写操作
 * @param {boolean} opts.forceWeekly       忽略 7 天/512KB 限制，强制跑一次周清理（排障用）
 * @param {boolean} opts.forceMonthly      忽略 30 天限制，强制跑一次月清理（排障用）
 * @param {Function} opts.logger
 */
export function runPersonaMaintenance(opts = {}) {
  const apply = opts.apply === true;
  const now = Number(opts.now) || Date.now();
  const stamp = stampOf(now);
  const log = typeof opts.logger === 'function' ? opts.logger : () => {};
  const ownerQQs = new Set((opts.ownerQQs ?? []).map((qq) => String(qq).trim()).filter(Boolean));
  const bridgeRunning = opts.bridgeRunning === true;
  const statePath = join(stateDir(), STATE_FILE);
  const socialPath = join(stateDir(), SOCIAL_FILE);
  const archiveRoot = join(stateDir(), ARCHIVE_DIR, stamp);

  const stateDoc = readJsonFile(statePath, null);
  const socialDoc = readJsonFile(socialPath, null);
  const namesFile = join(stateDir(), NAMES_FILE);
  const collectedNames = collectNicknames(socialDoc, readJsonFile(namesFile, null) ?? {}, socialBackupFiles());
  const exemptCache = new Map();
  const isExempt = (qq) => {
    const id = String(qq ?? '').trim();
    if (!id) return false;
    if (ownerQQs.has(id)) return true;
    if (!exemptCache.has(id)) exemptCache.set(id, isPrivateChatQQ(id, socialDoc));
    return exemptCache.get(id);
  };

  const report = {
    at: now,
    stamp,
    apply,
    stateDir: stateDir(),
    weekly: { due: false, reason: '', fileBytes: fileBytes(statePath), threshold: WEEKLY_STATE_MIN_BYTES, removed: [], kept: 0 },
    groups: { checked: false, reason: '', current: [], local: [], missing: [] },
    relations: { total: 0, totalBytes: 0, deletions: [], exempt: [], legacyArchive: [], compaction: { files: 0, bytesBefore: 0, bytesAfter: 0 } },
    social: { bytes: fileBytes(socialPath), conversations: 0, idle: [], impressions: [], bridgeRunning, skipped: '' },
    names: { total: 0, updated: 0, recovered: 0 },
    backups: [],
    pendingSocial: []
  };

  let stateDirty = false;
  let socialDirty = false;
  const schedule = loadSchedule();
  report.names = {
    total: Object.keys(collectedNames.names).length,
    updated: collectedNames.updated,
    recovered: collectedNames.recovered
  };

  // ── 1. 周清理：persona-state.json 的过期/空桶 ───────────────────────────────
  // only=left-groups：只跑退群删除，周/月清理一律不碰（用户明确要求“其他一律不动”）。
  const onlyLeftGroups = opts.only === 'left-groups';
  const weeklyDue = !onlyLeftGroups && (opts.forceWeekly === true
    || (report.weekly.fileBytes > WEEKLY_STATE_MIN_BYTES && now - (Number(schedule.lastWeeklyAt) || 0) >= WEEKLY_INTERVAL_MS));
  if (!stateDoc) {
    report.weekly.reason = 'missing-state-file';
  } else if (onlyLeftGroups) {
    report.weekly.reason = 'only-left-groups';
  } else if (!weeklyDue) {
    report.weekly.reason = report.weekly.fileBytes > WEEKLY_STATE_MIN_BYTES
      ? 'interval-not-reached' : 'below-size-threshold';
  } else {
    report.weekly.due = true;
    for (const kind of ['openLoops', 'selfNotes']) {
      const buckets = stateDoc[kind];
      if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) continue;
      const ttl = kind === 'openLoops' ? OPEN_LOOP_TTL_MS : SELF_NOTE_TTL_MS;
      for (const [scope, list] of Object.entries(buckets)) {
        if (PROTECTED_SCOPES.has(scope)) continue;
        const items = Array.isArray(list) ? list : [];
        const alive = items.filter((item) => {
          const at = Number(item?.at) || 0;
          return at > 0 && now - at <= ttl;
        });
        if (alive.length > 0) { report.weekly.kept += 1; continue; }
        const qq = /^p(\d+)$/.exec(scope)?.[1] ?? /-(\d+)$/.exec(scope)?.[1] ?? '';
        if (qq && isExempt(qq)) {
          log('skip(exempt-private)', kind, scope);
          report.weekly.kept += 1;
          continue;
        }
        report.weekly.removed.push({ kind, scope, items: items.length });
        delete buckets[scope];
        stateDirty = true;
      }
    }
    const focus = stateDoc.currentFocus;
    if (focus && typeof focus === 'object' && !Array.isArray(focus) && typeof focus.text !== 'string') {
      for (const [scope, entry] of Object.entries(focus)) {
        if (PROTECTED_SCOPES.has(scope)) continue;
        const at = Number(entry?.at) || 0;
        if (at > 0 && now - at <= FOCUS_TTL_MS) { report.weekly.kept += 1; continue; }
        const qq = /^p(\d+)$/.exec(scope)?.[1] ?? /-(\d+)$/.exec(scope)?.[1] ?? '';
        if (qq && isExempt(qq)) {
          log('skip(exempt-private)', 'currentFocus', scope);
          report.weekly.kept += 1;
          continue;
        }
        report.weekly.removed.push({ kind: 'currentFocus', scope, items: 1 });
        delete focus[scope];
        stateDirty = true;
      }
    }
    if (!report.weekly.removed.length) report.weekly.reason = 'nothing-expired';
  }

  // ── 2. 退群对账：机器人不在的群，群作用域记忆全删 ──────────────────────────
  const currentGroupIds = Array.isArray(opts.currentGroupIds)
    ? opts.currentGroupIds.map((id) => String(id).trim()).filter(Boolean) : [];
  const localGroupIds = socialDoc || existsSync(join(stateDir(), RELATIONS_DIR))
    ? groupIdsFromLocalMemory(socialDoc) : [];
  report.groups.local = localGroupIds;
  report.groups.current = currentGroupIds;
  if (!currentGroupIds.length) {
    // 群列表拿不到（接口失败 / 掉线）时绝不能按“空列表”推断退群。
    report.groups.reason = 'group-list-unavailable';
  } else {
    report.groups.checked = true;
    const current = new Set(currentGroupIds);
    for (const groupId of localGroupIds) {
      if (current.has(groupId)) continue;
      const files = filesOfGroup(groupId);
      const buckets = [];
      for (const kind of ['openLoops', 'selfNotes', 'currentFocus']) {
        const map = stateDoc?.[kind];
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        for (const scope of Object.keys(map)) {
          if (scopesOfGroup(groupId)(scope)) buckets.push({ kind, scope });
        }
      }
      const conversationKey = `group:${groupId}`;
      const hasConversation = Boolean(socialDoc?.conversations?.[conversationKey]);
      report.groups.missing.push({
        groupId,
        reason: 'leave',
        files: files.map((name) => ({ name, bytes: fileBytes(join(stateDir(), RELATIONS_DIR, name)) })),
        buckets,
        conversation: hasConversation,
        conversationDeferred: hasConversation && bridgeRunning,
        bytes: files.reduce((sum, name) => sum + fileBytes(join(stateDir(), RELATIONS_DIR, name)), 0)
          + (hasConversation ? Buffer.byteLength(JSON.stringify(socialDoc.conversations[conversationKey]), 'utf8') : 0)
      });
    }
  }

  // ── 3. 月清理：关系文件（90 天无内容且无 traits）+ 一次性旧群级文件归档 ─────
  const monthlyDue = !onlyLeftGroups
    && (opts.forceMonthly === true || now - (Number(schedule.lastMonthlyAt) || 0) >= MONTHLY_INTERVAL_MS);
  report.relations.total = relationNames().length;
  report.relations.totalBytes = relationNames().reduce((sum, name) => sum + fileBytes(join(stateDir(), RELATIONS_DIR, name)), 0);
  // 目录里的真实文件数与体积（含 .bak），用于报“清理前后”的对比。
  const allRelationNames = existsSync(join(stateDir(), RELATIONS_DIR)) ? readdirSync(join(stateDir(), RELATIONS_DIR)) : [];
  report.relations.dirFiles = allRelationNames.length;
  report.relations.dirBytes = allRelationNames.reduce((sum, name) => sum + fileBytes(join(stateDir(), RELATIONS_DIR, name)), 0);
  if (monthlyDue) {
    const presentGroups = new Set(currentGroupIds);
    for (const name of relationNames()) {
      const file = join(stateDir(), RELATIONS_DIR, name);
      const bytes = fileBytes(file);
      const match = /^([gp])(\d+)(?:-(\d+))?\.json$/.exec(name);
      if (!match) continue;
      const [, kind, groupOrQQ, memberQQ] = match;
      let doc = null;
      try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { doc = null; }
      const fresh = relationFreshness(doc);

      if (kind === 'p') {
        // 私聊关系文件天然属于“私聊过的人”，永久豁免。
        report.relations.exempt.push({ name, qq: groupOrQQ });
        continue;
      }
      if (!memberQQ) {
        // 旧群级文件（g<群号>.json）：写侧只会写 g<群号>-<QQ>.json，这类文件已经不会被读取。
        // 已退的群走 deleteGroupMemory 直接删；还在的群整体移进归档目录（连同历史 .bak）。
        if (!report.groups.checked || presentGroups.has(groupOrQQ)) {
          const siblings = filesOfGroup(groupOrQQ).filter((n) => !/-\d+\.json/.test(n));
          report.relations.legacyArchive.push({
            name, bytes, groupId: groupOrQQ, files: siblings,
            bytesAll: siblings.reduce((sum, n) => sum + fileBytes(join(stateDir(), RELATIONS_DIR, n)), 0)
          });
        }
        continue;
      }
      if (isExempt(memberQQ)) {
        log('skip(exempt-private)', 'relation', name);
        report.relations.exempt.push({ name, qq: memberQQ });
        continue;
      }
      const mtime = (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })();
      const stale = fresh.empty
        && (fresh.recent.length ? now - fresh.lastAt > RELATION_STALE_MS : now - mtime > RELATION_STALE_MS);
      if (stale) {
        report.relations.deletions.push({ name, qq: memberQQ, bytes, lastAt: fresh.lastAt });
        continue;
      }
      // 存活文件统一改紧凑写法（去掉 2 空格缩进），省的是纯格式字节。
      const compact = Buffer.byteLength(JSON.stringify(doc), 'utf8') + 1;
      report.relations.compaction.files += 1;
      report.relations.compaction.bytesBefore += bytes;
      report.relations.compaction.bytesAfter += compact;
    }
  }

  // ── 4. 月清理：social 会话归档 + 群印象淘汰 ────────────────────────────────
  if (socialDoc?.conversations && typeof socialDoc.conversations === 'object') {
    report.social.conversations = Object.keys(socialDoc.conversations).length;
    for (const [key, conv] of Object.entries(socialDoc.conversations)) {
      if (!monthlyDue) break;
      // 私聊会话一律豁免（命中最高优先级规则）。
      if (key.startsWith('private:')) {
        const qq = key.slice('private:'.length);
        if (isExempt(qq)) { log('skip(exempt-private)', 'social', key); continue; }
      }
      const last = lastActivityOf(conv);
      if (last > 0 && now - last <= SOCIAL_IDLE_MS) continue;
      if (key.startsWith('group:') && presentGroupsSafe(currentGroupIds).has(key.slice(6))) {
        report.social.idle.push({ key, bytes: Buffer.byteLength(JSON.stringify(conv), 'utf8'), lastAt: last });
      }
    }

    // only=left-groups 或未到月清理周期：印象淘汰一律不做。
    if (monthlyDue) {
      for (const [key, conv] of Object.entries(socialDoc.conversations)) {
        const impressions = conv?.memberImpressions;
        if (!impressions || typeof impressions !== 'object') continue;
        for (const [qqKey, item] of Object.entries(impressions)) {
          const seen = Number(item?.lastSeenAt) || 0;
          if (!seen || now - seen <= IMPRESSION_STALE_MS) continue;
          const qq = /^\d+$/.test(qqKey) ? qqKey : resolveQQByName(conv, qqKey);
          if (qq && isExempt(qq)) {
            log('skip(exempt-private)', 'impression', `${key}/${qqKey}`);
            continue;
          }
          report.social.impressions.push({ key, qqKey, qq, name: item?.name ?? '', ageDays: Math.round((now - seen) / 86_400_000) });
        }
      }
    }
    if (bridgeRunning && (report.social.idle.length || report.social.impressions.length)) {
      report.social.skipped = 'bridge-running';
    }
  }

  report.pendingSocial = Array.isArray(schedule.pendingSocialGroupDeletes)
    ? [...schedule.pendingSocialGroupDeletes] : [];

  if (!apply) return report;

  // ── 落盘 ────────────────────────────────────────────────────────────────────
  if (collectedNames.updated && !onlyLeftGroups) writeJsonFile(namesFile, collectedNames.names, true);

  const relationDir = join(stateDir(), RELATIONS_DIR);
  const willTouchRelations = report.relations.deletions.length
    || report.relations.legacyArchive.length
    || report.relations.compaction.files;
  if (willTouchRelations) {
    // 目录级快照：紧凑化会原地重写很多小文件，逐文件 .bak 反而更乱，这里统一留一份。
    const snapshot = join(archiveRoot, 'persona-relations.bak');
    ensureDir(snapshot);
    for (const name of relationNames()) {
      copyFileSync(join(relationDir, name), join(snapshot, name));
    }
  }

  // 3a. 关系文件删除（先备份）
  for (const item of report.relations.deletions) {
    const file = join(relationDir, item.name);
    const backup = backupOnce(file, stamp);
    if (backup) report.backups.push(backup);
    try { unlinkSync(file); log('delete-relation', item.name, `bytes=${item.bytes}`); } catch (error) {
      log('delete-relation-failed', item.name, error?.message ?? error);
    }
  }

  // 3b. 旧群级文件移进归档（不删）
  if (report.relations.legacyArchive.length) {
    const dest = join(archiveRoot, 'legacy-group-relations');
    ensureDir(dest);
    for (const item of report.relations.legacyArchive) {
      for (const name of item.files ?? [item.name]) {
        try {
          renameSync(join(relationDir, name), join(dest, name));
          log('archive-legacy-relation', name);
        } catch (error) {
          log('archive-legacy-relation-failed', name, error?.message ?? error);
        }
      }
    }
  }

  // 3c. 关系文件紧凑化（只动非豁免、且保留下来的文件）
  const compacted = new Set();
  for (const name of relationNames()) {
    if (report.relations.deletions.some((item) => item.name === name)) continue;
    if (report.relations.exempt.some((item) => item.name === name)) continue;
    if (report.relations.legacyArchive.some((item) => item.name === name)) continue;
    const file = join(relationDir, name);
    const raw = readJsonFile(file, null);
    if (!raw) continue;
    const before = fileBytes(file);
    const after = writeJsonFile(file, raw, true);
    if (after < before) compacted.add(name);
  }
  report.relations.compaction.applied = compacted.size;

  // 2. 退群删除：state 桶 + 关系文件 + social 会话
  for (const group of report.groups.missing) {
    deleteGroupMemory({
      groupId: group.groupId,
      reason: 'reconcile',
      now,
      stamp,
      apply: true,
      bridgeRunning,
      stateDoc,
      socialDoc,
      log
    });
    if (group.buckets.length) stateDirty = true;
    if (group.conversation && !bridgeRunning) socialDirty = true;
  }

  // 4. social 归档（bridge 在跑时跳过，避免被内存副本回写复活）
  if (report.social.idle.length && !bridgeRunning) {
    const archiveFile = join(archiveRoot, 'social-conversations.json');
    const payload = readJsonFile(archiveFile, null) ?? { archivedAt: now, conversations: {} };
    for (const item of report.social.idle) {
      const conv = socialDoc.conversations[item.key];
      if (!conv) continue;
      payload.conversations[item.key] = conv;
      delete socialDoc.conversations[item.key];
      log('archive-social', item.key, `idleDays=${item.lastAt ? Math.round((now - item.lastAt) / 86_400_000) : 'unknown'}`);
    }
    writeJsonFile(archiveFile, payload);
    socialDirty = true;
  }

  if (report.social.impressions.length && !bridgeRunning) {
    for (const item of report.social.impressions) {
      const conv = socialDoc?.conversations?.[item.key];
      if (!conv?.memberImpressions?.[item.qqKey]) continue;
      delete conv.memberImpressions[item.qqKey];
      socialDirty = true;
      log('evict-impression', item.key, item.qqKey, `ageDays=${item.ageDays}`);
    }
  }

  if (stateDirty && stateDoc) {
    const backup = backupOnce(statePath, stamp);
    if (backup) report.backups.push(backup);
    writeJsonFile(statePath, stateDoc);
  }
  if (socialDirty && socialDoc) {
    const backup = backupOnce(socialPath, stamp);
    if (backup) report.backups.push(backup);
    writeJsonFile(socialPath, socialDoc);
  }

  // 5. 调度状态
  const pending = new Set(report.pendingSocial);
  for (const group of report.groups.missing) {
    if (group.conversation && bridgeRunning) pending.add(group.groupId);
    else pending.delete(group.groupId);
  }
  saveSchedule({
    ...(report.weekly.due ? { lastWeeklyAt: now } : {}),
    ...(monthlyDue ? { lastMonthlyAt: now } : {}),
    ...(report.groups.checked ? { lastReconcileAt: now } : {}),
    lastRunAt: now,
    pendingSocialGroupDeletes: [...pending]
  });
  report.pendingSocial = [...pending];
  return report;
}

/** 当前在群列表为空时按“未知”处理，不能据此推断退群。 */
function presentGroupsSafe(ids) {
  return new Set(Array.isArray(ids) ? ids : []);
}

function cleanNick(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 30);
}

/**
 * QQ → 昵称旁挂表。
 * 群印象的键在迁移后是 QQ 号，注入时不能把数字当名字。这里把“最后一次见到的昵称”
 * 单独存一份（不改 social-v2 结构、不动 bridge.js 的写入路径），注入端优先读它。
 * 数据来源：当前 social 与历史 .bak 的 recentMessages（sender↔userId），
 * 以及旧版用昵称作键的 memberImpressions（按 traits 内容对回 QQ）。
 */
function collectNicknames(socialDoc, existing = {}, backupFiles = []) {
  const names = { ...existing };
  let updated = 0;
  let recovered = 0;
  const put = (scope, name, at) => {
    const nick = cleanNick(name);
    if (!scope || !nick) return;
    const current = names[scope];
    if (current && (current.name === nick || (Number(current.at) || 0) > at)) return;
    names[scope] = { name: nick, at };
    updated += 1;
  };
  const absorb = (doc) => {
    for (const [key, conv] of Object.entries(doc?.conversations ?? {})) {
      const isGroup = key.startsWith('group:');
      const chatId = key.slice(isGroup ? 6 : 8);
      if (!chatId) continue;
      for (const message of Array.isArray(conv?.recentMessages) ? conv.recentMessages : []) {
        const uid = String(message?.userId ?? '').trim();
        if (!/^\d+$/.test(uid)) continue;
        const nick = cleanNick(message?.sender);
        if (!nick || nick === uid) continue;
        put(isGroup ? `g${chatId}-${uid}` : `p${uid}`, nick, Number(message?.time) || 0);
      }
    }
  };
  absorb(socialDoc);
  for (const file of backupFiles) absorb(readJsonFile(file));
  // 旧版印象用昵称作键：把“昵称 → traits 签名”记下来，再用它给当前 QQ 键找回名字。
  const nicknameByTraits = new Map();
  const rememberTraitNames = (doc) => {
    for (const conv of Object.values(doc?.conversations ?? {})) {
      for (const [key, item] of Object.entries(conv?.memberImpressions ?? {})) {
        if (/^\d+$/.test(key)) continue;
        const signature = JSON.stringify(item?.traits ?? []);
        if (signature) nicknameByTraits.set(signature, cleanNick(key));
      }
    }
  };
  rememberTraitNames(socialDoc);
  for (const file of backupFiles) rememberTraitNames(readJsonFile(file));
  for (const [key, conv] of Object.entries(socialDoc?.conversations ?? {})) {
    if (!key.startsWith('group:')) continue;
    const groupId = key.slice(6);
    for (const [qq, item] of Object.entries(conv?.memberImpressions ?? {})) {
      if (!/^\d+$/.test(qq)) continue;
      const scope = `g${groupId}-${qq}`;
      if (names[scope]?.name) continue;
      const signature = JSON.stringify(item?.traits ?? []);
      const nick = signature ? nicknameByTraits.get(signature) : '';
      if (!nick) continue;
      names[scope] = { name: nick, at: Number(item?.lastSeenAt) || 0 };
      updated += 1;
      recovered += 1;
    }
  }
  return { names, updated, recovered };
}

function socialBackupFiles() {
  try {
    return readdirSync(stateDir())
      .filter((name) => /^social-v2\.json\.bak-/.test(name))
      .map((name) => join(stateDir(), name));
  } catch { return []; }
}

/** 印象键可能是旧昵称；从该会话最近消息里找回对应的 QQ。 */
function resolveQQByName(conv, name) {
  const target = String(name ?? '').trim();
  if (!target) return '';
  for (const msg of Array.isArray(conv?.recentMessages) ? conv.recentMessages : []) {
    if (String(msg?.sender ?? '').trim() === target) return String(msg?.userId ?? '').trim();
  }
  return '';
}

/**
 * 删除一个已退出群（机器人不在里面）的全部群作用域记忆。
 * 私聊 p<QQ> 不在此函数范围内，永远不会被动。
 * 删除前把内容追加进 group-deletions.ndjson（append-only、不被任何代码回读），作为误判保险。
 */
export function deleteGroupMemory({
  groupId,
  reason = 'leave',
  now = Date.now(),
  stamp = stampOf(now),
  apply = false,
  bridgeRunning = true,
  stateDoc = null,
  socialDoc = null,
  log = () => {}
} = {}) {
  const id = String(groupId ?? '').trim();
  const result = {
    groupId: id, reason, applied: false, buckets: [], files: [], conversation: false,
    bytes: 0, socialSkipped: false
  };
  if (!/^\d+$/.test(id)) return result;

  const state = stateDoc ?? readJsonFile(join(stateDir(), STATE_FILE), null);
  const social = socialDoc ?? readJsonFile(join(stateDir(), SOCIAL_FILE), null);
  const relationDir = join(stateDir(), RELATIONS_DIR);
  const isGroupScope = scopesOfGroup(id);

  const bucketEntries = [];
  for (const kind of ['openLoops', 'selfNotes', 'currentFocus']) {
    const map = state?.[kind];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const scope of Object.keys(map)) {
      if (PROTECTED_SCOPES.has(scope) || !isGroupScope(scope)) continue;
      bucketEntries.push({ kind, scope, value: map[scope] });
    }
  }
  const files = filesOfGroup(id);
  const conversationKey = `group:${id}`;
  const conversation = social?.conversations?.[conversationKey] ?? null;
  const fileContents = files.map((name) => {
    const file = join(relationDir, name);
    return { name, bytes: fileBytes(file), content: readJsonFile(file, null) };
  });
  result.buckets = bucketEntries.map(({ kind, scope }) => ({ kind, scope }));
  result.files = fileContents.map(({ name, bytes }) => ({ name, bytes }));
  result.conversation = Boolean(conversation);
  result.bytes = fileContents.reduce((sum, f) => sum + f.bytes, 0)
    + (conversation ? Buffer.byteLength(JSON.stringify(conversation), 'utf8') : 0);

  if (!apply) return result;

  // 保险：先把要删的内容写进只追加的归档日志。
  ensureDir(join(stateDir(), ARCHIVE_DIR));
  const record = {
    at: now,
    groupId: id,
    reason,
    buckets: bucketEntries,
    relations: fileContents,
    conversation
  };
  try {
    writeFileSync(join(stateDir(), ARCHIVE_DIR, GROUP_DELETION_LOG), `${JSON.stringify(record)}\n`, { flag: 'a' });
  } catch (error) {
    // 归档写不进去就不删：宁保留勿误删。
    log('delete-group-aborted', id, `archive-failed:${error?.message ?? error}`);
    return { ...result, applied: false };
  }

  for (const entry of bucketEntries) {
    const map = state?.[entry.kind];
    if (map) delete map[entry.scope];
  }
  if (state && bucketEntries.length) {
    backupOnce(join(stateDir(), STATE_FILE), stamp);
    writeJsonFile(join(stateDir(), STATE_FILE), state);
  }
  for (const item of fileContents) {
    try { unlinkSync(join(relationDir, item.name)); } catch (error) {
      log('delete-group-file-failed', item.name, error?.message ?? error);
    }
  }
  if (conversation) {
    if (bridgeRunning) {
      // bridge.js 在内存里持有 social 副本，此刻删会被回写“复活”；留给下次 bridge 停止时重试。
      result.socialSkipped = true;
      log('delete-group-social-deferred', id, 'bridge-running');
    } else if (social?.conversations) {
      delete social.conversations[conversationKey];
      backupOnce(join(stateDir(), SOCIAL_FILE), stamp);
      writeJsonFile(join(stateDir(), SOCIAL_FILE), social);
    }
  }
  result.applied = true;
  log('delete-group', id, `reason=${reason}`, `files=${fileContents.length}`, `buckets=${bucketEntries.length}`,
    `conversation=${conversation ? (result.socialSkipped ? 'deferred' : 'deleted') : 'none'}`);
  return result;
}

/**
 * 启动周期性维护。
 * 依据：退群事件可能漏（掉线/被踢时事件不一定送达），所以 6 小时做一次对账；
 * 周/月清理本身有 7 天 / 30 天节流，6 小时只是“到点就查”。
 * 首次延迟 30 秒，避开 OneBot/DSH 冷启动。
 */
export function startPersonaMaintenance({
  fetchGroupIds = null,
  ownerQQs = [],
  logger = () => {},
  intervalMs = MAINTENANCE_CHECK_INTERVAL_MS,
  initialDelayMs = 30_000
} = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let currentGroupIds = null;
      if (typeof fetchGroupIds === 'function') {
        try { currentGroupIds = await fetchGroupIds(); } catch (error) {
          logger('[persona-maint] group list unavailable:', error?.message ?? error);
        }
      }
      const bridgeRunning = await isBridgeRunning();
      const report = runPersonaMaintenance({ apply: true, now: Date.now(), ownerQQs, currentGroupIds, bridgeRunning, logger });
      const removed = report.weekly.removed.length + report.relations.deletions.length
        + report.groups.missing.length + report.social.idle.length + report.social.impressions.length;
      if (removed) logger('[persona-maint] cleaned', JSON.stringify({
        weekly: report.weekly.removed, groups: report.groups.missing.map((g) => g.groupId),
        relations: report.relations.deletions.map((r) => r.name), social: report.social.idle.map((s) => s.key),
        impressions: report.social.impressions.length
      }));
    } catch (error) {
      logger('[persona-maint] failed:', error?.message ?? error);
    } finally {
      running = false;
    }
  };
  let interval = null;
  const kickoff = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  kickoff.unref?.();
  return {
    tick,
    stop() {
      clearTimeout(kickoff);
      if (interval) clearInterval(interval);
    }
  };
}

/** 供脚本/测试清理临时目录用（不会删除 state 根目录本身）。 */
export function removeArchive(dateStamp) {
  const target = join(stateDir(), ARCHIVE_DIR, dateStamp);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  return target;
}
