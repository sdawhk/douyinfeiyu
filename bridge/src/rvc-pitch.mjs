// 整首自动变调判据（移植自技能包的 pitch-shift.py，纯 JS 实现，不 spawn Python）。
//
// 为什么不是简单的男/女声二分：RVC 只换音色、不改音高。原唱音区离模型舒适音域
// 太远时音色会发闷。判据是「中位基频离锚点有多远」，再用 p95 天花板压一次，
// 避免只盯中位数把最高的几句顶出模型音域。
//
// 本模块只做三件事：
//   1. 用 ffmpeg 把音频解成 8 kHz 单声道 f32，跑近似 YIN 的基频检测；
//   2. 计算 median / p95，并在低音歌上做一次「低八度纠错」；
//   3. 按补丁包的四步判据给出 shift（半音）。任何异常都失败关闭为 0。

import { spawn } from 'node:child_process';

export const PITCH_SAMPLE_RATE = 8000;
export const PITCH_FRAME_LENGTH = 512;
export const PITCH_HOP_LENGTH = 256;
export const PITCH_MIN_HZ = 65;
export const PITCH_OCTAVE_CHECK_HZ = 260;
export const PITCH_LOW_ZONE_HZ = 170;
export const PITCH_HIGH_ZONE_HZ = 250;

export const SINGING_PITCH_DEFAULTS = Object.freeze({
  enabled: true,
  anchorHz: 310,
  detectMaxHz: 1300,
  pitchCeilingHz: 780,
  minShiftSemitones: 4,
  maxShiftSemitones: 8,
  minVocalSeconds: 8,
  manualOverride: false
});

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 把 config.json 的 singing.singingPitch 段规整成可用参数，非法值回落到默认值。 */
export function singingPitchOptions(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const manual = source.manualOverride;
  return {
    enabled: source.enabled !== false,
    anchorHz: boundedNumber(source.anchorHz, SINGING_PITCH_DEFAULTS.anchorHz, 80, 1000),
    detectMaxHz: boundedNumber(source.detectMaxHz, SINGING_PITCH_DEFAULTS.detectMaxHz, 200, 4000),
    pitchCeilingHz: boundedNumber(source.pitchCeilingHz, SINGING_PITCH_DEFAULTS.pitchCeilingHz, 0, 4000),
    minShiftSemitones: Math.round(boundedNumber(source.minShiftSemitones, SINGING_PITCH_DEFAULTS.minShiftSemitones, 0, 12)),
    maxShiftSemitones: Math.round(boundedNumber(source.maxShiftSemitones, SINGING_PITCH_DEFAULTS.maxShiftSemitones, 1, 12)),
    minVocalSeconds: boundedNumber(source.minVocalSeconds, SINGING_PITCH_DEFAULTS.minVocalSeconds, 0, 300),
    manualOverride: manual === true
  };
}

/**
 * 自动 / 手动模式判定：
 *   - singingPitch.enabled=false、manualOverride=true、或显式 rvcPitch≠0 → 手动；
 *   - 否则自动。rvcPitch=0 是现有默认值，不能算“显式指定”，否则自动模式永远进不去。
 */
export function resolveSingingPitchPlan(settings = {}) {
  const config = singingPitchOptions(settings?.singingPitch);
  const manualPitch = Number.isInteger(settings?.rvcPitch) ? settings.rvcPitch : 0;
  const manual = config.manualOverride || !config.enabled || manualPitch !== 0;
  return { mode: manual ? 'manual' : 'auto', pitch: manual ? manualPitch : 0, config };
}

/** Python round() 是银行家舍入（.5 到偶数）；照搬，别用 Math.round 凑合。 */
export function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

function pitchZone(medianHz) {
  if (medianHz < PITCH_LOW_ZONE_HZ) return '低音区';
  if (medianHz < PITCH_HIGH_ZONE_HZ) return '中音区';
  return '高音区';
}

/**
 * 四步判据（与补丁包一致）：
 *   raw = 12*log2(anchor/median)
 *   ceiling 再压一次：semis = max(raw-3, min(raw, 12*log2(pitchCeilingHz/p95)))
 *   clamp ±maxShiftSemitones
 *   round（银行家舍入）；abs(shift) < minShiftSemitones → 0
 */
export function decidePitchShift(stats, config = {}) {
  const options = singingPitchOptions(config);
  const medianHz = Number(stats?.medianHz);
  const p95Hz = Number(stats?.p95Hz);
  const zone = medianHz > 0 ? pitchZone(medianHz) : '未测出';
  if (!(medianHz > 0)) {
    return { shift: 0, semis: 0, rawSemis: 0, ceilingSemis: null, ceilingApplied: false, zone,
      medianHz: 0, p95Hz: 0 };
  }
  const rawSemis = 12 * Math.log2(options.anchorHz / medianHz);
  let semis = rawSemis;
  let ceilingSemis = null;
  let ceilingApplied = false;
  if (options.pitchCeilingHz > 0 && p95Hz > 0) {
    ceilingSemis = 12 * Math.log2(options.pitchCeilingHz / p95Hz);
    const limited = Math.max(semis - 3, Math.min(semis, ceilingSemis));
    ceilingApplied = Math.abs(limited - semis) > 1e-9;
    semis = limited;
  }
  const clipped = Math.max(-options.maxShiftSemitones, Math.min(options.maxShiftSemitones, semis));
  const rounded = roundHalfToEven(clipped);
  const shift = Math.abs(rounded) < options.minShiftSemitones ? 0 : rounded;
  return { shift, semis: clipped, rawSemis, ceilingSemis, ceilingApplied, zone,
    medianHz, p95Hz };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = 0.95 * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function frameRms(samples, start, length) {
  let sum = 0;
  for (let index = 0; index < length; index++) {
    const value = samples[start + index];
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, length));
}

