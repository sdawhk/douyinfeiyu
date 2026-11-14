#!/usr/bin/env node
// 小屋世界桥 / Cabin World bridge — 参考实现，零依赖（Node.js 18+）。
//
// 它做两件事：
//  1. 当游戏的“宿主”：在 127.0.0.1 上监听，把端口和一次性 token 写进 <data>/world/game-link.json，
//     游戏启动后自己连上来（协议见 docs/PROTOCOL.md）。
//  2. 给你的机器人软件（AstrBot、QQAgent、任意语言）一个本机 HTTP 接口：
//     GET /v1/status、/v1/look、/v1/catalog、/v1/events，POST /v1/go、/v1/use、/v1/buy、/v1/eat、/v1/stop、/v1/tool …
//     详见 docs/HTTP-API.md。接口地址和访问 token 写在 <data>/bridge.json，只有本机能连。
//
// 多居民（一个世界、几个身体）：
//   配置里写 residents 数组，一条居民一个 HTTP 端口；游戏这边一份宿主连接同时驱动所有身体。
//   第 1 位居民的接口信息写 <data>/bridge.json（旧脚本照旧能用），其余写 <data>/bridge.<key>.json。
//
// 它不调用任何 AI、不登录 QQ、不保存记忆。模型、人设、记忆都留在你的机器人软件里。
//
// 用法 / usage:  node bridge.mjs [--config bridge.config.json] [--no-launch]
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path'; import http from 'node:http'; import net from 'node:net';
import { spawn } from 'node:child_process'; import { randomBytes, timingSafeEqual } from 'node:crypto'; import { fileURLToPath } from 'node:url';
import { CabinHost } from './cabin-host.mjs';
import { Resident } from './lib/resident.mjs';
import { virtualWeather } from './lib/weather.mjs';
import { createChatLink } from './lib/chat-link.mjs';
import { createAutonomy } from './lib/autonomy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (...a) => console.log('[小屋世界桥]', ...a);

/** 读取配置；相对路径都相对于配置文件所在目录。 */
export function loadConfig(file) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
  const base = path.dirname(path.resolve(file));
  const rel = v => (v ? path.resolve(base, v) : v);
  const basePort = Number(raw.http?.port ?? 18790);
  // residents 数组缺省时退回旧的单居民字段，老配置照样跑。
  let list = Array.isArray(raw.residents) && raw.residents.length
    ? raw.residents.map((r, i) => ({
        key: String(r.key ?? r.resident ?? '').trim() || `resident${i + 1}`,
        who: String(r.who ?? r.key ?? r.resident ?? '').trim(),
        name: String(r.name ?? r.displayName ?? r.key ?? '').slice(0, 20),
        port: Number(r.port ?? (basePort + i)),
        // 可选：把这位居民的接口信息同时写到另一个 <目录>/bridge.json（老脚本只认这个文件名时用）
        mirror: rel(r.mirrorInfo) || null,
      }))
    : [{ key: raw.resident || 'xiaojingyu', who: raw.who || raw.resident || 'xiaojingyu', name: raw.displayName || '小鲸鱼', port: basePort }];
  // key 重复会让游戏把两具身体当成同一个演员，直接拒绝
  const seen = new Set();
  for (const r of list) { if (seen.has(r.key)) throw Error('bridge.config.json 里居民 key 重复：' + r.key); seen.add(r.key); if (!r.who) r.who = r.key; }
  const ports = new Set();
  for (const r of list) { if (!Number.isInteger(r.port) || r.port < 0 || r.port > 65535) throw Error('居民 ' + r.key + ' 的 port 不合法'); if (r.port && ports.has(r.port)) throw Error('两个居民用了同一个端口：' + r.port); ports.add(r.port); }
  return {
    residents: list,
    // 兼容旧字段：第一个居民
    resident: list[0].key,
    who: list[0].who,
    displayName: list[0].name,
    hostName: String(raw.hostName || '我的机器人').slice(0, 40),
    dataDir: rel(raw.dataDir || '../data'),
    gameExe: rel(raw.gameExe || '../CabinWorld.exe'),
    // 从源码跑（编辑器当运行时）时需要给引擎参数，例如 ["--path", "D:\\CabinWorld2\\game-src\\game"]
    gameArgs: Array.isArray(raw.gameArgs) ? raw.gameArgs.map(v => (String(v).startsWith('.') ? rel(String(v)) : String(v))) : [],
    launchGame: raw.launchGame !== false,
    http: { host: '127.0.0.1', port: list[0].port },
    weather: { mode: raw.weather?.mode === 'push' ? 'push' : 'virtual' },
    waitMs: Math.max(0, Math.min(Number(raw.waitMs ?? 45000), 600000)),
    catalog: rel(raw.catalog || path.join(HERE, 'catalog.json')),
    chatLink: {
      enabled: raw.chatLink?.enabled !== false,
      log: rel(raw.chatLink?.log) || '',
    },
    autonomy: {
      enabled: raw.autonomy?.enabled === true,
      intervalMs: Math.max(10 * 60000, Math.min(Number(raw.autonomy?.intervalMs ?? 15 * 60000), 20 * 60000)),
      firstDelayMs: Math.max(5000, Math.min(Number(raw.autonomy?.firstDelayMs ?? 20000), 60000)),
    },
  };
}

