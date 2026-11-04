// 动态表情包预处理：字节级判型 + ffmpeg 均匀抽帧 + 2×2 网格拼图。
//
// 视觉模型直接吃 GIF/APNG/动态 WebP 会报 400（项目内 dsh-imgctx 已有实证），
// 因此这里把动图压成一张 JPEG 网格图，再交回现有视觉链路。静态图完全不经过本模块。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const DEFAULT_FFMPEG_PATH = path.join(APP_ROOT, 'state', 'singing-rvc', 'ffmpeg', 'bin', 'ffmpeg.exe');
// ffmpeg 子进程在某些受限环境下无法写入系统临时目录，默认放到项目 state 下。
const DEFAULT_WORK_DIR = path.join(APP_ROOT, 'state', 'image-animation-work');

export const IMAGE_ANIMATION_DEFAULTS = Object.freeze({
  enabled: true,
  frames: 4,
  sampleFps: 4,
  maxFrames: 48,
  cellSize: 384,
  jpegQuality: 82,
  maxInputBytes: 12 * 1024 * 1024,
  maxOutputBytes: 512 * 1024,
  ffmpegTimeoutMs: 8_000,
  turnTimeoutMs: 30_000,
  concurrency: 2,
  ffmpegPath: ''
});

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 把 config.json 的 imageAnimation 段规整成可用参数，非法值回落到默认值。 */
export function imageAnimationOptions(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    enabled: source.enabled !== false,
    frames: boundedNumber(source.frames, IMAGE_ANIMATION_DEFAULTS.frames, 2, 4),
    sampleFps: boundedNumber(source.sampleFps, IMAGE_ANIMATION_DEFAULTS.sampleFps, 1, 30),
    maxFrames: boundedNumber(source.maxFrames, IMAGE_ANIMATION_DEFAULTS.maxFrames, 4, 240),
    cellSize: boundedNumber(source.cellSize, IMAGE_ANIMATION_DEFAULTS.cellSize, 128, 1024),
    jpegQuality: boundedNumber(source.jpegQuality, IMAGE_ANIMATION_DEFAULTS.jpegQuality, 30, 95),
    maxInputBytes: boundedNumber(source.maxInputBytes, IMAGE_ANIMATION_DEFAULTS.maxInputBytes, 1 << 20, 64 << 20),
    maxOutputBytes: boundedNumber(source.maxOutputBytes, IMAGE_ANIMATION_DEFAULTS.maxOutputBytes, 64 << 10, 8 << 20),
    ffmpegTimeoutMs: boundedNumber(source.ffmpegTimeoutMs, IMAGE_ANIMATION_DEFAULTS.ffmpegTimeoutMs, 1_000, 60_000),
    turnTimeoutMs: boundedNumber(source.turnTimeoutMs, IMAGE_ANIMATION_DEFAULTS.turnTimeoutMs, 5_000, 120_000),
    concurrency: boundedNumber(source.concurrency, IMAGE_ANIMATION_DEFAULTS.concurrency, 1, 8),
    ffmpegPath: String(source.ffmpegPath || '')
  };
}

/**
 * ffmpeg 路径优先级：显式配置 → DSH_FFMPEG → 现有 state/singing-rvc 路径。
 * 全部不存在时返回 null，调用方静默降级，不影响文本聊天与静态图。
 */
export function resolveFfmpegPath(explicitPath = '', { fallback = true, envPath = process.env.DSH_FFMPEG, defaultPath = DEFAULT_FFMPEG_PATH } = {}) {
  const explicit = String(explicitPath || '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (!fallback) return null;
  const fromEnv = String(envPath || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (defaultPath && existsSync(defaultPath)) return defaultPath;
  return null;
}

/** 启动时检查一次；不可用时只打日志，不阻塞任何链路。 */
export function imageAnimationStatus(config = {}) {
  const opts = imageAnimationOptions(config);
  const ffmpeg = resolveFfmpegPath(opts.ffmpegPath);
  return { available: Boolean(ffmpeg), ffmpeg, options: opts };
}

/**
 * 字节级判型，不解码图片。
 * 只返回 gif / apng / webp；静态图返回 null。
 */
export function detectAnimatedFormat(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (bytes.length < 12) return null;
  const ascii = (start, end) => bytes.toString('ascii', start, end);

  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    let gceCount = 0;
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) gceCount++;
    }
    if (gceCount >= 2 || bytes.includes(Buffer.from('NETSCAPE2.0'))) return 'gif';
    return null;
  }

  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return bytes.includes(Buffer.from('acTL')) ? 'apng' : null;
  }

  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const hasAnimationChunk = bytes.includes(Buffer.from('ANMF'));
    const vp8xOffset = bytes.indexOf(Buffer.from('VP8X'));
    const animationFlag = vp8xOffset >= 0 && bytes.length > vp8xOffset + 8
      ? (bytes[vp8xOffset + 8] & 0x02) === 0x02 : false;
    return hasAnimationChunk || animationFlag ? 'webp' : null;
  }

  return null;
}

