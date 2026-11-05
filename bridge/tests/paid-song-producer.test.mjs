import test from 'node:test';
import assert from 'node:assert/strict';
import { makePaidFullSong, makePaidSongPreview } from '../src/paid-song-producer.mjs';

const FRAME_SIZE = Math.floor(144 * 128_000 / 44_100);
function mp3(seconds) {
  const frames = Math.round(seconds * 44_100 / 1152);
  const audio = Buffer.alloc(FRAME_SIZE * frames);
  for (let index = 0; index < frames; index++) audio.writeUInt32BE(0xfffb9000, index * FRAME_SIZE);
  return audio;
}

test('paid preview always applies Liuying RVC when cover is enabled, regardless of rvcEnabled setting', async () => {
  const input = mp3(30);
  const output = mp3(30);
  let rvcCalls = 0;
  const result = await makePaidSongPreview('精确歌曲名', {
    getSettings: () => ({ coverEnabled: true, rvcEnabled: false, rvcPitch: 0, singingPitch: { enabled: false } }),
    searchImpl: async () => [{ title: '精确歌曲名', url: 'https://source.test/song' }],
    makeClip: async () => ({ title: '精确歌曲名', url: 'https://source.test/song', audio: input, startSeconds: 30 }),
    applyVoice: async (audio) => { rvcCalls++; assert.equal(audio, input); return output; },
    loadOutput: () => null,
    saveOutput: () => {},
    outputPath: () => 'cached-preview.mp3'
  });
  assert.equal(rvcCalls, 1);
  assert.equal(result.audio, output);
  assert.equal(result.sourceIdentity, 'https://source.test/song');
  assert.equal(result.pitchMode, 'manual');
});

test('paid preview auto mode saves the detected shift into the cache variant', async () => {
  const input = mp3(30);
  const output = mp3(30);
  let saved = null;
  const result = await makePaidSongPreview('精确歌曲名', {
    getSettings: () => ({ coverEnabled: true, rvcEnabled: false, rvcPitch: 0, singingPitch: { enabled: true } }),
    searchImpl: async () => [{ title: '精确歌曲名', url: 'https://source.test/song' }],
    makeClip: async () => ({ title: '精确歌曲名', url: 'https://source.test/song', audio: input, startSeconds: 30 }),
    applyVoice: async () => ({ audio: output, pitchShift: 5, pitchInfo: { medianHz: 212 } }),
    loadAutoOutput: () => null,
    saveOutput: (options) => { saved = options; },
    outputPath: () => 'cached-preview.mp3'
  });
  assert.equal(result.audio, output);
  assert.equal(result.pitchShift, 5);
  assert.equal(result.voiceVariant, 'rvc:5:clear-v5');
  assert.equal(saved.voiceVariant, 'rvc:5:clear-v5');
  assert.equal(saved.pitchMode, 'auto');
});

test('full-song auto mode detects once and reuses the same shift for all three segments', async () => {
  const sourceAudio = mp3(90);
  const renderCalls = [];
  const saved = [];
  const result = await makePaidFullSong('精确歌曲名', {
    getSettings: () => ({ coverEnabled: true, rvcEnabled: true, rvcPitch: 0, singingPitch: { enabled: true } }),
    searchImpl: async () => [{ title: '精确歌曲名', url: 'https://source.test/song' }],
    makeSegments: async () => ({ title: '精确歌曲名', url: 'https://source.test/song',
      sourceIdentity: 'https://source.test/song#sha256=stable', duration: 90, sourceAudio,
      segments: [0, 1, 2].map((index) => ({ segmentIndex: index, startSeconds: index * 30, seconds: 30, audio: mp3(30) })) }),
    prepareStems: async () => ({ work: 'stems', vocals: 'vocals.wav', accompaniment: 'no_vocals.wav',
      pitchShift: 5, pitchInfo: { medianHz: 212 }, close: async () => {} }),
    renderSegment: async (stems, options) => { renderCalls.push({ shift: stems.pitchShift, options }); return mp3(30); },
    applyVoice: async () => assert.fail('auto mode must render from whole-song stems, not per-segment RVC'),
    loadOutput: () => null,
    saveOutput: (options) => saved.push(options),
    outputPath: (options) => `cache-${options.segmentIndex}.mp3`
  });
  assert.equal(renderCalls.length, 3);
  assert.deepEqual(renderCalls.map((call) => call.shift), [5, 5, 5]);
  assert.deepEqual(saved.map((options) => options.voiceVariant), ['rvc:5:clear-v5', 'rvc:5:clear-v5', 'rvc:5:clear-v5']);
  assert.equal(result.pitchShift, 5);
  assert.equal(result.voiceVariant, 'rvc:5:clear-v5');
});

test('full-song auto mode falls back to shift=0 when whole-song stems fail', async () => {
  const saved = [];
  const applied = [];
  const result = await makePaidFullSong('精确歌曲名', {
    getSettings: () => ({ coverEnabled: true, rvcEnabled: true, rvcPitch: 0, singingPitch: { enabled: true } }),
    searchImpl: async () => [{ title: '精确歌曲名', url: 'https://source.test/song' }],
    makeSegments: async () => ({ title: '精确歌曲名', url: 'https://source.test/song',
      sourceIdentity: 'https://source.test/song#sha256=stable', duration: 30, sourceAudio: mp3(30),
      segments: [{ segmentIndex: 0, startSeconds: 0, seconds: 30, audio: mp3(30) }] }),
    prepareStems: async () => { throw new Error('demucs failed'); },
    applyVoice: async (audio, options) => { applied.push(options); return { audio: mp3(30), pitchShift: 0 }; },
    loadOutput: () => null,
    saveOutput: (options) => saved.push(options),
    outputPath: () => 'cache-0.mp3',
    logger: { warn() {}, info() {} }
  });
  assert.equal(applied[0].pitch, 0);
  assert.equal(result.pitchShift, 0);
  assert.equal(saved[0].voiceVariant, 'rvc:0:clear-v5');
});

test('full-song resume loads every persisted source-specific cache segment without search, download or RVC', async () => {
  const audio = mp3(30);
  const cacheOptions = [];
  const result = await makePaidFullSong('精确歌曲名', {
    getSettings: () => ({ coverEnabled: true, rvcEnabled: false, rvcPitch: 7 }),
    searchImpl: async () => assert.fail('resume must not search'),
    makeSegments: async () => assert.fail('resume must not download or segment'),
    applyVoice: async () => assert.fail('resume must use already converted cached segments'),
    loadOutput: (options) => { cacheOptions.push(options); return { audio }; },
    outputPath: (options) => `cache-${options.segmentIndex}.mp3`,
    resume: {
      title: '精确歌曲名', sourceIdentity: 'https://source.test/song#sha256=stable', voiceVariant: 'rvc:0',
      segments: [0, 1].map((segment_index) => ({ segment_index, start_seconds: segment_index * 30, seconds: 30 }))
    }
  });
  assert.equal(cacheOptions.length, 2);
  assert.ok(cacheOptions.every((options) => options.sourceIdentity === 'https://source.test/song#sha256=stable'));
  assert.ok(cacheOptions.every((options) => options.voiceVariant === 'rvc:0'), 'resume retains the original voice cache identity after settings change');
  assert.deepEqual(result.segments.map((segment) => segment.cachePath), ['cache-0.mp3', 'cache-1.mp3']);
});
