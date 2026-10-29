import { isExactSongMatch, makeExistingSongClip, makeExistingSongSegments, searchExistingSongs } from './song-cover.mjs';
import { applyLiuyingVoice, LIUYING_SINGING_VOCAL_VARIANT } from './rvc-singing.mjs';
import { getSongOutputPath, loadSongOutput, saveSongOutput } from './song-output-cache.mjs';
import { inspectMp3Duration } from './song-library.mjs';

function verifyDuration(audio, expectedSeconds, label) {
  const actual = inspectMp3Duration(audio);
  if (!Number.isFinite(actual) || Math.abs(actual - expectedSeconds) > 0.5) {
    throw new Error(`${label}音频时长校验失败（应为 ${expectedSeconds.toFixed(1)} 秒）`);
  }
}

function singingSettings(getSettings) {
  const settings = getSettings?.() ?? {};
  if (settings.coverEnabled !== true) throw new Error('现成歌曲翻唱当前未启用');
  return { pitch: Number.isInteger(settings.rvcPitch) ? settings.rvcPitch : 0 };
}

export async function makePaidSongPreview(query, { getSettings, searchImpl = searchExistingSongs,
  makeClip = makeExistingSongClip, applyVoice = applyLiuyingVoice, loadOutput = loadSongOutput,
  saveOutput = saveSongOutput, outputPath = getSongOutputPath } = {}) {
  const { pitch } = singingSettings(getSettings);
  const voiceVariant = LIUYING_SINGING_VOCAL_VARIANT(pitch);
  const results = await searchImpl(query);
  const exact = results.filter((item) => isExactSongMatch(query, item.title));
  if (!exact.length) throw new Error('没有找到与所点歌名完全匹配的音源，请提供准确歌名');
  for (const source of exact) {
    const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: 30, seconds: 30,
      voiceVariant, sourceIdentity: source.url };
    const cached = loadOutput(cacheOptions);
    if (cached) { verifyDuration(cached.audio, 30, '缓存试听'); return { audio: cached.audio, title: cached.title, sourceIdentity: source.url,
      file: outputPath(cacheOptions), voiceVariant, startSeconds: cached.startSeconds ?? 30 };
    }
  }
  const clip = await makeClip(query, { seconds: 30, startSeconds: 30, candidate: 1,
    requireExact: true, searchImpl: async () => exact });
  if (!exact.some((source) => source.url === clip.url)) throw new Error('paid preview source is not in the exact-match candidate list');
  const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: 30, seconds: 30,
    voiceVariant, sourceIdentity: clip.url };
  const audio = await applyVoice(clip.audio, { pitch });
  verifyDuration(audio, 30, '流萤试听');
  saveOutput({ ...cacheOptions, title: clip.title, source: clip.source, duration: clip.duration }, audio);
  return { audio, title: clip.title, sourceIdentity: clip.url, file: outputPath(cacheOptions),
    voiceVariant, startSeconds: clip.startSeconds };
}

export async function makePaidFullSong(query, { getSettings, searchImpl = searchExistingSongs,
  makeSegments = makeExistingSongSegments, applyVoice = applyLiuyingVoice, loadOutput = loadSongOutput,
  saveOutput = saveSongOutput, outputPath = getSongOutputPath, resume = null } = {}) {
  const { pitch } = singingSettings(getSettings);
  const voiceVariant = resume ? resume.voiceVariant : LIUYING_SINGING_VOCAL_VARIANT(pitch);
  if (resume) {
    if (!resume.sourceIdentity || !resume.title || !resume.voiceVariant || !Array.isArray(resume.segments) || !resume.segments.length) {
      throw new Error('saved full-song order is missing source, voice or segment metadata');
    }
    const segments = resume.segments.map((segment, index) => {
      if (segment.segment_index !== index || !Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.seconds)) {
        throw new Error('saved full-song segment metadata is not contiguous');
      }
      const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: segment.start_seconds,
        seconds: segment.seconds, voiceVariant, sourceIdentity: resume.sourceIdentity, segmentIndex: index };
      const cached = loadOutput(cacheOptions);
      if (!cached) throw new Error(`第 ${index + 1} 段本地缓存缺失或校验失败，订单保留待主人处理`);
      verifyDuration(cached.audio, segment.seconds, '续传缓存分段');
      return { segmentIndex: index, startSeconds: segment.start_seconds, seconds: segment.seconds,
        audio: cached.audio, cachePath: outputPath(cacheOptions) };
    });
    return { title: resume.title, sourceIdentity: resume.sourceIdentity, duration: segments.reduce((sum, item) => sum + item.seconds, 0), voiceVariant, segments };
  }
  const results = await searchImpl(query);
  const exact = results.filter((item) => isExactSongMatch(query, item.title));
  if (!exact.length) throw new Error('没有找到与所点歌名完全匹配的音源，请提供准确歌名');
  const source = await makeSegments(query, { chunkSeconds: 60, searchImpl: async () => exact });
  if (!exact.some((item) => item.url === source.url) || !source.sourceIdentity) throw new Error('整首音源不在完全匹配候选中或缺少稳定来源标识');
  const segments = [];
  for (const segment of source.segments) {
    const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: segment.startSeconds,
      seconds: segment.seconds, voiceVariant, sourceIdentity: source.sourceIdentity, segmentIndex: segment.segmentIndex };
    const cached = loadOutput(cacheOptions);
    const audio = cached?.audio ?? await applyVoice(segment.audio, { pitch });
    verifyDuration(audio, segment.seconds, cached ? '缓存分段' : '流萤分段');
    if (!cached) saveOutput({ ...cacheOptions, title: source.title, source: source.source,
      duration: source.duration }, audio);
    segments.push({ segmentIndex: segment.segmentIndex, startSeconds: segment.startSeconds,
      seconds: segment.seconds, audio, cachePath: outputPath(cacheOptions) });
  }
  return { title: source.title, sourceIdentity: source.sourceIdentity, duration: source.duration, voiceVariant, segments };
}
