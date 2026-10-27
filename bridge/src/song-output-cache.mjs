import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_ROOT = fileURLToPath(new URL('../state/song-cache/', import.meta.url));
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/雨愛/g, '雨爱')
    .replace(/司[鳳風风]/g, '司凤').replace(/\s+/g, ' ').trim();
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
