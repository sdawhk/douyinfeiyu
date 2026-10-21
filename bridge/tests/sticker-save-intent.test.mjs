import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStickerSaveIntent, isStickerName } from '../src/sticker-save-intent.mjs';

test('owner can explicitly save a picture classified as non-sticker', () => {
  assert.deepEqual(parseStickerSaveIntent('本人自画像你存下'), { key: '本人自画像' });
  assert.deepEqual(parseStickerSaveIntent('/存表情 本人自画像'), { key: '本人自画像' });
  assert.deepEqual(parseStickerSaveIntent('存表情包 本人自画像'), { key: '本人自画像' });
  assert.deepEqual(parseStickerSaveIntent('快存'), { key: null });
  assert.equal(isStickerName('本人自画像'), true);
  assert.equal(isStickerName('取消'), false);
  assert.equal(parseStickerSaveIntent('现在是表情包了'), null);
});
