// 一次性迁移：人格记忆从"全局 / 整群"改成按 会话+发言人 分桶。
//
// 规则：
// - 幂等：已经是新格式的字段不再改；重跑只会再次打印未决项。
// - 所有被改动的文件先备份为 <file>.bak-20261111（已存在则不覆盖）。
// - 拿不准的（分不清发言人、疑似把非主人认成主人）一律保留原样，只打印出来。
//
// 用法：
//   node scripts/migrate-persona-scope.mjs          # 只打印计划，不写文件
//   node scripts/migrate-persona-scope.mjs --apply  # 执行迁移

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_DIR = process.env.DSH_PERSONA_STATE_DIR || fileURLToPath(new URL('../state/', import.meta.url));
const APPLY = process.argv.includes('--apply');
const BACKUP_SUFFIX = '.bak-20261111';
const BOT_QQ = '2427256325';
const OWNER_QQ = '1668389572';
const UNCLAIMED = '_unclaimed';

const STATE_FILE = join(STATE_DIR, 'persona-state.json');
const SOCIAL_FILE = join(STATE_DIR, 'social-v2.json');
const RELATIONS_DIR = join(STATE_DIR, 'persona-relations');

const FOCUS_INTERNAL_RE = /【[^】]*】|主动(?:私聊|联系|去找|找)主人/u;
const PROMPT_NOISE_RE = /主动(?:私聊|联系|去找|找)主人|系统提示|内部提示|不要输出|只输出|（只 @ 了你|把这几句当成这轮/u;

// 用户明确认领过的两条 00:53:29 / 00:54:12 不猜，统一放进 _unclaimed 等人工处理。
const LOOP_SCOPE_BY_AT = new Map([
  [1794333317155, 'p982269045'], // 群里聊到胃不舒服后的回复
  [1794333404453, 'p982269045'], // 同上，第二条
  [1794329609123, UNCLAIMED],    // 00:53:29「在呢，等你开口」待认领
  [1794329652150, UNCLAIMED],    // 00:54:12「口什么？是爽什么吧…」待认领
  [1794355602819, '__self__']    // 机器人自己的早安问候，不是人物的心事
]);

const report = [];
const note = (line) => report.push(line);

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    const text = readFileSync(path, 'utf8').trim();
    return text ? JSON.parse(text) : fallback;
  } catch { return fallback; }
}

function backup(path) {
  if (!existsSync(path)) return;
  const target = `${path}${BACKUP_SUFFIX}`;
  if (!existsSync(target)) copyFileSync(path, target);
}

