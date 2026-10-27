// DSH 0.2.x 适配层 —— 替换原 0.1.1 的 NodeApiClient。
//
// 为什么需要这一层：仓库里的 bridge 是按 DSH 0.1.1 的协议写的，而本机运行的是 0.2.x，
// 两者协议完全不同（实测逆向得出）：
//
//   1. 鉴权：0.2.x 的 /api 有浏览器信任栅栏 + 令牌认证。
//      先 GET /?token=<启动令牌> 换取签名 Cookie，之后所有请求带该 Cookie 与 Origin。
//   2. RPC 路径：0.1.1 是 /api/session.list（点号），0.2.x 是 /api/session/list（斜杠）。
//   3. RPC 信封：0.2.x 要求
//        { type:'client-request', rpcId, method:'<endpoint>', payload:{ args:{ <字段>:{...} } } }
//      字段由各 endpoint 的 descriptor 决定（如 session/create 要 request，session/list 要 _request）。
//   4. 事件流：0.1.1 走 SSE（events.mux），0.2.x 走 WebSocket /api/remote.mux，
//      客户端需先发 { type:'open', streamId, endpoint, payload:{args:{}} } 打开逻辑流。
//
// 本文件只实现 bridge 实际用到的最小集合，并保持与旧客户端同名的调用面
// （api.host.describe / api.sessions.* / api.events.mux），让 bridge.js 无需大改即可接入。

const DEFAULT_TIMEOUT_MS = 30_000;

