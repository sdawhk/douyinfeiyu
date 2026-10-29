import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMp3Duration } from './song-library.mjs';

const exec = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RVC_ROOT = path.resolve(process.env.SINGING_RVC_DIR || path.join(APP_ROOT, 'state', 'singing-rvc'));
const FFMPEG = process.env.DSH_FFMPEG || path.join(RVC_ROOT, 'ffmpeg', 'bin', 'ffmpeg.exe');
const YTDLP = process.env.DSH_YTDLP || path.join(RVC_ROOT, 'venv', 'Scripts', 'python.exe');
const YTDLP_ARGS = process.env.DSH_YTDLP ? [] : ['-m', 'yt_dlp'];
const SITE_PACKAGES = path.join(RVC_ROOT, 'venv', 'Lib', 'site-packages');
const WORK_ROOT = path.resolve(process.env.SINGING_WORK_DIR || path.join(APP_ROOT, 'state', 'song-cover-work'));
const MAX_CLIP_BYTES = 12 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36';

export function parseExistingSongCommand(text, { botNickname = '', botSelf = '', hasBotMention = false } = {}) {
  let input = String(text ?? '').trim();
  const mention = input.match(/^@([^\s@]+)\s+/);
  if (mention && (hasBotMention || mention[1] === botNickname || mention[1] === botSelf || mention[1] === `QQ${botSelf}`)) {
    input = input.slice(mention[0].length).trim();
  }
  const command = input.match(/^\/?(搜歌|原唱|翻唱|唱歌)(?:\s+|：|:)([\s\S]*)$/);
  if (command) {
    const selected = command[2].trim().match(/^(.*?)(?:\s+#([1-8]))?$/);
    return { mode: { 搜歌: 'search', 原唱: 'original', 翻唱: 'ai', 唱歌: 'ai' }[command[1]],
      song: selected[1].trim().slice(0, 80), candidate: Number(selected[2] || 1),
      ...(selected[2] ? { candidateExplicit: true } : {}) };
  }
  const titled = input.match(/^(?:(?:我想听(?:你)?|想听(?:你)?|给我|帮我|给大家|帮大家)\s*)?唱(?:一首|首|个)?\s*[《「]([^》」]+)[》」](?:吧|呗|呀|啊)?$/);
  if (titled) return { mode: 'ai', song: titled[1].trim().slice(0, 80), candidate: 1 };
  if (/^(?:给我唱首歌|我想听你唱歌|唱首歌|唱一首歌|唱歌)$/.test(input)) return { mode: 'ai', song: '', candidate: 1 };
  const natural = input.match(/^(?<modal>(?:可以|能|可不可以|能不能|麻烦)\s*)?(?<addressee>(?:给我|帮我|给大家|帮大家|我想让你|我想听你|想听你)\s*)?(?<voice>用语音\s*)?(?<verb>唱|来)(?<singword>歌唱|歌)?(?<measure>一首|首|个|一下|一段|段)?\s*(?:(?<seconds>\d{1,3})\s*秒(?:钟)?\s*)?(?<song>.+)$/);
  if (natural) {
    const { modal, addressee, voice, verb, singword, measure, seconds: duration, song: requestedSong } = natural.groups;
    if (verb === '来' && !modal && !addressee && !voice && !singword && !measure && !duration) return null;
    if (singword === '歌' && !modal && !addressee && !voice && !measure && !duration) return null;
    if (!modal && !addressee && !voice && !measure && !duration &&
        (!/^[\p{Script=Han}a-zA-Z0-9·_-]{2,20}$/u.test(requestedSong.trim()) || /^(?:什么|怎么|为啥|为什么|得|的|到|了|过|不|出来|起来|下去|完|好听|难听|那么|这么)/.test(requestedSong))) return null;
    const song = requestedSong.trim().replace(/[吗呢吧呗呀啊]?[？?!！。]+$/, '').replace(/[吗呢吧呗呀啊]$/, '')
      .replace(/(?:的|这首)(?:歌|歌曲)$/, '').trim();
    const title = song === '歌' || song === '歌曲' ? '' : song;
    if (/^(?:什么|怎么|哪首|这个|那个|歌词|一下|一首|歌|歌曲)$/.test(title)
        || (title && (title.length < 2 || title.length > 40))) return null;
    const seconds = duration ? Number(duration) : undefined;
    if (seconds !== undefined && (seconds < 5 || seconds > 240)) return null;
    return { mode: 'ai', song: title.slice(0, 80), candidate: 1, ...(seconds === undefined ? {} : { seconds }) };
  }
  return null;
}

export function parseRecentSongReplayRequest(text, { hasBotMention = false } = {}) {
  let input = String(text ?? '').trim();
  if (hasBotMention) input = input.replace(/^@[^\s@]+\s+/, '').trim();
  const anotherGroup = input.match(/^(?:这个群|本群|这里)(?:也)?来一首\s*(.+?)(?:吧|呀|啊)?[！!。.]?$/);
  if (anotherGroup) return { song: anotherGroup[1].trim().slice(0, 80) };
  if (/^(?:唱出来|用语音唱出来|再发一遍|重发刚才那首|把刚才那首发出来)[！!。.]?$/.test(input)) return { song: '' };
  if (/^唱(?:下一段|后面一段|接下来一段)[！!。.]?$/.test(input)) return { song: '', continuation: true };
  const continuation = input.match(/^(?:再来|再唱|接着唱)(?:一段|一首|段)?(?:语音)?(?:的)?(?:可以)?(?:直接)?(?:发)?\s*(?:(\d{1,3})\s*秒(?:钟)?(?:的)?(?:一段|段)?)?(?:吗)?(?:吧|呀|啊)?[？?！!。.]?$/);
  if (continuation) {
    const seconds = continuation[1] === undefined ? undefined : Number(continuation[1]);
    if (seconds !== undefined && (seconds < 5 || seconds > 240)) return null;
    return { song: '', continuation: true, ...(seconds === undefined ? {} : { seconds }) };
  }
  const namedContinuation = input.match(/^唱(.+?)(?:的)?(?:下一段|后面一段|接下来一段)[！!。.]?$/);
  if (namedContinuation) return { song: namedContinuation[1].trim().slice(0, 80), continuation: true };
  const titledContinuation = input.match(/^再来一段(?:语音)?的(.+?)[！!。.]?$/);
  if (titledContinuation) return { song: titledContinuation[1].trim().slice(0, 80), continuation: true };
  if (input.length <= 80 && /刚才|刚刚|上一首|那首/.test(input)
      && /歌|歌曲|翻唱|生成|唱/.test(input)
      && /发出来|发过来|发到|发在|放到|放在|再发/.test(input)) return { song: '' };
  return null;
}

function parseClock(value) {
  const parts = String(value ?? '').split(':');
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function cleanTitle(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160);
}

function normalizeSongText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/雨愛/g, '雨爱').replace(/司[鳳風风]/g, '司凤');
}

