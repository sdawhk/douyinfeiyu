import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('bulk review updates every alias and requires local origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-bulk-review-'));
  const imageRoot = join(root, 'images');
  const stickerIndex = join(root, 'stickers.json');
  const day = '2026-10-22';
  const file = '0123456789abcdef.png';
  mkdirSync(join(imageRoot, day), { recursive: true });
  writeFileSync(join(imageRoot, day, file), Buffer.from('fake image'));
  writeFileSync(stickerIndex, JSON.stringify({
    开心: { ref: file, day, status: 'pending' },
    高兴: { ref: file, day, status: 'pending' }
  }));
  process.env.IMAGE_LIBRARY_ROOT = imageRoot;
  process.env.STICKER_INDEX_PATH = stickerIndex;
  const { server } = await import('../src/image-library-server.mjs');

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const body = JSON.stringify({ status: 'rejected', items: [{ day, file }] });
    const denied = await fetch(`${baseUrl}/api/images/bulk-review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    assert.equal(denied.status, 403);

    const response = await fetch(`${baseUrl}/api/images/bulk-review`, {
      method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, updated: 1, aliasesUpdated: 2, status: 'rejected' });
    const index = JSON.parse(readFileSync(stickerIndex, 'utf8'));
    assert.equal(index['开心'].status, 'rejected');
    assert.equal(index['高兴'].status, 'rejected');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.IMAGE_LIBRARY_ROOT;
    delete process.env.STICKER_INDEX_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});
