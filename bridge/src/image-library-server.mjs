import http from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.IMAGE_LIBRARY_PORT || 18902);
const IMAGE_ROOT = path.resolve(process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images');
const STICKER_INDEX = path.resolve(process.env.STICKER_INDEX_PATH || 'D:\\deepseek\\stickers\\index.json');
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'image-library.html');
const PAGE_SIZE_MAX = 72;
const IMAGE_NAME = /^[a-f0-9]{16}\.(?:jpg|jpeg|png|gif|webp)$/i;
let mutationQueue = Promise.resolve();

const mimeTypes = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp'
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

function readIndex() {
  if (!existsSync(STICKER_INDEX)) return {};
  const value = JSON.parse(readFileSync(STICKER_INDEX, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('表情索引格式异常');
  }
  return value;
}

function writeIndexAtomic(index) {
  const temp = `${STICKER_INDEX}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(index, null, 2), 'utf8');
  try {
    renameSync(temp, STICKER_INDEX);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* temporary file may already be gone */ }
    throw error;
  }
}

function archiveFiles() {
  if (!existsSync(IMAGE_ROOT)) return { rows: [], index: readIndex() };
  const index = readIndex();
  const tagsByImage = new Map();
  for (const [tag, record] of Object.entries(index)) {
    if (!record || typeof record.ref !== 'string' || !IMAGE_NAME.test(record.ref)) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(record.day || '') ? record.day : '';
    const key = `${day}/${record.ref}`;
    const tags = tagsByImage.get(key) || [];
    tags.push(tag);
    tagsByImage.set(key, tags);
  }

  const rows = [];
  for (const folder of readdirSync(IMAGE_ROOT, { withFileTypes: true })) {
    if (!folder.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(folder.name)) continue;
    const dayPath = path.join(IMAGE_ROOT, folder.name);
    for (const entry of readdirSync(dayPath, { withFileTypes: true })) {
      if (!entry.isFile() || !IMAGE_NAME.test(entry.name)) continue;
      const fullPath = path.join(dayPath, entry.name);
      const stat = statSync(fullPath);
      rows.push({
        day: folder.name,
        file: entry.name,
        bytes: stat.size,
        modified: stat.mtime.toISOString(),
        tags: tagsByImage.get(`${folder.name}/${entry.name}`) || []
      });
    }
  }
  rows.sort((a, b) => b.day.localeCompare(a.day) || b.modified.localeCompare(a.modified) || a.file.localeCompare(b.file));
  return { rows, index };
}

function safeImagePath(day, file) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !IMAGE_NAME.test(file)) return null;
  const folder = path.resolve(IMAGE_ROOT, day);
  if (path.dirname(folder) !== IMAGE_ROOT) return null;
  const target = path.resolve(folder, file);
  if (path.dirname(target) !== folder) return null;
  return target;
}

function validTags(input) {
  if (!Array.isArray(input)) return null;
  const tags = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const tag = raw.trim();
    if (!tag) continue;
    if ([...tag].length > 40 || /[\u0000-\u001f\u007f]/.test(tag)) return null;
    const normalized = tag.toLocaleLowerCase('zh-CN');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      tags.push(tag);
    }
  }
  return tags;
}

function serialMutation(fn) {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.catch(() => {});
  return next;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw Object.assign(new Error('请求内容太大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求 JSON 格式无效'), { status: 400 }); }
}

function sameImage(record, day, file) {
  return record && record.ref === file && (!record.day || record.day === day);
}

function aliasesFor(index, day, file) {
  return Object.keys(index).filter((key) => sameImage(index[key], day, file));
}

function requireLocalOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const port = server.address()?.port ?? PORT;
  if (!origin || !new RegExp(`^(?:127\\.0\\.0\\.1|localhost):${port}$`, 'i').test(host || '')) return false;
  return origin === `http://${host}`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/') {
    if (!existsSync(PAGE)) return json(res, 500, { error: '图片管理页面文件不存在' });
    const body = readFileSync(PAGE);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    return res.end(body);
  }

  if (req.method === 'GET' && url.pathname === '/api/images') {
    try {
      const { rows, index } = archiveFiles();
      const q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('zh-CN');
      const day = url.searchParams.get('day') || '';
      const sort = url.searchParams.get('sort') || 'newest';
      let filtered = rows.filter((row) => (!day || row.day === day)
        && (!q || `${row.file} ${row.day} ${row.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(q)));
      if (sort === 'largest') filtered.sort((a, b) => b.bytes - a.bytes || b.day.localeCompare(a.day));
      const total = filtered.length;
      const pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, Number(url.searchParams.get('limit')) || 48));
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.max(1, Math.min(pages, Number(url.searchParams.get('page')) || 1));
      const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
      const days = [...new Set(rows.map((row) => row.day))].sort().reverse();
      return json(res, 200, {
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        page, pageSize, total, pages,
        stats: { total: rows.length, bytes: totalBytes, aliases: Object.keys(index).length, days: days.length },
        days
      });
    } catch (error) {
      return json(res, 500, { error: error.message || '读取图片库失败' });
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    let parts;
    try { parts = url.pathname.slice('/media/'.length).split('/').map(decodeURIComponent); }
    catch { return json(res, 400, { error: '图片地址无效' }); }
    if (parts.length !== 2) return json(res, 404, { error: '图片不存在' });
    const target = safeImagePath(parts[0], parts[1]);
    if (!target || !existsSync(target)) return json(res, 404, { error: '图片不存在' });
    const stat = statSync(target);
    const etag = `W/\"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}\"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'private, max-age=3600' });
      return res.end();
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'private, max-age=3600',
      etag,
      'x-content-type-options': 'nosniff'
    });
    return createReadStream(target).pipe(res);
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/images/')) {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机页面修改图片库' });
    let parts;
    try { parts = url.pathname.slice('/api/images/'.length).split('/').map(decodeURIComponent); }
    catch { return json(res, 400, { error: '图片地址无效' }); }
    if (parts.length !== 2) return json(res, 404, { error: '图片不存在' });
    const [day, file] = parts;
    const target = safeImagePath(day, file);
    if (!target || !existsSync(target)) return json(res, 404, { error: '图片不存在' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    const tags = validTags(body.tags);
    if (!tags) return json(res, 400, { error: '关键词需为文本，且每个不超过 40 个字符' });

    try {
      return await serialMutation(() => {
        const index = readIndex();
        for (const tag of tags) {
          const existing = index[tag];
          if (existing && !sameImage(existing, day, file)) {
            return json(res, 409, { error: `关键词“${tag}”已用于另一张图片` });
          }
        }
        for (const key of aliasesFor(index, day, file)) delete index[key];
        const ext = path.extname(file).toLowerCase();
        const mime = mimeTypes[ext] || 'image/jpeg';
        const bytes = statSync(target).size;
        for (const tag of tags) index[tag] = { ref: file, day, mime, bytes, at: new Date().toISOString() };
        writeIndexAtomic(index);
        return json(res, 200, { ok: true, tags });
      });
    } catch (error) {
      return json(res, 500, { error: error.message || '保存图片关键词失败' });
    }
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/images/')) {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机页面修改图片库' });
    let parts;
    try { parts = url.pathname.slice('/api/images/'.length).split('/').map(decodeURIComponent); }
    catch { return json(res, 400, { error: '图片地址无效' }); }
    if (parts.length !== 2) return json(res, 404, { error: '图片不存在' });
    const [day, file] = parts;
    const target = safeImagePath(day, file);
    if (!target || !existsSync(target)) return json(res, 404, { error: '图片不存在' });

    try {
      return await serialMutation(() => {
        const index = readIndex();
        const removed = aliasesFor(index, day, file);
        const next = { ...index };
        const otherCopy = readdirSync(IMAGE_ROOT, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== day && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
          .map((entry) => ({ day: entry.name, path: path.join(IMAGE_ROOT, entry.name, file) }))
          .find((entry) => existsSync(entry.path));
        if (otherCopy) {
          for (const tag of removed) next[tag] = { ...next[tag], day: otherCopy.day };
        } else {
          for (const tag of removed) delete next[tag];
        }

        const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.deleting`;
        renameSync(target, temp);
        try {
          writeIndexAtomic(next);
        } catch (error) {
          try { renameSync(temp, target); } catch { /* preserve the original write error */ }
          throw error;
        }
        try { unlinkSync(temp); } catch { /* stale tombstone can be cleaned up manually */ }
        return json(res, 200, { ok: true, removedAliases: otherCopy ? 0 : removed.length, reassignedAliases: otherCopy ? removed.length : 0 });
      });
    } catch (error) {
      return json(res, 500, { error: error.message || '删除图片失败' });
    }
  }

  json(res, 404, { error: 'not found' });
}

export const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) json(res, 500, { error: error.message || '服务器内部错误' });
    else res.destroy(error);
  });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`[image-library] listening http://${HOST}:${PORT}`);
  });
}
