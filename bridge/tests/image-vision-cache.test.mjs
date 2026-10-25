import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('identical image bytes reuse the previous vision result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-vision-cache-'));
  process.env.IMAGE_VISION_CACHE_PATH = join(dir, 'cache.json');
  process.env.VISION_MODEL_COOLDOWN_PATH = join(dir, 'cooldowns.json');
  try {
    const { inspectCachedImage } = await import('../src/image-vision-cache.mjs');
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { ok: true, json: async () => ({ model: 'test/vision', choices: [
        { message: { content: '{"sticker":true,"caption":"小鲸鱼挥手","confidence":0.9}' } }
      ] }) };
    };
    const b64 = Buffer.from('same image bytes').toString('base64');
    const options = { models: ['test/vision'], fetcher };
    const first = await inspectCachedImage(b64, 'image/png', options);
    const second = await inspectCachedImage(b64, 'image/png', options);
    assert.equal(calls, 1);
    assert.equal(first.caption, second.caption);
    assert.equal(second.cacheHit, true);
    assert.equal(Object.keys(JSON.parse(readFileSync(process.env.IMAGE_VISION_CACHE_PATH, 'utf8'))).length, 1);
  } finally {
    delete process.env.IMAGE_VISION_CACHE_PATH;
    delete process.env.VISION_MODEL_COOLDOWN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
