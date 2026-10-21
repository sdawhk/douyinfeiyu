import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const base = cfg.snowluma.httpUrl.replace(/\/+$/, '');
const token = cfg.snowluma.httpAccessToken || cfg.snowluma.accessToken || '';

async function onebot(action, params = {}) {
  const response = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json();
  if (!response.ok || result?.retcode !== 0) throw new Error(`${action}: ${result?.wording ?? response.status}`);
  return result.data;
}

const friends = await onebot('get_friend_list');
const matches = (Array.isArray(friends) ? friends : []).filter((friend) =>
  `${friend.remark ?? ''} ${friend.nickname ?? ''}`.includes('M星辰')
);
console.log('MATCHES', JSON.stringify(matches.map(({ user_id, nickname, remark }) => ({ user_id, nickname, remark }))));
if (matches.length !== 1) process.exit(0);
const friend = matches[0];
const history = await onebot('get_friend_msg_history', { user_id: Number(friend.user_id), count: 30 });
const messages = history?.messages ?? history?.data?.messages ?? [];
console.log('HISTORY_COUNT', messages.length);
for (const item of messages.slice(-12)) {
  const message = Array.isArray(item.message)
    ? item.message.map((part) => part?.data?.text ?? (part?.type === 'image' ? '[图片]' : '')).join('')
    : String(item.message ?? '');
  console.log(`${item.time ?? ''} ${String(item.user_id ?? item.sender?.user_id) === String(friend.user_id) ? '对方' : '机器人'}: ${message}`);
}
