import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelReply, replySafetyDiagnostics, replyQualityIssue, repeatsRecentReply } from '../src/reply-output-safety.mjs';

test('keeps ordinary conversational replies unchanged', () => {
  const result = sanitizeModelReply('这免死金牌听着挺可靠，金币都拿出来担保了。');
  assert.equal(result.text, '这免死金牌听着挺可靠，金币都拿出来担保了。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, false);
});

test('blocks leaked sticker send status text', () => {
  for (const text of ['[sticker] sent', '[sticker] sent 开心']) {
    const result = sanitizeModelReply(text);
    assert.equal(result.text, '', text);
    assert.equal(result.leaked, true, text);
    assert.equal(result.blocked, true, text);
  }
});

test('blocks replies made only of QQ media placeholders', () => {
  for (const text of ['[图片] [图片]', '[表情][图片]', '<|analysis|>ignore<|final|>[视频]']) {
    const result = sanitizeModelReply(text);
    assert.equal(result.text, '', text);
    assert.equal(result.blocked, true, text);
    assert.equal(result.leaked, true, text);
  }
});

test('removes media placeholders from an otherwise useful reply', () => {
  const result = sanitizeModelReply('我平时看游戏视频 [图片] 偶尔看电影解说 [sticker:开心]');
  assert.equal(result.text, '我平时看游戏视频 偶尔看电影解说 [sticker:开心]');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
});

test('flags obvious non-answers to a question without rejecting short real answers', () => {
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '[sticker:开心]'), 'missing-answer');
  assert.equal(replyQualityIssue('这是什么意思？', '[STICKER:897]'), 'missing-answer');
  assert.equal(replyQualityIssue('这是什么意思？', '[table:621]'), 'missing-answer');
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '哈哈'), 'generic-non-answer');
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '你喜欢看什么视频？'), 'echoed-question');
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '游戏实况'), '');
  assert.equal(replyQualityIssue('到了吗？', '到了'), '');
  assert.equal(replyQualityIssue('来看看', '哈哈'), '');
});

test('detects repeated reply wording without confusing the same topic for repetition', () => {
  const recent = ['我平时看游戏实况，偶尔看电影解说。[sticker:开心]'];
  assert.equal(repeatsRecentReply('我平时看游戏实况，偶尔看电影解说。', recent), true);
  assert.equal(repeatsRecentReply('电影解说我只看悬疑题材，你呢？', recent), false);
});

test('blocks silent control markers with model metadata attached', () => {
  for (const text of [
    '[SILENT]',
    '[silent] {amount: 1, reasoning: "do not answer"}',
    '[SKIP] internal routing payload'
  ]) {
    const result = sanitizeModelReply(text);
    assert.equal(result.text, '', text);
    assert.equal(result.blocked, true, text);
  }
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

test('blocks English recap analysis about a previous group message', () => {
  const result = sanitizeModelReply('长期素食 said "这大肥鱼笨笨的" and then "没有那么好玩嘞". Hmm, the previous message "这大肥鱼笨笨的" — 大肥鱼 is my 雷点 (they call me 蓝色大肥鱼). But co…');
  assert.equal(result.text, '');
  assert.equal(result.blocked, true);
  assert.equal(result.leaked, true);
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

test('reports marker categories and lengths without including reply text', () => {
  const raw = '[at:1917174653] 你好[tob:1917174653] <think>分析内容</think>你好';
  const safe = sanitizeModelReply(raw);
  const diagnostics = replySafetyDiagnostics(raw, safe);
  assert.deepEqual(diagnostics, {
    rawChars: raw.length,
    safeChars: safe.text.length,
    leaked: true,
    blocked: false,
    markers: ['tob', 'at', 'reasoning-tag'],
    remainingMarkers: ['tob', 'at']
  });
  assert.equal(JSON.stringify(diagnostics).includes('1917174653'), false);
  assert.equal(JSON.stringify(diagnostics).includes('分析内容'), false);
});
