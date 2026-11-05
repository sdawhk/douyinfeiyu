import { isExactSongMatch, makeExistingSongClip, makeExistingSongSegments, searchExistingSongs } from './song-cover.mjs';
import {
  applyLiuyingVoiceDetailed, LIUYING_SINGING_VOCAL_PROFILE, LIUYING_SINGING_VOCAL_VARIANT,
  prepareLiuyingSongStems, renderLiuyingSegmentFromStems
} from './rvc-singing.mjs';
import { getSongOutputPath, loadAutoSongOutput, loadSongOutput, saveSongOutput } from './song-output-cache.mjs';
import { resolveSingingPitchPlan } from './rvc-pitch.mjs';
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
  return resolveSingingPitchPlan(settings);
}

function audioOf(result) {
  return Buffer.isBuffer(result) ? result : result?.audio;
}

function shiftOf(result, fallback) {
  return Number.isInteger(result?.pitchShift) ? result.pitchShift : fallback;
}

export async function makePaidSongPreview(query, { getSettings, searchImpl = searchExistingSongs,
  makeClip = makeExistingSongClip, applyVoice = applyLiuyingVoiceDetailed, loadOutput = loadSongOutput,
  loadAutoOutput = loadAutoSongOutput, saveOutput = saveSongOutput, outputPath = getSongOutputPath } = {}) {
  const plan = singingSettings(getSettings);
  const results = await searchImpl(query);
  const exact = results.filter((item) => isExactSongMatch(query, item.title));
  if (!exact.length) throw new Error('没有找到与所点歌名完全匹配的音源，请提供准确歌名');
  for (const source of exact) {
    const base = { query, mode: 'ai', candidate: 1, startSeconds: 30, seconds: 30, sourceIdentity: source.url };
    if (plan.mode === 'auto') {
      const cached = loadAutoOutput(base, { profile: LIUYING_SINGING_VOCAL_PROFILE });
      if (cached) {
        verifyDuration(cached.audio, 30, '缓存试听');
        return { audio: cached.audio, title: cached.title, sourceIdentity: source.url, file: outputPath(base),
          voiceVariant: cached.voiceVariant, pitchShift: cached.pitch ?? 0, pitchMode: 'auto', startSeconds: cached.startSeconds ?? 30 };
      }
    } else {
      const cacheOptions = { ...base, voiceVariant: LIUYING_SINGING_VOCAL_VARIANT(plan.pitch) };
      const cached = loadOutput(cacheOptions);
      if (cached) {
        verifyDuration(cached.audio, 30, '缓存试听');
        return { audio: cached.audio, title: cached.title, sourceIdentity: source.url, file: outputPath(cacheOptions),
          voiceVariant: cacheOptions.voiceVariant, pitchShift: plan.pitch, pitchMode: 'manual', startSeconds: cached.startSeconds ?? 30 };
      }
    }
  }
  const clip = await makeClip(query, { seconds: 30, startSeconds: 30, candidate: 1,
    requireExact: true, searchImpl: async () => exact });
  if (!exact.some((source) => source.url === clip.url)) throw new Error('paid preview source is not in the exact-match candidate list');
  const result = await applyVoice(clip.audio, { pitch: plan.pitch, pitchMode: plan.mode, pitchConfig: plan.config });
  const audio = audioOf(result);
  const shift = shiftOf(result, plan.pitch);
  const voiceVariant = LIUYING_SINGING_VOCAL_VARIANT(shift);
  const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: 30, seconds: 30,
    voiceVariant, sourceIdentity: clip.url, pitch: shift, pitchMode: plan.mode };
  verifyDuration(audio, 30, '流萤试听');
  saveOutput({ ...cacheOptions, title: clip.title, source: clip.source, duration: clip.duration }, audio);
  return { audio, title: clip.title, sourceIdentity: clip.url, file: outputPath(cacheOptions),
    voiceVariant, pitchShift: shift, pitchMode: plan.mode, pitchInfo: result?.pitchInfo ?? null, startSeconds: clip.startSeconds };
}

