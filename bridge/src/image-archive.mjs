// 自动图库：收到图片就把【原图】缓存到本地，防止以后链接失效取不回来。
//
// 背景：QQ 的图片下载链接带 rkey 鉴权，会过期。实测一张几小时前的图
// 再取就只剩 70 字节的 1x1 占位图了。所以"收到时立刻存原图"是唯一
// 能保证长期可用的办法 —— 发过就等于已经存下一半。
//
// 存储：D:\deepseek\images\<YYYY-MM-DD>\<hash>.<ext>

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images';

function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function extFor(mime) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

/** 按解码后的图片字节计算哈希，避免 base64 表示差异造成重复文件。 */
function hashOf(b64) {
  return createHash('sha1').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);
}

/** 按内容哈希算出的文件名（供表情库引用，不重复存实体）。 */
export function nameFor(b64, mime) {
  return `${hashOf(b64)}.${extFor(mime || 'image/jpeg')}`;
}

/**
 * 缓存一张图片原图。
 * @returns {string|null} 本地绝对路径；已存在或失败时也能返回已有路径
 */
export function archiveImage(b64, mime) {
  try {
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return null;
    const day = dayKey();
    const dir = join(ROOT, day);
    ensure(dir);
    const name = `${hashOf(b64)}.${extFor(mime || 'image/jpeg')}`;
    const path = join(dir, name);
    if (existsSync(path)) return { path, file: name, fresh: false, bytes: statSync(path).size };

    // 查找旧版本按 base64 字符串命名的存档，避免升级后重复写入历史图片。
    const legacyStem = createHash('sha1').update(b64).digest('hex').slice(0, 16);
    if (existsSync(ROOT)) {
      for (const folder of readdirSync(ROOT, { withFileTypes: true })) {
        if (!folder.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(folder.name)) continue;
        const candidates = readdirSync(join(ROOT, folder.name)).filter((file) =>
          new RegExp(`^(?:${hashOf(b64)}|${legacyStem})\\.(?:jpg|jpeg|png|gif|webp)$`, 'i').test(file));
        for (const candidateName of candidates) {
          const candidate = join(ROOT, folder.name, candidateName);
          if (statSync(candidate).isFile() && statSync(candidate).size === bytes.length) {
            return { path: candidate, file: candidateName, fresh: false, bytes: bytes.length };
          }
        }
      }
    }

    writeFileSync(path, bytes);
    return { path, file: name, fresh: true, bytes: bytes.length };
  } catch {
    return null;
  }
}

/**
 * 列出最近缓存的图片（按天倒序）。
 * @param {number} days 回溯天数
 */
export function listArchived(days = 2) {
  if (!existsSync(ROOT)) return [];
  const out = [];
  const dirs = readdirSync(ROOT).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse().slice(0, days);
  for (const d of dirs) {
    const dir = join(ROOT, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      out.push({ path: p, day: d, file: f, bytes: statSync(p).size });
    }
  }
  return out;
}

/** Move an archived image out of the active gallery without irreversibly deleting it. */
export function quarantineArchivedImage(day, file) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))
    || !/^[a-f0-9]{16}\.(?:jpg|jpeg|png|gif|webp)$/i.test(String(file))) return null;
  const source = join(ROOT, day, file);
  if (!existsSync(source)) return null;
  const targetDir = join(ROOT, '.quarantine', 'automatic-private-image-cleanup', day);
  const target = join(targetDir, file);
  try {
    ensure(targetDir);
    if (existsSync(target)) return null;
    renameSync(source, target);
    return target;
  } catch {
    return null;
  }
}

/** 读某张缓存图为 base64（供转发/存档用）。 */
export function readArchived(path) {
  try {
    return readFileSync(path).toString('base64');
  } catch {
    return null;
  }
}

/** 按文件名的 hash 前缀找一张缓存图。 */
export function findArchived(hashPrefix) {
  const all = listArchived(30);
  return all.find((x) => x.file.startsWith(hashPrefix)) ?? null;
}

/** Locate an exact content-addressed image even when it was archived long ago. */
export function findArchivedByName(file) {
  const name = String(file ?? '');
  if (!/^[a-f0-9]{16}\.(?:jpg|jpeg|png|gif|webp)$/i.test(name) || !existsSync(ROOT)) return null;
  for (const folder of readdirSync(ROOT, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    const path = join(ROOT, folder.name, name);
    try {
      const info = statSync(path);
      if (info.isFile()) return { path, day: folder.name, file: name, bytes: info.size };
    } catch { /* continue searching */ }
  }
  return null;
}
