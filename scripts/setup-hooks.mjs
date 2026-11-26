#!/usr/bin/env node
// npm install 的 postinstall：把 git 的 hooks 目录指向仓库内的 .githooks。
//
// 为什么要它：core.hooksPath 是本机配置，不随仓库走。新克隆一份代码以后
// 如果忘了执行 git config core.hooksPath .githooks，pre-commit 检查（桥代码漂移拦截）
// 就悄悄失效了。跑一次 npm install 就能自动补上。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(path.join(ROOT, '.git'))) {
  console.log('[setup-hooks] 这里不是 git 仓库，跳过');
  process.exit(0);
}
if (!existsSync(path.join(ROOT, '.githooks', 'pre-commit'))) {
  console.log('[setup-hooks] 没找到 .githooks/pre-commit，跳过');
  process.exit(0);
}

try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (current === '.githooks') {
    console.log('[setup-hooks] core.hooksPath 已经是 .githooks，无需改动');
    process.exit(0);
  }
} catch { /* 未设置时 git config 会返回非 0，正常 */ }

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'inherit' });
  console.log('[setup-hooks] 已设置 core.hooksPath = .githooks（提交前会检查桥代码是否同步）');
} catch (error) {
  console.warn(`[setup-hooks] 设置失败，可手动执行 git config core.hooksPath .githooks：${error?.message ?? error}`);
}
