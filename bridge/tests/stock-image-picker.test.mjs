import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadStockSends, parseStockKeywords, pickStockImageForRequest, recordStockSend,
  scoreStockCandidate, selectStockImage
} from '../src/stock-image-picker.mjs';

const DAY = 24 * 60 * 60 * 1000;

function candidate(over = {}) {
  return {
    key: '2026-11-01/gen-100-abcdef12.jpg',
    path: 'D:/tmp/gen-100-abcdef12.jpg',
    description: '',
    outfit: '',
    framing: '',
    hairstyle: '',
    tags: [],
    createdAt: 1,
    privateOnly: false,
    ...over
  };
}

test('库存图：从请求里抠关键词，过滤命令词', () => {
  const keywords = parseStockKeywords('大肥鱼帮我画一张猫娘');
  assert.ok(keywords.includes('猫娘'));
  assert.ok(!keywords.includes('帮我'));
  assert.ok(!keywords.includes('一张'));
  assert.deepEqual(parseStockKeywords(''), []);
});

test('库存图：关键词命中越多得分越高', () => {
  const cat = candidate({ description: '猫娘 女仆装', outfit: 'maid' });
  const plain = candidate({ description: '日常 街景' });
  const keywords = parseStockKeywords('画个猫娘');
  assert.ok(scoreStockCandidate(cat, keywords) > scoreStockCandidate(plain, keywords));
  assert.equal(scoreStockCandidate(plain, keywords), 0);
});

test('库存图：群里排除仅主人服装，同会话冷却期内不再发同一张', () => {
  const now = Date.now();
  const cat = candidate({ key: 'k1', description: '猫娘', createdAt: 10 });
  const bikini = candidate({ key: 'k2', description: '猫娘 海边', privateOnly: true, createdAt: 20 });
  const plain = candidate({ key: 'k3', description: '日常', createdAt: 5 });

  // 群里：privateOnly 直接不可选。
  const groupPick = selectStockImage([cat, bikini, plain], {
    keywords: ['猫娘'], chatKey: 'group:1', sends: [], now, isGroup: true
  });
  assert.equal(groupPick.key, 'k1');

  // 发过给这个群，冷却期内要避开。
  const again = selectStockImage([cat, plain], {
    keywords: ['猫娘'], chatKey: 'group:1',
    sends: [{ fileKey: 'k1', chatKey: 'group:1', at: now - 1000 }], now
  });
  assert.equal(again.key, 'k3');

  // 冷却期过了可以再发。
  const later = selectStockImage([cat, plain], {
    keywords: ['猫娘'], chatKey: 'group:1',
    sends: [{ fileKey: 'k1', chatKey: 'group:1', at: now - 30 * DAY }], now
  });
  assert.equal(later.key, 'k1');
});

test('库存图：匹配不到就挑最久没发过的一张', () => {
  const now = Date.now();
  const a = candidate({ key: 'a', createdAt: 100 });
  const b = candidate({ key: 'b', createdAt: 200 });
  const picked = selectStockImage([a, b], {
    keywords: ['完全不相关'],
    sends: [{ fileKey: 'b', chatKey: 'group:9', at: now - 30 * DAY }],
    chatKey: 'group:1', now
  });
  assert.equal(picked.key, 'a');
});

test('库存图：扫描已生成目录并按会话去重落盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'stock-root-'));
  const statePath = join(root, 'stock-sends.json');
  const dayDir = join(root, '2026-11-10');
  mkdirSync(dayDir, { recursive: true });
  const image = join(dayDir, 'gen-1700000000000-abcdef12.jpg');
  writeFileSync(image, 'x');
  writeFileSync(`${image.slice(0, -4)}.json`, JSON.stringify({
    description: '猫娘 女仆装', outfit: 'maid', createdAt: 1700000000000
  }));
  try {
    const first = pickStockImageForRequest({ request: '画个猫娘', chatKey: 'group:1', isGroup: true, root, statePath });
    assert.equal(first.key, '2026-11-10/gen-1700000000000-abcdef12.jpg');
    assert.ok(first.score > 0);

    recordStockSend({ fileKey: first.key, chatKey: 'group:1', senderId: '999' }, statePath);
    assert.equal(loadStockSends(statePath).items.length, 1);

    // 同一个群冷却期内不再挑这张。
    const second = pickStockImageForRequest({ request: '画个猫娘', chatKey: 'group:1', isGroup: true, root, statePath });
    assert.equal(second, null);

    // 换个群仍然可以发。
    const other = pickStockImageForRequest({ request: '画个猫娘', chatKey: 'group:2', isGroup: true, root, statePath });
    assert.equal(other.key, first.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
