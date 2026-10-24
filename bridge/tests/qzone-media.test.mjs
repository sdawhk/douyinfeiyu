import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelatedQzoneMedia } from '../src/qzone-media.mjs';
import { recentMediaRefs } from '../src/daily-qzone.mjs';

test('selects an image that matches the dynamic and avoids recently posted images', () => {
  const candidates = [
    { ref: 'food.png', path: 'food.png', safe: true, description: '夜宵拉面热汤食物' },
    { ref: 'fish.png', path: 'fish.png', safe: true, description: '小鲸鱼挥手开心表情' },
  ];
  assert.equal(selectRelatedQzoneMedia('群里聊到夜宵拉面，我突然也好想吃一碗', candidates)?.ref, 'food.png');
  assert.equal(selectRelatedQzoneMedia('群里聊到夜宵拉面，我突然也好想吃一碗', candidates, ['food.png']), null);
  assert.equal(selectRelatedQzoneMedia('群里聊到夜宵拉面，我突然也好想吃一碗', [candidates[0]], ['food.png']), null);
});

test('recent media history ignores old entries and handles legacy posts', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const refs = recentMediaRefs([
    { at: '2026-10-22T12:00:00Z', mediaRefs: ['a.png', 'a.png'] },
    { at: '2026-10-01T12:00:00Z', mediaRefs: ['old.png'] },
    { at: '2026-10-22T13:00:00Z', text: 'legacy post' },
  ], now);
  assert.deepEqual(refs, ['a.png']);
});
