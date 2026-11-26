import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDouyinVideoMemory, recordDouyinVideoSends, recordDouyinVideoFeedback, filterRankDouyinCandidates, resolveDouyinFeedbackOwner, douyinPreferencesForPrompt } from '../src/douyin-video-memory.mjs';

test('feedback authorization accepts the MCP private:QQ session key only for configured owners', () => {
  assert.equal(resolveDouyinFeedbackOwner('private:12345678', new Set(['12345678'])), '12345678');
  assert.equal(resolveDouyinFeedbackOwner('p12345678', new Set(['12345678'])), '');
  assert.equal(resolveDouyinFeedbackOwner('private:12345678', new Set(['87654321'])), '');
});

test('records feedback by QQ message id, then excludes sent videos and ranks liked styles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-memory-'));
  try {
    const file = join(dir, 'memory.json');
    const memory = loadDouyinVideoMemory(file);
    recordDouyinVideoSends(file, memory, [
      { messageId: 501, url: 'https://www.douyin.com/video/1001', title: '猫咪搞笑日常', author: 'A', ok: true },
      { messageId: 502, url: 'https://www.douyin.com/video/1002', title: '猫咪做饭', author: 'B', ok: true }
    ]);
    assert.equal(recordDouyinVideoFeedback(file, memory, { messageId: 502, sentiment: 'like', preference: '猫咪做饭' }).ok, true);
    assert.equal(recordDouyinVideoFeedback(file, memory, { messageId: 501, sentiment: 'dislike', preference: '真人整蛊' }).ok, true);
    assert.equal(recordDouyinVideoFeedback(file, memory, { messageId: 999, sentiment: 'dislike' }).ok, false);
    const ranked = filterRankDouyinCandidates([
      { url: 'https://www.douyin.com/video/1001', title: '猫咪搞笑日常' },
      { url: 'https://www.douyin.com/video/1002', title: '猫咪做饭' },
      { url: 'https://www.douyin.com/video/1003', title: '猫咪做饭教程' },
      { url: 'https://www.douyin.com/video/1004', title: '真人整蛊小猫合集' }
    ], memory, '猫咪');
    assert.deepEqual(ranked.map((item) => item.url), ['https://www.douyin.com/video/1003']);
    assert.deepEqual(loadDouyinVideoMemory(file).preferences.map((item) => item.text), ['猫咪做饭', '真人整蛊']);
    assert.equal(douyinPreferencesForPrompt(memory), '喜欢：猫咪做饭\n不喜欢：真人整蛊');
    assert.equal(douyinPreferencesForPrompt({ sent: [], preferences: [{ sentiment: 'like', text: '猫咪做饭' }] }), '喜欢：猫咪做饭');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('single-video feedback without a stated reason does not create a style preference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-memory-'));
  try {
    const file = join(dir, 'memory.json');
    const memory = loadDouyinVideoMemory(file);
    recordDouyinVideoSends(file, memory, [
      { messageId: 700, url: 'https://www.douyin.com/video/2001', title: '美食做法教程', ok: true }
    ]);
    assert.equal(recordDouyinVideoFeedback(file, memory, { messageId: 700, sentiment: 'dislike' }).ok, true);
    assert.equal(memory.sent[0].sentiment, 'dislike');
    assert.deepEqual(memory.preferences, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
