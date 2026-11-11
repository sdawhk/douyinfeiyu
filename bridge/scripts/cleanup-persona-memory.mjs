// 人格记忆清理 CLI。
//
//   node scripts/cleanup-persona-memory.mjs            # dry-run：只列将删/将留/豁免，不动文件
//   node scripts/cleanup-persona-memory.mjs --apply    # 真正执行（需要 bridge/qq-bot 都停着）
//
// 为什么 --apply 要求 bridge 停：bridge.js 在内存里持有 social-v2 副本，运行时会整份回写，
// 运行中改文件会被覆盖（归档的会话“复活”）。qq-bot 同理持有关系文件写入路径。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isBridgeRunning, runPersonaMaintenance } from '../src/persona-maintenance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_PATH = `${ROOT}config.json`;
const FORCE = process.argv.includes('--force');
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1] ?? '').trim() || null;

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function kb(bytes) {
  return `${(Number(bytes || 0) / 1024).toFixed(1)} KB`;
}

async function fetchGroupIds() {
  const cfg = readJson(CONFIG_PATH, {}) ?? {};
  const snow = cfg.snowluma ?? {};
  const url = `${snow.httpUrl ?? 'http://127.0.0.1:3002'}/get_group_list`;
  const token = snow.httpAccessToken || snow.accessToken || '';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}',
    signal: AbortSignal.timeout(15_000)
  });
  const json = await res.json();
  if (json?.retcode !== 0) throw new Error(`get_group_list retcode=${json?.retcode} ${json?.wording ?? ''}`);
  return (json.data ?? []).map((item) => String(item.group_id ?? item.groupId ?? '')).filter(Boolean);
}

function portOpen(port) {
  return new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect({ host: '127.0.0.1', port });
      const done = (value) => { try { socket.destroy(); } catch {} resolve(value); };
      socket.setTimeout(400);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    }).catch(() => resolve(false));
  });
}