function songKeywords(query) {
  const normalized = normalizeSongText(query).replace(/[《》「」【】()（）]/g, ' ').trim();
  const version = normalized.match(/^(?:司凤\s*版\s*(.+)|(.+?)\s*司凤\s*版)$/u);
  if (version) {
    const base = (version[1] || version[2]).match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) ?? [];
    return [...base, '司凤'];
  }
  return (normalized.replace(/(?:remix|dj|抖音|版本?|原唱|翻唱)/g, ' ')
    .match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu) ?? []);
}

export function isExactSongMatch(query, title) {
  const keywords = songKeywords(query);
  if (keywords.at(-1) === '司凤' && keywords.length > 1) {
    const compact = normalizeSongText(title).replace(/[^\p{Script=Han}a-z0-9]/gu, '');
    const base = keywords.slice(0, -1).join('');
    return compact.includes(`${base}司凤版`) || compact.includes(`司凤版${base}`);
  }
  const core = keywords.at(-1);
  if (!core) return false;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s\\-—《「【(（])${escaped}(?=$|[\\s\\-—》」】)）(（]|dj|remix|版)`, 'iu')
    .test(normalizeSongText(title));
}

const NOT_VOCAL_SONG = /伴奏|纯音乐|無人聲|无人声|卡拉\s*ok|karaoke|instrumental|off[\s-]?vocal|\bktv\b|导唱|導唱|翻弹|翻彈|钢琴演奏|鋼琴演奏/i;
const NOT_SONG_VIDEO = /短剧|短劇|全集|电视剧|電視劇|电影解说|電影解說|剧情解说|劇情解說|广播剧|廣播劇|有声书|有聲書|解说|解說|教程|教学|教學|reaction|歌单|歌單|串烧|串燒|合集/i;

function reliableSongResults(query, entries, limit) {
  const keywords = songKeywords(query);
  if (!keywords.length) return [];
  const wantsDj = /(?:dj|remix)/i.test(query);
  return entries.map((entry, index) => {
    const title = normalizeSongText(entry.title);
    const hits = keywords.filter((word) => title.includes(word)).length;
    if (!hits || (keywords.includes('司凤') && hits !== keywords.length)
        || (wantsDj && !/(?:dj|remix|电音|電音|电摇|電搖)/i.test(title))
        || NOT_VOCAL_SONG.test(title) || NOT_SONG_VIDEO.test(title)
        || (entry.duration != null && (entry.duration < 45 || entry.duration > 900))) return null;
    const score = hits * 10 + (isExactSongMatch(query, title) ? 30 : 0)
      + (/(?:dj|remix)/i.test(query) && /(?:dj|remix)/i.test(title) ? 5 : 0)
      + (/官方|原唱|演唱|mv|歌詞|歌词|完整版/i.test(title) ? 2 : 0);
    return { entry, score, index };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(({ entry }, index, ranked) => ranked.findIndex((item) => item.entry.title === entry.title) === index)
    .slice(0, limit).map(({ entry }) => entry);
}

function allowedVideoUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      (host === 'www.bilibili.com' && /^\/video\/BV[\w]+\/?$/.test(url.pathname))
      || (['www.youtube.com', 'youtube.com'].includes(host) && url.pathname === '/watch')
      || (host === 'youtu.be' && /^\/[\w-]+$/.test(url.pathname))
    );
  } catch { return false; }
}

async function run(file, args, timeout = 120_000) {
  const env = { ...process.env, PYTHONPATH: [SITE_PACKAGES, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  try {
    const { stdout } = await exec(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env });
    return stdout;
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`${path.basename(file)} 执行失败：${detail}`);
  }
}

export async function searchExistingSongs(query, { fetchImpl = fetch, runImpl = run, limit = 5 } = {}) {
  const song = String(query ?? '').trim().slice(0, 80);
  if (!song) throw new Error('请提供歌名');
  const searchSong = normalizeSongText(song);
  const errors = [];
  let partialMatches = [];
  const exactBySource = [];
  const rememberResults = (results) => {
    const exact = results.filter((item) => isExactSongMatch(song, item.title));
    if (exact.length) exactBySource.push(exact);
    else if (results.length && !partialMatches.length) partialMatches = results;
  };
  try {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(searchSong)}&page=1`;
    const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.code !== 0) throw new Error(`code=${body.code}`);
    const results = (body.data?.result ?? []).filter((item) => /^BV[\w]+$/.test(String(item.bvid ?? '')))
      .map((item) => ({ title: cleanTitle(item.title), url: `https://www.bilibili.com/video/${item.bvid}`,
        duration: parseClock(item.duration), source: 'bilibili' })).filter((item) => item.title);
    rememberResults(reliableSongResults(song, results, limit));
  } catch (error) { errors.push(`B站接口：${error.message}`); }
  for (const [prefix, source] of [[`bilisearch${Math.max(limit * 3, 10)}:`, 'bilibili'], [`ytsearch${Math.max(limit * 3, 10)}:`, 'youtube']]) {
    try {
      const raw = await runImpl(YTDLP, [...YTDLP_ARGS, '--no-warnings', '--ignore-errors', '--flat-playlist', '-J', `${prefix}${searchSong}`], 120_000);
      const entries = JSON.parse(raw).entries ?? [];
      const results = entries.filter(Boolean).map((item) => ({ title: cleanTitle(item.fulltitle || item.title),
        url: String(item.webpage_url || item.url || ''), duration: item.duration == null ? null : Number(item.duration),
        source })).filter((item) => item.title && allowedVideoUrl(item.url));
      rememberResults(reliableSongResults(song, results, limit));
    } catch (error) { errors.push(`${source}：${error.message}`); }
  }
  if (exactBySource.length) {
    const merged = [];
    const seen = new Set();
    for (let index = 0; merged.length < limit; index++) {
      let added = false;
      for (const sourceResults of exactBySource) {
        const item = sourceResults[index];
        if (!item || seen.has(item.url)) continue;
        seen.add(item.url);
        merged.push(item);
        added = true;
        if (merged.length >= limit) break;
      }
      if (!added) break;
    }
    return merged;
  }
  if (partialMatches.length) return partialMatches;
  throw new Error(`没有找到歌名匹配、含人声的歌曲录音${errors.length ? `（${errors.join('；')}）` : ''}`);
}

