import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './proxy-env.mjs';
import { resolveFfmpegPath } from './animated-image.mjs';
import { detectPitchShiftFromAudio, singingPitchOptions } from './rvc-pitch.mjs';

const exec = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RVC_ROOT = path.resolve(process.env.SINGING_RVC_DIR || path.join(APP_ROOT, 'state', 'singing-rvc'));
const SING_DIR = path.join(RVC_ROOT, 'sing');
const VENV_PYTHON = path.join(RVC_ROOT, 'venv', 'Scripts', 'python.exe');
const SITE_PACKAGES = path.join(RVC_ROOT, 'venv', 'Lib', 'site-packages');
const COVER = path.join(SING_DIR, 'cover.py');
const MODEL = path.join(SING_DIR, 'model', 'liuying.pth');
const RVC_CODE = path.join(SING_DIR, 'rvc_cli');
const FFMPEG_DEFAULT = path.join(RVC_ROOT, 'ffmpeg', 'bin', 'ffmpeg.exe');
// 复用 animated-image 的解析顺序：显式路径 → DSH_FFMPEG → state/singing-rvc 自带 ffmpeg。
const FFMPEG = resolveFfmpegPath('', { defaultPath: FFMPEG_DEFAULT }) || FFMPEG_DEFAULT;
const DEMUCS_MODEL = 'htdemucs';
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
// 整首源文件比 24 MB 单段上限大：15 分钟 192 kbps 约 21 MB，留足余量。
const MAX_SONG_BYTES = 64 * 1024 * 1024;
const MIX_SAMPLE_RATE = 44_100;
// Bump this whenever the post-RVC sound changes, so saved songs don't mask the improvement.
// clear-v5：整首自动变调 + 伴奏跟调，旧 clear-v4 缓存必须失效。
export const LIUYING_SINGING_VOCAL_PROFILE = 'clear-v5';
export const LIUYING_SINGING_VOCAL_VARIANT = pitch => `rvc:${pitch}:${LIUYING_SINGING_VOCAL_PROFILE}`;
export const SINGING_MIX_FILTER = '[0:a]highpass=f=90,lowpass=f=14000,equalizer=f=300:t=q:w=1:g=-1.5,equalizer=f=3200:t=q:w=1:g=1,volume=1.0[v];[1:a]volume=0.38[i];[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.9[out]';
const PYTHON_HOME_FILE = path.join(RVC_ROOT, 'python-home.txt');
const WORK_ROOT = path.join(RVC_ROOT, 'work');

function atempoChain(factor) {
  const parts = [];
  let value = factor;
  while (value > 2) { parts.push('atempo=2'); value /= 2; }
  while (value < 0.5) { parts.push('atempo=0.5'); value /= 0.5; }
  parts.push(`atempo=${value.toFixed(6)}`);
  return parts.join(',');
}

/** 伴奏同半音移调滤镜；shift=0 返回空串，调用方必须完全不插入任何处理。 */
export function buildTransposeFilter(shift, sampleRate = MIX_SAMPLE_RATE) {
  if (!Number.isInteger(shift) || shift === 0) return '';
  const ratio = 2 ** (shift / 12);
  return `asetrate=${(sampleRate * ratio).toFixed(2)},aresample=${sampleRate},${atempoChain(1 / ratio)}`;
}

/**
 * 混音滤镜：移调只挂在伴奏输入 [1:a] 上，放在人声 EQ 链之后、amix 之前。
 * 理由：人声链（高通/低通/EQ/limiter）保持不变，伴奏移调的重采样不会污染 RVC 人声；
 * 音量 0.38 放在移调之后，保证跟调后伴奏响度口径与改动前一致。
 * shift=0 时返回与改动前逐字符相同的字符串（回归基线）。
 */
export function buildSingingMixFilter(shift = 0, sampleRate = MIX_SAMPLE_RATE) {
  const transpose = buildTransposeFilter(shift, sampleRate);
  if (!transpose) return SINGING_MIX_FILTER;
  return SINGING_MIX_FILTER.replace('[1:a]volume=0.38[i]', `[1:a]${transpose},volume=0.38[i]`);
}

function pythonRuntimePath() {
  try { return readFileSync(PYTHON_HOME_FILE, 'utf8').trim(); } catch { return ''; }
}

