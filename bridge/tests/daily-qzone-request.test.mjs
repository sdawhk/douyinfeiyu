import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQzoneRequest, isQzoneFollowupRequest, isPublishableQzoneText, repeatsRecentTopic, canResolvePendingPost } from '../src/daily-qzone.mjs';

test('parses contextual owner requests to publish a QQ dynamic', () => {
  assert.equal(parseQzoneRequest('今天主人帮你更新了好感度系统你去以这个内容发一篇动态'), '主人帮你更新了好感度系统');
  assert.equal(parseQzoneRequest('你去把这件事发一条动态'), '这件事');
  assert.equal(parseQzoneRequest('你去以这个内容发一篇动态'), '根据主人最近给出的聊天内容');
  assert.equal(parseQzoneRequest('发一条动态'), '根据主人最近给出的聊天内容');
  assert.equal(parseQzoneRequest('帮我发一条关于今天晚饭的动态'), '今天晚饭');
  assert.equal(parseQzoneRequest('我觉得这件事值得发动态'), null);
});

test('recognizes short follow-ups for history-based context resolution', () => {
  assert.equal(isQzoneFollowupRequest('给你加了呀，你去发吧'), true);
  assert.equal(isQzoneFollowupRequest('好，你去发吧'), true);
  assert.equal(isQzoneFollowupRequest('这图发吧'), false);
});

test('rejects control markers, non-Chinese output, progress, and diagnostics from public dynamics', () => {
  for (const text of [
    '[silent] {reasoning: "thinking"}',
    'Finding the rain-soaked remix while I am searching.',
    '请求失败：HTTP 503 Error',
    '正在搜索《雨爱》，请稍等。'
  ]) assert.equal(isPublishableQzoneText(text), false, text);
});

test('allows a short Chinese user-facing dynamic', () => {
  assert.equal(isPublishableQzoneText('雨夜听歌，窗上的灯影也跟着晃。'), true);
});

test('rejects clipped or oversized text and requires enough shared topic evidence', () => {
  assert.equal(isPublishableQzoneText('雨夜听歌，窗上的灯影也跟着晃……'), false);
  assert.equal(isPublishableQzoneText('中文'.repeat(251)), false);
  assert.equal(repeatsRecentTopic('我第一次开口居然真的发出声音，语气比打字温柔多了。', [
    { text: '刚才第一次开口说话，紧张得像在做梦，语气还带点温柔。' }
  ]), true);
  assert.equal(repeatsRecentTopic('今天说到唱歌，我觉得很开心。', [
    { text: '唱歌的时候状态不错，后来整理了歌单。' }
  ]), false);
  assert.equal(canResolvePendingPost({ at: '2026-10-27T00:00:00.000Z', readbackMisses: 2 }, Date.parse('2026-10-27T00:20:00.000Z')), false);
  assert.equal(canResolvePendingPost({ at: '2026-10-27T00:00:00.000Z', readbackMisses: 3 }, Date.parse('2026-10-27T00:09:00.000Z')), false);
  assert.equal(canResolvePendingPost({ at: '2026-10-27T00:00:00.000Z', readbackMisses: 3 }, Date.parse('2026-10-27T00:10:00.000Z')), true);
  assert.equal(canResolvePendingPost({ at: '2026-10-27T00:00:00.000Z', readbackMisses: 3, tid: 'known-tid' }, Date.parse('2026-10-27T01:00:00.000Z')), true);
  assert.equal(canResolvePendingPost({ at: 'invalid', readbackMisses: 3 }, Date.parse('2026-10-27T01:00:00.000Z')), false);
});
