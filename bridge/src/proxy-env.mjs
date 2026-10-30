// 子进程代理环境修正。
//
// 背景：这台机器设了用户级环境变量 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:12450，
// 但 12450 上的代理软件经常没在运行。Node 的 fetch 不读这些变量（所以搜歌直连是通的），
// 而 python/yt-dlp 会照用不误，于是唱歌下载音频时全部报
// "Unable to connect to proxy ... WinError 10061 连接被拒绝"，下一段就发不出来。
//
// 做法：启动子进程前先探测代理端口是否可连。
//   - 代理活着 -> 原样继承（保留需要代理的场景，比如 YouTube）
//   - 代理死了 -> 从环境里剔除代理变量，让子进程直连（B 站直连实测可用）
// 探测结果缓存 30 秒，避免每次点歌都做 TCP 握手。

import { createConnection } from 'node:net';

const PROBE_CACHE_MS = 30_000;
let cached = { at: 0, alive: false, proxy: '' };

function proxyUrl() {
  return String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '').trim();
}

/** TCP 连接探测代理端口（只看能不能连上，不发请求）。 */
function probe(proxy, timeoutMs = 800) {
  return new Promise((resolve) => {
    let host = '127.0.0.1', port = 0;
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
      host = u.hostname; port = Number(u.port) || 80;
    } catch { resolve(false); return; }
    const sock = createConnection({ host, port, timeout: timeoutMs });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 代理当前是否可用（带缓存）。 */
export async function proxyAlive() {
  const proxy = proxyUrl();
  if (!proxy) return false;
  if (cached.proxy === proxy && Date.now() - cached.at < PROBE_CACHE_MS) return cached.alive;
  const alive = await probe(proxy);
  cached = { at: Date.now(), alive, proxy };
  return alive;
}

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/**
 * 构造子进程 env：代理不可用时剔除代理变量，让 python/yt-dlp 直连。
 * @param {object} extra 额外要合并的变量
 */
export async function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const proxy = proxyUrl();
  if (!proxy) return env;
  const alive = await proxyAlive();
  if (!alive) {
    for (const k of PROXY_KEYS) delete env[k];
    // 明确告诉工具链不要找系统代理
    env.NO_PROXY = '*';
    env.no_proxy = '*';
  }
  return env;
}

/** 同步版本：用缓存里的探测结果；没有缓存时保守保留代理。 */
export function childEnvSync(extra = {}) {
  const env = { ...process.env, ...extra };
  const proxy = proxyUrl();
  if (!proxy) return env;
  if (cached.proxy === proxy && !cached.alive) {
    for (const k of PROXY_KEYS) delete env[k];
    env.NO_PROXY = '*';
    env.no_proxy = '*';
  }
  return env;
}

/** 诊断信息（给日志/管理端用）。 */
export function proxyStatus() {
  return { configured: proxyUrl() || null, alive: cached.alive, checkedAt: cached.at ? new Date(cached.at).toISOString() : null };
}
