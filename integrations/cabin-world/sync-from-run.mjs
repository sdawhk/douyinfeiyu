#!/usr/bin/env node
// 把「运行目录」（桌面发布包里真正在跑的那份）的桥代码同步回工作区，供 Git 追踪。
//
// 背景：工作区的 bridge/ 和发布包的 bridge/ 是两份独立文件，没有任何链接关系。
// 在发布包里改代码才会生效，所以改完必须跑一次这个脚本，Git 里才看得到改动。
//
// 用法：
//   node sync-from-run.mjs            同步运行目录 → 工作区
//   node sync-from-run.mjs --dry-run  只列出差异，不写文件
//   node sync-from-run.mjs --check    有差异就返回退出码 1（提交前检查 / CI 用）
//
// 不会同步：bridge.config.json（含本机 token 和路径）、日志、.bak 备份、node_modules。
// 不会删除：工作区里有、运行目录里没有的文件（例如 xxx.example.json），只提示。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = process.env.CABIN_RUN_BRIDGE || 'C:\\Users\\admin\\Desktop\\小屋世界-v0.1\\bridge';
const WORK_DIR = path.join(HERE, 'bridge');

const SKIP_FILES = new Set(['bridge.config.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'logs']);
const SKIP_SUFFIX = /\.(log|pck|exe)$/i;
const SKIP_BACKUP = /\.bak([-.]|$)/i;

const dryRun = process.argv.includes('--dry-run');
const checkOnly = process.argv.includes('--check');

function walk(root, relative = '', out = []) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name) || SKIP_SUFFIX.test(entry.name) || SKIP_BACKUP.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

function same(a, b) {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

if (!existsSync(RUN_DIR)) {
  console.error(`运行目录不存在：${RUN_DIR}`);
  console.error('用 CABIN_RUN_BRIDGE 环境变量指定发布包里的 bridge 目录。');
  process.exit(2);
}
if (!existsSync(WORK_DIR)) {
  console.error(`工作区目录不存在：${WORK_DIR}`);
  process.exit(2);
}

const added = [];
const updated = [];
let identical = 0;

for (const rel of walk(RUN_DIR)) {
  const source = path.join(RUN_DIR, rel);
  const target = path.join(WORK_DIR, rel);
  if (!existsSync(target)) {
    added.push(rel);
    if (!dryRun && !checkOnly) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    continue;
  }
  if (same(source, target)) {
    identical += 1;
    continue;
  }
  updated.push(rel);
  if (!dryRun && !checkOnly) copyFileSync(source, target);
}

// 工作区独有：不删，只列出来提醒
const onlyInWorkDir = walk(WORK_DIR).filter((rel) => !existsSync(path.join(RUN_DIR, rel)));

console.log(`运行目录：${RUN_DIR}`);
console.log(`工作区  ：${WORK_DIR}`);
console.log('');
for (const rel of added) console.log(`  + ${rel}`);
for (const rel of updated) console.log(`  ~ ${rel}`);
if (onlyInWorkDir.length) {
  console.log('');
  for (const rel of onlyInWorkDir) console.log(`  ? ${rel}（仅工作区有，未改动）`);
}
console.log('');
console.log(`新增 ${added.length} · 更新 ${updated.length} · 相同 ${identical} · 仅工作区 ${onlyInWorkDir.length}`);

const drifted = added.length + updated.length;

if (dryRun) {
  console.log(drifted ? '（--dry-run：未写入任何文件）' : '两边一致。');
  process.exit(0);
}
if (checkOnly) {
  process.exit(drifted ? 1 : 0);
}
console.log(drifted ? '已同步。' : '两边一致，没有需要同步的文件。');
process.exit(0);
