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
const COOLDOWN_MS = Number(process.env.KEY_COOLDOWN_MS || 60 * 60 * 1000); // 1h

// 单个 key 最长等它多久
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30_000);
const MODEL_FALLBACK_BUDGET_MS = Number(process.env.MODEL_FALLBACK_BUDGET_MS || 240_000);

// DSH 内部 model id -> 上游实际 id（沿用原 model-map-proxy 的映射）
const MAP = new Map(Object.entries({
  'deepseek-flash': 'deepseek-v4.1-flash-free',
  'deepseek-v4-pro': 'buddy/deepseek-v4-pro',
}));

// Free models used when a request hits exhausted credits or a model rate limit.
// The paid Trae/GLM model stays selectable, but is deliberately excluded here.
const FREE_MODEL_FALLBACKS = [
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'reflection/beam-free',
  'deepseek-v4.1-flash-free',
];

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
async function forward(entry, path, method, headers, body, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const up = await fetch(entry.upstream + path, {
      method,
      headers: { ...headers, authorization: `Bearer ${entry.key}` },
      body,
      signal: ctrl.signal,
    });
    const text = await up.text();
    return { status: up.status, text };
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

function isTransientUpstreamFailure(status) {
  return status === 408 || status === 425 || status >= 500;
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
    const mayFallback = model && /\/(?:chat\/completions|responses)(?:\?|$)/.test(path);
    const modelCandidates = mayFallback
      ? [...new Set([model, ...FREE_MODEL_FALLBACKS])]
      : [model];
    const modelDeadline = mayFallback ? Date.now() + MODEL_FALLBACK_BUDGET_MS : Infinity;

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
      let shouldTryNextModel = false;
      for (const entry of activeKeys) {
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
        try {
          r = await forward(entry, path, req.method, headers, requestBody,
            Math.min(UPSTREAM_TIMEOUT_MS, remainingMs));
        } catch (err) {
          // 网络/超时不代表 key 失效；换完 key 后也继续尝试下一个模型。
          lastModelFailure = {
            status: 503,
            text: JSON.stringify({ error: { message: `upstream network error: ${err.message}` } }),
          };
          shouldTryNextModel = true;
          console.log(`[models] ${candidate} network/timeout error; trying another key or model`);
          continue;
        }

        if (isQuotaFailure(r.status, r.text) || isUnavailableModel(r.status, r.text)) {
          lastModelFailure = r;
          shouldTryNextModel = true;
          continue;
        }
        if (isTransientUpstreamFailure(r.status)) {
          lastModelFailure = r;
          shouldTryNextModel = true;
          continue;
        }
        if (isKeyFailure(r.status, r.text)) {
          markDead(entry.key, `HTTP ${r.status}`);
          activeKeys = activeKeys.filter((key) => key !== entry);
          continue;
        }

        const ct = r.text.trimStart().startsWith('{') || r.text.trimStart().startsWith('[')
          ? 'application/json' : 'text/plain';
        res.writeHead(r.status, { 'content-type': ct });
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
