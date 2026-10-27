import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseExistingSongCommand, parseRecentSongReplayRequest, searchExistingSongs, makeExistingSongClip, makeExistingSongSegments, isExactSongMatch } from '../src/song-cover.mjs';
import { hasAudibleVocals, LIUYING_SINGING_VOCAL_PROFILE, LIUYING_SINGING_VOCAL_VARIANT } from '../src/rvc-singing.mjs';
import { loadSongOutput, saveSongOutput } from '../src/song-output-cache.mjs';

test('clearer RVC mix uses a new cache variant so old mixes are regenerated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'song-cache-profile-'));
  try {
    const base = { query: '夜曲', mode: 'ai', candidate: 1, startSeconds: 30, seconds: 30 };
    const audio = Buffer.alloc(2048, 1);
    saveSongOutput({ ...base, voiceVariant: 'rvc:0' }, audio, { root });
    assert.equal(loadSongOutput({ ...base, voiceVariant: 'rvc:0' }, { root })?.audio.length, 2048);
    assert.equal(loadSongOutput({ ...base, voiceVariant: LIUYING_SINGING_VOCAL_VARIANT(0) }, { root }), null);
    assert.equal(LIUYING_SINGING_VOCAL_PROFILE, 'clear-v2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full song segments use one fully measured exact source and source-specific segment cache keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'song-full-source-'));
  const frameSize = Math.floor(144 * 128_000 / 44_100);
  const makeMp3 = (seconds) => {
    const frames = Math.max(10, Math.floor(seconds * 44_100 / 1152));
    const audio = Buffer.alloc(frameSize * frames);
    for (let i = 0; i < frames; i++) audio.writeUInt32BE(0xfffb9000, i * frameSize);
    return audio;
  };
  let downloads = 0;
  const runImpl = async (_file, args) => {
    if (args.includes('-o')) {
      downloads++;
      const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp3');
      await writeFile(output, makeMp3(68));
    } else if (args.at(-1) !== '-') {
      await writeFile(args.at(-1), makeMp3(Number(args[args.indexOf('-t') + 1])));
    }
    return '';
  };
  try {
    const full = await makeExistingSongSegments('夜曲', { runImpl, ffmpeg: process.execPath, ytdlp: process.execPath, ytdlpArgs: [],
      searchImpl: async () => [{ title: '周杰伦 夜曲', source: 'youtube', url: 'https://www.youtube.com/watch?v=one-source', duration: 68 }] });
    assert.equal(downloads, 1);
    assert.equal(full.url, 'https://www.youtube.com/watch?v=one-source');
    assert.ok(Math.abs(full.duration - 68) < 1);
    assert.equal(full.segments.length, 3);
    assert.deepEqual(full.segments.map((item) => item.startSeconds), [0, 30, 60]);
    assert.ok(full.segments.every((item) => Buffer.isBuffer(item.audio)));
    const options = { query: '夜曲', mode: 'ai', startSeconds: 0, seconds: 30, voiceVariant: 'rvc:0', sourceIdentity: full.url, segmentIndex: 0 };
    saveSongOutput(options, Buffer.alloc(2048, 1), { root });
    assert.equal(loadSongOutput(options, { root })?.audio.length, 2048);
    assert.equal(loadSongOutput({ ...options, sourceIdentity: 'https://www.youtube.com/watch?v=other' }, { root }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('existing-song requests stay separate from original generation', () => {
  assert.deepEqual(parseExistingSongCommand('/唱歌 夜曲'), { mode: 'ai', song: '夜曲', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('翻唱：夜曲 #2'), { mode: 'ai', song: '夜曲', candidate: 2, candidateExplicit: true });
  assert.deepEqual(parseExistingSongCommand('原唱 夜曲'), { mode: 'original', song: '夜曲', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('搜歌 夜曲'), { mode: 'search', song: '夜曲', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('给我唱《夜曲》'), { mode: 'ai', song: '夜曲', candidate: 1 });
  assert.equal(parseExistingSongCommand('/原创唱歌 夏天'), null);
  assert.deepEqual(parseExistingSongCommand('给我唱首歌'), { mode: 'ai', song: '', candidate: 1 });
});

test('natural song requests route to an existing song clip', () => {
  assert.deepEqual(parseExistingSongCommand('唱一首雨夜dj版'), { mode: 'ai', song: '雨夜dj版', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('@最爱吃白饭 唱一首雨夜dj版', { botNickname: '最爱吃白饭' }),
    { mode: 'ai', song: '雨夜dj版', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('@旧昵称 唱一首雨夜dj版', { hasBotMention: true }),
    { mode: 'ai', song: '雨夜dj版', candidate: 1 });
  assert.equal(parseExistingSongCommand('@其他人 唱一首雨夜dj版', { botNickname: '最爱吃白饭' }), null);
  assert.deepEqual(parseExistingSongCommand('唱一首雨夜 DJ 版的歌'), { mode: 'ai', song: '雨夜 DJ 版', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('用语音唱一首雨夜'), { mode: 'ai', song: '雨夜', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('可以给我唱10秒钟雨夜吗？'), { mode: 'ai', song: '雨夜', candidate: 1, seconds: 10 });
  assert.deepEqual(parseExistingSongCommand('我想让你唱歌唱雨夜'), { mode: 'ai', song: '雨夜', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('唱一下雨夜'), { mode: 'ai', song: '雨夜', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('唱雨夜'), { mode: 'ai', song: '雨夜', candidate: 1 });
  assert.deepEqual(parseExistingSongCommand('唱一首歌'), { mode: 'ai', song: '', candidate: 1 });
  assert.equal(parseExistingSongCommand('我会唱歌'), null);
  assert.equal(parseExistingSongCommand('唱歌真好听'), null);
  assert.equal(parseExistingSongCommand('唱得好听'), null);
  assert.equal(parseExistingSongCommand('唱到一半'), null);
  assert.equal(parseExistingSongCommand('唱什么歌'), null);
  assert.equal(parseExistingSongCommand('原创唱歌 雨夜'), null);
});

test('recent song follow-ups ask to resend audio instead of becoming chat text', () => {
  assert.deepEqual(parseRecentSongReplayRequest('这个群也来一首雨爱司凤版'), { song: '雨爱司凤版' });
  assert.deepEqual(parseRecentSongReplayRequest('唱出来'), { song: '' });
  assert.deepEqual(parseRecentSongReplayRequest('你刚才不是生成吗直接在这个群里发出来'), { song: '' });
  assert.deepEqual(parseRecentSongReplayRequest('再来一段'), { song: '', continuation: true });
  assert.deepEqual(parseRecentSongReplayRequest('接着唱吧'), { song: '', continuation: true });
  assert.deepEqual(parseRecentSongReplayRequest('@最爱吃白饭 这个群也来一首雨爱司凤版', { hasBotMention: true }), { song: '雨爱司凤版' });
  assert.equal(parseRecentSongReplayRequest('我听过雨爱司凤版'), null);
});

test('song search rejects accompaniment, drama, and unrelated titles', async () => {
  const found = await searchExistingSongs('夜曲', { fetchImpl: async () => Response.json({ code: 0, data: { result: [
    { title: '<em>夜曲</em> &amp; 演唱', bvid: 'BV1234567890', duration: '3:12' }
  ] } }), runImpl: async () => { throw new Error('unexpected yt-dlp search'); } });
  assert.deepEqual(found, [{ title: '夜曲 & 演唱', url: 'https://www.bilibili.com/video/BV1234567890', duration: 192, source: 'bilibili' }]);

  const fallback = await searchExistingSongs('夜曲', { fetchImpl: async () => { throw new Error('offline'); },
    runImpl: async (_file, args) => JSON.stringify({ entries: [
      { title: 'bad', webpage_url: 'https://example.com/video', duration: 180 },
      { title: '夜曲 KTV 伴奏', webpage_url: 'https://www.youtube.com/watch?v=bad123', duration: 190 },
      { title: '夜曲 演唱', webpage_url: 'https://www.youtube.com/watch?v=abc123', duration: 190 }
    ] }) });
  assert.deepEqual(fallback.map((item) => item.title), ['夜曲 演唱']);

  const rain = await searchExistingSongs('雨夜', { fetchImpl: async () => Response.json({ code: 0, data: { result: [
    { title: '《雨夜邂逅》短剧全集', bvid: 'BV1234567890', duration: '1:20:00' },
    { title: '雨夜钢琴 KTV 导唱字幕 备有伴奏视频', bvid: 'BV1234567891', duration: '3:12' },
    { title: '林志美 - 雨夜钢琴 DJ 原唱', bvid: 'BV1234567892', duration: '3:12' }
  ] } }), runImpl: async () => JSON.stringify({ entries: [] }) });
  assert.deepEqual(rain.map((item) => item.title), ['林志美 - 雨夜钢琴 DJ 原唱']);
  assert.equal(isExactSongMatch('雨夜', rain[0].title), false);
  assert.equal(isExactSongMatch('雨夜钢琴 DJ', rain[0].title), true);

  const dj = await searchExistingSongs('雨夜 DJ', { fetchImpl: async () => Response.json({ code: 0, data: { result: [
    { title: '陈琳：《雨夜》MV', bvid: 'BV1234567893', duration: '3:12' },
    { title: '林志美 - 雨夜钢琴 DJ 演唱', bvid: 'BV1234567894', duration: '3:12' }
  ] } }), runImpl: async () => JSON.stringify({ entries: [] }) });
  assert.deepEqual(dj.map((item) => item.title), ['林志美 - 雨夜钢琴 DJ 演唱']);

  const exactAfterPartial = await searchExistingSongs('雨夜 DJ', { fetchImpl: async () => Response.json({ code: 0, data: { result: [
    { title: '雨夜钢琴 DJ 演唱', bvid: 'BV1234567895', duration: '3:12' }
  ] } }), runImpl: async (_file, args) => JSON.stringify({ entries: args.at(-1).startsWith('ytsearch') ? [
    { title: '雨夜 DJ版 原唱', webpage_url: 'https://www.youtube.com/watch?v=exact123', duration: 190 }
  ] : [] }) });
  assert.deepEqual(exactAfterPartial.map((item) => item.title), ['雨夜 DJ版 原唱']);
});

test('song search keeps exact matches from each provider for automatic download fallback', async () => {
  const results = await searchExistingSongs('夜曲', {
    fetchImpl: async () => Response.json({ code: 0, data: { result: [
      { title: '周杰伦 夜曲 官方版', bvid: 'BV1234567890', duration: '3:12' }
    ] } }),
    runImpl: async (_file, args) => JSON.stringify({ entries: args.at(-1).startsWith('bilisearch') ? [
      { title: '周杰伦 夜曲 高清', url: 'https://www.bilibili.com/video/BV1234567891', duration: 190 }
    ] : [
      { title: '周杰伦 夜曲 MV', url: 'https://www.youtube.com/watch?v=night123', duration: 190 }
    ] })
  });
  assert.deepEqual(results.map((item) => item.source), ['bilibili', 'bilibili', 'youtube']);
  assert.equal(results.length, 3);
});

test('司凤版搜索接受倒序和括号标题，并兼容司风别字', async () => {
  assert.equal(isExactSongMatch('雨爱司凤版', '司凤版雨爱'), true);
  assert.equal(isExactSongMatch('雨爱司风版', '雨愛（司鳳版）'), true);
  assert.equal(isExactSongMatch('雨爱司凤版', '杨丞琳 雨爱 DJ'), false);
  const calls = [];
  const found = await searchExistingSongs('雨爱司风版', {
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('', { status: 412 });
    },
    runImpl: async (_file, args) => {
      calls.push(args.at(-1));
      return JSON.stringify({ entries: args.at(-1).startsWith('ytsearch') ? [
        { title: '杨丞琳 雨爱 DJ', url: 'https://www.youtube.com/watch?v=original1', duration: 198 },
        { title: '雨爱(司凤版) 伴奏', url: 'https://www.youtube.com/watch?v=backing1', duration: 232 },
        { title: '司凤版雨爱', url: 'https://www.youtube.com/watch?v=cover123', duration: 232 }
      ] : [] });
    }
  });
  assert.deepEqual(found.map((item) => item.title), ['司凤版雨爱']);
  assert.ok(calls.every((call) => call.includes('雨爱司凤版') || call.includes(encodeURIComponent('雨爱司凤版'))));
});

test('vocal preflight refuses instrumental stems and keeps clear singing', () => {
  assert.equal(hasAudibleVocals(-42, -18), false);
  assert.equal(hasAudibleVocals(-34, -12), false);
  assert.equal(hasAudibleVocals(-24, -17), true);
});

test('clip chain downloads, cuts, returns audio and removes temporary files', async () => {
  let work;
  const calls = [];
  const runImpl = async (_file, args) => {
    calls.push(args);
    if (args.includes('-o')) {
      work = path.dirname(args[args.indexOf('-o') + 1]);
      await writeFile(path.join(work, 'source.mp3'), Buffer.alloc(2048, 1));
    } else {
      await writeFile(args.at(-1), Buffer.alloc(2048, 2));
    }
    return '';
  };
  const clip = await makeExistingSongClip('夜曲', { candidate: 2, runImpl, ffmpeg: process.execPath, ytdlp: process.execPath, ytdlpArgs: [], searchImpl: async () => [
    { title: 'other', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1234567890', duration: 180 },
    { title: '夜曲', source: 'youtube', url: 'https://www.youtube.com/watch?v=abc123', duration: 180 }
  ] });
  assert.equal(clip.audio.length, 2048);
  assert.equal(clip.title, '夜曲');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].at(-1), 'https://www.youtube.com/watch?v=abc123');
  assert.equal(clip.duration, 180);
  assert.equal(clip.startSeconds, 30);
  assert.equal(existsSync(work), false);
  await assert.rejects(makeExistingSongClip('夜曲', { runImpl, ffmpeg: process.execPath, ytdlp: process.execPath, ytdlpArgs: [], searchImpl: async () => [
    { title: 'bad', url: 'https://example.com/song.mp3' }
  ] }), /没有找到可下载/);
});

test('clip chain retries another exact-match source when the selected download is blocked', async () => {
  const calls = [];
  const runImpl = async (_file, args) => {
    calls.push(args);
    const sourceUrl = args.at(-1);
    if (args.includes('-o')) {
      if (sourceUrl === 'https://www.youtube.com/watch?v=blocked') throw new Error('Sign in to confirm you are not a bot');
      const work = path.dirname(args[args.indexOf('-o') + 1]);
      await writeFile(path.join(work, 'source.mp3'), Buffer.alloc(2048, 1));
    } else {
      await writeFile(args.at(-1), Buffer.alloc(2048, 2));
    }
    return '';
  };
  const clip = await makeExistingSongClip('夜曲', { candidate: 2, runImpl,
    ffmpeg: process.execPath, ytdlp: process.execPath, ytdlpArgs: [], searchImpl: async () => [
      { title: '周杰伦 夜曲', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1234567890', duration: 180 },
      { title: '周杰伦 夜曲', source: 'youtube', url: 'https://www.youtube.com/watch?v=blocked', duration: 180 }
    ] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].at(-1), 'https://www.youtube.com/watch?v=blocked');
  assert.equal(calls[1].at(-1), 'https://www.bilibili.com/video/BV1234567890');
  assert.equal(clip.source, 'bilibili');
});

test('clip chain reports only that no matching sources were downloadable after retries', async () => {
  const runImpl = async (_file, args) => {
    if (args.includes('-o')) throw new Error('Sign in to confirm you are not a bot');
    throw new Error('should not reach clipping');
  };
  await assert.rejects(makeExistingSongClip('夜曲', { runImpl, ffmpeg: process.execPath, ytdlp: process.execPath,
    ytdlpArgs: [], searchImpl: async () => [
      { title: '周杰伦 夜曲', source: 'youtube', url: 'https://www.youtube.com/watch?v=blocked', duration: 180 },
      { title: '周杰伦 夜曲 Live', source: 'bilibili', url: 'https://www.bilibili.com/video/BV1234567890', duration: 180 }
    ] }), /所有 2 个匹配音源都无法下载/);
});

test('a continuation cuts the next 30 seconds from the same source', async () => {
  const calls = [];
  const runImpl = async (_file, args) => {
    calls.push(args);
    if (args.includes('-o')) {
      await writeFile(path.join(path.dirname(args[args.indexOf('-o') + 1]), 'source.mp3'), Buffer.alloc(2048, 1));
    } else {
      await writeFile(args.at(-1), Buffer.alloc(2048, 2));
    }
    return '';
  };
  const clip = await makeExistingSongClip('雨爱司凤版', { seconds: 30, startSeconds: 60, runImpl,
    ffmpeg: process.execPath, ytdlp: process.execPath, ytdlpArgs: [], searchImpl: async () => [
      { title: '司凤版雨爱', source: 'youtube', url: 'https://www.youtube.com/watch?v=abc123', duration: 232 }
    ] });
  assert.equal(calls[1][calls[1].indexOf('-ss') + 1], '60');
  assert.equal(clip.startSeconds, 60);
  assert.equal(clip.url, 'https://www.youtube.com/watch?v=abc123');
});
