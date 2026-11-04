import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWatchedVideo } from '../src/douyin-watch-memory.mjs';

const now = Date.parse('2026-11-04T08:00:00Z');
const memory = { watchedVideos: [
  { title: '长亭外，古道边，芳草碧连天 ---《送别》来自星辰', url: 'https://www.douyin.com/video/12345', observedAt: '2026-11-04T15:04:00+08:00' },
  { title: '法国阿尔卑斯山下，藏着童话般滑雪小镇', url: 'https://www.douyin.com/video/67890', observedAt: '2026-11-04T15:04:00+08:00' }
] };

test('finds one recent video by the short title phrase the owner approved', () => {
  assert.equal(resolveWatchedVideo(memory, '送别', { now }).url, 'https://www.douyin.com/video/12345');
});

test('rejects an ambiguous title and never chooses arbitrarily', () => {
  const ambiguous = { watchedVideos: [...memory.watchedVideos, {
    title: '另一版本《送别》', url: 'https://www.douyin.com/video/24680', observedAt: '2026-11-04T15:04:00+08:00'
  }] };
  assert.throws(() => resolveWatchedVideo(ambiguous, '送别', { now }), /多条/);
});

test('rejects stale or noncanonical records', () => {
  const bad = { watchedVideos: [
    { title: '送别', url: 'https://www.douyin.com/video/12345', observedAt: '2026-10-01T00:00:00Z' },
    { title: '送别', url: 'https://example.com/video/24680', observedAt: '2026-11-04T15:04:00+08:00' }
  ] };
  assert.throws(() => resolveWatchedVideo(bad, '送别', { now }), /没有匹配/);
});
