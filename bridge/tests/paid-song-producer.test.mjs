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
    getSettings: () => ({ coverEnabled: true, rvcEnabled: false, rvcPitch: 0 }),
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
