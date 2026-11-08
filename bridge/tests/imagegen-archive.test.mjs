import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDeliveredImage, createArchivePusher, monthKey } from '../src/imagegen-archive.mjs';

function fixture({ delivered = true, bytes = 8, createdAt = '2026-11-08T05:49:50.318Z' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'image-archive-'));
  const sourceDir = join(root, 'state');
  mkdirSync(sourceDir, { recursive: true });
  const imagePath = join(sourceDir, 'gen-1.png');
  writeFileSync(imagePath, Buffer.alloc(bytes));
  const meta = {
    file: 'gen-1.png',
    path: imagePath,
    prompt: '【固定人物】…；【画面内容，只描述动作、场景与光线】窗边看书，轻轻微笑；【严格禁止】糊',
    description: '窗边看书 | 轻轻微笑',
    model: 'qwen-image-3.0',
    vibe: 'youth',
    hairstyle: 'side_braid',
    outfit: 'dress',
    moderation: { appropriate: true, confidence: 0.98 },
    createdAt,
    ...(delivered ? { delivery: { target: 'private:1', messageId: '42', at: 1 } } : {})
  };
  const metaPath = join(sourceDir, 'gen-1.json');
  writeFileSync(metaPath, JSON.stringify(meta));
  return { root, repoDir: join(root, 'diary'), subdir: 'images', metaPath, imagePath };
}

test('归档：已投递的图连同 meta 进按月目录并生成索引', () => {
  const { root, repoDir, subdir, metaPath } = fixture();
  try {
    const result = archiveDeliveredImage({ metaPath, repoDir, subdir, now: Date.parse('2026-11-08T06:00:00Z') });
    assert.equal(result.ok, true);
    assert.equal(result.month, '2026-11');
    assert.equal(result.image, 'images/2026-11/gen-1.png');
    assert.equal(result.meta, 'images/2026-11/gen-1.json');
    assert.ok(existsSync(join(repoDir, 'images/2026-11/gen-1.png')));
    assert.ok(existsSync(join(repoDir, 'images/2026-11/gen-1.json')));
    const index = readFileSync(join(repoDir, 'images/2026-11/index.md'), 'utf8');
    assert.match(index, /# 2026-11 出图归档/);
    assert.match(index, /gen-1\.png/);
    assert.match(index, /窗边看书/);
    assert.match(index, /qwen-image-3\.0 \/ youth \/ side_braid \/ dress/);
    assert.match(index, /通过 0\.98/);
    assert.match(index, /窗边看书 \/ 轻轻微笑/, '描述里的竖线要转义');
    // 原 meta 回写归档标记，便于幂等。
    assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).archive.image, undefined);
    assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).archive.file, 'images/2026-11/gen-1.png');
    // 重复归档不重复复制，也不重复写索引行。
    const again = archiveDeliveredImage({ metaPath, repoDir, subdir });
    assert.equal(again.skipped, true);
    assert.equal(again.reason, 'already-archived');
    const rows = readFileSync(join(repoDir, 'images/2026-11/index.md'), 'utf8').split('\n').filter((line) => line.includes('gen-1.png'));
    assert.equal(rows.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('归档：未投递、超大、缺图都不进仓库', () => {
  const notDelivered = fixture({ delivered: false });
  try {
    const result = archiveDeliveredImage({ metaPath: notDelivered.metaPath, repoDir: notDelivered.repoDir });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not-delivered');
    assert.equal(existsSync(join(notDelivered.repoDir, 'images')), false);
  } finally {
    rmSync(notDelivered.root, { recursive: true, force: true });
  }

  const tooLarge = fixture({ bytes: 32 });
  try {
    const result = archiveDeliveredImage({ metaPath: tooLarge.metaPath, repoDir: tooLarge.repoDir, maxBytes: 16 });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'too-large');
    assert.equal(existsSync(join(tooLarge.repoDir, 'images')), false);
  } finally {
    rmSync(tooLarge.root, { recursive: true, force: true });
  }
});

test('归档推送：复用日记推送参数，防抖合并并失败重试', async () => {
  const pushes = [];
  const timers = [];
  const pusher = createArchivePusher({
    repoDir: 'D:/deepseek/diary',
    subdir: 'images',
    debounceMs: 120_000,
    retryMs: 600_000,
    maxAttempts: 3,
    log: () => {},
    now: () => Date.parse('2026-11-08T06:00:00Z'),
    push: async (options) => {
      pushes.push(options);
      return pushes.length === 1
        ? { ok: false, reason: 'push-failed', detail: 'proxy refused' }
        : { ok: true, reason: 'pushed', viaBypass: true };
    },
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; },
    clearTimer: () => {}
  });

  pusher.schedule();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 120_000);

  await timers[0].fn();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].dir, 'D:/deepseek/diary');
  assert.deepEqual(pushes[0].paths, ['images']);
  assert.equal(pushes[0].commitMessage, 'images: 2026-11');
  // 第一次失败后安排 10 分钟重试。
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 600_000);

  await timers[1].fn();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].commitMessage, 'images: 2026-11');
  assert.equal(monthKey(Date.parse('2026-11-08T06:00:00Z')), '2026-11');
});

test('归档推送：未配置仓库时不排期也不推送', async () => {
  let pushed = 0;
  const pusher = createArchivePusher({
    repoDir: '',
    push: async () => { pushed += 1; return { ok: true }; },
    setTimer: () => ({ unref() {} })
  });
  pusher.schedule();
  const result = await pusher.runPush();
  assert.equal(result.ok, false);
  assert.equal(pushed, 0);
});
