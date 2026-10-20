import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'deepseek-image-library-'));
const imageRoot = path.join(root, 'images');
const stickerRoot = path.join(root, 'stickers');
const day = '2026-10-20';
const imageDir = path.join(imageRoot, day);
const imageFile = '0123456789abcdef.jpg';
const otherFile = 'fedcba9876543210.png';
mkdirSync(imageDir, { recursive: true });
mkdirSync(stickerRoot, { recursive: true });
writeFileSync(path.join(imageDir, imageFile), Buffer.from('image-fixture'));
writeFileSync(path.join(imageDir, otherFile), Buffer.from('other-fixture'));
const indexPath = path.join(stickerRoot, 'index.json');
writeFileSync(indexPath, JSON.stringify({
  old: { ref: imageFile, day, mime: 'image/jpeg', bytes: 13 },
  reserved: { ref: otherFile, day, mime: 'image/png', bytes: 13 }
}));

process.env.IMAGE_LIBRARY_PORT = '0';
process.env.IMAGE_LIBRARY_ROOT = imageRoot;
process.env.STICKER_INDEX_PATH = indexPath;
const { server } = await import(`../src/image-library-server.mjs?test=${Date.now()}`);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

try {
  const listResponse = await fetch(`${origin}/api/images`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.stats.total, 2);
  assert.deepEqual(list.items.find((item) => item.file === imageFile).tags, ['old']);

  const media = await fetch(`${origin}/media/${day}/${imageFile}`);
  assert.equal(await media.text(), 'image-fixture');

  const noOrigin = await fetch(`${origin}/api/images/${day}/${imageFile}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags: ['renamed'] })
  });
  assert.equal(noOrigin.status, 403);

  const patch = await fetch(`${origin}/api/images/${day}/${imageFile}`, {
    method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tags: ['renamed', 'favorite'] })
  });
  assert.equal(patch.status, 200);
  let index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(index.old, undefined);
  assert.equal(index.renamed.ref, imageFile);
  assert.equal(index.favorite.ref, imageFile);

  const conflict = await fetch(`${origin}/api/images/${day}/${imageFile}`, {
    method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tags: ['reserved'] })
  });
  assert.equal(conflict.status, 409);

  const del = await fetch(`${origin}/api/images/${day}/${imageFile}`, { method: 'DELETE', headers: { origin } });
  assert.equal(del.status, 200);
  assert.equal(existsSync(path.join(imageDir, imageFile)), false);
  index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(index.renamed, undefined);
  assert.equal(index.favorite, undefined);
  assert.ok(index.reserved);

  console.log('image library API: listing, preview, local-origin guard, tag edit, conflict protection, and delete passed');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
