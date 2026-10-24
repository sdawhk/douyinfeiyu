import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStickerHandling } from '../src/sticker-moderation.mjs';

test('valuable, appropriate, confidently unique stickers are enabled automatically', () => {
  assert.deepEqual(decideStickerHandling({ sticker: true, appropriate: true, valuable: true, confidence: 0.91 }, { duplicate: false, confidence: 0.95 }), {
    archive: true, status: 'approved', reason: 'valuable'
  });
});

test('high-confidence low-value stickers and duplicates are skipped before archiving', () => {
  assert.equal(decideStickerHandling({ sticker: true, valuable: false, confidence: 0.9 }, { duplicate: false }).reason, 'low-value');
  assert.equal(decideStickerHandling({ sticker: true, valuable: true, confidence: 0.9 }, { duplicate: true, confidence: 0.85 }).reason, 'duplicate');
  assert.equal(decideStickerHandling({ sticker: true, valuable: true, confidence: 0.9 }, { duplicate: true, confidence: 0.7 }).status, 'pending');
});

test('uncertain value or duplicate judgments remain pending', () => {
  assert.equal(decideStickerHandling({ sticker: true, appropriate: true, valuable: true, confidence: 0.9 }, null).status, 'pending');
  assert.equal(decideStickerHandling({ sticker: true, appropriate: true, valuable: false, confidence: 0.6 }, { duplicate: false }).status, 'pending');
});

test('inappropriate stickers remain isolated', () => {
  assert.deepEqual(decideStickerHandling({ sticker: true, appropriate: false, valuable: true, confidence: 0.95 }, { duplicate: false }), {
    archive: true, status: 'rejected', reason: 'inappropriate'
  });
});