function pythonExecutable() {
  const home = pythonRuntimePath();
  const runtime = home ? path.join(home, 'python.exe') : '';
  return runtime && existsSync(runtime) ? runtime : VENV_PYTHON;
}

async function run(file, args, timeout = 900_000, stage = 'command') {
  try {
    const pythonHome = pythonRuntimePath();
    // 代理端口不通时剔除代理变量：cover.py 会用 urllib 下载权重，
    // 跟着死代理走会 SSL/连接失败，导致整段翻唱做不出来。
    const baseEnv = await childEnv({ PYTHONUTF8: '1', HF_HOME: path.join(RVC_ROOT, 'cache', 'huggingface') });
    const { stdout, stderr } = await exec(file, args, {
      timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...baseEnv,
        PATH: [pythonHome, pythonHome && path.join(pythonHome, 'DLLs'), path.dirname(FFMPEG), baseEnv.PATH].filter(Boolean).join(path.delimiter),
        PYTHONPATH: [SITE_PACKAGES, baseEnv.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    });
    return `${stdout || ''}${stderr || ''}`;
  } catch (error) {
    const rawDetail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    const detail = rawDetail.split(/\r?\n/).slice(-100).join('\n').slice(-24_000);
    console.error(`[rvc] subprocess failed stage=${stage} executable=${path.basename(file)} exit=${error?.code ?? 'unknown'} signal=${error?.signal ?? 'none'} timeout=${Boolean(error?.killed)}\n${detail}`);
    const summary = detail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    throw new Error(`流萤音色处理失败 [${stage}]：${summary || error?.message || error}`);
  }
}

export async function rvcSingingStatus() {
  const required = [pythonExecutable(), COVER, MODEL, RVC_CODE, FFMPEG,
    path.join(SING_DIR, 'model', 'rvc', 'models', 'embedders', 'contentvec', 'pytorch_model.bin'),
    path.join(SING_DIR, 'model', 'rmvpe.pt')];
  const missing = [];
  for (const file of required) {
    try { await stat(file); } catch { missing.push(path.relative(RVC_ROOT, file)); }
  }
  if (missing.length) return { ready: false, missing };
  try {
    const probe = `import os,sys; os.chdir(${JSON.stringify(SING_DIR)}); sys.path.insert(0,${JSON.stringify(RVC_CODE)}); from demucs.api import Separator; from rvc_cli.rvc.infer.infer import VoiceConverter`;
    await run(pythonExecutable(), ['-c', probe], 60_000, 'runtime-probe');
    return { ready: true, root: RVC_ROOT };
  } catch (error) {
    return { ready: false, missing: [String(error.message).slice(0, 180)] };
  }
}

export function hasAudibleVocals(vocalDb, accompanimentDb) {
  return Number.isFinite(vocalDb) && vocalDb >= -38
    && (!Number.isFinite(accompanimentDb) || vocalDb >= accompanimentDb - 18);
}

async function meanVolumeDb(file) {
  const output = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], 120_000, 'measure-stem-volume');
  const value = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(output)?.[1];
  return value == null ? -Infinity : Number(value);
}

async function separateStems(normalized, work, stage = 'demucs-separation') {
  const demucsOut = path.join(work, 'demucs');
  const vocals = path.join(demucsOut, DEMUCS_MODEL, 'song', 'vocals.wav');
  const accompaniment = path.join(demucsOut, DEMUCS_MODEL, 'song', 'no_vocals.wav');
  console.info(`[rvc] stage started stage=${stage} model=${DEMUCS_MODEL} device=cpu file=${path.basename(normalized)}`);
  await run(pythonExecutable(), ['-m', 'demucs', '-n', DEMUCS_MODEL, '--two-stems=vocals', '-d', 'cpu', '-o', demucsOut, normalized], 1_800_000, stage);
  const [vocalDb, accompanimentDb] = await Promise.all([meanVolumeDb(vocals), meanVolumeDb(accompaniment)]);
  console.log(`[song-cover] stem levels vocals=${vocalDb.toFixed(1)}dB accompaniment=${accompanimentDb.toFixed(1)}dB`);
  return { vocals, accompaniment, vocalDb, accompanimentDb };
}

