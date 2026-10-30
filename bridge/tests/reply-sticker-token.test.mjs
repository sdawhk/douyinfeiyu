import test from 'node:test';
import assert from 'node:assert/strict';
import { stickerTokens, hasStickerDirective, stripStickerDirectives } from '../src/reply-sticker-token.mjs';

test('recognizes uppercase and spaced sticker directives as image requests', () => {
  const text = '先看这个 [STICKER:897]，再看 [ Sticker ： 389 ]';
  assert.deepEqual(stickerTokens(text).map((match) => match[1].trim()), ['897', '389']);
  assert.equal(stripStickerDirectives(text), '先看这个 ，再看');
});

test('text send guard removes even malformed sticker directives', () => {
  assert.equal(hasStickerDirective('[STICKER:897]'), true);
  assert.equal(stripStickerDirectives('[STICKER:897]'), '');
  assert.equal(stripStickerDirectives('答复 [STICKER:897'), '答复');
  assert.equal(stickerTokens('【STICKER：897】').at(0)?.[1], '897');
  assert.equal(stripStickerDirectives('[sticker] sent'), '');
});
