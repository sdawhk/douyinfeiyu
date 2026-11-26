import { isExactSongMatch, isVocalSongSource, makeExistingSongClip, makeExistingSongSegments, searchExistingSongs } from './song-cover.mjs';
import {
  applyLiuyingVoiceDetailed, LIUYING_SINGING_VOCAL_PROFILE, LIUYING_SINGING_VOCAL_VARIANT,
  prepareLiuyingSongStems, renderLiuyingSegmentFromStems
} from './rvc-singing.mjs';
import { findCachedSongInPlaylist, getSongOutputPath, loadAutoSongOutput, loadAutoSongSegments, loadSongOutput, saveSongOutput } from './song-output-cache.mjs';
import { resolveSingingPitchPlan } from './rvc-pitch.mjs';
import { inspectMp3Duration } from './song-library.mjs';
import { NO_AUDIBLE_VOCALS, STEM_SEPARATION_FAILED, SONG_SOURCE_UNAVAILABLE, canRetrySongSource, songSourceError } from './song-source-errors.mjs';

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
  prepareStems = prepareLiuyingSongStems, renderSegment = renderLiuyingSegmentFromStems,
  findCachedSource = findCachedSongInPlaylist, logger = console } = {}) {
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
  if (plan.mode === 'auto') {
    const cached = loadAutoSongSegments(query, { profile: LIUYING_SINGING_VOCAL_PROFILE });
    if (cached) {
      for (const segment of cached.segments) verifyDuration(segment.audio, segment.seconds, '缓存整首分段');
      logger.info?.(`[paid-song] full cache hit; reusing ${cached.segments.length} segments for ${query}`);
      return { title: cached.title, sourceIdentity: cached.sourceIdentity, duration: cached.duration,
        voiceVariant: cached.voiceVariant, pitchShift: cached.pitchShift, pitchMode: 'auto',
        pitchInfo: null, segments: cached.segments };
    }
  }
  const known = findCachedSource(query);
  const preferred = known?.url && isExactSongMatch(query, known.title) ? known : null;
  let results;
  try { results = await searchImpl(query); }
  catch (error) {
    if (!preferred) throw error;
    logger.warn?.('[paid-song] search unavailable; trying the verified cached song source');
    results = [];
  }
  const seen = new Set();
  const exact = [preferred, ...results].filter((item) => {
    if (!item?.url || seen.has(item.url) || !isExactSongMatch(query, item.title)
        || !isVocalSongSource(query, item.title)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 8);
  if (!exact.length) throw new Error('没有找到与所点歌名完全匹配的演唱音源，请提供准确歌名');
  const failures = [];
  for (const [index, candidate] of exact.entries()) {
    let stems = null;
    try {
      // 每次只允许一个明确来源；无歌声时才能转到下一个，避免同一坏源重做。
      logger.info?.(`[paid-song] full source attempt=${index + 1}/${exact.length} title=${candidate.title} url=${candidate.url}`);
      const source = await makeSegments(query, { chunkSeconds: 60, searchImpl: async () => [candidate] });
      if (source.url !== candidate.url || !source.sourceIdentity) throw new Error('整首音源不在当前完全匹配候选中或缺少稳定来源标识');
      logger.info?.(`[paid-song] full source selected duration=${source.duration}s identity=${source.sourceIdentity}`);
      let shift = plan.pitch;
      let pitchInfo = null;
      if (Buffer.isBuffer(source.sourceAudio)) {
        try {
          stems = await prepareStems(source.sourceAudio, { pitchConfig: plan.config,
            pitchShift: plan.mode === 'auto' ? null : plan.pitch, logger });
          shift = Number.isInteger(stems.pitchShift) ? stems.pitchShift : plan.pitch;
          pitchInfo = stems.pitchInfo ?? null;
        } catch (error) {
          // 无歌声、环境和未知错误不再当成变调失败；仅明确的分离执行失败受控降级。
          if (error.code !== STEM_SEPARATION_FAILED) throw error;
          shift = plan.mode === 'auto' ? 0 : plan.pitch;
          logger.warn?.(`[paid-song] whole-song separator execution failed; trying per-segment conversion shift=${shift}`);
        }
      } else if (plan.mode === 'auto') {
        logger.warn?.('[paid-song] whole-song audio unavailable; using shift=0 for every segment');
        shift = 0;
      }
      const voiceVariant = LIUYING_SINGING_VOCAL_VARIANT(shift);
      const segments = [];
      const pending = [];
      for (const segment of source.segments) {
        const cacheOptions = { query, mode: 'ai', candidate: 1, startSeconds: segment.startSeconds,
          seconds: segment.seconds, voiceVariant, sourceIdentity: source.sourceIdentity,
          segmentIndex: segment.segmentIndex, pitch: shift, pitchMode: plan.mode };
        const cached = loadOutput(cacheOptions);
        let audio = cached?.audio;
        if (!audio) {
          if (stems) audio = await renderSegment(stems, { startSeconds: segment.startSeconds,
            seconds: segment.seconds, tag: `segment-${segment.segmentIndex}`, logger });
          else {
            const result = await applyVoice(segment.audio, { pitch: shift, pitchMode: 'manual', pitchConfig: plan.config });
            audio = audioOf(result);
          }
        }
        verifyDuration(audio, segment.seconds, cached ? '缓存分段' : '流萤分段');
        if (!cached) pending.push({ options: { ...cacheOptions, title: source.title,
          url: source.url, source: source.source, duration: source.duration }, audio });
        segments.push({ segmentIndex: segment.segmentIndex, startSeconds: segment.startSeconds,
          seconds: segment.seconds, audio, cachePath: outputPath(cacheOptions) });
      }
      // 当前候选全部制作完成才提交新增缓存，不把失败候选的半成品当成整首。
      for (const item of pending) saveOutput(item.options, item.audio);
      return { title: source.title, sourceIdentity: source.sourceIdentity, duration: source.duration,
        voiceVariant, pitchShift: shift, pitchMode: plan.mode, pitchInfo, segments };
    } catch (error) {
      if (!canRetrySongSource(error)) throw error;
      failures.push({ title: candidate.title, url: candidate.url, code: error.code });
      logger.warn?.(`[paid-song] full source rejected code=${error.code} title=${candidate.title} url=${candidate.url}; trying next candidate`);
    } finally {
      if (stems) await stems.close?.();
    }
  }
  const noVocals = failures.some((item) => item.code === NO_AUDIBLE_VOCALS);
  throw songSourceError(noVocals ? NO_AUDIBLE_VOCALS : SONG_SOURCE_UNAVAILABLE,
    noVocals ? '已尝试匹配音源，但未取得可用于翻唱的清晰歌声' : '匹配歌曲音源暂时无法下载或核验', { attempts: failures });
}
