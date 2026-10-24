// 禁言状态：主人 @ 机器人说"闭嘴"后，这个群 / 这个私聊就不再回应，
// 直到主人说"你可以讲话"才恢复。
//
// 状态必须写文件：否则机器人一重启就自己开口了，主人明明还没让说话。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'D:\\deepseek\\state';
const FILE = `${DIR}\\mute.json`;

function ensure() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function read() {
  ensure();
  try {
    if (!existsSync(FILE)) return {};
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function write(j) {
  ensure();
  writeFileSync(FILE, JSON.stringify(j, null, 2), 'utf8');
}

/** 群的 key；私聊用 privateKey。 */
export const groupKey = (id) => `g${id}`;
export const privateKey = (id) => `p${id}`;
export const allGroupsKey = () => 'g*';

function active(state, key, now) {
  const value = state[key];
  if (value === true) return true;
  if (!value || typeof value !== 'object' || value.muted !== true) return false;
  if (!Number.isFinite(value.expiresAt) || value.expiresAt > now) return true;
  delete state[key];
  return false;
}

export function isMuted(key) {
  const state = read();
  const before = JSON.stringify(state);
  const now = Date.now();
  const muted = active(state, key, now)
    || (String(key).startsWith('g') && active(state, allGroupsKey(), now));
  if (JSON.stringify(state) !== before) write(state);
  return muted;
}

export function setMuted(key, value, durationMs = null) {
  const j = read();
  if (value && Number.isFinite(durationMs) && durationMs > 0) j[key] = { muted: true, expiresAt: Date.now() + durationMs };
  else if (value) j[key] = true;
  else delete j[key];
  write(j);
}

export function listMuted() {
  return Object.keys(read()).map((key) => key === allGroupsKey() ? '全部群聊' : key);
}