export async function makePaidFullSong(query, { getSettings, searchImpl = searchExistingSongs,
  makeSegments = makeExistingSongSegments, applyVoice = applyLiuyingVoiceDetailed, loadOutput = loadSongOutput,
  saveOutput = saveSongOutput, outputPath = getSongOutputPath, resume = null,
  prepareStems = prepareLiuyingSongStems, renderSegment = renderLiuyingSegmentFromStems, logger = console } = {}) {
  const plan = singingSettings(getSettings);
  if (resume) {
    if (!resume.sourceIdentity || !resume.title || !resume.voiceVariant || !Array.isArray(resume.segments) || !resume.segments.length) {
      throw new Error('saved full-song order is missing source, voice or segment metadata');
    }
    const voiceVariant = resume.voiceVariant;
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
    const parsedShift = Number.parseInt(/^rvc:(-?\d+):/.exec(voiceVariant)?.[1] ?? '', 10);
    return { title: resume.title, sourceIdentity: resume.sourceIdentity,
      duration: segments.reduce((sum, item) => sum + item.seconds, 0), voiceVariant,
      pitchShift: Number.isInteger(parsedShift) ? parsedShift : plan.pitch, pitchMode: 'resume',
      pitchInfo: null, segments };
  }
  const results = await searchImpl(query);
  const exact = results.filter((item) => isExactSongMatch(query, item.title));
  if (!exact.length) throw new Error('没有找到与所点歌名完全匹配的音源，请提供准确歌名');
  const source = await makeSegments(query, { chunkSeconds: 60, searchImpl: async () => exact });
  if (!exact.some((item) => item.url === source.url) || !source.sourceIdentity) throw new Error('整首音源不在完全匹配候选中或缺少稳定来源标识');
  // 整首只算一次 shift：先分离整首人声/伴奏，检测一次，所有分段复用同一个值。
  let shift = plan.pitch;
  let effectiveMode = plan.mode;
  let pitchInfo = null;
  let stems = null;
  if (plan.mode === 'auto') {
    if (!Buffer.isBuffer(source.sourceAudio)) {
      logger.warn?.('[paid-song] auto pitch skipped: whole-song audio unavailable; using shift=0 for every segment');
      shift = 0;
    } else {
      try {
        stems = await prepareStems(source.sourceAudio, { pitchConfig: plan.config, logger });
        shift = Number.isInteger(stems.pitchShift) ? stems.pitchShift : 0;
        pitchInfo = stems.pitchInfo ?? null;
      } catch (error) {
        logger.warn?.(`[paid-song] whole-song stems failed; falling back to per-segment shift=0: ${error?.message ?? error}`);
        shift = 0;
        stems = null;
      }
    }
  }
  const voiceVariant = LIUYING_SINGING_VOCAL_VARIANT(shift);
  const segments = [];
  try {
    for (const segment of source.segments) {
      const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: segment.startSeconds,
        seconds: segment.seconds, voiceVariant, sourceIdentity: source.sourceIdentity,
        segmentIndex: segment.segmentIndex, pitch: shift, pitchMode: effectiveMode };
      const cached = loadOutput(cacheOptions);
      let audio = cached?.audio;
      if (!audio) {
        if (stems) {
          audio = await renderSegment(stems, { startSeconds: segment.startSeconds,
            seconds: segment.seconds, tag: `segment-${segment.segmentIndex}`, logger });
        } else {
          const result = await applyVoice(segment.audio, { pitch: shift, pitchMode: 'manual', pitchConfig: plan.config });
          audio = audioOf(result);
        }
      }
      verifyDuration(audio, segment.seconds, cached ? '缓存分段' : '流萤分段');
      if (!cached) saveOutput({ ...cacheOptions, title: source.title, source: source.source,
        duration: source.duration }, audio);
      segments.push({ segmentIndex: segment.segmentIndex, startSeconds: segment.startSeconds,
        seconds: segment.seconds, audio, cachePath: outputPath(cacheOptions) });
    }
  } finally {
    if (stems) await stems.close?.();
  }
  return { title: source.title, sourceIdentity: source.sourceIdentity, duration: source.duration,
    voiceVariant, pitchShift: shift, pitchMode: effectiveMode, pitchInfo, segments };
}
