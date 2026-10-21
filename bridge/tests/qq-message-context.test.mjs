import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMessageReferences, explicitGroupReplyDecision, groupTurnPrompt } from '../src/qq-message-context.mjs';

const botSelf = '2427256325';
const keywords = ['小鲸鱼', '鲸鱼', 'deepseek'];

function decision(message, text, isOwner = false) {
  return explicitGroupReplyDecision({
    botSelf, text, isOwner, keywords,
    references: describeMessageReferences(message, botSelf)
  });
}

test('an @ of another 小鲸鱼 does not address the bot', () => {
  const otherAt = [{ type: 'at', data: { qq: '1581449421', text: '@小鲸鱼' } },
    { type: 'text', data: { text: ' 你怎么看' } }];
  assert.equal(decision(otherAt, '你怎么看'), false);
  assert.equal(decision(otherAt, '@小鲸鱼 你怎么看'), false);
  assert.equal(decision(otherAt, '@小鲸鱼 你怎么看', true), false);
  assert.equal(decision([{ type: 'text', data: { text: '@小鲸鱼 你怎么看' } }], '@小鲸鱼 你怎么看'), false);
});

test('the bot still answers its own QQ mention and a separate nickname call', () => {
  const selfAt = [{ type: 'at', data: { qq: botSelf, text: '@最爱吃白饭' } },
    { type: 'text', data: { text: ' 你怎么看' } }];
  assert.equal(decision(selfAt, '你怎么看'), true);
  assert.equal(decision([{ type: 'text', data: { text: '小鲸鱼你怎么看' } }], '小鲸鱼你怎么看'), true);
});

test('group turns identify each speaker and keep self-descriptions with that speaker', () => {
  const first = groupTurnPrompt({ groupId: '123', botSelf, senderId: '456',
    senderName: '群友甲', text: '真好，看的叔叔骨架都暖暖的' });
  const second = groupTurnPrompt({ groupId: '123', botSelf, senderId: '789',
    senderName: '群友乙', text: '你这叔叔有点危险啊' });
  assert.match(first, /机器人 QQ：2427256325；发言人："群友甲"（QQ 456），群友/);
  assert.match(first, /自称、身份、亲属称谓属于本轮发言人/);
  assert.match(first, /【本轮发言人原话】"真好，看的叔叔骨架都暖暖的"/);
  assert.match(second, /发言人："群友乙"（QQ 789），群友/);
  assert.doesNotMatch(second, /群友甲/);
});
