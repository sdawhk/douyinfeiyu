// 日记仓库的每日推送：只提交日记目录内的文件，不阻塞主流程。
// 代理常不在线：先常规 push，失败再用 `-c http.proxy= -c https.proxy=` 直连，不改全局配置。

import { execFile } from 'node:child_process';

export const DIARY_PUSH_MAX_ATTEMPTS = 3;
export const DIARY_PUSH_RETRY_MS = 30 * 60_000;
export const DIARY_PUSH_TIMEOUT_MS = 90_000;

function runGit(dir, args, { timeoutMs = DIARY_PUSH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: dir, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
        error: error ? String(error.message ?? error) : ''
      });
    });
  });
}

/**
 * 提交并推送当天日记。dir 本身就是独立仓库根目录，`git add` 只覆盖其中的日记文件。
 * @returns {Promise<{ok:boolean, reason:string, skipped?:boolean, viaBypass?:boolean, commit?:string, detail?:string}>}
 */
export async function pushDiaryRepo({ dir, dayKey, log = () => {}, run = runGit } = {}) {
  const inside = await run(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    return { ok: false, reason: 'not-a-repo', detail: inside.stderr || inside.error };
  }

  const added = await run(dir, ['add', '--all', '--', '.']);
  if (!added.ok) return { ok: false, reason: 'add-failed', detail: added.stderr || added.error };

  // diff --quiet：0=无差异，1=有差异。
  const staged = await run(dir, ['diff', '--cached', '--quiet']);
  if (staged.code !== 0 && staged.code !== 1) {
    return { ok: false, reason: 'diff-failed', detail: staged.stderr || staged.error };
  }

  let commit = '';
  if (staged.code === 1) {
    const committed = await run(dir, ['commit', '-m', `diary: ${dayKey}`]);
    if (!committed.ok) return { ok: false, reason: 'commit-failed', detail: committed.stderr || committed.error };
    commit = committed.stdout;
  } else {
    // 没有新改动，但昨天的提交可能还没推上去：有未推送提交才继续。
    const ahead = await run(dir, ['rev-list', '--count', '@{u}..HEAD']);
    if (!ahead.ok || (Number(ahead.stdout) || 0) === 0) {
      return { ok: true, reason: 'no-changes', skipped: true };
    }
  }

  let pushed = await run(dir, ['push', 'origin', 'HEAD']);
  let viaBypass = false;
  if (!pushed.ok) {
    log(`[diary-git] push failed, retrying without proxy: ${(pushed.stderr || pushed.error).slice(0, 200)}`);
    viaBypass = true;
    pushed = await run(dir, ['-c', 'http.proxy=', '-c', 'https.proxy=', 'push', 'origin', 'HEAD']);
  }
  if (!pushed.ok) {
    return { ok: false, reason: 'push-failed', detail: pushed.stderr || pushed.error, viaBypass, commit };
  }
  return { ok: true, reason: 'pushed', viaBypass, commit, detail: pushed.stderr || pushed.stdout };
}
