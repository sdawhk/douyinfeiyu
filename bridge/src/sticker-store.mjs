// 表情包索引：只存【引用】，不存图片实体。
//
// 重构原因：之前表情库和图片库各存一份同样的图，10 个表情就占了双份
// （实测 8.26MB x2）。现在改成：
//   - 图片实体只在图片库存一份，按内容哈希寻址（天然去重）
//   - 表情库只记 "关键词 -> 图片库里的文件名"
// 这样同一张图无论存成多少个别名，磁盘上都只有一份。
//
// 存的内容：D:\deepseek\stickers\index.json
// 图片实体：D:\deepseek\images\<日期>\<hash>.<ext>

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { archiveImage, nameFor } from './image-archive.mjs';

const DIR = process.env.STICKER_LIBRARY_ROOT || 'D:\\deepseek\\stickers';
const INDEX = process.env.STICKER_INDEX_PATH || join(DIR, 'index.json');
const ALIASES = process.env.STICKER_ALIAS_PATH || join(DIR, 'aliases.json');
const IMAGE_ROOT = process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images';

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function readIndex() {
  ensureDir();
  try {
    if (!existsSync(INDEX)) return {};
    const j = JSON.parse(readFileSync(INDEX, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function readAliases() {
  try {
    const value = JSON.parse(readFileSync(ALIASES, 'utf8'));
    return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writeIndex(idx) {
  ensureDir();
  writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8');
}

function mimeOf(file) {
  const e = extname(file).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.gif') return 'image/gif';
  if (e === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * 存一个表情关键词，指向图片库里的一张图。
 * @param {string} key  关键词
 * @param {string} b64  图片 base64（用于算哈希、并确保实体已入库）
 * @param {string} mime MIME
 */
export function saveSticker(key, b64, mime = 'image/jpeg', options = {}) {
  // 1) 确保图片实体在图库里（内容哈希去重：已存在就不会再写一次）
  const archived = archiveImage(b64, mime);
  if (!archived) return null;
  // 2) 只记引用，不复制文件
  const idx = readIndex();
  const status = options.status === 'pending' || options.status === 'rejected' ? options.status : 'approved';
  const existing = Object.entries(idx).find(([, record]) => record?.ref === archived.file
    && record.status !== 'pending' && record.status !== 'rejected');
  if (existing) return { ...existing[1], duplicateKey: existing[0] };
  if (status === 'approved') {
    for (const record of Object.values(idx)) {
      if (record?.ref === archived.file) record.status = 'approved';
    }
  }
  idx[key] = {
    ref: archived.file || nameFor(b64, mime),   // 图片库里的文件名
    day: dayOf(archived.path), // 从路径反推日期目录
    mime: mimeOf(archived.path),
    bytes: archived.bytes,
    status,
    at: new Date().toISOString()
  };
  writeIndex(idx);
  return idx[key];
}

/** 从形如 ...\<YYYY-MM-DD>\<hash>.ext 的路径里取出日期目录。 */
function dayOf(path) {
  const parts = path.split('\\');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/**
 * 取表情的本地绝对路径。
 * 兼容旧格式：老记录是 {file}（表情库自存实体），新记录是 {ref}（引用图库）。
 */
export function getStickerPath(key) {
  const idx = readIndex();
  const rec = idx[key];
  if (!rec || rec.status === 'pending' || rec.status === 'rejected') return null;

  // 新格式：引用图片库
  if (rec.ref) {
    const p = join(IMAGE_ROOT, rec.day || '', rec.ref);
    if (existsSync(p)) return p;
    // day 缺失时按日期目录找一遍（向前兼容）
    const found = findInImages(rec.ref);
    if (found) return found;
    return null;
  }
  // 旧格式：表情库自己存的文件
  if (rec.file) {
    const p = join(DIR, rec.file);
    return existsSync(p) ? p : null;
  }
  return null;
}

/** 在图片库所有日期目录里找某个文件名。 */
function findInImages(name) {
  const root = IMAGE_ROOT;
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const p = join(root, d, name);
    try { if (statSync(p).isFile() && existsSync(p)) return p; } catch { /* skip */ }
  }
  return null;
}

export function listStickers() {
  return Object.entries(readIndex())
    .filter(([, record]) => record?.status !== 'pending' && record?.status !== 'rejected')
    .map(([key]) => key).sort();
}

export function listAllStickerKeys() {
  return Object.keys(readIndex()).sort();
}

export function listStickerRecords() {
  return Object.fromEntries(Object.entries(readIndex())
    .filter(([, record]) => record?.status !== 'pending' && record?.status !== 'rejected'));
}

export function findStickerByRef(ref) {
  return Object.entries(readIndex()).find(([, record]) => record?.ref === ref)?.[0] ?? null;
}

export function deleteSticker(key) {
  const idx = readIndex();
  if (!idx[key]) return false;
  delete idx[key];
  writeIndex(idx);
  // 注意：不删图片库实体 —— 图库是永久备份，且可能还被别的表情引用
  return true;
}

/** Remove every sticker alias that points at one archived image. */
export function deleteStickersByRef(ref) {
  const idx = readIndex();
  const removed = Object.entries(idx).filter(([, record]) => record?.ref === ref).map(([key]) => key);
  if (!removed.length) return [];
  for (const key of removed) delete idx[key];
  writeIndex(idx);
  return removed;
}

export function findSticker(keyword) {
  const keys = listStickers();
  const k = String(keyword).trim().toLowerCase();
  if (!k) return null;
  const exact = keys.find((x) => x.toLowerCase() === k);
  if (exact) return exact;
  const aliases = readAliases();
  const oldKey = Object.keys(aliases).find((x) => x.toLowerCase() === k);
  if (oldKey && keys.includes(aliases[oldKey])) return aliases[oldKey];
  const matches = keys.filter((x) => x.toLowerCase().includes(k));
  return matches.length === 1 ? matches[0] : null;
}

/** 关键词转安全名（虽然现在不再作为文件名，但仍用于兼容旧逻辑）。 */
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40) || 'sticker';
}
