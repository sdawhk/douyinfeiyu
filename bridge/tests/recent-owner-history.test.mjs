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

test('a newly shared video keeps only the two exchanges right before it', () => {
  const prompt = formatDouyinRecentHistory([
    { input: '更早的一轮', reply: '更早的回复' },
    { input: '分享旧视频', reply: '旧视频讲了什么' },
    { input: '分享新视频之前', reply: '好呀' },
  ], ['第一次分享的视频', '另一个旧视频'], { currentVideo: true });
  assert.ok(prompt.includes('分享这条视频之前的一两轮私信'));
  assert.ok(prompt.includes('爸：分享旧视频'));
  assert.ok(prompt.includes('爸：分享新视频之前'));
  assert.ok(!prompt.includes('更早的一轮'));
  // Old replies carry no usable text context for a brand new video.
  assert.ok(!prompt.includes('第一次分享的视频'));
  assert.ok(!prompt.includes('另一个旧视频'));
  assert.equal(formatDouyinRecentHistory([], [], { currentVideo: true }), '');
});