async function convertAndMix({ vocals, accompaniment, shift, work, tag }) {
  const converted = path.join(work, `${tag}-liuying.wav`);
  const output = path.join(work, `${tag}-liuying.mp3`);
  console.info(`[rvc] stage started stage=rvc-voice-conversion pitch=${shift} tag=${tag}`);
  await run(pythonExecutable(), [COVER, vocals, converted, String(shift), 'rmvpe'], 1_800_000, 'rvc-voice-conversion');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', converted, '-i', accompaniment,
    '-filter_complex', buildSingingMixFilter(shift),
    '-map', '[out]', '-ar', '48000', '-ac', '2', '-b:a', '192k', output], 180_000, 'mix-vocals-and-accompaniment');
  const result = await readFile(output);
  if (result.length < 1024) throw new Error('转换结果为空');
  return result;
}

/**
 * 单段翻唱：分离 → （可选）自动检测 shift → RVC → 伴奏跟调混音。
 * pitchShift 是“整首算一次”的预计算结果；传入时不再检测，保证所有分段用同一个值。
 */
export async function applyLiuyingVoiceDetailed(audio, { pitch = 0, pitchMode = 'manual',
  pitchShift = null, pitchConfig = {}, logger = console } = {}) {
  const input = Buffer.from(audio);
  if (!input.length || input.length > MAX_AUDIO_BYTES) throw new Error('歌曲为空或超过 24 MB，无法进行流萤音色转换');
  if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) throw new Error('流萤变调范围须在 -12 到 12 之间');
  if (pitchShift != null && (!Number.isInteger(pitchShift) || pitchShift < -12 || pitchShift > 12)) {
    throw new Error('流萤变调范围须在 -12 到 12 之间');
  }
  const status = await rvcSingingStatus();
  if (!status.ready) throw new Error(`流萤 RVC 环境尚未就绪：${status.missing.join('、')}`);
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'singing-rvc-'));
  let stage = 'prepare-input';
  try {
    const source = path.join(work, 'song.mp3');
    const normalized = path.join(work, 'song.wav');
    await writeFile(source, input, { flag: 'wx' });
    stage = 'normalize-input';
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '44100', '-ac', '2', normalized], 180_000, stage);
    const stems = await separateStems(normalized, work);
    const { vocals, accompaniment, vocalDb, accompanimentDb } = stems;
    if (!hasAudibleVocals(vocalDb, accompanimentDb)) {
      throw new Error('这一段几乎没有清晰人声，已停止转换；请换有人声的歌曲版本或指定其他候选');
    }
    const auto = pitchMode === 'auto';
    let shift = Number.isInteger(pitchShift) ? pitchShift : pitch;
    let pitchInfo = null;
    let pitchReason = Number.isInteger(pitchShift) ? 'precomputed' : (auto ? 'detect-error' : 'manual');
    if (!Number.isInteger(pitchShift) && auto) {
      const detected = await detectPitchShiftFromAudio(vocals, { ffmpegPath: FFMPEG,
        config: singingPitchOptions(pitchConfig), logger });
      shift = detected.shift;
      pitchInfo = detected.pitchInfo;
      pitchReason = detected.reason;
    }
    logger.info?.(`[rvc] singing pitch mode=${auto ? 'auto' : 'manual'} shift=${shift} reason=${pitchReason}`);
    stage = 'rvc-voice-conversion';
    const result = await convertAndMix({ vocals, accompaniment, shift, work, tag: 'song' });
    return { audio: result, pitchShift: shift, pitchMode: auto ? 'auto' : 'manual', pitchInfo, pitchReason };
  } catch (error) {
    console.error(`[rvc] singing conversion failed stage=${stage} inputBytes=${input.length} pitch=${pitch} mode=${pitchMode}:`, error?.stack ?? error?.message ?? error);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** 兼容旧调用：只要成品 Buffer。 */
export async function applyLiuyingVoice(audio, options = {}) {
  const result = await applyLiuyingVoiceDetailed(audio, options);
  return result.audio;
}

/**
 * 整首点歌：分离整首人声/伴奏一次，检测一次 shift，返回可逐段复用的会话。
 * 检测失败（过短/静音/异常）只会得到 shift=0，仍旧照原样出歌。
 */
export async function prepareLiuyingSongStems(audio, { pitchConfig = {}, logger = console } = {}) {
  const input = Buffer.from(audio);
  if (!input.length || input.length > MAX_SONG_BYTES) throw new Error('整首歌曲为空或超过 64 MB，无法进行流萤音色转换');
  const status = await rvcSingingStatus();
  if (!status.ready) throw new Error(`流萤 RVC 环境尚未就绪：${status.missing.join('、')}`);
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'singing-full-'));
  let stage = 'prepare-input';
  try {
    const source = path.join(work, 'song.mp3');
    const normalized = path.join(work, 'song.wav');
    await writeFile(source, input, { flag: 'wx' });
    stage = 'normalize-input';
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '44100', '-ac', '2', normalized], 300_000, stage);
    const { vocals, accompaniment, vocalDb, accompanimentDb } = await separateStems(normalized, work);
    if (!hasAudibleVocals(vocalDb, accompanimentDb)) {
      throw new Error('整首歌几乎没有清晰人声，已停止转换；请换有人声的歌曲版本或指定其他候选');
    }
    stage = 'pitch-detection';
    const detected = await detectPitchShiftFromAudio(vocals, { ffmpegPath: FFMPEG,
      config: singingPitchOptions(pitchConfig), logger });
    logger.info?.(`[rvc] whole-song pitch shift=${detected.shift} reason=${detected.reason}`);
    return {
      work, vocals, accompaniment,
      pitchShift: detected.shift, pitchInfo: detected.pitchInfo, pitchReason: detected.reason,
      close: async () => { await rm(work, { recursive: true, force: true }); }
    };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    console.error(`[rvc] whole-song stem preparation failed stage=${stage} inputBytes=${input.length}:`, error?.stack ?? error?.message ?? error);
    throw error;
  }
}