/** game-link.json 残留（上次崩溃）就清掉；若另一个宿主真的在用，则拒绝启动。 */
async function clearStaleLink(dataDir) {
  const file = path.join(dataDir, 'world', 'game-link.json');
  let row; try { row = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return; }
  const alive = await new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port: Number(row?.port) || 1 }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1500); });
  if (alive) throw Error('另一个宿主（可能是另一个桥或 VADS）正在使用这份数据目录：' + file + '。先关掉它，或给这个桥换一个 dataDir。');
  await fsp.unlink(file); say('清理了上次残留的 game-link.json');
}

export async function startBridge(cfg, { launch = cfg.launchGame, engineArgs = [], userArgs = [], quiet = false } = {}) {
  const log = quiet ? () => {} : say;
  const catalog = JSON.parse(fs.readFileSync(cfg.catalog, 'utf8'));
  const chatLink = createChatLink(cfg);
  await fsp.mkdir(path.join(cfg.dataDir, 'world'), { recursive: true });
  await clearStaleLink(cfg.dataDir);
  let pushed = null; // POST /v1/weather 推送的真实天气
  const weather = () => (cfg.weather.mode === 'push' && pushed?.reading ? pushed.reading : virtualWeather(Date.now()));

  // 一位居民一条记录：游戏里那具身体 + 一个 HTTP 端口 + 一份发现文件
  const specs = cfg.residents?.length ? cfg.residents : [{ key: cfg.resident, who: cfg.who, name: cfg.displayName, port: cfg.http.port }];
  const rows = [];
  const host = new CabinHost({ dataDir: cfg.dataDir, name: cfg.hostName, audioSettings: false,
    onPanelGet: async frame => {
      const row = rows.find(r => r.key === frame.actor) || rows[0];
      return row ? row.resident.panel(frame) : { ok: false, error: '没有这位居民' };
    },
    onPanelDo: async () => ({ ok: false, error: '这项由机器人软件自己提供' }) });
  const autonomyLoop = createAutonomy({ rows, host, intervalMs: cfg.autonomy?.intervalMs, firstDelayMs: cfg.autonomy?.firstDelayMs, log, logFile: cfg.chatLink?.log || path.join(cfg.dataDir, 'world', 'cabin-log.jsonl') });
  for (const [i, spec] of specs.entries()) {
    const resident = new Resident({ host, key: spec.key, who: spec.who, name: spec.name, catalog, weather });
    const row = { key: spec.key, name: spec.name, port: spec.port, mirror: spec.mirror || null, resident, token: randomBytes(24).toString('hex'),
      events: [], eventSeq: 0, server: null, infoFile: null, url: null };
    resident.on('event', e => { row.events.push({ seq: ++row.eventSeq, at: Date.now(), ...e }); if (row.events.length > 200) row.events.shift(); });
    rows.push(row);
    void i;
  }
  // 游戏每 15 秒收到一次天气；local（城市、温度…）只用于右上角的天气牌，可选。
  // 没有推送城市天气时，天气牌显示虚拟天气（标明来源），不会显示“天气待更新”。
  const localOf = r => ({ city: '小屋世界', condition: r.name, temperature: r.temp, wind: Math.round(r.wind * 6 * 10) / 10, source: '虚拟天气（未接真实天气）', at: Date.now(), fetchedAt: Date.now() });
  const sendWeather = () => { if (!host.connected) return; const reading = weather(); host.send({ type: 'weather', reading, local: pushed?.local && Date.now() - pushed.local.at < 90 * 60000 ? pushed.local : localOf(reading) }); };
  host.on('connected', caps => {
    log('游戏已连接（' + (caps.game || 'cabin-world') + '），居民 ' + rows.map(r => r.name).join(' / '));
    sendWeather();
    for (const row of rows) {
      row.events.push({ seq: ++row.eventSeq, at: Date.now(), type: 'game', connected: true });
      row.resident.open().then(() => { log(`${row.name} 已就位：零花钱 ${row.resident.state?.wallet?.coins ?? '?'} 元`); if (cfg.autonomy?.enabled) autonomyLoop.start(); }, e => log(`${row.name} 初始化失败：` + e.message));
    }
  });
  host.on('disconnected', () => {
    log('游戏断开（关闭窗口不会关闭桥，重新打开游戏会自动连回）');
    for (const row of rows) row.events.push({ seq: ++row.eventSeq, at: Date.now(), type: 'game', connected: false });
  });
  host.on('frame', f => { if (f.type === 'quit') log('游戏窗口关闭了'); });
  await host.start();
  const timer = setInterval(() => { sendWeather(); for (const row of rows) row.resident.publish(); }, 15000); timer.unref();

  // ---- HTTP（每位居民一个端口，token 各自独立）----
  const taskView = t => ({ taskId: t.id, status: t.status, label: t.label, ...(t.status === 'done' ? { result: t.result } : {}), ...(t.status === 'failed' ? { error: t.error } : {}), ...(t.status === 'running' ? { hint: '还在进行中：稍后用 GET /v1/tasks/' + t.id + ' 查询，完成前不要当作已经做完' } : {}) });
  const waitTask = async (task, waitMs) => { if (waitMs > 0) await Promise.race([task.promise, new Promise(r => setTimeout(r, waitMs).unref())]); return taskView(task); };
  const need = () => { if (!host.connected) throw Object.assign(Error('游戏没有打开或还没连上。请先打开小屋世界。'), { status: 503 }); };

  const makeServer = row => {
    const resident = row.resident, token = row.token;
    const authed = req => { const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-cabin-token'] || ''); const a = Buffer.from(h), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
    const TOOLS = {
      cabin_status: () => ({ ok: true, ...resident.status() }),
      cabin_look: () => ({ ok: true, ...resident.look() }),
      cabin_go: a => { need(); return resident.go(a.place, a.zone); },
      cabin_use: a => { need(); return resident.use(a.object, a.use, { item: a.item, feeling: a.feeling }); },
      cabin_buy: a => { need(); return resident.buy(a.product, { feeling: a.feeling }); },
      cabin_eat: a => { need(); return resident.eat(a.product, { feeling: a.feeling }); },
      cabin_stop: () => resident.stop(),
    };
    const runTool = async (name, args = {}, waitMs = cfg.waitMs) => {
      const fn = TOOLS[name]; if (!fn) throw Object.assign(Error('没有这个工具：' + name), { status: 404 });
      if (['cabin_go', 'cabin_use', 'cabin_buy', 'cabin_eat'].includes(name) && resident.task?.source === 'autonomy') {
        const task = resident.task, stopped = resident.stop('主人开始操作');
        if (!stopped.stopped) throw Object.assign(Error(`自主活动“${task.label}”已经进入提交阶段，暂时无法撤回；完成后请重试。`), { code: 'busy' });
        await task.promise;
      }
      const out = await fn(args || {});
      return out && out.promise ? waitTask(out, Number.isFinite(args.waitMs) ? args.waitMs : waitMs) : out;
    };
    const server = http.createServer(async (req, res) => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      try {
        // 浏览器网页不能调用（防止网页借你的浏览器操纵角色）/ refuse browser cross-site calls
        if (req.headers.origin) return send(403, { ok: false, error: 'browser requests are not allowed' });
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/v1/health') return send(200, { ok: true, game: host.connected, resident: row.key, name: row.name });
        if (!authed(req)) return send(401, { ok: false, error: '缺少或错误的 token（见 data/bridge.json）' });
        let body = {};
        if (req.method === 'POST') {
          let raw = ''; for await (const c of req) { raw += c; if (raw.length > 65536) return send(413, { ok: false, error: 'too large' }); }
          try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { ok: false, error: 'body must be JSON' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, error: 'body must be a JSON object' });
        }
        const route = req.method + ' ' + url.pathname;
        if (route === 'GET /v1/status') return send(200, await runTool('cabin_status'));
        if (route === 'GET /v1/look') return send(200, await runTool('cabin_look'));
        if (route === 'GET /v1/catalog') return send(200, catalog);
        if (route === 'GET /v1/tools') return send(200, JSON.parse(fs.readFileSync(path.join(HERE, 'openai-tools.json'), 'utf8')));
        if (route === 'GET /v1/events') { const after = Number(url.searchParams.get('after') || 0); return send(200, { ok: true, last: row.eventSeq, events: row.events.filter(e => e.seq > after) }); }
        if (req.method === 'GET' && url.pathname.startsWith('/v1/tasks/')) { const t = resident.tasks.get(url.pathname.slice(10)); return t ? send(200, taskView(t)) : send(404, { ok: false, error: '没有这个任务' }); }
        const map = { 'POST /v1/go': 'cabin_go', 'POST /v1/use': 'cabin_use', 'POST /v1/buy': 'cabin_buy', 'POST /v1/eat': 'cabin_eat', 'POST /v1/stop': 'cabin_stop' };
        if (map[route]) return send(200, await runTool(map[route], body));
        if (route === 'POST /v1/tool') {
          let args = body.arguments; if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { return send(400, { ok: false, error: 'arguments must be JSON' }); } }
          return send(200, await runTool(String(body.name || ''), args || {}));
        }
        if (route === 'POST /v1/weather') {
          if (body.reading && typeof body.reading !== 'object') return send(400, { ok: false, error: 'reading must be an object' });
          pushed = { reading: body.reading ? { ...virtualWeather(Date.now()), ...body.reading } : null, local: body.local && typeof body.local === 'object' ? { ...body.local, at: Date.now(), fetchedAt: Date.now() } : null };
          sendWeather(); return send(200, { ok: true, mode: cfg.weather.mode, note: cfg.weather.mode === 'push' ? '已采用' : 'local 已显示；reading 需要把 weather.mode 设为 push 才会替代虚拟天气' });
        }
        return send(404, { ok: false, error: 'unknown endpoint, see docs/HTTP-API.md' });
      } catch (error) { send(error.status || (error.code === 'busy' ? 409 : 400), { ok: false, error: String(error.message || error) }); }
    });
    return { server, runTool };
  };

  const servers = [];
  for (const [i, row] of rows.entries()) {
    const { server, runTool } = makeServer(row);
    await new Promise((resolve, reject) => {
      server.once('error', e => reject(e.code === 'EADDRINUSE' ? Error(`端口 ${row.port} 已被占用：可能桥已经在运行；或在 bridge.config.json 里换一个 port（0 = 自动）`) : e));
      server.listen(row.port, cfg.http.host, resolve);
    });
    row.server = server; row.runTool = runTool;
    if (chatLink.file) row.resident.on('event', e => chatLink.note(row, e));
    row.url = `http://127.0.0.1:${server.address().port}`;
    // 第一位写 bridge.json（老脚本照旧能读到），其余写 bridge.<key>.json
    row.infoFile = path.join(cfg.dataDir, i === 0 ? 'bridge.json' : `bridge.${row.key}.json`);
    const infoText = JSON.stringify({ url: row.url, token: row.token, resident: row.key, name: row.name, pid: process.pid, at: Date.now() }, null, 2) + '\n';
    await fsp.writeFile(row.infoFile, infoText, { mode: 0o600 });
    // 老安装目录里的脚本只认 <目录>/data/bridge.json：按要求把同一份信息镜像过去
    if (row.mirror) {
      row.mirrorFile = path.join(row.mirror, 'bridge.json');
      try { await fsp.mkdir(row.mirror, { recursive: true }); await fsp.writeFile(row.mirrorFile, infoText, { mode: 0o600 }); }
      catch (e) { log(`镜像 ${row.mirrorFile} 失败：${e.message}`); row.mirrorFile = null; }
    }
    servers.push(server);
    log(`${row.name}（${row.key}）的 HTTP 接口：` + row.url + '（token 在 ' + row.infoFile + '）');
  }

  let child = null;
  if (launch) {
    if (!fs.existsSync(cfg.gameExe)) log('找不到游戏：' + cfg.gameExe + '（只启动桥，可以手动打开游戏）');
    else {
      // 不传 --unit：桥退出时游戏不会被强制关闭；数据目录与桥一致。
      const owned = engineArgs.length > 0 || userArgs.length > 0; // 自检时由桥管理游戏进程
      child = spawn(cfg.gameExe, [...cfg.gameArgs, ...engineArgs, '--', '--data', cfg.dataDir, ...userArgs], { stdio: 'ignore', detached: !owned, windowsHide: owned });
      child.on('error', e => log('启动游戏失败：' + e.message)); if (!owned) child.unref();
      log('已打开游戏窗口');
    }
  }
  const close = async () => {
    autonomyLoop.close();
    clearInterval(timer);
    for (const server of servers) await new Promise(r => server.close(r));
    await host.close();
    for (const row of rows) { try { const line = JSON.parse(await fsp.readFile(row.infoFile, 'utf8')); if (line.token === row.token) await fsp.unlink(row.infoFile); } catch { /* 已删除 */ } }
    for (const row of rows) { if (!row.mirrorFile) continue; try { const line = JSON.parse(await fsp.readFile(row.mirrorFile, 'utf8')); if (line.token === row.token) await fsp.unlink(row.mirrorFile); } catch { /* 已删除 */ } }
  };
  return { host, resident: rows[0].resident, residents: rows.map(r => ({ key: r.key, name: r.name, url: r.url, token: r.token, resident: r.resident })), server: servers[0], url: rows[0].url, token: rows[0].token, close, child, runTool: rows[0].runTool };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), ci = args.indexOf('--config');
  const cfgFile = ci >= 0 ? path.resolve(args[ci + 1]) : path.join(HERE, 'bridge.config.json');
  if (!fs.existsSync(cfgFile)) say('没有找到 ' + cfgFile + '，使用默认设置（可复制 bridge.config.example.json 修改）');
  const cfg = loadConfig(cfgFile);
  startBridge(cfg, { launch: !args.includes('--no-launch') && cfg.launchGame }).then(b => {
    say('准备好了。按 Ctrl+C 关闭桥（游戏窗口可以单独关）。');
    const stop = () => { void b.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }, e => { say('启动失败：' + e.message); process.exit(1); });
}
