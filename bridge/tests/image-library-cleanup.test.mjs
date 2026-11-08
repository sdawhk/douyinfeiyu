import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { cleanupClassifiedImages, IMAGE_LIBRARY_CLEANUP_INTERVAL_MS, shouldCleanImageArchiveRecord } from '../src/image-library-cleanup.mjs';

test('identifies confident payment images and low-value chat screenshots while preserving useful or generic images', () => {
  assert.equal(shouldCleanImageArchiveRecord({ kind: '支付凭证', confidence: 0.88 }), true);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '二维码', tags: ['付款码'], confidence: 0.8 }), true);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '聊天截图', valuable: false, confidence: 0.85 }), true);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '聊天截图', valuable: true, confidence: 0.95 }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '聊天截图', confidence: 0.95 }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '截图', caption: '普通风景截图', confidence: 0.9 }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '支付凭证', confidence: 0.79 }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '聊天截图', confidence: 0.4 }), false);
});

test('cleans confidently flagged sexualized or graphic images and preserves uncertain classifications', () => {
  assert.equal(shouldCleanImageArchiveRecord({ kind: '表情包', sexualSuggestive: true, confidence: 0.9 }), true);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '照片', grossOrGraphic: true, confidence: 0.82 }), true);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '照片', appropriate: false, confidence: 0.9 }), true);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '照片', sexualSuggestive: true, confidence: 0.7 }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '照片', sexualSuggestive: true }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '照片', grossOrGraphic: false, confidence: 0.95 }), false);
  // 人工归档的反面教材即使 appropriate=false 也保留在图库，供复盘与负向词提炼。
  assert.equal(shouldCleanImageArchiveRecord({ kind: '自绘测试图', appropriate: false, confidence: 0.9, tags: ['反面教材·发色跑偏·1', '不要这样画·发色跑偏·1'] }), false);
  assert.equal(shouldCleanImageArchiveRecord({ kind: '自绘测试图', appropriate: false, confidence: 0.9, tags: ['不要这样画·Q版幼态·3'] }), false);
});

test('cleanup moves matching files and removes aliases only after a successful move', () => {
  const moved = [];
  const removedAliases = [];
  const images = [
    { day: '2026-10-23', file: 'a'.repeat(16) + '.jpg' },
    { day: '2026-10-23', file: 'b'.repeat(16) + '.jpg' }
  ];
  const result = cleanupClassifiedImages({
    images,
    analyses: {
      [images[0].file]: { kind: '聊天截图', valuable: false, confidence: 0.9 },
      [images[1].file]: { kind: '支付凭证', confidence: 0.95 }
    },
    quarantineImage: (_day, file) => {
      if (file === images[1].file) return null;
      moved.push(file);
      return 'quarantined';
    },
    removeStickerAliases: (ref) => {
      removedAliases.push(ref);
      return ['alias'];
    }
  });
  assert.deepEqual(result, { scanned: 2, matched: 2, quarantined: 1, aliasesRemoved: 1, failed: 1 });
  assert.deepEqual(removedAliases, moved);
  assert.equal(IMAGE_LIBRARY_CLEANUP_INTERVAL_MS, 10 * 60 * 1000);
});

test('quarantined images are removed from active archive listings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-cleanup-'));
  const day = '2026-10-23';
  const file = 'c'.repeat(16) + '.jpg';
  process.env.IMAGE_LIBRARY_ROOT = root;
  try {
    mkdirSync(join(root, day), { recursive: true });
    mkdirSync(join(root, '.quarantine', 'old'), { recursive: true });
    writeFileSync(join(root, day, file), Buffer.from('image'));
    writeFileSync(join(root, '.quarantine', 'old', file), Buffer.from('old image'));
    const archive = await import(`../src/image-archive.mjs?cleanup-test=${randomUUID()}`);
    const moved = archive.quarantineArchivedImage(day, file);
    assert.ok(moved && existsSync(moved));
    assert.deepEqual(archive.listArchived(10).map((item) => item.file), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.IMAGE_LIBRARY_ROOT;
  }
});
