import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inspectStickerImage } from './sticker-vision.mjs';

const CACHE_PATH = process.env.IMAGE_VISION_CACHE_PATH || 'D:\\deepseek\\state\\image-vision-cache.json';
let entries;
const pending = new Map();

function cache() {
  if (entries) return entries;
  try { entries = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
  catch { entries = {}; }
  return entries;
}

function save() {
  const keys = Object.keys(entries);
  for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete entries[key];
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const temp = `${CACHE_PATH}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(entries), 'utf8');
  try { renameSync(temp, CACHE_PATH); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

export async function inspectCachedImage(b64, mime, options = {}) {
  const hash = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  const saved = cache()[hash];
  if (saved) return { ...saved, cacheHit: true };
  if (pending.has(hash)) return { ...await pending.get(hash), cacheHit: true };
  const job = inspectStickerImage(b64, mime, options);
  pending.set(hash, job);
  try {
    const result = await job;
    entries[hash] = result;
    try { save(); } catch { /* The next image can still be inspected. */ }
    return result;
  } finally { pending.delete(hash); }
}