function frameLayout(count) {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count === 3) return { columns: 3, rows: 1 };
  return { columns: 2, rows: 2 };
}

function pickEvenly(files, count) {
  if (files.length <= count) return files.slice();
  return Array.from({ length: count }, (_, index) =>
    files[Math.round(index * (files.length - 1) / (count - 1))]);
}

async function runFfmpeg(ffmpeg, args, timeout) {
  await exec(ffmpeg, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

function jpegQualityScale(quality) {
  return Math.max(2, Math.min(31, Math.round((100 - quality) / 3)));
}

async function buildGrid(ffmpeg, frames, layout, target, opts) {
  if (frames.length === 1) {
    await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', frames[0],
      '-q:v', String(jpegQualityScale(opts.jpegQuality)), target], opts.ffmpegTimeoutMs);
    return;
  }

  const inputs = frames.flatMap((frame) => ['-i', frame]);
  const labels = frames.map((_, index) => `[${index}:v]`);
  let filter;
  if (layout.rows === 1) {
    filter = `${labels.join('')}hstack=inputs=${frames.length}[out]`;
  } else {
    filter = `${labels[0]}${labels[1]}hstack=inputs=2[top];`
      + `${labels[2]}${labels[3]}hstack=inputs=2[bottom];`
      + '[top][bottom]vstack=inputs=2[out]';
  }

  const baseQuality = jpegQualityScale(opts.jpegQuality);
  for (const quality of [baseQuality, baseQuality + 4, baseQuality + 8]) {
    await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-filter_complex', filter, '-map', '[out]',
      '-q:v', String(Math.min(31, quality)), target], opts.ffmpegTimeoutMs);
    const size = (await stat(target)).size;
    if (size <= opts.maxOutputBytes || quality >= baseQuality + 8) return size;
  }
  return null;
}

let activeJobs = 0;
const waitingJobs = [];
async function withSlot(limit, task) {
  if (activeJobs >= limit) await new Promise((resolve) => waitingJobs.push(resolve));
  activeJobs++;
  try {
    return await task();
  } finally {
    activeJobs--;
    const next = waitingJobs.shift();
    if (next) next();
  }
}

/**
 * 把动图字节转成一张 JPEG 网格图。
 * 失败（判型非动图 / 无 ffmpeg / 超时 / 超限）一律返回 null，由调用方降级。
 */
export async function prepareAnimatedImage(value, config = {}) {
  const opts = imageAnimationOptions(config);
  if (!opts.enabled) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  const format = config.format || detectAnimatedFormat(bytes);
  if (!format) return null;
  if (!bytes.length || bytes.length > opts.maxInputBytes) return null;

  const ffmpeg = resolveFfmpegPath(opts.ffmpegPath, { fallback: config.allowPathFallback !== false });
  if (!ffmpeg) return null;

  return withSlot(opts.concurrency, async () => {
    const roots = [config.workDir, process.env.IMAGE_ANIMATION_WORK_DIR, DEFAULT_WORK_DIR, tmpdir()]
      .map((value) => String(value || '').trim()).filter(Boolean);
    let work = null;
    for (const root of roots) {
      try {
        await mkdir(root, { recursive: true });
        work = await mkdtemp(path.join(root, 'qq-anim-'));
        break;
      } catch { /* 换下一个可写目录 */ }
    }
    if (!work) return null;
    try {
      const extension = format === 'apng' ? 'png' : format;
      const input = path.join(work, `input.${extension}`);
      const framesDir = path.join(work, 'frames');
      const target = path.join(work, 'grid.jpg');
      await writeFile(input, bytes, { flag: 'wx' });
      await mkdir(framesDir);

      const size = opts.cellSize;
      const scaleFilter = [
        `fps=${opts.sampleFps}`,
        `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white`
      ].join(',');
      await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-fps_mode', 'passthrough', '-vf', scaleFilter, '-frames:v', String(opts.maxFrames),
        '-q:v', '3', path.join(framesDir, 'f_%03d.jpg')], opts.ffmpegTimeoutMs);

      const files = (await readdir(framesDir))
        .filter((name) => /^f_\d{3}\.jpg$/.test(name))
        .sort();
      if (!files.length) return null;

      const picked = pickEvenly(files, opts.frames);
      const layout = frameLayout(picked.length);
      const outputBytes = await buildGrid(ffmpeg, picked.map((name) => path.join(framesDir, name)),
        layout, target, opts);
      if (!outputBytes || outputBytes > opts.maxOutputBytes) return null;

      const output = await readFile(target);
      if (!output.length || output.length > opts.maxOutputBytes) return null;
      return {
        ok: true,
        b64: output.toString('base64'),
        mime: 'image/jpeg',
        format,
        frameCount: picked.length,
        width: layout.columns * size,
        height: layout.rows * size,
        bytes: output.length
      };
    } catch {
      return null;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
}
