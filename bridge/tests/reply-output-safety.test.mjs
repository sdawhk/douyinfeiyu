import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelReply } from '../src/reply-output-safety.mjs';

test('keeps ordinary conversational replies unchanged', () => {
  const result = sanitizeModelReply('这免死金牌听着挺可靠，金币都拿出来担保了。');
  assert.equal(result.text, '这免死金牌听着挺可靠，金币都拿出来担保了。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, false);
});

test('blocks analysis written as a user-facing narration', () => {
  const result = sanitizeModelReply('当前这轮，小鲸鱼说“免死金牌”——他可能看到一张图。等等，我需要更仔细一点。本轮说…');
  assert.equal(result.text, '');
  assert.equal(result.blocked, true);
  assert.equal(result.leaked, true);
});

test('blocks internal narration even when it appears after a plausible opening', () => {
  const result = sanitizeModelReply('这句挺有意思。当前这轮，用户可能在调侃之前的惩罚，我需要分析上下文。');
  assert.equal(result.blocked, true);
  assert.equal(result.text, '');
});

test('blocks less explicit planning language in Chinese and English', () => {
  for (const text of [
    '我得先判断用户说的“一千天小蛋糕”指什么，然后再回答。',
    'The user is asking about the cake context. I should respond carefully.',
    '先分析一下这张图片可能表达什么，再组织回复。'
  ]) {
    const result = sanitizeModelReply(text);
    assert.equal(result.blocked, true, text);
    assert.equal(result.text, '', text);
  }
});

test('extracts only the final segment after explicit reasoning tags', () => {
  const result = sanitizeModelReply('<|analysis|>The user means a gold coin promise.<|final|>金币上的承诺，我先保留怀疑。');
  assert.equal(result.text, '金币上的承诺，我先保留怀疑。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
});

test('removes closed think tags and their contents', () => {
  const result = sanitizeModelReply('<think>Need reason about the context.</think>这承诺听着不太牢靠。');
  assert.equal(result.text, '这承诺听着不太牢靠。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
});
