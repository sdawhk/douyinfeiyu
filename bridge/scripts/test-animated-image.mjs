// 离线验证动态表情包预处理：判型、抽帧、网格尺寸与降级。
// 运行：node scripts/test-animated-image.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_ANIMATION_DEFAULTS,
  detectAnimatedFormat,
  imageAnimationStatus,
  prepareAnimatedImage,
  resolveFfmpegPath
} from '../src/animated-image.mjs';
import { ANIMATED_FALLBACK_DESCRIPTION, hasUsableImageDescription, resolveImageDescription } from '../src/recent-image-context.mjs';

const exec = promisify(execFile);
const ffmpeg = resolveFfmpegPath('');
const WORK_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');

async function run(args, timeout = 60_000) {
  await exec(ffmpeg, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG SOF marker not found');
}

async function makeFixtures(dir) {
  const source = ['-f', 'lavfi', '-i', 'testsrc2=size=160x160:rate=10:duration=2'];
  const gif = path.join(dir, 'animated.gif');
  const png = path.join(dir, 'static.png');
  const webp = path.join(dir, 'animated.webp');
  const apng = path.join(dir, 'animated.apng');

  await run(['-hide_banner', '-loglevel', 'error', '-y', ...source, '-vf', 'format=rgb24', '-loop', '0', gif]);
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3366cc:size=160x160',
    '-frames:v', '1', png]);
  await run(['-hide_banner', '-loglevel', 'error', '-y', ...source, '-c:v', 'libwebp_anim', '-loop', '0',
    '-q:v', '80', webp]);
  await run(['-hide_banner', '-loglevel', 'error', '-y', ...source, '-plays', '0', '-f', 'apng', apng]);
  return { gif, png, webp, apng };
}

async function main() {
  const status = imageAnimationStatus({});
  console.log(`[test] ffmpeg=${status.available ? status.ffmpeg : 'missing'}`);
  assert.equal(status.available, true, 'ffmpeg 不可用，无法验证动图链路');
  assert.equal(resolveFfmpegPath('Z:\\definitely-missing\\ffmpeg.exe', { fallback: false }), null,
    '显式缺失路径且禁止回退时应返回 null');

  await mkdir(WORK_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(WORK_ROOT, 'test-animated-image-'));
  try {
    const files = await makeFixtures(dir);
    const bytes = {};
    for (const [name, file] of Object.entries(files)) {
      bytes[name] = await readFile(file);
      const info = await stat(file);
      console.log(`[fixture] ${name} ${info.size} bytes`);
    }

    assert.equal(detectAnimatedFormat(bytes.gif), 'gif');
    assert.equal(detectAnimatedFormat(bytes.png), null);
    assert.equal(detectAnimatedFormat(bytes.webp), 'webp');
    assert.equal(detectAnimatedFormat(bytes.apng), 'apng');
    console.log('[test] 判型通过：gif / static png=null / webp / apng');

    for (const name of ['gif', 'webp', 'apng']) {
      const result = await prepareAnimatedImage(bytes[name], {
        ...IMAGE_ANIMATION_DEFAULTS,
        ffmpegPath: ffmpeg,
        format: detectAnimatedFormat(bytes[name])
      });
      assert.ok(result, `${name} 预处理失败`);
      assert.equal(result.frameCount, 4, `${name} 选中帧数应为 4`);
      assert.deepEqual({ width: result.width, height: result.height }, { width: 768, height: 768 },
        `${name} 网格应为 768×768`);
      assert.ok(result.bytes <= IMAGE_ANIMATION_DEFAULTS.maxOutputBytes,
        `${name} 输出 ${result.bytes}B 超过 512KB`);
      const image = Buffer.from(result.b64, 'base64');
      assert.equal(jpegSize(image).width, 768);
      assert.equal(jpegSize(image).height, 768);
      console.log(`[test] ${name} frames=${result.frameCount} grid=${result.width}x${result.height} bytes=${result.bytes}`);
    }

    const unavailable = await prepareAnimatedImage(bytes.gif, {
      ...IMAGE_ANIMATION_DEFAULTS,
      ffmpegPath: 'Z:\\definitely-missing\\ffmpeg.exe',
      allowPathFallback: false,
      format: 'gif'
    });
    assert.equal(unavailable, null, 'ffmpeg 不可用时应返回 null 以触发降级');
    console.log('[test] ffmpeg 不可用 → prepareAnimatedImage 返回 null（最终降级）');

    for (const placeholder of ['[动画表情]', '[表情]', '[动图]', '']) {
      assert.equal(hasUsableImageDescription(placeholder), false, `${placeholder || '(空)'} 不应被视为可用描述`);
    }
    assert.equal(hasUsableImageDescription(ANIMATED_FALLBACK_DESCRIPTION), true);
    assert.ok(ANIMATED_FALLBACK_DESCRIPTION.trim().length > 0);
    console.log(`[test] 视觉失败兜底："${ANIMATED_FALLBACK_DESCRIPTION}"，占位符不会进入主模型`);

    // 视觉失败时的最终决策：动图必须给出非空描述，静态图保持原有“识别不了”流程。
    assert.equal(resolveImageDescription({ summary: '[动画表情]', animatedFallback: true }),
      ANIMATED_FALLBACK_DESCRIPTION, '动图识别失败应落到兜底描述');
    assert.equal(resolveImageDescription({ summary: '[动画表情]', animatedFallback: false }),
      '', '静态图识别失败仍返回空串');
    assert.equal(resolveImageDescription({ caption: '一只猫在跳舞', summary: '[动画表情]', animatedFallback: true }),
      '一只猫在跳舞', '有真实 caption 时不应被兜底覆盖');
    assert.equal(hasUsableImageDescription(resolveImageDescription({
      summary: '[动画表情]', animatedFallback: true
    })), true, '兜底描述必须通过可用性检查，不能产生空 caption');
    console.log('[test] 降级决策通过：动图非空兜底 / 静态图空串 / 真实 caption 优先');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('[test] all assertions passed');
}

main().catch((error) => {
  console.error('[test] FAILED:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
