import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzePitchSamples, decidePitchShift, detectPitchShiftFromAudio,
  resolveSingingPitchPlan, roundHalfToEven } from '../src/rvc-pitch.mjs';

const FFMPEG = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../state/singing-rvc/ffmpeg/bin/ffmpeg.exe');
const SAMPLE_RATE = 8000;

function sine(frequency, seconds, sampleRate = SAMPLE_RATE, amplitude = 0.4) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return samples;
}

test('decidePitchShift leaves small adjustments untouched (under 4 semitones)', () => {
  // 310/266 ≈ 1.165 → 2.65 半音，四舍五入 3，不足 4 → 不动。
  const decision = decidePitchShift({ medianHz: 266, p95Hz: 300 });
  assert.equal(decision.shift, 0);
  assert.equal(decision.zone, '高音区');
});

test('decidePitchShift applies a mid-range shift', () => {
  // 310/220 ≈ 1.409 → 5.94 半音 → 6。
  const decision = decidePitchShift({ medianHz: 220, p95Hz: 330 });
  assert.equal(decision.shift, 6);
  assert.equal(decision.ceilingApplied, false);
});

test('decidePitchShift pulls back by at most 3 semitones when p95 ceiling triggers', () => {
  // 中位 200 Hz 需要 +7.62；p95 600 Hz 的天花板只有 +4.53，最终 = max(7.62-3, 4.53) = 4.62 → 5。
  const decision = decidePitchShift({ medianHz: 200, p95Hz: 600 });
  assert.equal(decision.shift, 5);
  assert.equal(decision.ceilingApplied, true);
});

test('decidePitchShift clamps over-limit shifts to ±8', () => {
  const high = decidePitchShift({ medianHz: 80, p95Hz: 100 });
  assert.equal(high.shift, 8);
  const low = decidePitchShift({ medianHz: 500, p95Hz: 600 });
  assert.equal(low.shift, -8);
});

test('decidePitchShift keeps patch-package boundary semantics for 3.9 and 8.1 semitones', () => {
  // 3.9 半音经银行家舍入为 4，达到下限 → 应用。
  const nearMin = 310 / 2 ** (3.9 / 12);
  assert.equal(decidePitchShift({ medianHz: nearMin, p95Hz: 330 }).shift, 4);
  // 8.1 先夹紧到 8，再舍入 → 8。
  const overMax = 310 / 2 ** (8.1 / 12);
  assert.equal(decidePitchShift({ medianHz: overMax, p95Hz: 400 }).shift, 8);
});

test('decidePitchShift rounds half to even like Python round()', () => {
  assert.equal(roundHalfToEven(3.5), 4);
  assert.equal(roundHalfToEven(2.5), 2);
  assert.equal(roundHalfToEven(-3.5), -4);
  assert.equal(roundHalfToEven(4.5), 4);
});

test('analyzePitchSamples is deterministic and detects a synthetic 220 Hz voice', () => {
  const samples = sine(220, 5);
  const first = analyzePitchSamples(samples);
  const second = analyzePitchSamples(samples);
  assert.deepEqual(first, second);
  assert.ok(Math.abs(first.medianHz - 220) < 2, `median=${first.medianHz}`);
  assert.ok(first.voicedFrames > 100);
});

test('analyzePitchSamples reports no pitch for a silent track', () => {
  const stats = analyzePitchSamples(new Float32Array(SAMPLE_RATE * 5));
  assert.equal(stats.medianHz, 0);
  assert.equal(stats.voicedFrames, 0);
});

test('resolveSingingPitchPlan keeps existing manual rvcPitch usage', () => {
  assert.deepEqual(resolveSingingPitchPlan({ rvcPitch: 0 }).mode, 'auto');
  assert.deepEqual(resolveSingingPitchPlan({ rvcPitch: 7 }), {
    mode: 'manual', pitch: 7, config: resolveSingingPitchPlan({ rvcPitch: 7 }).config
  });
  assert.equal(resolveSingingPitchPlan({ rvcPitch: 0, singingPitch: { enabled: false } }).mode, 'manual');
  assert.equal(resolveSingingPitchPlan({ rvcPitch: 3, singingPitch: { manualOverride: true } }).pitch, 3);
});

test('detectPitchShiftFromAudio fails closed on a short vocal and detects 200 Hz on a long one', async () => {
  if (!existsSync(FFMPEG)) return;
  const work = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.pitch-fixture-'));
  try {
    const short = path.join(work, 'short.wav');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=220:sample_rate=44100:duration=4', short]);
    const shortResult = await detectPitchShiftFromAudio(short, { ffmpegPath: FFMPEG, logger: { warn() {}, info() {} } });
    assert.equal(shortResult.shift, 0);
    assert.equal(shortResult.reason, 'vocal-too-short');

    const silent = path.join(work, 'silent.wav');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=mono:sample_rate=44100', '-t', '10', silent]);
    const silentResult = await detectPitchShiftFromAudio(silent, { ffmpegPath: FFMPEG, logger: { warn() {}, info() {} } });
    assert.equal(silentResult.shift, 0);
    assert.equal(silentResult.reason, 'no-pitch');

    const voice = path.join(work, 'voice.wav');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=200:sample_rate=44100:duration=10', voice]);
    const detected = await detectPitchShiftFromAudio(voice, { ffmpegPath: FFMPEG, logger: { warn() {}, info() {} } });
    assert.equal(detected.reason, 'ok');
    assert.equal(detected.shift, 8);
    assert.ok(Math.abs(detected.pitchInfo.medianHz - 200) < 3, `median=${detected.pitchInfo.medianHz}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
