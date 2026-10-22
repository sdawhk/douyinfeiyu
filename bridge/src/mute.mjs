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

export function isMuted(key) {
  const state = read();
  return state[key] === true || (String(key).startsWith('g') && state[allGroupsKey()] === true);
}

export function setMuted(key, value) {
  const j = read();
  if (value) j[key] = true;
  else delete j[key];
  write(j);
}

export function listMuted() {
  return Object.keys(read()).map((key) => key === allGroupsKey() ? '全部群聊' : key);
}
