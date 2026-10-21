import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setStickerSemantics, readStickerSemantics, deepSeekStickerCatalog, parseDeepSeekStickerRequest, parsePersonalStickerRequest, selectDeepSeekStickerKeys
} from '../src/sticker-semantics.mjs';

test('DeepSeek image classification keeps actions and respects manual correction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-semantics-'));
  const file = join(dir, 'semantics.json');
  const ref = '1234567890abcdef.png';
  try {
    setStickerSemantics(ref, { deepseek: true, confidence: 0.85, action: '挥手', emotion: '开心' }, file);
    assert.equal(readStickerSemantics(file)[ref].action, '挥手');
    setStickerSemantics(ref, { deepseek: false, confidence: 1, action: '站立', emotion: '平静', overridden: true }, file);
    setStickerSemantics(ref, { deepseek: true, confidence: 0.9, action: '挥手' }, file);
    assert.equal(readStickerSemantics(file)[ref].deepseek, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('theme requests and catalog select classified images only', () => {
  assert.deepEqual(parseDeepSeekStickerRequest('发三张DeepSeek表情包'), { count: 3 });
  assert.deepEqual(parseDeepSeekStickerRequest('来点小鲸鱼贴纸'), { count: 3 });
  assert.deepEqual(parseDeepSeekStickerRequest('/表情 DeepSeek'), { count: 1 });
  assert.equal(parseDeepSeekStickerRequest('你知道DeepSeek吗'), null);
  assert.equal(parseDeepSeekStickerRequest('别发DeepSeek表情包'), null);
  assert.deepEqual(parsePersonalStickerRequest('来点你的表情包'), { count: 3 });
  assert.deepEqual(parsePersonalStickerRequest('快快来点表情包'), { count: 3 });
  assert.deepEqual(parsePersonalStickerRequest('给我一张表情包'), { count: 1 });
  assert.equal(parsePersonalStickerRequest('为什么不发表情包'), null);
  const records = { 开心: { ref: '1234567890abcdef.png' }, 开心2: { ref: '1234567890abcdef.png' }, 哭泣: { ref: 'fedcba0987654321.png' } };
  const semantics = {
    '1234567890abcdef.png': { deepseek: true, confidence: 0.85, action: '挥手', emotion: '开心' },
    'fedcba0987654321.png': { deepseek: true, confidence: 0.4, action: '哭', emotion: '难过' }
  };
  assert.deepEqual(deepSeekStickerCatalog(records, semantics).map((item) => item.key), ['开心']);
  const choices = [
    { key: '大笑', action: '挥手', emotion: '开心', caption: '' },
    { key: '委屈', action: '低头', emotion: '难过', caption: '' }
  ];
  assert.deepEqual(selectDeepSeekStickerKeys(choices, '发一张开心的DeepSeek表情包', 1, () => 0.5), ['大笑']);
});
