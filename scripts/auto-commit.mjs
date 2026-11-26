#!/usr/bin/env node
// 静默自动提交：工作区有改动、而且最近 5 分钟没人再动 → 提交并推送。
//
// 由计划任务每 5 分钟跑一次，也可以手动执行：node scripts/auto-commit.mjs
// 想只看会发生什么：node scripts/auto-commit.mjs --dry-run
//
// 安全阀（任何一条命中都直接跳过，不动仓库）：
//   1. 有 .git/index.lock、merge、rebase 正在进行 → 等它结束
//   2. 改动里出现疑似密钥的文件名（.env / *.pem / keys.json / bridge.config.json …）
//   3. 距最近一次文件改动不到 5 分钟 → 说明还没改完
//
// push 逐个远端执行，某个失败只记日志、不影响其他远端，也不回滚提交。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'auto-commit.log');

const IDLE_MS = Number(process.env.AUTO_COMMIT_IDLE_MS || 5 * 60_000);
const REMOTES = (process.env.AUTO_COMMIT_REMOTES || 'github,gitee').split(',').map((s) => s.trim()).filter(Boolean);
const BRANCH = process.env.AUTO_COMMIT_BRANCH || 'main';
// 运行时噪声：锁文件、心跳每几秒重写一次，不能算“还在改代码”，否则永远不会静默。
const NOISE = /\.(lock|pid)$|-heartbeat\.json$|\/\.video-worker|\.browser-profile/i;
const SENSITIVE = /(^|\/)(\.env(\..*)?|keys?\.json|credentials?\.json|bridge\.config\.json|id_rsa|id_ed25519|[^/]+\.(pem|key|pfx|jks|keystore))$/i;
const dryRun = process.argv.includes('--dry-run');

function log(line) {
  const text = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}`;
  console.log(text);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, text + '\n', 'utf8');
  } catch { /* 日志写不进去不影响主流程 */ }
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  }).trim();
}

function fail(message) {
  log(`跳过：${message}`);
  process.exit(0);
}

// ---- 1. 仓库状态 ----------------------------------------------------------------------
if (!existsSync(path.join(ROOT, '.git'))) fail('不是 git 仓库');
for (const marker of ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
  if (existsSync(path.join(ROOT, '.git', marker))) fail(`仓库正在操作中（${marker}），等一下再提交`);
}

let status = '';
try {
  status = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: ROOT, encoding: 'utf8' }).replace(/\0$/, '');
} catch (error) {
  fail(`读取 git status 失败：${String(error?.message ?? error).slice(0, 120)}`);
}
if (!status) fail('工作区没有改动');

const entries = status.split('\0').filter(Boolean).map((row) => ({ code: row.slice(0, 2), file: row.slice(3) }));
const files = entries.map((item) => item.file);

// ---- 2. 敏感文件守门 ------------------------------------------------------------------
const sensitiveHits = files.filter((file) => SENSITIVE.test(file));
if (sensitiveHits.length) {
  fail(`改动里疑似有密钥文件，拒绝自动提交：${sensitiveHits.slice(0, 5).join('、')}`);
}

// ---- 3. 静默判定 ----------------------------------------------------------------------
let latest = 0;
for (const item of entries) {
  if (item.code.includes('D')) continue;
  if (NOISE.test(item.file)) continue;
  try {
    const at = statSync(path.join(ROOT, item.file)).mtimeMs;
    if (at > latest) latest = at;
  } catch { /* 已删除或权限不足，忽略 */ }
}
const idleFor = Date.now() - latest;
if (latest && idleFor < IDLE_MS) {
  const waitSec = Math.ceil((IDLE_MS - idleFor) / 1000);
  fail(`最近一次改动在 ${Math.round(idleFor / 1000)} 秒前，还没静默满 ${Math.round(IDLE_MS / 60000)} 分钟（再等 ${waitSec} 秒）`);
}

// ---- 4. 提交 --------------------------------------------------------------------------
const now = new Date();
const stamp = now.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
const groups = new Map();
for (const file of files) {
  const top = file.includes('/') ? file.split('/').slice(0, file.includes('/bridge/') ? 2 : 1).join('/') : '(根目录)';
  groups.set(top, (groups.get(top) || 0) + 1);
}
const topDirs = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([dir, count]) => `${dir}(${count})`).join('、');

if (dryRun) {
  log(`[dry-run] 将提交 ${files.length} 个文件：${topDirs}`);
  process.exit(0);
}

try {
  git(['add', '-A']);
  const shortstat = git(['diff', '--cached', '--shortstat']) || `${files.length} 个文件`;
  const message = `chore(auto): ${stamp} 自动提交\n\n${shortstat}\n涉及：${topDirs}\n\n由 scripts/auto-commit.mjs 在静默 ${Math.round(IDLE_MS / 60000)} 分钟后自动生成。`;
  git(['commit', '-m', message]);
  const head = git(['rev-parse', '--short', 'HEAD']);
  log(`已提交 ${head}：${files.length} 个文件（${shortstat}）`);
} catch (error) {
  const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
  log(`提交失败：${detail}`);
  process.exit(0);
}

// ---- 5. 推送 --------------------------------------------------------------------------
for (const remote of REMOTES) {
  try {
    git(['push', remote, BRANCH], { timeout: 90_000 });
    log(`已推送 ${remote}/${BRANCH}`);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').slice(0, 160);
    log(`推送 ${remote} 失败（提交已保留，稍后会随下次提交重试）：${detail}`);
  }
}