function yinFrame(samples, start, window, minLag, maxLag, sampleRate) {
  const difference = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    for (let index = 0; index < window; index++) {
      const delta = samples[start + index] - samples[start + index + tau];
      sum += delta * delta;
    }
    difference[tau] = sum;
  }
  const normalized = new Float64Array(maxLag + 1);
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    running += difference[tau];
    normalized[tau] = running > 0 ? (difference[tau] * tau) / running : 1;
  }
  let best = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (normalized[tau] < 0.15) {
      let valley = tau;
      while (valley + 1 <= maxLag && normalized[valley + 1] < normalized[valley]) valley++;
      best = valley;
      break;
    }
  }
  if (best < 0) {
    let lowest = Infinity;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (normalized[tau] < lowest) { lowest = normalized[tau]; best = tau; }
    }
    if (lowest > 0.5) return 0;
  }
  if (best <= 1 || best >= maxLag) {
    const frequency = sampleRate / best;
    return frequency >= PITCH_MIN_HZ * 0.9 && frequency <= sampleRate / 3 ? frequency : 0;
  }
  const left = normalized[best - 1];
  const middle = normalized[best];
  const right = normalized[best + 1];
  const denominator = left - 2 * middle + right;
  const offset = denominator !== 0 ? Math.max(-1, Math.min(1, (left - right) / (2 * denominator))) : 0;
  const period = best + offset;
  if (!(period > 0)) return 0;
  const frequency = sampleRate / period;
  return frequency >= PITCH_MIN_HZ * 0.9 && frequency <= sampleRate / 3 ? frequency : 0;
}

function yinStats(samples, sampleRate, { maxHz, minRms }) {
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  let maxLag = Math.min(PITCH_FRAME_LENGTH - 2, Math.ceil(sampleRate / PITCH_MIN_HZ));
  if (maxLag <= minLag) maxLag = minLag + 1;
  const window = PITCH_FRAME_LENGTH - maxLag;
  const values = [];
  let totalFrames = 0;
  for (let start = 0; start + PITCH_FRAME_LENGTH <= samples.length; start += PITCH_HOP_LENGTH) {
    totalFrames++;
    if (frameRms(samples, start, PITCH_FRAME_LENGTH) < minRms) continue;
    const frequency = yinFrame(samples, start, window, minLag, maxLag, sampleRate);
    if (frequency > 0) values.push(frequency);
  }
  if (values.length < 10) return { medianHz: 0, p95Hz: 0, voicedFrames: values.length, totalFrames };
  return { medianHz: median(values), p95Hz: percentile95(values), voicedFrames: values.length, totalFrames };
}

// 只用少量等间距窗口做单频能量估计；用于判断低八度读数是否真的更有能量。
function tonePower(samples, frequency, sampleRate) {
  if (!(frequency > 0) || !samples.length) return 0;
  const blockSize = Math.min(4096, samples.length);
  const blocks = Math.min(64, Math.max(1, Math.floor(samples.length / blockSize)));
  const frequencies = [frequency * 0.94, frequency, frequency * 1.06];
  let total = 0;
  for (let block = 0; block < blocks; block++) {
    const offset = blocks === 1 ? 0 : Math.floor((block * (samples.length - blockSize)) / (blocks - 1));
    let peak = 0;
    for (const target of frequencies) {
      const step = (2 * Math.PI * target) / sampleRate;
      const stepSin = Math.sin(step);
      const stepCos = Math.cos(step);
      let cos = 1;
      let sin = 0;
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < blockSize; index++) {
        const value = samples[offset + index];
        real += value * cos;
        imaginary += value * sin;
        const nextCos = cos * stepCos - sin * stepSin;
        sin = sin * stepCos + cos * stepSin;
        cos = nextCos;
      }
      peak = Math.max(peak, Math.hypot(real, imaginary));
    }
    total += peak;
  }
  return total / blocks;
}

