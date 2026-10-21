// Multi-key proxy: DSH -> 本代理 -> 上游模型服务
//
// 目的：配置多个模型密钥，按优先级使用；某个密钥没积分/失效时自动换下一个。
// 它替换了原来的 model-map-proxy.mjs：除了多密钥，还保留了原来的 model id 映射。
//
// 文件：
//   密钥列表  D:\deepseek\keys.json          （你自己维护，改这个文件即可加密钥）
//   用量状态  D:\deepseek\state\keys.json    （自动写，记录哪个 key 挂了、什么时候挂的）
//
// 判定"这个 key 不能用了"：HTTP 401/402/403/429，或错误信息里含
//   quota / balance / insufficient / 余额 / 额度 / 积分 / exhausted / rate limit
// 之后该 key 进入冷却（默认 1 小时），冷却期内不再用；冷却结束会自动再试一次
// （万一只是临时限流，能自动恢复）。

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT || 18901);
const KEYS_FILE = process.env.KEYS_FILE || 'D:\\deepseek\\keys.json';
const STATE_FILE = 'D:\\deepseek\\state\\keys.json';
const MODEL_STATE_FILE = process.env.MODEL_STATE_FILE || 'D:\\deepseek\\state\\models.json';
const MODEL_POLICY_FILE = process.env.MODEL_POLICY_FILE || 'D:\\deepseek\\state\\model-policy.json';
const MODEL_ACTIVITY_FILE = process.env.MODEL_ACTIVITY_FILE || 'D:\\deepseek\\state\\model-activity.json';
const COOLDOWN_MS = Number(process.env.KEY_COOLDOWN_MS || 60 * 60 * 1000); // 1h

// 首字超时触发模型切换；已经开始输出的回答有更长的总时限。
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30_000);
const MODEL_FIRST_TOKEN_TIMEOUT_MS = Number(process.env.MODEL_FIRST_TOKEN_TIMEOUT_MS || 12_000);
const MODEL_STREAM_TOTAL_TIMEOUT_MS = Number(process.env.MODEL_STREAM_TOTAL_TIMEOUT_MS || 120_000);
const MODEL_FALLBACK_BUDGET_MS = Number(process.env.MODEL_FALLBACK_BUDGET_MS || 45_000);
// Try the requested free model plus every configured automatic free fallback.
const MODEL_MAX_ATTEMPTS = Number(process.env.MODEL_MAX_ATTEMPTS || 8);
const MODEL_COOLDOWN_MS = Number(process.env.MODEL_COOLDOWN_MS || 3 * 60 * 1000);
const MODEL_QUOTA_COOLDOWN_MS = Number(process.env.MODEL_QUOTA_COOLDOWN_MS || 5 * 60 * 1000);
const MODEL_UNAVAILABLE_COOLDOWN_MS = Number(process.env.MODEL_UNAVAILABLE_COOLDOWN_MS || 30 * 60 * 1000);

// DSH 内部 model id -> 上游实际 id（沿用原 model-map-proxy 的映射）
const MAP = new Map(Object.entries({
  'deepseek-flash': 'deepseek-v4.1-flash-free',
  'deepseek-v4-pro': 'buddy/deepseek-v4-pro',
}));

// Free routes first; a working non-free route is the final chat fallback.
const CHAT_MODEL_FALLBACKS = [
  'space-bunny-free',
  'reflection/beam-free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  'deepseek-v4.1-flash-free',
  'trae/glm-5.3-flash',
];
const VISION_MODEL_FALLBACKS = [
  'nvidia/nemotron-3.5-super-vl:free',
  'trae/multimodal_image_kimi-k2.5',
];

function hasImageInput(request) {
  const inputs = request?.messages ?? request?.input ?? [];
  return Array.isArray(inputs) && inputs.some((item) =>
    Array.isArray(item?.content) && item.content.some((part) =>
      ['image_url', 'input_image', 'image'].includes(part?.type)));
}

const KEY_FAIL_STATUS = new Set([401, 403]);
const QUOTA_FAIL_STATUS = new Set([402, 429]);
const FAIL_TEXT = /quota|balance|insufficient|exhausted|rate[_ ]?limit|余额|额度|积分|欠费|超额|arrears/i;