export async function makeExistingSongClip(query, { seconds = 60, startSeconds = 30, candidate = 1,
  fetchImpl = fetch, runImpl = run, searchImpl = searchExistingSongs,
  requireExact = false, ffmpeg = FFMPEG, ytdlp = YTDLP, ytdlpArgs = YTDLP_ARGS } = {}) {
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 240) throw new Error('片段长度须在 5–240 秒之间');
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 3600) throw new Error('起始时间无效');
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 8) throw new Error('候选序号无效');
  if (!existsSync(ffmpeg)) throw new Error(`缺少 ffmpeg：${ffmpeg}`);
  if (!existsSync(ytdlp)) throw new Error(`缺少 yt-dlp 运行环境：${ytdlp}`);
  const results = await searchImpl(query, { fetchImpl, runImpl, limit: Math.max(5, candidate) });
  const eligible = requireExact ? results.filter((item) => isExactSongMatch(query, item.title)) : results;
  const picked = eligible[candidate - 1];
  if (!picked || !allowedVideoUrl(picked.url)) throw new Error('没有找到可下载的歌曲候选');
  const candidates = [picked, ...results.filter((item, index) => index !== candidate - 1
    && allowedVideoUrl(item.url) && isExactSongMatch(query, item.title))];
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'song-cover-'));
  try {
    let sourceFile = '';
    let selected = null;
    for (let index = 0; index < candidates.length; index++) {
      const item = candidates[index];
      const attemptDir = path.join(work, `candidate-${index + 1}`);
      await mkdir(attemptDir, { recursive: true });
      const template = path.join(attemptDir, 'source.%(ext)s');
      try {
        await runImpl(ytdlp, [...ytdlpArgs, '--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-x',
          '--audio-format', 'mp3', '--audio-quality', '5', '--ffmpeg-location', path.dirname(ffmpeg), '-o', template, item.url], 300_000);
        const files = await readdir(attemptDir);
        const source = files.find((name) => name === 'source.mp3');
        if (!source) throw new Error('下载完成但没有找到歌曲音频');
        sourceFile = path.join(attemptDir, source);
        selected = item;
        break;
      } catch (error) {
        console.warn(`[song-cover] download candidate ${index + 1}/${candidates.length} failed:`, item.source, item.title, error?.message ?? error);
      }
    }
    if (!selected) throw new Error(`所有 ${candidates.length} 个匹配音源都无法下载`);
    const clip = path.join(work, 'clip.mp3');
    const start = selected.duration ? Math.min(startSeconds, Math.max(0, selected.duration - seconds)) : startSeconds;
    await runImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(seconds),
      '-i', sourceFile, '-ar', '44100', '-ac', '2', '-b:a', '192k', clip], 120_000);
    const size = (await stat(clip)).size;
    if (size < 1024 || size > MAX_CLIP_BYTES) throw new Error('歌曲片段为空或超过 QQ 语音大小限制');
    return { audio: await readFile(clip), title: selected.title, source: selected.source, url: selected.url,
      duration: selected.duration, seconds, startSeconds: start };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function makeExistingSongSegments(query, { chunkSeconds = 60, fetchImpl = fetch, runImpl = run,
  searchImpl = searchExistingSongs, ffmpeg = FFMPEG, ytdlp = YTDLP, ytdlpArgs = YTDLP_ARGS } = {}) {
  if (!Number.isInteger(chunkSeconds) || chunkSeconds < 15 || chunkSeconds > 60) throw new Error('整首分段长度须在 15–60 秒之间');
  if (!existsSync(ffmpeg)) throw new Error(`缺少 ffmpeg：${ffmpeg}`);
  if (!existsSync(ytdlp)) throw new Error(`缺少 yt-dlp 运行环境：${ytdlp}`);
  const results = await searchImpl(query, { fetchImpl, runImpl, limit: 8 });
  const candidates = results.filter((item) => allowedVideoUrl(item.url) && isExactSongMatch(query, item.title));
  if (!candidates.length) throw new Error('没有找到与所点歌名完全匹配的歌曲音源');
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'song-full-'));
  try {
    let sourceFile = '';
    let selected = null;
    let duration = null;
    for (let index = 0; index < candidates.length; index++) {
      const item = candidates[index];
      const attemptDir = path.join(work, `candidate-${index + 1}`);
      await mkdir(attemptDir, { recursive: true });
      try {
        await runImpl(ytdlp, [...ytdlpArgs, '--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-x',
          '--audio-format', 'mp3', '--audio-quality', '5', '--ffmpeg-location', path.dirname(ffmpeg),
          '-o', path.join(attemptDir, 'source.%(ext)s'), item.url], 300_000);
        const file = path.join(attemptDir, 'source.mp3');
        if (!existsSync(file)) throw new Error('下载完成但没有找到歌曲音频');
        const audio = await readFile(file);
        const measured = inspectMp3Duration(audio);
        if (!Number.isFinite(measured) || measured < 60 || measured > 900) throw new Error('下载音源不完整、超出支持时长或时长无法核验');
        if (Number.isFinite(item.duration) && Math.abs(measured - item.duration) > Math.max(8, item.duration * 0.08)) {
          throw new Error(`下载音源时长 ${measured.toFixed(1)} 秒与搜索时长 ${item.duration} 秒差异过大`);
        }
        await runImpl(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], 300_000);
        sourceFile = file;
        selected = item;
        duration = measured;
        break;
      } catch (error) {
        console.warn(`[song-cover] full source candidate ${index + 1}/${candidates.length} failed:`, item.source, item.title, error?.message ?? error);
      }
    }
    if (!selected) throw new Error(`所有 ${candidates.length} 个完全匹配音源都无法完整核验或下载`);
    const count = Math.ceil(duration / chunkSeconds);
    const tailSeconds = duration - (count - 1) * chunkSeconds;
    const secondLastSeconds = tailSeconds < 5 && count > 1
      ? chunkSeconds - (5 - tailSeconds) : chunkSeconds;
    const segments = [];
    let nextStartSeconds = 0;
    for (let segmentIndex = 0; segmentIndex < count; segmentIndex++) {
      const startSeconds = nextStartSeconds;
      const seconds = segmentIndex === count - 2 ? secondLastSeconds
        : Math.min(chunkSeconds, duration - startSeconds);
      nextStartSeconds += seconds;
      if (seconds < 5 && segments.length) {
        const previous = segments.pop();
        const mergedSeconds = previous.seconds + seconds;
        const output = path.join(work, `segment-${previous.segmentIndex}.mp3`);
        await runImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(previous.startSeconds),
          '-t', String(mergedSeconds), '-i', sourceFile, '-ar', '44100', '-ac', '2', '-b:a', '192k', output], 180_000);
        const audio = await readFile(output);
        if (audio.length < 1024 || audio.length > MAX_CLIP_BYTES) throw new Error(`合并后的第 ${previous.segmentIndex + 1} 段为空或超过 QQ 语音大小限制`);
        const actual = inspectMp3Duration(audio);
        if (!Number.isFinite(actual) || Math.abs(actual - mergedSeconds) > 0.5) throw new Error(`第 ${previous.segmentIndex + 1} 段时长未通过校验`);
        segments.push({ segmentIndex: previous.segmentIndex, startSeconds: previous.startSeconds, seconds: mergedSeconds, audio });
        continue;
      }
      const output = path.join(work, `segment-${segmentIndex}.mp3`);
      await runImpl(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startSeconds), '-t', String(seconds),
        '-i', sourceFile, '-ar', '44100', '-ac', '2', '-b:a', '192k', output], 180_000);
      const audio = await readFile(output);
      if (audio.length < 1024 || audio.length > MAX_CLIP_BYTES) throw new Error(`第 ${segmentIndex + 1} 段为空或超过 QQ 语音大小限制`);
      const actual = inspectMp3Duration(audio);
      if (!Number.isFinite(actual) || Math.abs(actual - seconds) > 0.5) throw new Error(`第 ${segmentIndex + 1} 段时长未通过校验`);
      segments.push({ segmentIndex, startSeconds, seconds, audio });
    }
    const sourceHash = createHash('sha256').update(await readFile(sourceFile)).digest('hex');
    return { title: selected.title, source: selected.source, url: selected.url, sourceIdentity: `${selected.url}#sha256=${sourceHash}`, duration, segments };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
