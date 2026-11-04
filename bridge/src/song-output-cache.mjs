import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_ROOT = fileURLToPath(new URL('../state/song-cache/', import.meta.url));
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/雨愛/g, '雨爱')
    .replace(/司[鳳風风]/g, '司凤').replace(/\s+/g, ' ').trim();
}

function comparableSongName(value) {
  return normalized(value).replace(/[\s\p{P}\p{S}]/gu, '');
}

function cacheId({ query, mode, candidate = 1, startSeconds = null, seconds = null, voiceVariant = '', sourceIdentity = '', segmentIndex = null }) {
  const identity = JSON.stringify({ query: normalized(query), mode: normalized(mode), candidate,
    startSeconds, seconds, voiceVariant: normalized(voiceVariant),
    ...(sourceIdentity ? { sourceIdentity: String(sourceIdentity) } : {}),
    ...(segmentIndex == null ? {} : { segmentIndex }) });
  return createHash('sha256').update(identity).digest('hex');
}

function paths(id, root) {
  return { audio: path.join(root, `${id}.mp3`), meta: path.join(root, `${id}.json`) };
}

export function loadSongOutput(options, { root = CACHE_ROOT } = {}) {
  const id = cacheId(options);
  const files = paths(id, root);
  try {
    if (!existsSync(files.audio) || !existsSync(files.meta)) return null;
    const meta = JSON.parse(readFileSync(files.meta, 'utf8'));
    if (meta.id !== id || !Number.isFinite(meta.at) || meta.at > Date.now()) return null;
    const audio = readFileSync(files.audio);
    if (audio.length < 1024 || audio.length > MAX_AUDIO_BYTES) return null;
    if (meta.audioSha256 && meta.audioSha256 !== createHash('sha256').update(audio).digest('hex')) return null;
    return { ...meta, audio };
  } catch { return null; }
}

export function loadSongOutputById(id, { root = CACHE_ROOT } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(id))) return null;
  try {
    const meta = JSON.parse(readFileSync(paths(id, root).meta, 'utf8'));
    if (meta.id !== id || !/^[a-f0-9]{64}$/.test(String(meta.audioSha256 ?? ''))) return null;
    const cached = loadSongOutput(meta, { root });
    return cached?.id === id ? cached : null;
  } catch { return null; }
}

// 歌单只展示已经制作并校验过的流萤翻唱单段；30 秒旧试听不参与。
export function listCachedSongPlaylist({ root = CACHE_ROOT } = {}) {
  let names;
  try { names = readdirSync(root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch { return []; }
  const candidates = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
      if (meta.id !== name.slice(0, -5) || meta.mode !== 'ai'
          || (meta.segmentIndex != null && meta.segmentIndex !== 0) || !meta.query || !meta.title
          || !Number.isFinite(meta.seconds) || meta.seconds <= 30
          || !/^[a-f0-9]{64}$/.test(String(meta.audioSha256 ?? ''))) continue;
      candidates.push(meta);
    } catch { /* 跳过损坏的缓存元数据。 */ }
  }
  candidates.sort((a, b) => Number(b.at) - Number(a.at) || a.id.localeCompare(b.id));
  const songs = [];
  const seen = new Set();
  for (const meta of candidates) {
    const key = comparableSongName(meta.query);
    if (!key || seen.has(key)) continue;
    const cached = loadSongOutputById(meta.id, { root });
    if (!cached) continue;
    songs.push({ id: cached.id, query: cached.query, title: cached.title,
      seconds: cached.seconds, url: cached.url, source: cached.source, duration: cached.duration, at: cached.at });
    seen.add(key);
  }
  return songs;
}

export function findCachedSongInPlaylist(query, options = {}) {
  const key = comparableSongName(query);
  return key ? listCachedSongPlaylist(options).find((song) => comparableSongName(song.query) === key) ?? null : null;
}

// 旧缓存保留原歌名的哈希；仅对现成歌曲做保守的标点别名回查。
// 仍校验模式、片段、音色和音频哈希，不把不同音源的付费分段混用。
export function loadExistingSongOutput(options, { root = CACHE_ROOT } = {}) {
  const exact = loadSongOutput(options, { root });
  if (exact || !['ai', 'original'].includes(options?.mode) || options?.sourceIdentity
      || options?.segmentIndex != null) return exact;
  const query = comparableSongName(options.query);
  if (query.length < 2) return null;
  let names;
  try { names = readdirSync(root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch { return null; }
  const matches = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
      if (meta.id !== name.slice(0, -5) || meta.sourceIdentity || meta.segmentIndex != null
          || comparableSongName(meta.query) !== query || meta.mode !== options.mode
          || Number(meta.candidate ?? 1) !== Number(options.candidate ?? 1)
          || meta.startSeconds !== options.startSeconds || meta.seconds !== options.seconds
          || normalized(meta.voiceVariant) !== normalized(options.voiceVariant)) continue;
      matches.push(meta);
    } catch { /* 损坏的元数据不能作为缓存候选。 */ }
  }
  matches.sort((a, b) => Number(b.at) - Number(a.at));
  for (const meta of matches) {
    const cached = loadSongOutput({ query: meta.query, mode: meta.mode, candidate: meta.candidate,
      startSeconds: meta.startSeconds, seconds: meta.seconds, voiceVariant: meta.voiceVariant }, { root });
    if (cached) return cached;
  }
  return null;
}

export function saveSongOutput(options, audio, { root = CACHE_ROOT } = {}) {
  if (!Buffer.isBuffer(audio) || audio.length < 1024 || audio.length > MAX_AUDIO_BYTES) {
    throw new Error('歌曲缓存音频为空或超过 QQ 语音大小限制');
  }
  const id = cacheId(options);
  mkdirSync(root, { recursive: true });
  const files = paths(id, root);
  const meta = { ...options, id, at: Date.now(), audioSha256: createHash('sha256').update(audio).digest('hex') };
  writeFileSync(files.audio, audio);
  writeFileSync(files.meta, JSON.stringify(meta));
  return meta;
}

export function getSongOutputPath(options, { root = CACHE_ROOT } = {}) {
  return paths(cacheId(options), root).audio;
}
