import assert from 'node:assert/strict';
import { buildDigest, isPublicSafe, isPostIntervalElapsed, parseQzoneRequest, promptFor, tidy } from '../src/daily-qzone.mjs';

const now = Math.floor(Date.now() / 1000);
const todayStart = now - (now % 86400) - 8 * 3600;
const digest = buildDigest([
  {
    kind: 'owner', selfId: 'bot', messages: [
      { time: now, sender: { user_id: 'owner', nickname: '主人真名' }, message: '今天修好机器人了' },
      { time: todayStart - 1, sender: { user_id: 'owner' }, message: '昨天的内容不应进入动态' }
    ]
  },
  {
    kind: 'group', selfId: 'bot', messages: [
      { time: now - 2, sender: { user_id: 'member', nickname: '群友真名' }, message: '群里第一次玩这个小游戏' },
      { time: now - 1, sender: { user_id: 'bot' }, message: [{ type: 'text', data: { text: '我居然赢了' } }] },
      { time: now, sender: { user_id: 'member' }, message: '验证码是123456' }
    ]
  }
]);

assert.deepEqual(digest, [
  '群友：群里第一次玩这个小游戏',
  '我：我居然赢了',
  '主人：今天修好机器人了'
]);
assert.equal(isPublicSafe('验证码是123456'), false);
assert.match(promptFor(digest), /主人私聊和群聊/);
assert.match(promptFor(digest), /匿名转述/);
assert.match(promptFor(digest), /不要把它们全部总结/);
assert.match(promptFor(digest), /一条动态只围绕一个素材点/);
assert.match(promptFor(digest), /夜宵拉面/);
assert.equal(parseQzoneRequest('你现在发条关于主人的动态'), '关于主人');
assert.equal(parseQzoneRequest('帮我发一条关于主人的QQ动态'), '关于主人');
assert.equal(parseQzoneRequest('今天群里聊到动态'), null);
assert.match(promptFor(digest, '今天群聊中', '关于主人'), /直接发布/);
assert.equal(tidy('🐳'.repeat(501)), '🐳'.repeat(500));

const historical = buildDigest([{
  kind: 'owner', selfId: 'bot', messages: [
    { time: 100, sender: { user_id: 'owner' }, message: '前一日真实小事' },
    { time: 99, sender: { user_id: 'owner' }, message: '范围外不应进入素材' },
    { time: 200, sender: { user_id: 'owner' }, message: '后一日真实小事' }
  ]
}], { startTime: 100, endTime: 200 });
assert.deepEqual(historical, ['主人：前一日真实小事']);
assert.match(promptFor(historical, '10月18日至19日'), /10月18日至19日/);
assert.equal(isPostIntervalElapsed(1_000, 3_600_999, 3_600_000), false);
assert.equal(isPostIntervalElapsed(1_000, 3_601_000, 3_600_000), true);
assert.equal(isPostIntervalElapsed(null, 1_000), true);

console.log('daily qzone: owner and group sources, anonymization, date/privacy filtering, and flexible length passed');
