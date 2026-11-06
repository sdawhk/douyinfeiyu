import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('image trash enforces safety checks, moves files, detaches aliases and empties', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'image-trash-'));
  const imageRoot = join(root, 'images');
  const trashRoot = join(root, 'trash');
  const stickerIndex = join(root, 'stickers.json');
  const outside = join(root, 'outside.png');
  const day = '2026-10-22';
  const file = '0123456789abcdef.png';
  const spare = 'bbbbbbbbbbbbbbbb.jpg';
  mkdirSync(join(imageRoot, day), { recursive: true });
  writeFileSync(join(imageRoot, day, file), Buffer.from('fake image'));
  writeFileSync(join(imageRoot, day, spare), Buffer.from('second image'));
  writeFileSync(outside, Buffer.from('outside image'));
  writeFileSync(stickerIndex, JSON.stringify({
    开心: { ref: file, day, status: 'pending' },
    高兴: { ref: file, day, status: 'pending' }
  }));
  process.env.IMAGE_LIBRARY_ROOT = imageRoot;
  process.env.STICKER_INDEX_PATH = stickerIndex;
  process.env.IMAGE_TRASH_ROOT = trashRoot;
  const { server } = await import('../src/image-library-server.mjs');

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, origin = baseUrl) => fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });

    const missingConfirm = await post('/api/images/trash', { items: [{ day, file }] });
    assert.equal(missingConfirm.status, 400);

    const traversal = await post('/api/images/trash', { confirm: true, items: [{ day, file: '../../outside.png' }] });
    assert.equal(traversal.status, 400);

    const absolute = await post('/api/images/trash', { confirm: true, items: [{ day: imageRoot, file }] });
    assert.equal(absolute.status, 400);

    const overLimit = await post('/api/images/trash', {
      confirm: true, items: Array.from({ length: 201 }, () => ({ day, file }))
    });
    assert.equal(overLimit.status, 400);

    const denied = await post('/api/images/trash', { confirm: true, items: [{ day, file }] }, 'http://example.com');
    assert.equal(denied.status, 403);
    assert.ok(existsSync(join(imageRoot, day, file)), '被拒绝的请求不能移动文件');

    let linked = false;
    try {
      symlinkSync(outside, join(imageRoot, day, 'cccccccccccccccc.png'), 'file');
      linked = true;
    } catch {
      t.diagnostic('当前环境无法创建符号链接，跳过符号链接校验');
    }
    if (linked) {
      const symlinked = await post('/api/images/trash', { confirm: true, items: [{ day, file: 'cccccccccccccccc.png' }] });
      assert.equal(symlinked.status, 400);
      assert.ok(existsSync(outside), '符号链接目标不能被删除');
    }

    const trashed = await post('/api/images/trash', { confirm: true, items: [{ day, file }] });
    assert.equal(trashed.status, 200);
    const moved = await trashed.json();
    assert.equal(moved.trashed, 1);
    assert.equal(moved.removedAliases, 2);
    assert.ok(moved.bytes > 0);
    assert.ok(!existsSync(join(imageRoot, day, file)), '原图应已移出图片库');
    assert.ok(existsSync(join(imageRoot, day, spare)), '未选中的图片不能受影响');
    const manifest = JSON.parse(readFileSync(moved.manifestPath, 'utf8'));
    assert.equal(manifest.items.length, 1);
    assert.equal(manifest.items[0].originalPath, join(imageRoot, day, file));
    assert.equal(manifest.items[0].trashPath, join(trashRoot, moved.batch, 'files', day, file));
    assert.deepEqual(manifest.items[0].aliases, ['开心', '高兴']);
    assert.ok(existsSync(manifest.items[0].trashPath), '清单里的回收路径必须真实存在');
    const index = JSON.parse(readFileSync(stickerIndex, 'utf8'));
    assert.deepEqual(index, {});

    const usage = await (await fetch(`${baseUrl}/api/images/trash`)).json();
    assert.equal(usage.files, 1);
    assert.ok(usage.bytes > 0);

    const emptyWithoutFlag = await post('/api/images/trash/empty', { confirm: true });
    assert.equal(emptyWithoutFlag.status, 400);
    assert.ok(existsSync(join(trashRoot, moved.batch, 'files', day, file)), '确认不完整时不能删除回收文件');

    const emptied = await post('/api/images/trash/empty', { confirm: true, confirmEmpty: true });
    assert.equal(emptied.status, 200);
    const emptiedBody = await emptied.json();
    assert.equal(emptiedBody.files, 1);
    assert.ok(emptiedBody.freedBytes > 0);
    assert.ok(!existsSync(join(trashRoot, moved.batch)), '回收批次目录应被清除');

    const usageAfter = await (await fetch(`${baseUrl}/api/images/trash`)).json();
    assert.equal(usageAfter.files, 0);
    assert.equal(usageAfter.bytes, 0);

    const audit = readFileSync(join(trashRoot, 'audit.log'), 'utf8');
    assert.match(audit, /"action":"trash"/);
    assert.match(audit, /"action":"empty-trash"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.IMAGE_LIBRARY_ROOT;
    delete process.env.STICKER_INDEX_PATH;
    delete process.env.IMAGE_TRASH_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});