/** 用启动令牌换取会话 Cookie。 */
async function acquireCookie(baseUrl, launchToken) {
  const res = await fetch(`${baseUrl}/?token=${encodeURIComponent(launchToken)}`, {
    redirect: 'manual', signal: AbortSignal.timeout(5000)
  });
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')];
  const cookie = (raw ?? [])
    .filter(Boolean)
    .map((entry) => String(entry).split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('dsh: token exchange did not return a session cookie');
  return cookie;
}

export class NodeApiClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.launchToken = options.launchToken ?? '';
    this.cookie = '';
    this.#buildSurface();
  }

  /** 完成令牌交换；必须在任何 RPC 之前调用。 */
  async connect() {
    if (this.launchToken) this.cookie = await acquireCookie(this.baseUrl, this.launchToken);
    return this;
  }

  #headers(extra = {}) {
    return {
      'content-type': 'application/json',
      // 信任栅栏要求 Origin 等于 Host；回环地址本身已可信，但仍需带上以通过校验。
      origin: this.baseUrl,
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra
    };
  }

  /** 发起一次 0.2.x RPC。args 会被包成 payload.args。 */
  async call(endpoint, args = {}, { signal } = {}) {
    const rpcId = `rq-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args }
    });
    const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: this.#headers(),
      body,
      signal: signal ?? AbortSignal.timeout(this.timeoutMs)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`dsh: ${endpoint}: HTTP ${res.status}: ${text.slice(0, 120)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`dsh: ${endpoint}: non-JSON response: ${text.slice(0, 200)}`); }
    if (parsed?.type === 'server-response' && parsed.result?.ok === false) {
      const { message } = parsed.result.error ?? {};
      throw new Error(`dsh: ${endpoint} failed: ${message ?? 'unknown error'}`);
    }
    return parsed?.result?.value ?? parsed;
  }

  /**
   * 打开 remote.mux 上的一个逻辑流并异步产出帧。
   * 0.2.x 的 mux 是双向 WebSocket：客户端先发 open，之后收到 { type:'item', streamId, value }。
   */
  async *openStream(endpoint, args = {}, { signal } = {}) {
    const streamId = `s-${Math.random().toString(36).slice(2)}`;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsUrl}/api/remote.mux`);
    const inbox = [];
    let wake;
    let closed = false;
    const enqueue = (item) => { inbox.push(item); const w = wake; wake = undefined; w?.(); };
    const onOpen = () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame?.streamId === streamId && frame?.type === 'item') enqueue({ kind: 'frame', value: frame.value });
      } catch { /* 忽略非 JSON 帧 */ }
    });
    const close = () => { if (!closed) { closed = true; enqueue({ kind: 'end' }); } };
    socket.addEventListener('close', close, { once: true });
    socket.addEventListener('error', close, { once: true });
    if (signal) signal.addEventListener('abort', () => { socket.close(); close(); }, { once: true });

    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item.kind === 'end') return;
          yield item.value;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      socket.removeEventListener('open', onOpen);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
  }

  /** 组装与旧客户端同名的调用面，减少 bridge.js 的改动量。 */
  #buildSurface() {
    const call = (endpoint, wrap) => (args = {}, opts) =>
      this.call(endpoint, wrap ? wrap(args) : args, opts);

    this.host = {
      // 0.2.x 不再暴露 host.describe；用会话列表作为连通性探针。
      describe: () => this.call('session/list', { _request: {} }, {
        signal: AbortSignal.timeout(5000)
      }).then(() => ({ ok: true }))
    };

    this.sessions = {
      list: call('session/list', (a) => ({ _request: a ?? {} })),
      create: call('session/create'),
      prompt: call('session/prompt'),
      cancel: call('session/cancel'),
      fork: call('session/fork'),
      rename: call('session/rename'),
      search: call('session/search'),
      projections: call('session/projections'),
      page: call('session/page', (a) => ({ request: a ?? {} })),
      // session/selectModel is one of the 0.2.x RPCs whose descriptor expects
      // the full request object under args.request (same as session/create).
      selectModel: call('session/selectModel', (a) => ({ request: a ?? {} })),
      history: call('session/page')
    };

    this.workspace = {
      create: call('workspace/create'),
      rename: call('workspace/rename'),
      delete: call('workspace/delete')
    };

    this.settings = {
      describe: call('settings/describe', (a) => a ?? {}),
      update: call('settings/update')
    };

    this.events = {
      /** 全局事件广播：status / activity / error。 */
      mux: (args = {}, opts = {}) => this.openStream('$events', args ?? {}, opts),
      /** 会话级事件流（含 assistant 文本），bridge 主要用这个。 */
      session: (sessionId, opts = {}) => this.openStream('session/follow', { request: { sessionId } }, opts)
    };
  }
}

/** 解出 RPC 结果槽；业务错误直接抛出（0.2.x 已在 call() 内抛过，这里保留兼容）。 */
export function unwrap(response, label) {
  if (response?.result?.ok === false) {
    const { code, message } = response.result.error ?? {};
    throw new Error(`${label} failed: ${code}: ${message}`);
  }
  return response?.result?.value ?? response;
}

/** 从 assistant 消息块中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 按 turn 收集 assistant 文本。
 * 0.2.x 的会话事件形状与 0.1.1 不同，这里同时接受两种形状，避免 bridge.js 大改。
 */
export function createTurnCollector() {
  const turns = new Map();
  return {
    push(event) {
      if (!event || typeof event !== 'object') return null;
      const type = event.type ?? event.event;
      if (type === 'turn/start') {
        turns.set(event.data?.turn ?? event.turn, { text: '' });
        return null;
      }
      if (type === 'assistant/message' || type === 'message/assistant') {
        const key = event.data?.turn ?? event.turn;
        const t = turns.get(key);
        if (!t) return null;
        t.text += blocksToText(event.data?.message?.content ?? event.content);
        return null;
      }
      if (type === 'turn/end') {
        const key = event.data?.turn ?? event.turn;
        const t = turns.get(key);
        turns.delete(key);
        if (!t) return null;
        return { turn: key, reason: event.data?.reason ?? event.reason ?? { kind: 'unknown' }, text: t.text };
      }
      return null;
    },
    has(turn) { return turns.has(turn); }
  };
}