function writeJson(path, value) {
  if (!APPLY) return;
  backup(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const social = readJson(SOCIAL_FILE) ?? {};
const conversations = social.conversations ?? {};

function scopeForConversation(key, userId) {
  if (key.startsWith('private:')) return `p${key.slice('private:'.length)}`;
  if (key.startsWith('group:') && userId) return `g${key.slice('group:'.length)}-${userId}`;
  return '';
}

/** 用 social-v2 的最近消息反查这句话是谁说的；只认唯一作用域，多个就放弃。 */
function findScopeByText(text) {
  if (!text || text.length < 4) return '';
  const scopes = new Set();
  for (const [key, conv] of Object.entries(conversations)) {
    for (const msg of conv?.recentMessages ?? []) {
      const msgText = String(msg?.text ?? '');
      if (!msgText) continue;
      const hit = msgText === text
        || (text.length >= 6 && msgText.startsWith(text))
        || (msgText.length >= 6 && text.startsWith(msgText));
      if (!hit) continue;
      const scope = scopeForConversation(key, String(msg.userId ?? ''));
      if (scope) scopes.add(scope);
    }
  }
  return scopes.size === 1 ? [...scopes][0] : '';
}

function bestMessage(messages, text, at) {
  if (!text || text.length < 4) return null;
  const candidates = (Array.isArray(messages) ? messages : []).filter((msg) => {
    const msgText = String(msg?.text ?? '');
    if (!msgText) return false;
    return msgText === text
      || (text.length >= 6 && msgText.startsWith(text))
      || (msgText.length >= 6 && text.startsWith(msgText));
  });
  if (!candidates.length) return null;
  // 同一句话在同群被多个人说过（如“早”）时，不能猜是谁：留给人工。
  const userIds = new Set(candidates.map((msg) => String(msg?.userId ?? '')));
  if (userIds.size > 1) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.reduce((a, b) => (
    Math.abs((Number(a.time) || 0) - at) <= Math.abs((Number(b.time) || 0) - at) ? a : b
  ));
}

function migrateState() {
  if (!existsSync(STATE_FILE)) return;
  const raw = readJson(STATE_FILE) ?? {};
  const before = JSON.stringify(raw);
  const next = { ...raw };

  if (Array.isArray(raw.openLoops)) {
    const buckets = {};
    for (const item of raw.openLoops) {
      const text = String(item?.text ?? '').trim();
      if (!text) continue;
      const at = Number(item?.at) || 0;
      let scope = LOOP_SCOPE_BY_AT.get(at) ?? '';
      if (scope === '__self__') {
        note(`[loop] 丢弃机器人自己的问候（原文只在备份里）：${text}`);
        continue;
      }
      if (!scope) scope = findScopeByText(text) || UNCLAIMED;
      (buckets[scope] ??= []).push({ text, at, important: item?.important === true });
      note(`[loop] ${scope} <- ${new Date(at).toLocaleString('zh-CN')} ${text}`);
    }
    next.openLoops = buckets;
    next.focusAt = 0;
    note(`[loop] 共 ${raw.openLoops.length} 条旧 loop 已分桶`);
  }

  if (typeof raw.currentFocus === 'string') {
    const text = raw.currentFocus.trim();
    const at = Number(raw.focusAt) || 0;
    if (!text) {
      next.currentFocus = {};
    } else if (FOCUS_INTERNAL_RE.test(text)) {
      next.currentFocus = {};
      note(`[focus] 清掉内部指令：${text}`);
    } else {
      const scope = findScopeByText(text) || UNCLAIMED;
      next.currentFocus = { [scope]: { text, at } };
      note(`[focus] ${scope} <- ${text}`);
    }
    next.focusAt = 0;
  }

  if (Array.isArray(raw.selfNotes)) {
    const notes = raw.selfNotes
      .map((item) => ({ text: String(item?.text ?? '').trim(), at: Number(item?.at) || 0 }))
      .filter((item) => item.text);
    next.selfNotes = notes.length ? { _legacy: notes } : {};
    if (notes.length) {
      note(`[selfNotes] ${notes.length} 条旧全局私事移入 _legacy（不再注入）：${notes.map((item) => item.text).join(' / ')}`);
    }
  }

  if (JSON.stringify(next) !== before) {
    writeJson(STATE_FILE, next);
    note(`[state] ${APPLY ? '已写入' : '将写入'} ${STATE_FILE}`);
  } else {
    note('[state] 已是新格式，跳过');
  }
}

function migrateRelations() {
  if (!existsSync(RELATIONS_DIR)) return;
  const files = readdirSync(RELATIONS_DIR).filter((name) => /^g\d+\.json$/.test(name));
  for (const name of files) {
    const path = join(RELATIONS_DIR, name);
    const gid = name.match(/^g(\d+)\.json$/)[1];
    const doc = readJson(path) ?? {};
    const messages = conversations[`group:${gid}`]?.recentMessages ?? [];
    const originalRecent = Array.isArray(doc.recent) ? doc.recent : [];
    const keep = [];
    const byScope = new Map();

    for (const item of originalRecent) {
      const text = String(item?.text ?? '').trim();
      if (!text) continue;
      if (PROMPT_NOISE_RE.test(text)) {
        note(`[relation] 内部提示词移出 ${name}（原文只在备份里）：${text.slice(0, 70)}`);
        continue;
      }
      const hit = bestMessage(messages, text, Number(item?.at) || 0);
      if (!hit) {
        keep.push(item);
        continue;
      }
      const uid = String(hit.userId ?? '');
      if (!uid || uid === BOT_QQ || hit.isSelf === true) {
        note(`[relation] 机器人发言移出 ${name}（原文只在备份里）：${text.slice(0, 70)}`);
        continue;
      }
      const scope = `g${gid}-${uid}`;
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push({ at: Number(item?.at) || 0, text: text.slice(0, 80) });
    }

    for (const [scope, items] of byScope) {
      const target = join(RELATIONS_DIR, `${scope}.json`);
      const targetDoc = readJson(target, null) ?? { traits: [], bits: [], boundaries: [], recent: [] };
      const recent = Array.isArray(targetDoc.recent) ? [...targetDoc.recent] : [];
      for (const item of items) {
        if (!recent.some((entry) => entry?.text === item.text)) recent.push(item);
      }
      targetDoc.recent = recent.slice(-6);
      writeJson(target, targetDoc);
      note(`[relation] ${scope} <- ${items.length} 条（来自 ${name}）`);
    }

    if (keep.length !== originalRecent.length) {
      writeJson(path, { ...doc, recent: keep });
      note(`[relation] ${name} 保留未能判定发言人的 ${keep.length} 条`);
    }
    if (Array.isArray(doc.traits) && doc.traits.length) {
      note(`[relation] ${name} 的 traits 无发言人信息，保留原样：${doc.traits.join(' | ')}`);
    }
  }
}

function mergeImpression(existing, entry) {
  if (!existing) return entry;
  const traits = [...new Set([
    ...(Array.isArray(existing.traits) ? existing.traits : []),
    ...(Array.isArray(entry?.traits) ? entry.traits : [])
  ])];
  return {
    ...existing,
    ...entry,
    traits,
    interactionCount: Math.max(Number(existing.interactionCount) || 0, Number(entry?.interactionCount) || 0),
    lastSeenAt: Math.max(Number(existing.lastSeenAt) || 0, Number(entry?.lastSeenAt) || 0)
  };
}

function migrateSocial() {
  if (!existsSync(SOCIAL_FILE)) return;
  const doc = readJson(SOCIAL_FILE);
  if (!doc?.conversations) return;

  const globalMap = new Map();
  for (const conv of Object.values(doc.conversations)) {
    for (const msg of conv?.recentMessages ?? []) {
      const sender = String(msg?.sender ?? '').trim();
      const uid = String(msg?.userId ?? '').trim();
      if (!sender || !uid) continue;
      if (!globalMap.has(sender)) globalMap.set(sender, new Set());
      globalMap.get(sender).add(uid);
    }
  }

  let changed = false;
  for (const [key, conv] of Object.entries(doc.conversations)) {
    const impressions = conv?.memberImpressions;
    if (!impressions || typeof impressions !== 'object') continue;
    const next = {};
    for (const [name, entry] of Object.entries(impressions)) {
      if (/^\d+$/.test(name)) {
        next[name] = mergeImpression(next[name], entry);
        continue;
      }
      const traits = Array.isArray(entry?.traits) ? entry.traits.map(String) : [];
      const claimsOwner = traits.some((trait) => /主人/u.test(trait));
      let uid = '';
      if (key.startsWith('private:')) {
        uid = key.slice('private:'.length);
      } else {
        const local = new Set((conv.recentMessages ?? [])
          .filter((msg) => msg?.sender === name)
          .map((msg) => String(msg.userId ?? ''))
          .filter(Boolean));
        if (local.size === 1) uid = [...local][0];
        else {
          const global = globalMap.get(name);
          if (global && global.size === 1) uid = [...global][0];
        }
      }
      if (!uid) {
        next[name] = entry;
        note(`[social] 无法确定 ${key} 的昵称「${name}」，保持原样`);
        continue;
      }
      if (claimsOwner && uid !== OWNER_QQ) {
        next[name] = entry;
        note(`[social] 待用户确认（疑似把非主人认成主人），暂不改键：${key} 的「${name}」→ ${uid}：${traits.join(' | ')}`);
        continue;
      }
      next[uid] = mergeImpression(next[uid], entry);
      changed = true;
      note(`[social] ${key} 的「${name}」→ ${uid}`);
    }
    conv.memberImpressions = next;
  }

  if (changed) {
    writeJson(SOCIAL_FILE, doc);
    note(`[social] ${APPLY ? '已写入' : '将写入'} ${SOCIAL_FILE}`);
  } else {
    note('[social] 无需改动');
  }
}

migrateState();
migrateRelations();
migrateSocial();

console.log(`\n===== ${APPLY ? '迁移已执行' : 'DRY RUN（未写任何文件）'} =====`);
for (const line of report) console.log(line);
console.log(`===== 共 ${report.length} 条 =====\n`);
if (!APPLY) console.log('确认无误后加 --apply 执行。');