/** 从整首 stems 里切出 60 秒区间，复用同一个 shift 完成 RVC + 伴奏跟调混音。 */
export async function renderLiuyingSegmentFromStems(stems, { startSeconds, seconds, tag = 'segment', logger = console } = {}) {
  if (!stems?.vocals || !stems?.accompaniment || !stems.work) throw new Error('整首音轨尚未准备');
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(seconds) || seconds <= 0) throw new Error('分段区间无效');
  const vocalSlice = path.join(stems.work, `${tag}-vocals.wav`);
  const accompanimentSlice = path.join(stems.work, `${tag}-accompaniment.wav`);
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startSeconds), '-t', String(seconds),
    '-i', stems.vocals, '-ar', '44100', '-ac', '2', vocalSlice], 180_000, 'cut-segment-vocals');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startSeconds), '-t', String(seconds),
    '-i', stems.accompaniment, '-ar', '44100', '-ac', '2', accompanimentSlice], 180_000, 'cut-segment-accompaniment');
  const shift = Number.isInteger(stems.pitchShift) ? stems.pitchShift : 0;
  logger.info?.(`[rvc] rendering segment tag=${tag} start=${startSeconds}s seconds=${seconds}s shift=${shift}`);
  return convertAndMix({ vocals: vocalSlice, accompaniment: accompanimentSlice, shift, work: stems.work, tag });
}

export async function applyLiuyingSpeech(audio, { pitch = 0 } = {}) {
  const input = Buffer.from(audio);
  if (!input.length || input.length > 24 * 1024 * 1024) throw new Error('语音为空或超过 24 MB，无法进行流萤音色转换');
  if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) throw new Error('流萤变调范围须在 -12 到 12 之间');
  const status = await rvcSingingStatus();
  if (!status.ready) throw new Error(`流萤 RVC 环境尚未就绪：${status.missing.join('、')}`);
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'speech-rvc-'));
  let stage = 'prepare-input';
  try {
    const source = path.join(work, 'speech-input.audio');
    const normalized = path.join(work, 'speech-input.wav');
    const converted = path.join(work, 'speech-liuying.wav');
    await writeFile(source, input, { flag: 'wx' });
    stage = 'normalize-input';
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '44100', '-ac', '1', normalized], 120_000, stage);
    stage = 'rvc-speech-conversion';
    await run(pythonExecutable(), [COVER, normalized, converted, String(pitch), 'rmvpe'], 600_000, stage);
    const result = await readFile(converted);
    if (result.length < 1024) throw new Error('转换结果为空');
    return result;
  } catch (error) {
    console.error(`[rvc] speech conversion failed stage=${stage} inputBytes=${input.length} pitch=${pitch}:`, error?.stack ?? error?.message ?? error);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
