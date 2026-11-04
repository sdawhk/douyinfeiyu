import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDouyinRecentHistory, isOwnerHistoryKey } from '../src/recent-owner-history.mjs';

test('recent history accepts only configured owner QQ and Douyin sessions', () => {
  const options = { ownerIds: ['123456'], douyinOwnerId: '123456' };
  assert.equal(isOwnerHistoryKey('p123456', options), true);
  assert.equal(isOwnerHistoryKey('d123456', options), true);
  assert.equal(isOwnerHistoryKey('d654321', options), false);
  assert.equal(isOwnerHistoryKey('g123456', options), false);
  assert.equal(isOwnerHistoryKey('d123456', { ownerIds: ['123456'], douyinOwnerId: '654321' }), false);
});

test('Douyin history prompt contains only the latest three exchanges and sets factual boundaries', () => {
  const prompt = formatDouyinRecentHistory([
    { input: 'first', reply: 'first reply' },
    { input: 'second', reply: 'second reply' },
    { input: 'third', reply: 'third reply' },
    { input: 'fourth', reply: 'fourth reply' },
  ], ['earlier video reply']);
  assert.ok(prompt.includes('爸：second'));
  assert.ok(prompt.includes('你：fourth reply'));
  assert.ok(!prompt.includes('爸：first'));
  assert.ok(prompt.includes('不要猜测“可能回复过”'));
  assert.ok(prompt.includes('你：earlier video reply'));
  assert.equal(formatDouyinRecentHistory([]), '');
});

test('previously saved Douyin replies remain visible before exchange history is available', () => {
  const prompt = formatDouyinRecentHistory([], ['旧回复一', '刚才我已经看过视频了']);
  assert.ok(prompt.includes('你：刚才我已经看过视频了'));
  assert.ok(prompt.includes('你：旧回复一'));
});

test('a newly shared video does not inherit old video replies as prompt context', () => {
  const prompt = formatDouyinRecentHistory([
    { input: '分享旧视频', reply: '旧视频讲了什么' },
  ], ['第一次分享的视频', '另一个旧视频'], { currentVideo: true });
  assert.equal(prompt, '');
});
