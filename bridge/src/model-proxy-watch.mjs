// 本地模型代理自检：18901/18903 静默消失时，DSH 每次生成都会卡到超时，
// 机器人只会吐“刚卡了一下”。这里做两件事：先把代理拉起来，拉不起来再用
// 平常语气私聊告诉主人，恢复后补一句闭环。

import { connect } from 'node:net';

export const MODEL_PROXY_INTERVAL_MS = 60_000;

// 两个代理互相独立：18901 是 keys 管理入口，18903 是 DSH 会话实际使用的路由。
export const MODEL_PROXY_ENTRIES = [
  {
    port: 18901,
    script: 'D:\\deepseek\\model-pool-proxy.mjs',
    logFile: 'D:\\deepseek\\logs\\model-pool.log'
  },
  {
    port: 18903,
    script: 'D:\\deepseek\\repo\\deploy\\windows\\model-pool-proxy.mjs',
    logFile: 'D:\\deepseek\\logs\\model-router.log'
  }
];

const START_COOLDOWN_MS = 2 * 60_000;
const NOTIFY_COOLDOWN_MS = 15 * 60_000;
const REVIVE_WAIT_MS = 6_000;
const DOWN_TEXT = '爸，我脑子那边断了，我自己在拉，拉不起来你帮我看看。';
const UP_TEXT = '爸，脑子接回来了，能正常说话了。';

/** 端口是否在监听（TCP 连一下就断开，不发 HTTP 请求）。 */
export function probeTcpPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function createModelProxyWatch(options = {}) {
  const entries = options.entries ?? MODEL_PROXY_ENTRIES;
  const probe = options.probe ?? probeTcpPort;
  const start = options.start ?? (async () => {});
  const notify = options.notify ?? (async () => {});
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const state = new Map(entries.map((entry) => [entry.port, { lastStartAt: 0, lastNotifyAt: 0, notified: false }]));
  let running = false;

  const announceRecovered = async () => {
    const recovered = entries.filter((entry) => state.get(entry.port)?.notified);
    if (!recovered.length) return;
    for (const entry of recovered) {
      const item = state.get(entry.port);
      item.notified = false;
      item.lastNotifyAt = 0;
    }
    log('[model-watch] proxies recovered', recovered.map((entry) => entry.port).join(','));
    await notify(UP_TEXT);
  };

  /** 一次巡检：探测 → 自愈 → 复检 → 通知。并发保护避免上一轮没跑完又进来。 */
  async function tick() {
    if (running) return;
    running = true;
    try {
      const dead = [];
      for (const entry of entries) {
        if (await probe(entry.port)) continue;
        const item = state.get(entry.port);
        if (now() - item.lastStartAt >= START_COOLDOWN_MS) {
          item.lastStartAt = now();
          log('[model-watch] proxy down, restarting', entry.port, entry.script);
          try {
            await start(entry);
          } catch (error) {
            log('[model-watch] restart failed', entry.port, error?.message ?? error);
          }
        }
        dead.push(entry);
      }
      if (!dead.length) {
        await announceRecovered();
        return;
      }

      await sleep(REVIVE_WAIT_MS);
      const stillDown = [];
      for (const entry of dead) {
        if (await probe(entry.port)) {
          state.get(entry.port).lastStartAt = now();
          continue;
        }
        stillDown.push(entry);
      }
      if (!stillDown.length) {
        log('[model-watch] self-heal ok', dead.map((entry) => entry.port).join(','));
        await announceRecovered();
        return;
      }

      const due = stillDown.filter((entry) => {
        const item = state.get(entry.port);
        return now() - item.lastNotifyAt >= NOTIFY_COOLDOWN_MS;
      });
      if (!due.length) return;
      for (const entry of due) {
        const item = state.get(entry.port);
        item.lastNotifyAt = now();
        item.notified = true;
      }
      log('[model-watch] still down after restart', due.map((entry) => entry.port).join(','));
      await notify(DOWN_TEXT);
    } finally {
      running = false;
    }
  }

  return { tick, state, entries };
}
