// 抖音分享链接 → 解析请求文件队列 → 视频投递。
// 纯逻辑 + 文件 IO 集中在这里，qq-bot.mjs 只做接线，方便单测覆盖
// 链接识别 / 去重 / 冷却 / 降级 / 重试等关键分支。

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DOUYIN_SHORT_LINK_RE = /https?:\/\/v\.douyin\.com\/([A-Za-z0-9_-]+)\/?/g;
const DOUYIN_VIDEO_LINK_RE = /https?:\/\/www\.douyin\.com\/video\/(\d+)/g;

// 抖音官方分享文案里的噪音（"7.02 pQg:/ 复制打开抖音…"之类），
// 用于判断去掉链接后是否还有值得交给模型的正文。
const DOUYIN_SHARE_NOISE_PATTERNS = [
  /\d+(?:\.\d+)?\s+[A-Za-z]{1,4}:\//g,
  /复制打开抖音[，,].*$/g,
  /复制此链接[，,].*$/g,
];

export const DOUYIN_VIDEO_DEFAULTS = {
  maxVideoMB: 95,
  cooldownSeconds: 60,
  dedupMinutes: 30,
  responseTimeoutMs: 360_000,
};

/** 提取文本里所有抖音分享链接（短链 + 完整视频链接）。 */
export function matchDouyinShareLinks(text) {
  const value = String(text ?? '');
  const links = [];
  const seenUrls = new Set();
  for (const pattern of [DOUYIN_VIDEO_LINK_RE, DOUYIN_SHORT_LINK_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      const [url, code] = match;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      links.push(code && /^\d+$/.test(code)
        ? { url, kind: 'video', key: `id:${code}` }
        : { url, kind: 'short', key: `short:${code}` });
    }
  }
  return links;
}

/** 同一条消息里同时出现短链和完整链接时，只保留完整链接（同一个视频只搬一次）。 */
export function preferredDouyinLinks(links) {
  if (!Array.isArray(links) || links.length === 0) return [];
  if (links.some((link) => link.kind === 'video')) {
    const ids = new Set();
    return links.filter((link) => link.kind === 'video' && !ids.has(link.key) && ids.add(link.key));
  }
  return [links[0]];
}

/** 去掉链接和分享噪音后剩余的正文；不足 4 个非空白字符视为纯分享。 */
export function significantTextBesideLinks(text, links = []) {
  let value = String(text ?? '');
  for (const link of links) value = value.split(link.url).join(' ');
  for (const pattern of DOUYIN_SHARE_NOISE_PATTERNS) value = value.replace(pattern, ' ');
  const stripped = value.replace(/\s+/g, '');
  return stripped.length >= 4 ? value.trim() : '';
}

/** 白名单 + 全局去重 + 同会话冷却的触发闸门。 */
export function createDouyinVideoGate({ config = {}, now = Date.now } = {}) {
  const seen = new Map(); // key -> 触发时间
  const lastTrigger = new Map(); // chatKey -> 上次触发时间
  return {
    check({ isGroup, target, sender, isOwner, links }) {
      if (!config.enabled) return { allowed: false, reason: 'disabled' };
      if (isGroup) {
        const whitelist = (config.groups ?? []).map(String);
        if (!isOwner && !whitelist.includes(String(target))) {
          return { allowed: false, reason: 'group-not-whitelisted' };
        }
      } else if (config.privateEnabled === false) {
        return { allowed: false, reason: 'private-disabled' };
      }
      const nowMs = now();
      const dedupMs = (Number(config.dedupMinutes) || DOUYIN_VIDEO_DEFAULTS.dedupMinutes) * 60_000;
      for (const [key, at] of seen) if (nowMs - at > dedupMs) seen.delete(key);
      const fresh = [];
      const freshKeys = new Set();
      for (const link of links) {
        if (seen.has(link.key) || freshKeys.has(link.key)) continue;
        freshKeys.add(link.key);
        fresh.push(link);
      }
      if (fresh.length === 0) return { allowed: false, reason: 'duplicate' };
      const chatKey = `${isGroup ? 'g' : 'p'}:${target}`;
      const cooldownMs = (Number(config.cooldownSeconds) || DOUYIN_VIDEO_DEFAULTS.cooldownSeconds) * 1000;
      if (nowMs - (lastTrigger.get(chatKey) ?? 0) < cooldownMs) {
        return { allowed: false, reason: 'cooldown' };
      }
      for (const key of freshKeys) seen.set(key, nowMs);
      lastTrigger.set(chatKey, nowMs);
      return { allowed: true, links: fresh, reason: 'ok' };
    },
    /** 解析出真实 aweme_id 后补记，让"短链发过、别人又发完整链接"也能去重。 */
    markResolved(key) {
      if (key) seen.set(key, now());
    },
  };
}

export function douyinVideoQueuePaths(requestDir) {
  return {
    queueDir: join(requestDir, 'video-queue'),
    heartbeat: join(requestDir, 'video-worker-heartbeat.json'),
    response: (id) => join(requestDir, `douyin-video-response-${id}.json`),
  };
}

/** 把一条解析请求原子写进队列，返回请求 id（worker 按文件名顺序认领）。 */
export function writeDouyinVideoRequest({ requestDir, url, maxVideoMB }) {
  const paths = douyinVideoQueuePaths(requestDir);
  const id = randomUUID().replace(/-/g, '');
  const created = Date.now();
  const name = `req-${String(created).padStart(15, '0')}-${id}.json`;
  const payload = { id, urls: [url], maxVideoMB: Number(maxVideoMB) || DOUYIN_VIDEO_DEFAULTS.maxVideoMB, created_at: created };
  mkdirSync(paths.queueDir, { recursive: true });
  writeFileSync(join(paths.queueDir, name), JSON.stringify(payload), 'utf8');
  return id;
}

/** 轮询等待 worker 的响应文件；超时返回 { ok:false, error:'timeout' } 而不是抛错。 */
export async function waitForDouyinVideoResponse({
  requestDir, id, timeoutMs = DOUYIN_VIDEO_DEFAULTS.responseTimeoutMs, pollMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const paths = douyinVideoQueuePaths(requestDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = paths.response(id);
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return { ok: false, error: '响应损坏' };
      } finally {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    }
    await sleep(pollMs);
  }
  return { ok: false, error: 'timeout', timeout: true };
}

/** 发视频，失败后重试一次（对付 highway 偶发的 TCP connect timeout）。 */
export async function sendVideoWithRetry({
  send, retries = 1, retryDelayMs = 3000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await send(attempt);
      return { ok: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }
  return { ok: false, attempts: retries + 1, error: String(lastError?.message ?? lastError ?? 'send failed') };
}

/** 超限 / 失败时的降级文案：一句话，不带错误栈。 */
export function douyinFallbackText({ response, shareUrl, maxVideoMB }) {
  if (response?.ok && response.oversize) {
    const sizeMB = Math.max(1, Math.round(Number(response.sizeBytes) / (1024 * 1024)));
    const title = String(response.title ?? '').trim().slice(0, 60);
    const head = title ? `《${title}》` : '这条视频';
    return `${head}有 ${sizeMB}MB，超过 ${maxVideoMB}MB 发不出来，直接点链接看：${shareUrl}`;
  }
  if (response?.timeout) return `视频搬运超时了，稍后再发一次试试，或直接点链接看：${shareUrl}`;
  if (String(response?.error ?? '').includes('图集')) return `这条是图集，暂时搬不了，直接点链接看：${shareUrl}`;
  return `这条抖音视频没搬过来，稍后再试或直接点链接看：${shareUrl}`;
}
