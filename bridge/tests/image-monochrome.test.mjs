import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureMonochrome } from '../src/image-monochrome.mjs';
import { resolveFfmpegPath } from '../src/animated-image.mjs';
import { decodePng } from '../src/image-composition.mjs';

// 两个颜色不同的像素，确保转换保留明度区别且输出是真正的单通道灰阶。
const colored = Buffer.concat([Buffer.from('P6\n2 1\n255\n'), Buffer.from([255, 100, 100, 20, 60, 220])]);
test('黑白最终输出消除颜色残留并保留明度层次', { skip: !resolveFfmpegPath() }, async () => {
  const result = await ensureMonochrome(colored);
  assert.equal(result.mime, 'image/png');
  const image = decodePng(result.buffer);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.equal(image.channels, 1);
  assert.notEqual(image.data[0], image.data[1]);
});
test('灰阶处理不可用或超出体积上限时明确失败', async () => {
  await assert.rejects(ensureMonochrome(colored, { ffmpegPath: 'Z:/missing-ffmpeg.exe' }), /无法启动/);
  if (resolveFfmpegPath()) await assert.rejects(ensureMonochrome(colored, { maxOutputBytes: 1 }), /体积上限/);
});
