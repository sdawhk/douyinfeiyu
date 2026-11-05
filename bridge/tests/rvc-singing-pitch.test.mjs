import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSingingMixFilter, buildTransposeFilter, SINGING_MIX_FILTER } from '../src/rvc-singing.mjs';
import { analyzePitchSamples, decodeAudioSamples } from '../src/rvc-pitch.mjs';

const FFMPEG = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../state/singing-rvc/ffmpeg/bin/ffmpeg.exe');
const SAMPLE_RATE = 8000;

test('shift=0 keeps the mix filter byte-for-byte identical to the pre-change baseline', () => {
  assert.equal(buildSingingMixFilter(0), SINGING_MIX_FILTER);
  assert.equal(buildSingingMixFilter(-0), SINGING_MIX_FILTER);
  assert.equal(buildSingingMixFilter(0).includes('asetrate'), false);
  assert.equal(buildSingingMixFilter(0).includes('atempo'), false);
});

test('shift!=0 inserts transposition on the accompaniment branch before amix', () => {
  const filter = buildSingingMixFilter(5);
  assert.ok(filter.includes('asetrate='));
  assert.ok(filter.includes('aresample=44100'));
  assert.ok(filter.includes('atempo='));
  assert.ok(filter.includes('[1:a]asetrate='));
  assert.ok(filter.includes(',volume=0.38[i];[v][i]amix='));
  // 人声 EQ 链保持原样，移调只挂在伴奏分支上。
  assert.ok(filter.startsWith('[0:a]highpass=f=90,lowpass=f=14000,equalizer=f=300'));
});

test('atempo is chained when the tempo factor falls outside 0.5–2.0', () => {
  const chain = buildTransposeFilter(24);
  assert.ok(chain.includes('atempo=0.5,atempo=0.5'), chain);
  assert.equal(chain.includes('atempo=0.250000'), false);
  const single = buildTransposeFilter(-8);
  assert.equal(single.includes('atempo=0.5,atempo'), false, single);
});

test('伴奏移调：时长不变，主频按 2^(N/12) 变化（+5 / -5 半音）', async () => {
  if (!existsSync(FFMPEG)) return;
  const work = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.transpose-fixture-'));
  try {
    for (const shift of [5, -5]) {
      const source = path.join(work, `sine-${shift}.wav`);
      const shifted = path.join(work, `shifted-${shift}.wav`);
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=44100:duration=4', source]);
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-af', buildTransposeFilter(shift), shifted]);
      const sourceSamples = await decodeAudioSamples(source, { ffmpegPath: FFMPEG, sampleRate: SAMPLE_RATE });
      const shiftedSamples = await decodeAudioSamples(shifted, { ffmpegPath: FFMPEG, sampleRate: SAMPLE_RATE });
      const sourceDuration = sourceSamples.length / SAMPLE_RATE;
      const shiftedDuration = shiftedSamples.length / SAMPLE_RATE;
      assert.ok(Math.abs(shiftedDuration - sourceDuration) < 0.05,
        `shift=${shift} duration ${sourceDuration}s → ${shiftedDuration}s`);
      const before = analyzePitchSamples(sourceSamples);
      const after = analyzePitchSamples(shiftedSamples);
      const expected = 440 * 2 ** (shift / 12);
      assert.ok(Math.abs(after.medianHz - expected) < 6,
        `shift=${shift} expected≈${expected.toFixed(1)}Hz got ${after.medianHz.toFixed(1)}Hz (before ${before.medianHz.toFixed(1)}Hz)`);
      if (shift > 0) assert.ok(after.medianHz > before.medianHz, 'positive shift must raise the pitch');
      else assert.ok(after.medianHz < before.medianHz, 'negative shift must lower the pitch');
    }
    assert.ok(readFileSync(path.join(work, 'shifted-5.wav')).length > 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
