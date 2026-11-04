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

test('legacy table markers resolve to the archived DeepSeek sticker keys without leaking as text', () => {
  const reply = '还好吧[table:621] 不是每个人都能像她这样聪明[table:917]';
  assert.deepEqual(stickerTokens(reply).map((match) => match[1]), ['DeepSeek娘621', 'DeepSeek娘917']);
  assert.equal(stripStickerDirectives(reply), '还好吧 不是每个人都能像她这样聪明');
  assert.equal(hasStickerDirective(reply), true);
  assert.equal(stripStickerDirectives('说完了[table:621'), '说完了');
  assert.equal(stripStickerDirectives('说完了[table:未知]'), '说完了');
  assert.equal(stripStickerDirectives('说完了[DeepSeek娘617'), '说完了');
  assert.equal(stickerTokens('[DeepSeek娘617]').at(0)?.[1], 'DeepSeek娘617');
});