/** 中位基频 + p95，带低音歌的八度纠错（高音歌不做比较，免得被按回低八度）。 */
export function analyzePitchSamples(samples, { sampleRate = PITCH_SAMPLE_RATE, config = {} } = {}) {
  const options = singingPitchOptions(config);
  const totalFrames = Math.max(0, Math.floor((samples.length - PITCH_FRAME_LENGTH) / PITCH_HOP_LENGTH) + 1);
  if (!samples.length || totalFrames <= 0) {
    return { medianHz: 0, p95Hz: 0, voicedFrames: 0, totalFrames: 0 };
  }
  const rmsValues = [];
  for (let start = 0; start + PITCH_FRAME_LENGTH <= samples.length; start += PITCH_HOP_LENGTH) {
    rmsValues.push(frameRms(samples, start, PITCH_FRAME_LENGTH));
  }
  const medianRms = median(rmsValues);
  const minRms = Math.max(1e-4, medianRms * 0.1);
  const hi = yinStats(samples, sampleRate, { maxHz: options.detectMaxHz, minRms });
  if (!(hi.medianHz > 0)) return { ...hi, totalFrames };
  if (hi.medianHz < 400) {
    const lo = yinStats(samples, sampleRate, { maxHz: PITCH_OCTAVE_CHECK_HZ, minRms });
    const ratio = lo.medianHz > 0 ? hi.medianHz / lo.medianHz : 0;
    if (ratio >= 1.75 && ratio <= 2.25) {
      const loEnergy = tonePower(samples, lo.medianHz, sampleRate);
      const hiEnergy = tonePower(samples, hi.medianHz, sampleRate);
      if (loEnergy >= 0.25 * hiEnergy) return { ...lo, totalFrames };
    }
  }
  return { ...hi, totalFrames };
}

/** 用 ffmpeg 解码成 8 kHz 单声道 f32；走 pipe，避免把整首歌落成临时 wav。 */
export function decodeAudioSamples(file, { ffmpegPath, sampleRate = PITCH_SAMPLE_RATE, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) { reject(new Error('缺少 ffmpeg，无法检测音高')); return; }
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('音高检测解码超时')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`音高检测解码失败（exit=${code}）：${stderr.trim().slice(-500)}`)); return; }
      const buffer = Buffer.concat(chunks, size);
      const samples = new Float32Array(buffer.length >> 2);
      for (let index = 0; index < samples.length; index++) samples[index] = buffer.readFloatLE(index * 4);
      resolve(samples);
    });
  });
}

const EMPTY_PITCH_INFO = Object.freeze({
  medianHz: 0, p95Hz: 0, zone: '未测出', rawSemis: 0, semis: 0,
  ceilingSemis: null, ceilingApplied: false, voicedFrames: 0, totalFrames: 0, seconds: 0
});

/**
 * 检测整首（或单段）人声的变调值。
 * 任何失败都返回 shift=0（照原样出歌），只写日志，不抛错、不中断订单。
 */
export async function detectPitchShiftFromAudio(file, { ffmpegPath, config = {}, logger = console } = {}) {
  const options = singingPitchOptions(config);
  const warn = (reason, detail = '') => {
    logger.warn?.(`[rvc-pitch] shift=0 reason=${reason}${detail ? ` ${detail}` : ''}`);
    return { shift: 0, reason, pitchInfo: { ...EMPTY_PITCH_INFO } };
  };
  try {
    const samples = await decodeAudioSamples(file, { ffmpegPath });
    const seconds = samples.length / PITCH_SAMPLE_RATE;
    const durationDetail = `seconds=${seconds.toFixed(1)}`;
    if (seconds < options.minVocalSeconds) return warn('vocal-too-short', `${durationDetail} min=${options.minVocalSeconds}`);
    const stats = analyzePitchSamples(samples, { sampleRate: PITCH_SAMPLE_RATE, config: options });
    if (!(stats.medianHz > 0) || stats.voicedFrames < 10) return warn('no-pitch', durationDetail);
    const decision = decidePitchShift(stats, options);
    const pitchInfo = {
      medianHz: Number(stats.medianHz.toFixed(1)), p95Hz: Number(stats.p95Hz.toFixed(1)),
      zone: decision.zone, rawSemis: Number(decision.rawSemis.toFixed(2)), semis: Number(decision.semis.toFixed(2)),
      ceilingSemis: decision.ceilingSemis == null ? null : Number(decision.ceilingSemis.toFixed(2)),
      ceilingApplied: decision.ceilingApplied, voicedFrames: stats.voicedFrames, totalFrames: stats.totalFrames,
      seconds: Number(seconds.toFixed(1))
    };
    logger.info?.(`[rvc-pitch] shift=${decision.shift >= 0 ? '+' : ''}${decision.shift} `
      + `median=${pitchInfo.medianHz}Hz p95=${pitchInfo.p95Hz}Hz zone=${pitchInfo.zone} `
      + `raw=${pitchInfo.rawSemis} clipped=${pitchInfo.semis} ceiling=${pitchInfo.ceilingSemis ?? 'n/a'} `
      + `ceilingApplied=${pitchInfo.ceilingApplied} voiced=${pitchInfo.voicedFrames}/${pitchInfo.totalFrames} `
      + `seconds=${pitchInfo.seconds} anchor=${options.anchorHz} max=±${options.maxShiftSemitones}`);
    return { shift: decision.shift, reason: 'ok', pitchInfo };
  } catch (error) {
    return warn('detect-error', String(error?.message ?? error).slice(0, 200));
  }
}
