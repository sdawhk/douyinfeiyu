import test from 'node:test';
import assert from 'node:assert/strict';
import { makePaidFullSong } from '../src/paid-song-producer.mjs';
import { isVocalSongSource } from '../src/song-cover.mjs';
import { songFailureReply } from '../src/song-library-commands.mjs';
import { NO_AUDIBLE_VOCALS, SONG_SOURCE_UNAVAILABLE, songSourceError } from '../src/song-source-errors.mjs';

const query = '修复测试歌';
const sources = ['first', 'second'].map((id) => ({ title: `${query} 演唱`, url: `https://source.test/${id}` }));
const frameSize = Math.floor(144 * 128_000 / 44_100);
function mp3(seconds) {
  const frames = Math.round(seconds * 44_100 / 1152);
  const bytes = Buffer.alloc(frameSize * frames);
  for (let i = 0; i < frames; i++) bytes.writeUInt32BE(0xfffb9000, i * frameSize);
  return bytes;
}
function fixture(overrides = {}) {
  const saved = [], attempts = [], rendered = [];
  const audioSource = new Map();
  const options = {
    getSettings: () => ({ coverEnabled: true, singingPitch: { enabled: true } }),
    searchImpl: async () => sources,
    findCachedSource: () => null,
    loadOutput: () => null,
    saveOutput: (item) => saved.push(item),
    outputPath: (item) => `cache-${item.sourceIdentity}-${item.segmentIndex}`,
    logger: { info() {}, warn() {} },
    makeSegments: async (_query, { searchImpl }) => {
      const candidates = await searchImpl();
      assert.equal(candidates.length, 1);
      const source = candidates[0];
      attempts.push(source.url);
      const sourceAudio = mp3(60);
      audioSource.set(sourceAudio, source.url);
      return { ...source, sourceIdentity: `${source.url}#sha256=stable`, duration: 60, sourceAudio,
        segments: [0, 1].map((index) => ({ segmentIndex: index, startSeconds: index * 30, seconds: 30, audio: mp3(30) })) };
    },
    prepareStems: async (audio, options) => ({ source: audioSource.get(audio), validatedVocals: true,
      pitchShift: options.pitchShift ?? 2, close: async () => {} }),
    renderSegment: async (stems, segment) => { rendered.push(stems.source); return mp3(segment.seconds); },
    applyVoice: async () => assert.fail('normal validated full-song processing must not re-separate clips'),
    ...overrides
  };
  return { options, saved, attempts, rendered, audioSource };
}

test('整首无歌声跳到下一候选，不对坏源逐段重做或写缓存', async () => {
  const f = fixture();
  const prepare = f.options.prepareStems;
  f.options.prepareStems = async (audio, options) => {
    if (f.audioSource.get(audio) === sources[0].url) throw songSourceError(NO_AUDIBLE_VOCALS, 'no vocals', { scope: 'whole' });
    return prepare(audio, options);
  };
  const result = await makePaidFullSong(query, f.options);
  assert.deepEqual(f.attempts, sources.map((x) => x.url));
  assert.equal(result.sourceIdentity, `${sources[1].url}#sha256=stable`);
  assert.deepEqual(f.rendered, [sources[1].url, sources[1].url]);
  assert.ok(f.saved.every((x) => x.sourceIdentity.startsWith(sources[1].url)));
});

test('全部候选没有歌声时明确失败且不保存半成品', async () => {
  const f = fixture({ prepareStems: async () => { throw songSourceError(NO_AUDIBLE_VOCALS, 'no vocals'); } });
  await assert.rejects(makePaidFullSong(query, f.options), (error) => error.code === NO_AUDIBLE_VOCALS && error.attempts.length === 2);
  assert.equal(f.saved.length, 0);
  assert.equal(f.rendered.length, 0);
});

test('未知和环境错误立即报告，不伪装成变调失败或更换多首重试', async () => {
  const f = fixture({ prepareStems: async () => { throw new Error('RVC runtime unavailable'); } });
  await assert.rejects(makePaidFullSong(query, f.options), /RVC runtime unavailable/);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.saved.length, 0);
});

test('已制作部分分段后换源不混用失败候选缓存', async () => {
  const f = fixture();
  f.options.renderSegment = async (stems, segment) => {
    if (stems.source === sources[0].url && segment.startSeconds > 0) throw songSourceError(NO_AUDIBLE_VOCALS, 'clip vocals unavailable');
    return mp3(segment.seconds);
  };
  await makePaidFullSong(query, f.options);
  assert.equal(f.saved.length, 2);
  assert.ok(f.saved.every((x) => x.sourceIdentity.startsWith(sources[1].url)));
});

test('来源下载失败可以换源；已成功片段的来源优先且去重', async () => {
  const f = fixture({ findCachedSource: () => sources[1], searchImpl: async () => [sources[0], sources[1], sources[1]] });
  await makePaidFullSong(query, f.options);
  assert.deepEqual(f.attempts, [sources[1].url]);
  const g = fixture();
  const makeSegments = g.options.makeSegments;
  g.options.makeSegments = async (q, options) => {
    if ((await options.searchImpl())[0].url === sources[0].url) throw songSourceError(SONG_SOURCE_UNAVAILABLE, 'download blocked');
    return makeSegments(q, options);
  };
  await makePaidFullSong(query, g.options);
  assert.equal(g.saved.length, 2);
});

test('手动变调也校验整首歌声，并把手动 shift 用于所有分段', async () => {
  const f = fixture({ getSettings: () => ({ coverEnabled: true, rvcPitch: 5, singingPitch: { enabled: false } }) });
  const result = await makePaidFullSong(query, f.options);
  assert.equal(result.pitchShift, 5);
  assert.ok(f.saved.every((x) => x.pitch === 5));
});

test('过滤英文和日文钢琴纯演奏，同时保留钢琴弹唱与歌名中的 Piano', () => {
  assert.equal(isVocalSongSource('打上花火', '【打上花火】DAOKO × 米津玄師 ピアノ Ru’s Piano'), false);
  assert.equal(isVocalSongSource('打上花火', '打上花火 Piano Cover'), false);
  assert.equal(isVocalSongSource('打上花火', '打上花火 钢琴版'), false);
  assert.equal(isVocalSongSource('打上花火', '打上花火 钢琴弹唱 Piano & Vocal'), true);
  assert.equal(isVocalSongSource('Piano Man', 'Piano Man - Billy Joel Official Video'), true);
  assert.equal(isVocalSongSource('打上花火', '打上花火 オルゴール'), false);
});

test('制作与发送失败分开，免费点唱不再说释放收费额度', () => {
  const free = songFailureReply({ query, kind: 'full', creditSource: 'promo', deliveryAttempted: false,
    error: songSourceError(NO_AUDIBLE_VOCALS, 'internal diagnostic') });
  assert.match(free, /清晰歌声/);
  assert.match(free, /未扣点歌单位/);
  assert.doesNotMatch(free, /额度已释放|发送失败|internal diagnostic/);
  const delivery = songFailureReply({ query, kind: 'full', creditSource: 'units', deliveryAttempted: true });
  assert.match(delivery, /发送失败，音频制作已完成/);
  assert.match(delivery, /预留额度已释放/);
});
