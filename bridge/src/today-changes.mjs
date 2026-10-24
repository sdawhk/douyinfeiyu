import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

function isToday(time, now) {
  return time.getFullYear() === now.getFullYear()
    && time.getMonth() === now.getMonth()
    && time.getDate() === now.getDate();
}

function workingTreeChanges(now) {
  let status = '';
  try { status = git(['status', '--short', '--untracked-files=normal']); }
  catch { return []; }
  const changes = [];
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2).trim();
    let name = line.slice(3).trim();
    if (name.includes(' -> ')) name = name.split(' -> ').at(-1);
    name = name.replace(/^"|"$/g, '');
    const fullPath = resolve(REPO_ROOT, name);
    const relPath = relative(REPO_ROOT, fullPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) continue;
    const removed = code.includes('D') || !existsSync(fullPath);
    if (!removed) {
      try { if (!isToday(statSync(fullPath).mtime, now)) continue; }
      catch { continue; }
    }
    changes.push(`${removed ? '删除' : code.includes('?') ? '新增' : '修改'}：${name}`);
    if (changes.length >= 20) break;
  }
  return changes;
}

export function todayChanges(now = new Date()) {
  let commits = '';
  try { commits = git(['log', '--since=midnight', '--format=%h%x09%s', '-n', '12']); }
  catch { return '我暂时无法读取项目 Git 记录，请确认项目目录和 Git 可用。'; }

  const commitLines = commits ? commits.split(/\r?\n/).filter(Boolean) : [];
  const workingChanges = workingTreeChanges(now);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lines = [`今天（${date}）项目改动：`];
  lines.push('已提交功能：');
  if (commitLines.length) lines.push(...commitLines.map((line) => `• ${line.replace('\t', '：')}`));
  else lines.push('• 暂无今天提交的记录。');
  lines.push('今天修改但尚未提交的文件：');
  if (workingChanges.length) lines.push(...workingChanges.map((line) => `• ${line}`));
  else lines.push('• 暂无。');
  if (workingChanges.length) lines.push('未提交部分按文件最后修改日期筛选；文件名不能准确说明功能，提交说明会提供更清楚的功能摘要。');
  return lines.join('\n').slice(0, 1800);
}

export function todayFeatureMaterials(now = new Date()) {
  let commits = '';
  try { commits = git(['log', '--since=midnight', '--format=%s', '-n', '8']); }
  catch { return []; }
  return commits.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^feat(?:ure)?(?:\([^)]*\))?:/i.test(line))
    .map((subject) => `今天的项目功能更新记录：${subject}`);
}
