import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from './proxy-env.mjs';

const exec = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RVC_ROOT = path.resolve(process.env.SINGING_RVC_DIR || path.join(APP_ROOT, 'state', 'singing-rvc'));
const SING_DIR = path.join(RVC_ROOT, 'sing');
const VENV_PYTHON = path.join(RVC_ROOT, 'venv', 'Scripts', 'python.exe');
const SITE_PACKAGES = path.join(RVC_ROOT, 'venv', 'Lib', 'site-packages');
const COVER = path.join(SING_DIR, 'cover.py');
const MODEL = path.join(SING_DIR, 'model', 'liuying.pth');
const RVC_CODE = path.join(SING_DIR, 'rvc_cli');
const FFMPEG = path.join(RVC_ROOT, 'ffmpeg', 'bin', 'ffmpeg.exe');
const DEMUCS_MODEL = 'htdemucs';
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
// Bump this whenever the post-RVC sound changes, so saved songs don't mask the improvement.
export const LIUYING_SINGING_VOCAL_PROFILE = 'clear-v4';
export const LIUYING_SINGING_VOCAL_VARIANT = pitch => `rvc:${pitch}:${LIUYING_SINGING_VOCAL_PROFILE}`;
const SINGING_MIX_FILTER = '[0:a]highpass=f=90,lowpass=f=14000,equalizer=f=300:t=q:w=1:g=-1.5,equalizer=f=3200:t=q:w=1:g=1,volume=1.0[v];[1:a]volume=0.38[i];[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.9[out]';
const PYTHON_HOME_FILE = path.join(RVC_ROOT, 'python-home.txt');
const WORK_ROOT = path.join(RVC_ROOT, 'work');

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

export async function applyLiuyingVoice(audio, { pitch = 0 } = {}) {
  const input = Buffer.from(audio);
  if (!input.length || input.length > MAX_AUDIO_BYTES) throw new Error('歌曲为空或超过 24 MB，无法进行流萤音色转换');
  if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) throw new Error('流萤变调范围须在 -12 到 12 之间');
  const status = await rvcSingingStatus();
  if (!status.ready) throw new Error(`流萤 RVC 环境尚未就绪：${status.missing.join('、')}`);
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'singing-rvc-'));
  let stage = 'prepare-input';
  try {
    const source = path.join(work, 'song.mp3');
    const normalized = path.join(work, 'song.wav');
    const demucsOut = path.join(work, 'demucs');
    const vocals = path.join(demucsOut, DEMUCS_MODEL, 'song', 'vocals.wav');
    const accompaniment = path.join(demucsOut, DEMUCS_MODEL, 'song', 'no_vocals.wav');
    const converted = path.join(work, 'vocals-liuying.wav');
    const output = path.join(work, 'song-liuying.mp3');
    await writeFile(source, input, { flag: 'wx' });
    const python = pythonExecutable();
    stage = 'normalize-input';
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '44100', '-ac', '2', normalized], 180_000, stage);
    stage = 'demucs-separation';
    console.info(`[rvc] stage started stage=${stage} model=${DEMUCS_MODEL} device=cpu inputBytes=${input.length}`);
    await run(python, ['-m', 'demucs', '-n', DEMUCS_MODEL, '--two-stems=vocals', '-d', 'cpu', '-o', demucsOut, normalized], 1_800_000, stage);
    const [vocalDb, accompanimentDb] = await Promise.all([meanVolumeDb(vocals), meanVolumeDb(accompaniment)]);
    console.log(`[song-cover] stem levels vocals=${vocalDb.toFixed(1)}dB accompaniment=${accompanimentDb.toFixed(1)}dB`);
    if (!hasAudibleVocals(vocalDb, accompanimentDb)) {
      throw new Error('这一段几乎没有清晰人声，已停止转换；请换有人声的歌曲版本或指定其他候选');
    }
    stage = 'rvc-voice-conversion';
    console.info(`[rvc] stage started stage=${stage} pitch=${pitch}`);
    await run(python, [COVER, vocals, converted, String(pitch), 'rmvpe'], 1_800_000, stage);
    stage = 'mix-vocals-and-accompaniment';
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', converted, '-i', accompaniment,
      '-filter_complex', SINGING_MIX_FILTER,
      '-map', '[out]', '-ar', '48000', '-ac', '2', '-b:a', '192k', output], 180_000, stage);
    const result = await readFile(output);
    if (result.length < 1024) throw new Error('转换结果为空');
    return result;
  } catch (error) {
    console.error(`[rvc] singing conversion failed stage=${stage} inputBytes=${input.length} pitch=${pitch}:`, error?.stack ?? error?.message ?? error);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
