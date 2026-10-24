import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('image archive deduplicates bytes across dates and pending stickers cannot be used', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sticker-moderation-'));
  const imageRoot = join(root, 'images');
  const stickerRoot = join(root, 'stickers');
  process.env.IMAGE_LIBRARY_ROOT = imageRoot;
  process.env.STICKER_LIBRARY_ROOT = stickerRoot;

  try {
    const bytes = Buffer.from('same image bytes');
    const b64 = bytes.toString('base64');
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 16);
    const oldDay = join(imageRoot, '2000-01-01');
    mkdirSync(oldDay, { recursive: true });
    writeFileSync(join(oldDay, `${hash}.png`), bytes);

    const { archiveImage } = await import('../src/image-archive.mjs');
    const { saveSticker, listStickers, getStickerPath, findStickerByRef, findSticker } = await import('../src/sticker-store.mjs');
    const archived = archiveImage(b64, 'image/png');
    assert.equal(archived.fresh, false);
    assert.equal(archived.path, join(oldDay, `${hash}.png`));

    const pending = saveSticker('待审核表情', b64, 'image/png', { status: 'pending' });
    assert.equal(findStickerByRef(pending.ref), '待审核表情');
    assert.deepEqual(listStickers(), []);
    assert.equal(getStickerPath('待审核表情'), null);

    saveSticker('已启用表情', b64, 'image/png', { status: 'approved' });
    saveSticker('另一张表情', Buffer.from('different image').toString('base64'), 'image/png', { status: 'approved' });
    assert.deepEqual(listStickers(), ['另一张表情', '已启用表情', '待审核表情']);
    assert.equal(findSticker('表情'), null);
    assert.equal(getStickerPath('待审核表情'), join(oldDay, `${hash}.png`));
    assert.equal(getStickerPath('已启用表情'), join(oldDay, `${hash}.png`));
    assert.equal(readdirSync(oldDay).length, 1);
    assert.ok(readFileSync(join(stickerRoot, 'index.json'), 'utf8').includes('approved'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.IMAGE_LIBRARY_ROOT;
    delete process.env.STICKER_LIBRARY_ROOT;
  }
});
