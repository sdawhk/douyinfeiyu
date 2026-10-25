import http from 'node:http';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettingsDocument, saveSettingsDocument } from './bot-settings.mjs';
import { synthesizeXfyunSpeech } from './xfyun-tts.mjs';
import { synthesizeEdgeSpeech } from './edge-tts.mjs';
import { generateSong, downloadSong } from './singing.mjs';
import { readStickerSemantics, setStickerSemantics } from './sticker-semantics.mjs';
import { readImageAnalyses } from './image-analysis-store.mjs';
import { modelStatus, modelCatalog, testModel, saveModelPolicy, syncPromotedModel } from './model-management.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.IMAGE_LIBRARY_PORT || 18902);
const IMAGE_ROOT = path.resolve(process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images');
const STICKER_INDEX = path.resolve(process.env.STICKER_INDEX_PATH || 'D:\\deepseek\\stickers\\index.json');
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'image-library.html');
const SETTINGS_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bot-settings.html');
const MODELS_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'model-settings.html');
const SETTINGS_HEARTBEAT = 'D:\\deepseek\\state\\settings-heartbeat.json';
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
  const semantics = readStickerSemantics();
  const analyses = readImageAnalyses();
  const tagsByImage = new Map();
  for (const [tag, record] of Object.entries(index)) {
    if (!record || typeof record.ref !== 'string' || !IMAGE_NAME.test(record.ref)) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(record.day || '') ? record.day : '';
    const key = `${day}/${record.ref}`;
    const tags = tagsByImage.get(key) || [];
    tags.push(tag);
    tagsByImage.set(key, tags);
  }
  const statusByImage = new Map();
  for (const record of Object.values(index)) {
    if (!record || typeof record.ref !== 'string' || !IMAGE_NAME.test(record.ref)) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(record.day || '') ? record.day : '';
    const key = `${day}/${record.ref}`;
    const status = ['pending', 'rejected'].includes(record.status) ? record.status : 'approved';
    const current = statusByImage.get(key);
    if (!current || status === 'pending' || (status === 'rejected' && current === 'approved')) statusByImage.set(key, status);
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
        tags: tagsByImage.get(`${folder.name}/${entry.name}`) || [],
        status: statusByImage.get(`${folder.name}/${entry.name}`) || 'archive',
        semantics: semantics[entry.name] || null,
        analysis: analyses[entry.name] || null
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
    for (const match of recentLogText(2_000_000).matchAll(/\[turn:[^\]]+\] received group target=(\d{5,20}) /g)) ids.add(match[1]);
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
      const turn = line.match(/\[turn:([^\]]+)\] (received|queued|processing|sent|skipped|failed)\b(?:[^\n]*?reason=([^\s]+))?/);
      if (turn) {
        const [, traceId, state, reason] = turn;
        const stateLabel = ({ received: '收到消息', queued: '进入回复队列', processing: '正在生成回复', sent: '回复已发送', skipped: '本次未回复', failed: '处理失败' })[state];
        const reasonLabel = ({ muted: '聊天已静音', 'muted-while-queued': '排队期间聊天被静音', 'muted-before-send': '发送前聊天被静音', 'stale-group-turn': '群聊消息已过期', 'superseded-before-image-recovery': '群里有更新消息', 'superseded-before-send': '群里有更新消息', 'group-queue-replaced': '群聊队列合并了较旧消息', 'group-frequency-control': '群聊频率规则跳过', 'image-only-cooldown': '图片消息冷却中', 'not-allowed': '未在允许范围', 'description-unavailable': '图片识别暂不可用' })[reason] || reason;
        event = `${stateLabel}${reasonLabel ? `：${reasonLabel}` : ''}（${traceId}）`;
      } else if (/\[qzone\] posted:|\[qzone\] owner-requested post published/.test(line)) event = 'QQ 动态发布成功';
      else if (/\[qzone\] (owner history|group list) fetch failed/.test(line)) event = '聊天记录接口不可用，动态素材读取失败';
      else if (/\[qzone\] not enough material/.test(line)) event = 'QQ 动态：素材不足';
      else if (/\[qzone\] failed:/.test(line)) event = 'QQ 动态执行失败';
      else if (/\[qzone-social\] (preview like friend=|liked friend=)/.test(line)) event = line.includes('preview') ? '好友动态互动：预览点赞' : '好友动态互动：已点赞';
      else if (/\[qzone-social\] (preview comment friend=|commented friend=)/.test(line)) event = line.includes('preview') ? '好友动态互动：预览评论' : '好友动态互动：已评论';
      else if (/\[qzone-social\] (preview reply commenter=|replied commenter=)/.test(line)) event = line.includes('preview') ? '好友动态互动：预览回复评论' : '好友动态互动：已回复评论';
      else if (/\[qzone-social\] (feed scan|own comment scan) failed/.test(line)) event = '好友动态互动：读取失败';
      else if (/\[qzone-social\] (like|comment|reply) failed/.test(line)) event = '好友动态互动：执行失败';
      else if (/\[qzone-social\] baseline established/.test(line)) event = '好友动态互动：首次扫描已建立基线';
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
  if (req.method === 'POST' && url.pathname === '/api/models/promoted') {
    const remoteAddress = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (!['127.0.0.1', '::1'].includes(remoteAddress)) return json(res, 403, { error: '仅允许本机模型代理同步' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    try { return await serialMutation(async () => json(res, 200, await syncPromotedModel(body.model))); }
    catch (error) { return json(res, error.status || 500, { error: error.message }); }
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
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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

  if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
    try {
      const body = await readBody(req);
      const config = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
      if (!config.edgeTts?.enabled || !config.edgeTts?.workerUrl) throw Object.assign(new Error('Edge TTS 尚未启用或缺少 Worker 地址'), { status: 400 });
      const file = await synthesizeEdgeSpeech(body.input, { url: config.edgeTts.workerUrl, voice: config.edgeTts.voice });
      const audio = Buffer.from(file.slice('base64://'.length), 'base64');
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(audio);
    } catch (error) { return json(res, error.status || 502, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/xfyun-tts-test') {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机设置页面测试语音' });
    try {
      const config = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
      const file = await synthesizeXfyunSpeech('你好，我是小鲸鱼。讯飞语音合成已经接通。', config.xfyunTts);
      const audio = Buffer.from(file.slice('base64://'.length), 'base64');
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(audio);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/edge-tts-test') {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机设置页面测试语音' });
    try {
      const config = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
      const file = await synthesizeEdgeSpeech('你好，我是小鲸鱼。Edge TTS 语音已经接通。', { ...config.edgeTts, url: config.edgeTts.workerUrl || config.edgeTts.url });
      const audio = Buffer.from(file.slice('base64://'.length), 'base64');
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(audio);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/singing-test') {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机设置页面测试唱歌' });
    try {
      const config = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
      const song = await generateSong('小鲸鱼在晴天里和朋友一起散步', config.singing);
      const audio = await downloadSong(song.url);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(audio);
    } catch (error) { return json(res, 400, { error: error.message }); }
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
      const status = url.searchParams.get('status') || '';
      const analysisFilter = url.searchParams.get('analysis') || '';
      const sort = url.searchParams.get('sort') || 'newest';
      let filtered = rows.filter((row) => (!day || row.day === day)
        && (!status || row.status === status)
        && (!analysisFilter
          || (analysisFilter === 'photo' && row.analysis?.isPhoto === true)
          || (analysisFilter === 'nonphoto' && row.analysis?.isPhoto === false)
          || (analysisFilter === 'valuable' && row.analysis?.valuable === true)
          || (analysisFilter === 'low-value' && row.analysis?.valuable === false)
          || (analysisFilter === 'duplicate' && row.analysis?.duplicate === true)
          || (analysisFilter === 'unique' && row.analysis?.duplicate === false))
        && (!q || `${row.file} ${row.day} ${row.tags.join(' ')} ${row.analysis?.tags?.join(' ') || ''} ${row.analysis?.caption || ''} ${row.analysis?.kind || ''} ${row.analysis?.valueReason || ''} ${row.analysis?.duplicate ? '重复' : ''} ${row.semantics?.deepseek ? 'DeepSeek 小鲸鱼' : ''} ${row.semantics?.action || ''} ${row.semantics?.emotion || ''}`.toLocaleLowerCase('zh-CN').includes(q)));
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
        moderation: {
          pending: rows.filter((row) => row.status === 'pending').length,
          approved: rows.filter((row) => row.status === 'approved').length,
          rejected: rows.filter((row) => row.status === 'rejected').length
        },
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

  if (req.method === 'POST' && url.pathname === '/api/images/bulk-review') {
    if (!requireLocalOrigin(req)) return json(res, 403, { error: '仅允许本机管理页面审核图片' });
    let body;
    try { body = await readBody(req); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    if (!['approved', 'rejected', 'pending'].includes(body.status)
      || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 200) {
      return json(res, 400, { error: '请选 1～200 张图片并指定审核状态' });
    }
    const items = [...new Map(body.items.map((item) => [`${item?.day}/${item?.file}`, item])).values()];
    for (const item of items) {
      if (typeof item?.day !== 'string' || typeof item?.file !== 'string') return json(res, 400, { error: '图片列表格式无效' });
      const target = safeImagePath(item.day, item.file);
      if (!target || !existsSync(target)) return json(res, 404, { error: `图片不存在：${item.file}` });
    }
    try {
      return await serialMutation(() => {
        const index = readIndex();
        const updates = items.map((item) => ({ item, aliases: aliasesFor(index, item.day, item.file) }));
        const missing = updates.find(({ aliases }) => !aliases.length);
        if (missing) return json(res, 409, { error: `图片 ${missing.item.file} 尚未绑定表情关键词，请先单独整理` });
        let aliasesUpdated = 0;
        for (const { aliases } of updates) {
          for (const key of aliases) {
            index[key] = { ...index[key], status: body.status, at: new Date().toISOString() };
            aliasesUpdated++;
          }
        }
        writeIndexAtomic(index);
        return json(res, 200, { ok: true, updated: items.length, aliasesUpdated, status: body.status });
      });
    } catch (error) {
      return json(res, 500, { error: error.message || '批量审核失败' });
    }
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
    const status = body.status;
    if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
      return json(res, 400, { error: '审核状态无效' });
    }
    const classification = body.semantics;
    if (classification && (typeof classification.deepseek !== 'boolean'
      || typeof classification.action !== 'string' || typeof classification.emotion !== 'string'
      || classification.action.length > 24 || classification.emotion.length > 24)) {
      return json(res, 400, { error: '主题和动作信息格式无效' });
    }

    try {
      return await serialMutation(() => {
        const index = readIndex();
        const previousAliases = aliasesFor(index, day, file);
        const previousStatus = previousAliases.map((key) => index[key]?.status)
          .find((value) => ['pending', 'rejected'].includes(value)) || 'approved';
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
        const imageStatus = status || (previousAliases.length ? previousStatus : 'approved');
        for (const tag of tags) index[tag] = { ref: file, day, mime, bytes, status: imageStatus, at: new Date().toISOString() };
        writeIndexAtomic(index);
        if (classification) {
          const previous = readStickerSemantics()[file] || {};
          setStickerSemantics(file, { ...previous, ...classification, confidence: 1, overridden: true });
        }
        return json(res, 200, { ok: true, tags, semantics: classification || null });
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
