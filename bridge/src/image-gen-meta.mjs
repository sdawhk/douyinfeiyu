// 自绘图的元数据读写：落盘时写同名 .json，之后按文件名或 sha256 反查，
// 让模型在上下文里再遇到这张图时知道“这是我自己画的”。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_META_SCHEMA = 1;
export const IMAGE_STATE_ROOT = fileURLToPath(new URL('../state/imagegen/', import.meta.url));

const GENERATED_FILE = /^gen-\d+-[0-9a-f]{8}\.[a-z0-9]+$/i;

export function sha256Of(buffer) {
  return createHash('sha256').update(Buffer.from(buffer ?? [])).digest('hex');
}

export function metaPathFor(filePath) {
  return join(dirname(filePath), `${basename(filePath, extname(filePath))}.json`);
}

/** 写一条元数据；返回 .json 的绝对路径。 */
export function writeImageMeta(filePath, meta = {}) {
  const target = metaPathFor(filePath);
  mkdirSync(dirname(target), { recursive: true });
  const payload = { schemaVersion: IMAGE_META_SCHEMA, ...meta, file: basename(filePath), path: filePath };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

export function readImageMeta(filePath) {
  const target = metaPathFor(filePath);
  if (!existsSync(target)) return null;
  try {
    const value = JSON.parse(readFileSync(target, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function listMetaFiles(root) {
  const out = [];
  let days = [];
  try { days = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dir = join(root, day.name);
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) if (file.isFile() && file.name.endsWith('.json')) out.push(join(dir, file.name));
  }
  return out;
}

function readMetaFile(metaPath) {
  try {
    const value = JSON.parse(readFileSync(metaPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 按文件名或 sha256 找到自绘图元数据。先按文件名（只认 gen-* 格式）匹配，
 * 再按内容 hash 兜底（QQ 重新托管的图片文件名会变，但字节通常不变）。
 */
export function findImageMeta({ file = '', sha256 = '', root = IMAGE_STATE_ROOT } = {}) {
  const name = file ? basename(String(file).split(/[?#]/)[0]) : '';
  const metas = listMetaFiles(root);
  if (name && GENERATED_FILE.test(name)) {
    for (const metaPath of metas) {
      const meta = readMetaFile(metaPath);
      if (meta && (meta.file === name || metaPath.endsWith(`${basename(name, extname(name))}.json`))) return meta;
    }
  }
  const hash = String(sha256 ?? '').trim().toLowerCase();
  if (hash) {
    for (const metaPath of metas) {
      const meta = readMetaFile(metaPath);
      if (meta && String(meta.sha256 ?? '').toLowerCase() === hash) return meta;
    }
  }
  return null;
}

function formatLocalTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 生成注入模型上下文的来源标记；没有元数据时返回空串。 */
export function formatSelfDrawnTag(meta, { maxPrompt = 60 } = {}) {
  if (!meta || typeof meta !== 'object') return '';
  const prompt = String(meta.description || meta.prompt || '').replace(/\s+/g, ' ').trim();
  if (!prompt) return '';
  const clipped = [...prompt].length > maxPrompt ? `${[...prompt].slice(0, maxPrompt).join('')}…` : prompt;
  const time = formatLocalTime(meta.createdAt);
  return `[我自己画的图${time ? `｜${time}` : ''}｜提示词：${clipped}]`;
}