// ---------- 密钥与状态 ----------
function loadKeys() {
  if (!existsSync(KEYS_FILE)) {
    // 兼容旧部署：从环境变量兜底
    const legacy = process.env.UPSTREAM_KEY;
    if (legacy) {
      return [{ name: 'legacy', key: legacy, upstream: process.env.UPSTREAM_BASE || 'http://127.0.0.1:18900' }];
    }
    console.error(`[keys] ${KEYS_FILE} not found and no UPSTREAM_KEY env -> no keys configured`);
    return [];
  }
  let j;
  try { j = JSON.parse(readFileSync(KEYS_FILE, 'utf8')); }
  catch (e) { console.error('[keys] bad JSON:', e.message); return []; }
  const arr = Array.isArray(j) ? j : (j.keys ?? []);
  return arr
    .filter((k) => k && k.key)
    .map((k, i) => ({
      name: k.name || `key${i + 1}`,
      key: String(k.key),
      upstream: k.upstream || j.upstream || 'http://127.0.0.1:18900',
      model: k.model || null, // 可选：这个 key 专用 model 覆盖
    }));
}

function loadState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveState(s) {
  try {
    mkdirSync('D:\\deepseek\\state', { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch { /* 状态写不进去不影响转发 */ }
}

let KEYS = loadKeys();
let state = loadState();
let modelState = loadModelState();
let activityHistory = null;
try { activityHistory = JSON.parse(readFileSync(MODEL_ACTIVITY_FILE, 'utf8')); } catch {}
let lastActivity = activityHistory?.lastActivity ?? activityHistory ?? null;
let lastSuccess = activityHistory?.lastSuccess ?? (lastActivity?.outcome === 'success' ? lastActivity : null);

function activePolicy() {
  try {
    const value = JSON.parse(readFileSync(MODEL_POLICY_FILE, 'utf8'));
    if (typeof value.primary === 'string' && Array.isArray(value.fallbacks)) return value;
  } catch { /* no saved policy yet */ }
  return null;
}

function recordActivity(value) {
  lastActivity = { ...value, at: new Date().toISOString() };
  if (value.outcome === 'success') lastSuccess = lastActivity;
  try { writeFileSync(MODEL_ACTIVITY_FILE, JSON.stringify({ lastActivity, lastSuccess }, null, 2), 'utf8'); }
  catch { /* runtime status is best effort */ }
}

function loadModelState() {
  try { return existsSync(MODEL_STATE_FILE) ? JSON.parse(readFileSync(MODEL_STATE_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveModelState() {
  try {
    mkdirSync('D:\\deepseek\\state', { recursive: true });
    writeFileSync(MODEL_STATE_FILE, JSON.stringify(modelState, null, 2), 'utf8');
  } catch { /* health memory is best-effort */ }
}
function modelRouteKey(upstream, model) { return `${upstream}|${model}`; }
function modelCooling(entry, model) {
  const key = modelRouteKey(entry.upstream, model);
  const record = modelState[key];
  if (!record) return false;
  if (Date.now() >= record.until) {
    delete modelState[key];
    saveModelState();
    return false;
  }
  return true;
}
function coolModel(entry, model, reason, durationMs = MODEL_COOLDOWN_MS) {
  const key = modelRouteKey(entry.upstream, model);
  modelState[key] = { until: Date.now() + durationMs, reason: String(reason).slice(0, 160) };
  saveModelState();
  console.log(`[models] cooling ${model} for ${Math.round(durationMs / 1000)}s (${reason})`);
}
function markModelHealthy(entry, model) {
  const key = modelRouteKey(entry.upstream, model);
  if (modelState[key]) {
    delete modelState[key];
    saveModelState();
  }
}

/** 当前可用的 key（冷却结束的会自动恢复） */
function availableKeys() {
  const now = Date.now();
  return KEYS.filter((k) => {
    const st = state[k.key];
    if (!st || !st.dead) return true;
    if (now - st.at > COOLDOWN_MS) {
      delete state[k.key]; // 冷却结束，重新启用
      saveState(state);
      return true;
    }
    return false;
  });
}

function markDead(key, reason) {
  state[key] = { dead: true, at: Date.now(), reason: String(reason).slice(0, 200) };
  saveState(state);
  const n = KEYS.find((k) => k.key === key);
  console.log(`[keys] marked dead: ${n?.name ?? key.slice(0, 8)} (${reason})`);
}

// ---------- 转发 ----------
function hasStreamContent(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const frame = JSON.parse(data);
      if (frame?.choices?.some((choice) =>
        (typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0)
        || (typeof choice?.text === 'string' && choice.text.length > 0)
        || (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0))) return true;
      if (typeof frame?.delta === 'string' && frame.delta.length > 0) return true;
      if (typeof frame?.output_text === 'string' && frame.output_text.length > 0) return true;
      if (typeof frame?.type === 'string' && /\.delta$/.test(frame.type)) return true;
    } catch { /* wait for a complete SSE frame */ }
  }
  return false;
}

async function forward(entry, path, method, headers, body, res, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const resetTimer = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
  };
  let sentStream = false;
  try {
    const up = await fetch(entry.upstream + path, {
      method,
      headers: { ...headers, authorization: `Bearer ${entry.key}` },
      body,
      signal: ctrl.signal,
    });

    const contentType = up.headers.get('content-type') || 'application/octet-stream';
    const isSse = contentType.includes('text/event-stream') && up.body;
    if (isSse && up.status >= 200 && up.status < 300) {
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      const pendingChunks = [];
      let pendingText = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (res.destroyed) {
            await reader.cancel().catch(() => {});
            return { status: up.status, text: pendingText, contentType, streamed: true };
          }
          if (!sentStream) {
            pendingChunks.push(Buffer.from(value));
            pendingText += decoder.decode(value, { stream: true });
            if (isStreamModelFailure(up.status, pendingText)) {
              await reader.cancel().catch(() => {});
              return { status: up.status, text: pendingText, contentType };
            }
            if (hasStreamContent(pendingText)) {
              res.writeHead(up.status, { 'content-type': contentType });
              for (const chunk of pendingChunks) res.write(chunk);
              pendingChunks.length = 0;
              sentStream = true;
              resetTimer(MODEL_STREAM_TOTAL_TIMEOUT_MS);
            }
          } else {
            res.write(value);
          }
        }
        pendingText += decoder.decode();
        if (!sentStream) {
          if (isStreamModelFailure(up.status, pendingText)) {
            return { status: up.status, text: pendingText, contentType };
          }
          if (!hasStreamContent(pendingText)) {
            // Some upstreams signal a model failure as HTTP 200 with an empty
            // SSE stream. Treat it as transient so the next free model can run.
            return {
              status: 502,
              text: JSON.stringify({ error: { message: 'upstream stream ended without generated content' } }),
              contentType,
            };
          }
          res.writeHead(up.status, { 'content-type': contentType });
          for (const chunk of pendingChunks) res.write(chunk);
        }
        res.end();
        return { status: up.status, text: '', contentType, streamed: true };
      } catch (error) {
        if (sentStream) {
          console.log(`[stream] ${entry.name} downstream stream ended early: ${error.message}`);
          if (!res.destroyed) res.end();
          return { status: up.status, text: '', contentType, streamed: true, interrupted: true };
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
    }

    const text = await up.text();
    return {
      status: up.status,
      text,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isKeyFailure(status, text) {
  if (KEY_FAIL_STATUS.has(status)) return true;
  if (status < 400) return false;
  return /invalid (?:api )?key|unauthorized|authentication failed|invalid token/i.test(String(text).slice(0, 500));
}

function isQuotaFailure(status, text) {
  return QUOTA_FAIL_STATUS.has(status) || (status >= 400 && FAIL_TEXT.test(String(text).slice(0, 500)));
}

function isUnavailableModel(status, text) {
  return status === 404 && /(?:model|endpoint).*(?:not found|unavailable)|no endpoints|unknown model/i.test(String(text));
}

function isPermanentModelFailure(status, text) {
  return isUnavailableModel(status, text)
    || /OpenCode['’]s free tier can only be used from within OpenCode|only be used from within OpenCode/i.test(String(text));
}

function isTransientUpstreamFailure(status) {
  return status === 408 || status === 425 || status >= 500;
}

// Some gateways encode a terminal model failure inside a successful SSE
// response (HTTP 200 + `data: {"error": ...}`), so status-only failover misses
// it and clients see an empty turn. Detect structured SSE/JSON errors and the
// OpenCode free-tier restriction returned by the local upstream.
function isStreamModelFailure(status, text) {
  if (status < 200 || status >= 300) return false;
  if (/OpenCode['’]s free tier can only be used from within OpenCode|only be used from within OpenCode/i.test(text)) {
    return true;
  }
  for (const line of String(text).split(/\r?\n/)) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!data || data === '[DONE]') continue;
    try {
      const frame = JSON.parse(data);
      if (frame?.error || frame?.type === 'error') return true;
    } catch { /* ordinary text/SSE comments are not model failures */ }
  }
  return false;
}

// ---------- Web 管理后台 ----------
const ADMIN_TOKEN = process.env.KEYS_ADMIN_TOKEN || ''; // 留空 = 只允许本机
const ADMIN_HTML = 'D:\\deepseek\\keys-admin.html';

function clientIsLocal(req) {
  const ip = (req.socket?.remoteAddress ?? '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function authorized(req) {
  if (ADMIN_TOKEN) {
    const h = req.headers.authorization ?? '';
    if (h.replace(/^Bearer\s+/i, '') === ADMIN_TOKEN) return true;
  }
  return clientIsLocal(req); // 没配 token 时只认本机
}

function persist() {
  // 把当前 KEYS 写回 keys.json（保留原文件里的注释/结构）
  let raw = {};
  try { raw = existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, 'utf8')) : {}; }
  catch { raw = {}; }
  raw.upstream = raw.upstream || 'http://127.0.0.1:18900';
  raw.keys = KEYS.map((k) => ({ name: k.name, key: k.key, upstream: k.upstream }));
  writeFileSync(KEYS_FILE, JSON.stringify(raw, null, 2), 'utf8');
}

async function handleAdmin(req, res) {
  const url = new URL(req.url, 'http://x');

  // 页面
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/admin'))) {
    if (!authorized(req)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(ADMIN_HTML, 'utf8'));
    } catch {
      res.writeHead(500); res.end('admin page missing');
    }
    return;
  }

  if (!authorized(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'forbidden' }));
    return;
  }

  // 状态（页面轮询用）；密钥打码，只露后 6 位
  if (req.method === 'GET' && url.pathname === '/_keys') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      keys: KEYS.map((k) => ({
        name: k.name,
        upstream: k.upstream,
        status: state[k.key]?.dead ? 'dead' : 'ok',
        reason: state[k.key]?.reason ?? null,
        keyMask: '••••••' + String(k.key).slice(-6),
      })),
    }));
    return;
  }

  // 写操作（body 已在 end 回调里读好，挂在 req.__raw）
  if (req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(req.__raw || '{}'); } catch { /* 用空 body */ }
    return await adminWrite(url.pathname, body, res);
  }

  res.writeHead(404); res.end('not found');
}

