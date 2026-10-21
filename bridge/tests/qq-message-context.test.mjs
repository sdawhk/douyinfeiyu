import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMessageReferences, explicitGroupReplyDecision } from '../src/qq-message-context.mjs';

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