function printReport(report) {
  const mode = report.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`\n=== 人格记忆清理（${mode}${ONLY ? ` only=${ONLY}` : ''}）  ${new Date(report.at).toISOString()} ===`);
  console.log(`state: ${report.stateDir}\n`);

  console.log(`[周清理] persona-state.json ${kb(report.weekly.fileBytes)} / 阈值 ${kb(report.weekly.threshold)} → ${report.weekly.due ? '执行' : `跳过（${report.weekly.reason}）`}`);
  if (report.weekly.due) {
    if (report.weekly.removed.length) {
      for (const item of report.weekly.removed) console.log(`  将删除桶 ${item.kind}/${item.scope}（${item.items} 条已过期）`);
    } else {
      console.log(`  无可清理的过期桶（保留 ${report.weekly.kept} 个）`);
    }
  }

  const g = report.groups;
  console.log(`\n[退群对账] ${g.checked ? `机器人当前在 ${g.current.length} 个群，本地记忆涉及 ${g.local.length} 个群` : `跳过（${g.reason}）`}`);
  if (g.checked) {
    if (!g.missing.length) console.log('  没有需要按退群删除的群');
    for (const item of g.missing) {
      console.log(`  直接删除 group:${item.groupId}  reason=leave  体积≈${kb(item.bytes)}`);
      console.log(`    关系文件 ${item.files.length} 个：${item.files.map((f) => f.name).join(', ') || '无'}`);
      console.log(`   state 桶 ${item.buckets.length} 个：${item.buckets.map((b) => `${b.kind}/${b.scope}`).join(', ') || '无'}`);
      console.log(`    social 会话：${item.conversation ? (item.conversationDeferred ? '有（bridge 在跑，本次延后）' : '有（删除）') : '无'}`);
    }
  }

  const r = report.relations;
  console.log(`\n[月清理·关系文件] 目录 ${r.dirFiles} 个文件 / ${kb(r.dirBytes)}；参与清理 ${r.total} 个 / ${kb(r.totalBytes)}`);
  console.log(`  将删除（traits 为空且 90 天无新内容）：${r.deletions.length}`);
  for (const item of r.deletions) console.log(`    ${item.name}  ${kb(item.bytes)}  qq=${item.qq}`);
  console.log(`  豁免（skip(exempt-private)）：${r.exempt.length}`);
  console.log(`  旧群级文件转入归档：${r.legacyArchive.length} 个主文件 / ${r.legacyArchive.reduce((sum, item) => sum + (item.files?.length ?? 1), 0)} 个文件（含历史 .bak）`);
  for (const item of r.legacyArchive) console.log(`    ${item.name}  ${kb(item.bytesAll ?? item.bytes)}  group=${item.groupId}`);
  console.log(`  紧凑化：${r.compaction.files} 个文件 ${kb(r.compaction.bytesBefore)} → ${kb(r.compaction.bytesAfter)}`);

  const s = report.social;
  console.log(`\n[QQ→昵称旁挂表] ${report.names.total} 条，本次新增/更新 ${report.names.updated}（其中从旧印象键恢复 ${report.names.recovered}）`);
  console.log(`\n[月清理·social] ${s.conversations} 个会话 / ${kb(s.bytes)}`);
  console.log(`  60 天无活动归档：${s.idle.length}${s.skipped ? `（bridge 在跑，本次跳过：${s.skipped}）` : ''}`);
  for (const item of s.idle) console.log(`    ${item.key}  ${kb(item.bytes)}`);
  console.log(`  90 天未见的群印象淘汰：${s.impressions.length}`);
  for (const item of s.impressions) console.log(`    ${item.key} / ${item.qqKey}（${item.ageDays} 天）`);

  const afterRelations = r.dirBytes
    - r.deletions.reduce((sum, item) => sum + item.bytes, 0)
    - r.legacyArchive.reduce((sum, item) => sum + (item.bytesAll ?? item.bytes), 0)
    - Math.max(0, r.compaction.bytesBefore - r.compaction.bytesAfter);
  const deletedFiles = r.deletions.length
    + r.legacyArchive.reduce((sum, item) => sum + (item.files?.length ?? 1), 0);
  const groupSocialBytes = report.groups.missing
    .filter((item) => item.conversation && !item.conversationDeferred)
    .reduce((sum, item) => sum + item.bytes, 0);
  const socialAfter = s.bytes - s.idle.reduce((sum, item) => sum + item.bytes, 0) - groupSocialBytes;
  console.log('\n[估算]');
  console.log(`  关系文件数 ${r.dirFiles} → ${r.dirFiles - deletedFiles}，体积 ${kb(r.dirBytes)} → ${kb(afterRelations)}`);
  console.log(`  social 体积 ${kb(s.bytes)} → ${kb(Math.max(0, socialAfter))}`);
  if (report.apply) console.log(`  备份：${report.backups.length ? report.backups.join(', ') : '无（本次没有写操作）'}`);
  if (!report.apply) console.log('\n（dry-run，未改动任何文件；确认后加 --apply 执行）');
}

async function main() {
  const cfg = readJson(CONFIG_PATH, {}) ?? {};
  const owners = (Array.isArray(cfg.ownerQQs) && cfg.ownerQQs.length ? cfg.ownerQQs : [cfg.ownerQQ])
    .filter(Boolean).map(String);
  const bridgeRunning = await isBridgeRunning();
  const qqBotRunning = await portOpen(3101);

  if (APPLY && (bridgeRunning || qqBotRunning) && !FORCE) {
    console.error(`拒绝执行：${bridgeRunning ? 'bridge.js(3100) ' : ''}${qqBotRunning ? 'qq-bot(3101)' : ''} 仍在运行。`);
    console.error('先停两轮看门狗与进程，再执行；或确认风险后加 --force。');
    process.exit(2);
  }

  let currentGroupIds = null;
  try {
    currentGroupIds = await fetchGroupIds();
  } catch (error) {
    console.warn(`[warn] 取群列表失败，本次跳过退群对账：${error?.message ?? error}`);
  }

  const report = runPersonaMaintenance({
    apply: APPLY,
    now: Date.now(),
    ownerQQs: owners,
    currentGroupIds,
    bridgeRunning,
    only: ONLY ?? undefined,
    logger: (...args) => console.log('[maint]', ...args)
  });
  printReport(report);
}

main().catch((error) => {
  console.error('cleanup failed:', error?.stack ?? error);
  process.exit(1);
});