/** 处理写操作；body 由调用方读好传入。 */
async function adminWrite(pathname, body, res) {
  const ok = (extra = {}) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...extra }));
  };
  const fail = (message, code = 400) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message }));
  };

  if (pathname === '/_keys/add') {
    const key = String(body.key ?? '').trim();
    if (!key) return fail('密钥不能为空');
    let name = String(body.name ?? '').trim();
    if (!name) name = `key${KEYS.length + 1}`;
    // 重名自动加后缀
    if (KEYS.some((k) => k.name === name)) name = `${name}-${Date.now() % 10000}`;
    // 同一个密钥不重复添加
    if (KEYS.some((k) => k.key === key)) return fail('这个密钥已经添加过了');
    KEYS.push({ name, key, upstream: body.upstream || 'http://127.0.0.1:18900' });
    persist();
    console.log(`[keys] added: ${name}`);
    return ok({ name });
  }

  if (pathname === '/_keys/delete') {
    const i = KEYS.findIndex((k) => k.name === body.name);
    if (i < 0) return fail('没找到这个密钥');
    if (KEYS.length === 1) return fail('至少保留一个密钥');
    const [gone] = KEYS.splice(i, 1);
    delete state[gone.key];
    saveState(state);
    persist();
    console.log(`[keys] deleted: ${body.name}`);
    return ok();
  }

  if (pathname === '/_keys/move') {
    const i = KEYS.findIndex((k) => k.name === body.name);
    const dir = Number(body.dir);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= KEYS.length) return fail('无法移动');
    [KEYS[i], KEYS[j]] = [KEYS[j], KEYS[i]];
    persist();
    return ok();
  }

  if (pathname === '/_keys/test') {
    const k = KEYS.find((x) => x.name === body.name);
    if (!k) return fail('没找到这个密钥');
    const t0 = Date.now();
    try {
      const up = await fetch(k.upstream + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${k.key}` },
        body: JSON.stringify({
          model: 'deepseek-v4.1-flash-free',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const ms = Date.now() - t0;
      const text = await up.text();
      if (isKeyFailure(up.status, text)) {
        return fail(`HTTP ${up.status} ${text.slice(0, 100)}`);
      }
      delete state[k.key];
      saveState(state);
      return ok({ ms });
    } catch (e) {
      return fail(e?.message ?? '请求失败');
    }
  }

  if (pathname === '/_reload') {
    KEYS = loadKeys();
    return ok({ count: KEYS.length });
  }

  return fail('unknown action', 404);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => {});
  req.on('end', async () => {
    let body = Buffer.concat(chunks);

    // --- 管理接口：Web 后台（POST 需要 body，先备好）---
    req.__raw = body.toString('utf8');
    if (req.url.startsWith('/_keys') || req.url === '/' || req.url.startsWith('/admin')) {
      return await handleAdmin(req, res);
    }
    if (req.method === 'GET' && req.url === '/_models') {
      if (!clientIsLocal(req)) { res.writeHead(403); res.end('forbidden'); return; }
      const policy = activePolicy();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        policy: policy && { version: policy.version, primary: policy.primary, fallbacks: policy.fallbacks,
          firstTokenTimeoutMs: policy.firstTokenTimeoutMs, fallbackBudgetMs: policy.fallbackBudgetMs },
        lastActivity, lastSuccess, cooling: modelState,
        keys: { total: KEYS.length, available: availableKeys().length }
      }));
      return;
    }
    if (req.url.startsWith('/_reload')) {
      KEYS = loadKeys();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: KEYS.length }));
      return;
    }

    // --- model id 映射与免费模型故障切换 ---
    let requestJson = null;
    if (body.length > 0) {
      try {
        requestJson = JSON.parse(body.toString('utf8'));
        if (requestJson && typeof requestJson.model === 'string' && MAP.has(requestJson.model)) {
          requestJson.model = MAP.get(requestJson.model);
        }
        body = Buffer.from(JSON.stringify(requestJson), 'utf8');
      } catch { /* 非 JSON 原样转发 */ }
    }

    const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
    const path = req.url; // 已含 /v1
    const model = typeof requestJson?.model === 'string' ? requestJson.model : null;
    if (path.includes('/chat/completions') || path.includes('/responses')) {
      console.log(`[request] ${req.method} ${path} model=${model ?? 'unknown'} stream=${requestJson?.stream === true}`);
    }
    const mayFallback = model && /\/(?:chat\/completions|responses)(?:\?|$)/.test(path);
    const policy = activePolicy();
    const fallbacks = hasImageInput(requestJson) ? VISION_MODEL_FALLBACKS : (policy?.fallbacks ?? CHAT_MODEL_FALLBACKS);
    const modelCandidates = mayFallback
      ? [...new Set([model, ...fallbacks])].slice(0, Math.max(MODEL_MAX_ATTEMPTS, policy ? policy.fallbacks.length + 1 : 0))
      : [model];
    const modelDeadline = mayFallback ? Date.now() + (policy?.fallbackBudgetMs ?? MODEL_FALLBACK_BUDGET_MS) : Infinity;

    const pool = availableKeys();
    if (pool.length === 0) {
      // 全挂了：清掉冷却再试一轮（可能是临时限流），否则如实报错
      state = {};
      saveState(state);
      console.log('[keys] all keys dead -> reset cooldown and retry once');
    }
    const tryList = pool.length ? pool : KEYS;
    if (tryList.length === 0) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no api keys configured' } }));
      return;
    }

    let activeKeys = tryList.slice();
    let lastModelFailure = null;
    for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex++) {
      const candidate = modelCandidates[modelIndex];
      const candidateKeys = activeKeys.filter((entry) => !modelCooling(entry, candidate));
      if (candidateKeys.length === 0) {
        console.log(`[models] ${candidate} skipped; every route is cooling down`);
        continue;
      }
      let shouldTryNextModel = false;
      for (const entry of candidateKeys) {
        const remainingMs = modelDeadline - Date.now();
        if (remainingMs <= 0) {
          lastModelFailure ??= {
            status: 503,
            text: JSON.stringify({ error: { message: 'model fallback time budget exceeded' } }),
          };
          break;
        }
        let requestBody = body.length ? body : undefined;
        if (candidate && requestJson && candidate !== requestJson.model) {
          requestBody = Buffer.from(JSON.stringify({ ...requestJson, model: candidate }), 'utf8');
        }

        let r;
        const attemptStarted = Date.now();
        const timeoutMs = Math.min(
          requestJson?.stream === true ? (policy?.firstTokenTimeoutMs ?? MODEL_FIRST_TOKEN_TIMEOUT_MS) : UPSTREAM_TIMEOUT_MS,
          remainingMs
        );
        try {
          r = await forward(entry, path, req.method, headers, requestBody,
            res, timeoutMs);
        } catch (err) {
          // 网络/首字超时不代表 key 失效；暂时冷却此模型路由，再继续尝试。
          lastModelFailure = {
            status: 503,
            text: JSON.stringify({ error: { message: `upstream network error: ${err.message}` } }),
          };
          coolModel(entry, candidate, err.name === 'AbortError' ? 'first-token timeout' : 'network error');
          recordActivity({ requested: model, attempted: candidate, outcome: 'failed', reason: err.message });
          shouldTryNextModel = true;
          console.log(`[models] ${candidate} network/timeout error; trying another key or model`);
          continue;
        }
        if (path.includes('/chat/completions') || path.includes('/responses')) {
          console.log(`[response] ${candidate} HTTP ${r.status} ${r.contentType} ${Date.now() - attemptStarted}ms`);
        }

        if (isQuotaFailure(r.status, r.text) || isUnavailableModel(r.status, r.text) || isStreamModelFailure(r.status, r.text)) {
          lastModelFailure = r;
          const duration = isQuotaFailure(r.status, r.text)
            ? MODEL_QUOTA_COOLDOWN_MS
            : isPermanentModelFailure(r.status, r.text)
              ? MODEL_UNAVAILABLE_COOLDOWN_MS
              : MODEL_COOLDOWN_MS;
          coolModel(entry, candidate, isUnavailableModel(r.status, r.text) ? 'model unavailable' : 'model returned an error', duration);
          recordActivity({ requested: model, attempted: candidate, outcome: 'failed', reason: `HTTP ${r.status}: ${String(r.text).slice(0, 180)}` });
          shouldTryNextModel = true;
          continue;
        }
        if (isTransientUpstreamFailure(r.status)) {
          lastModelFailure = r;
          coolModel(entry, candidate, `HTTP ${r.status}`);
          recordActivity({ requested: model, attempted: candidate, outcome: 'failed', reason: `HTTP ${r.status}` });
          shouldTryNextModel = true;
          continue;
        }
        if (isKeyFailure(r.status, r.text)) {
          markDead(entry.key, `HTTP ${r.status}`);
          activeKeys = activeKeys.filter((key) => key !== entry);
          continue;
        }

        markModelHealthy(entry, candidate);
        if (r.status >= 200 && r.status < 300) recordActivity({ requested: model, actual: candidate, outcome: 'success', fallback: candidate !== model });
        if (r.streamed) {
          if (candidate !== model) console.log(`[models] ${model} served with fallback ${candidate}`);
          return;
        }

        // Preserve SSE for OpenAI-compatible streaming clients (including DSH's
        // pi-ai adapter). Replacing text/event-stream with text/plain makes a
        // successful upstream response look like an empty model turn to DSH.
        res.writeHead(r.status, { 'content-type': r.contentType });
        res.end(r.text);
        if (candidate !== model) {
          console.log(`[models] ${model} served with fallback ${candidate}`);
        }
        return;
      }

      if (shouldTryNextModel && modelIndex + 1 < modelCandidates.length) {
        console.log(`[models] ${candidate} failed; trying next fallback model`);
        continue;
      }
      if (activeKeys.length === 0) break;
    }

    if (lastModelFailure) {
      const ct = lastModelFailure.text.trimStart().startsWith('{') ? 'application/json' : 'text/plain';
      res.writeHead(lastModelFailure.status, { 'content-type': ct });
      res.end(lastModelFailure.text);
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'all api keys failed or out of quota' }
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`model-pool proxy: http://127.0.0.1:${PORT}/v1`);
  console.log(`keys loaded: ${KEYS.length}`, KEYS.map((k) => k.name).join(', '));
  console.log(`cooldown: ${COOLDOWN_MS / 60000} min | status: http://127.0.0.1:${PORT}/_keys`);
});
