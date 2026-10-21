import http from 'node:http';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettingsDocument, saveSettingsDocument } from './bot-settings.mjs';
import { modelStatus, modelCatalog, testModel, saveModelPolicy } from './model-management.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.IMAGE_LIBRARY_PORT || 18902);
const IMAGE_ROOT = path.resolve(process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images');
const STICKER_INDEX = path.resolve(process.env.STICKER_INDEX_PATH || 'D:\\deepseek\\stickers\\index.json');
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'image-library.html');
const SETTINGS_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bot-settings.html');
const MODELS_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'model-settings.html');
const SETTINGS_HEARTBEAT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'settings-heartbeat.json');
const QZONE_STATE = 'D:\\deepseek\\state\\qzone-daily.json';
const OWNER_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'owner-proactive.json');
const BRIDGE_LOG = 'D:\\deepseek\\logs\\bridge.log';
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

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function recentLogText(limit = 160_000) {
  const size = statSync(BRIDGE_LOG).size;
  const buffer = Buffer.alloc(Math.min(size, limit));
  const fd = openSync(BRIDGE_LOG, 'r');
  try { readSync(fd, buffer, 0, buffer.length, size - buffer.length); }
  finally { closeSync(fd); }
  return buffer.toString('utf8');
}

function knownGroups(configured, disabled) {
  const ids = new Set([...configured, ...disabled]);
  try {
    for (const match of recentLogText(2_000_000).matchAll(/\[msg\] group (\d{5,20}) from /g)) ids.add(match[1]);
  } catch { /* first launch may have no log */ }
  return [...ids].sort();
}

function settingsStatus(version, settings) {
  const heartbeat = readJsonFile(SETTINGS_HEARTBEAT);
  const qzone = readJsonFile(QZONE_STATE);
  const owner = readJsonFile(OWNER_STATE);
  const now = Date.now();
  const today = new Date(now).toLocaleDateString('en-CA');
  const ownerMessagesToday = Array.isArray(owner?.sentDates) ? owner.sentDates.filter((day) => day === today).length : 0;
  const qzoneNext = new Date(now);
  qzoneNext.setMinutes(settings.dailyQzone.minute, 0, 0);
  if (qzoneNext.getTime() <= now) qzoneNext.setHours(qzoneNext.getHours() + 1);
  const ownerSettings = settings.ownerProactive;
  let ownerNext = Math.max(now, Number(owner?.lastOwnerActivityAt || 0) + ownerSettings.idleMs,
    Number(owner?.lastAttemptAt || owner?.lastSentAt || 0) + ownerSettings.cooldownMs);
  const nextDate = new Date(ownerNext);
  if (ownerMessagesToday >= ownerSettings.maxPerDay || nextDate.getHours() >= ownerSettings.endHour) {
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate.setHours(ownerSettings.startHour, 0, 0, 0);
  } else if (nextDate.getHours() < ownerSettings.startHour) {
    nextDate.setHours(ownerSettings.startHour, 0, 0, 0);
  }
  ownerNext = nextDate.getTime();
  const recentEvents = [];
  try {
    const log = recentLogText().split(/\r?\n/);
    for (const line of log.slice(-500)) {
      let event = '';
      if (/\[qzone\] posted:|\[qzone\] owner-requested post published/.test(line)) event = 'QQ 动态发布成功';
      else if (/\[qzone\] (owner history|group list) fetch failed/.test(line)) event = '聊天记录接口不可用，动态素材读取失败';
      else if (/\[qzone\] not enough material/.test(line)) event = 'QQ 动态：素材不足';
      else if (/\[qzone\] failed:/.test(line)) event = 'QQ 动态执行失败';
      else if (/\[owner-proactive\] sent/.test(line)) event = '主动私聊已发送';
      else if (/\[owner-proactive\] skipped/.test(line)) event = '主动私聊：本次跳过';
      else if (/\[owner-proactive\] failed/.test(line)) event = '主动私聊执行失败';
      else if (/\[poke\] replied/.test(line)) event = '戳一戳：已发送回复';
      else if (/\[poke\] poked back/.test(line)) event = '戳一戳：已回戳';
      else if (/\[poke\] (reply|poke-back) failed/.test(line)) event = '戳一戳：操作失败';
      else if (/\[poke\] observed/.test(line)) event = '收到戳一戳事件';
      else if (/\[skip\] not replying \(frequency control\)/.test(line)) event = '群聊消息被冷却规则跳过';
      else if (/\[error\] dsh: timeout/.test(line)) event = '模型回复超时';
      else if (/\[warn\] OneBot HTTP did not respond/.test(line)) event = 'QQ 接口未响应，收发消息可能受影响';
      if (event) recentEvents.push({ time: `${line.slice(0, 8)} UTC`, event });
    }
  } catch { /* no log yet */ }
  return {
    applied: Boolean(heartbeat?.version === version && Date.now() - Number(heartbeat.at) < 90_000),
    lastHeartbeatAt: heartbeat?.at || null,
    lastQzoneAt: qzone?.lastPostAtMs || null,
    nextQzoneCheckAt: settings.dailyQzone.enabled ? qzoneNext.getTime() : null,
    lastOwnerMessageAt: owner?.lastSentAt || null,
    nextOwnerEligibleAt: ownerSettings.enabled ? ownerNext : null,
    ownerMessagesToday,
    recentEvents: recentEvents.slice(-16).reverse()
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const localPort = server.address()?.port ?? PORT;
  if (!new RegExp(`^(?:127\\.0\\.0\\.1|localhost):${localPort}$`, 'i').test(req.headers.host || '')) {
    return json(res, 403, { error: '仅允许本机访问' });
  }
  if (req.method === 'GET' && url.pathname === '/models') {
    if (!existsSync(MODELS_PAGE)) return json(res, 500, { error: '模型管理页面文件不存在' });
    const body = readFileSync(MODELS_PAGE);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'content-length': body.length,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    return res.end(body);
  }
  if (req.method === 'GET' && url.pathname === '/api/models/status') {
    try { return json(res, 200, await modelStatus()); }
    catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/models/catalog') {
    try { return json(res, 200, await modelCatalog()); }
    catch (error) { return json(res, 503, { error: error.message }); }
  }
  if ((req.method === 'POST' && url.pathname === '/api/models/test')
      || (req.method === 'PUT' && url.pathname === '/api/models/policy')) {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机管理页面修改模型配置' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    try {
      if (url.pathname.endsWith('/test')) return json(res, 200, await testModel(body.model));
      return await serialMutation(async () => json(res, 200, await saveModelPolicy(body)));
    } catch (error) { return json(res, error.status || 500, { error: error.message, tests: error.tests }); }
  }
  if (req.method === 'GET' && url.pathname === '/settings') {
    if (!existsSync(SETTINGS_PAGE)) return json(res, 500, { error: '设置页面文件不存在' });
    const body = readFileSync(SETTINGS_PAGE);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'content-length': body.length,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    return res.end(body);
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    try {
      const document = readSettingsDocument();
      return json(res, 200, { ...document,
        groups: knownGroups(document.groups, document.settings.groupInterjectionDisabled),
        status: settingsStatus(document.version, document.settings) });
    } catch (error) { return json(res, 500, { error: error.message }); }
  }

  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机管理页面保存设置' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    try {
      return await serialMutation(() => json(res, 200, saveSettingsDocument(body.version, body.settings)));
    } catch (error) { return json(res, error.status || 500, { error: error.message || '保存设置失败' }); }
  }

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
