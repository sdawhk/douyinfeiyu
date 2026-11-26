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
// 它不调用任何 AI、不登录 QQ、不保存记忆。模型、人设、记忆都留在你的机器人软件里。
//
// 用法 / usage:  node bridge.mjs [--config bridge.config.json] [--no-launch]
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path'; import http from 'node:http'; import net from 'node:net';
import { spawn } from 'node:child_process'; import { randomBytes, timingSafeEqual } from 'node:crypto'; import { fileURLToPath } from 'node:url';
import { CabinHost } from './cabin-host.mjs';
import { Resident } from './lib/resident.mjs';
import { Arcade, ARCADE_NAMES } from './lib/arcade.mjs';
import { CustomFurniture } from './lib/custom-furniture.mjs';
import { virtualWeather } from './lib/weather.mjs';
import { discover } from './lib/discovery.mjs';
import { Updater, readDescriptions, filterCatalog } from './lib/update.mjs';
import { firstRun } from './lib/first-run.mjs';
import { Processes } from './lib/processes.mjs';
import { createAutonomy } from './lib/autonomy.mjs';
import { createChatLink } from './lib/chat-link.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (...a) => console.log('[小屋世界桥]', ...a);

/** 读取配置；相对路径都相对于配置文件所在目录。 */
export function loadConfig(file) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
  const base = path.dirname(path.resolve(file));
  const rel = v => (v ? path.resolve(base, v) : v);
  return {
    resident: raw.resident || 'xiaojingyu',
    residents: Array.isArray(raw.residents) ? raw.residents : [],
    who: raw.who || raw.resident || 'xiaojingyu',
    displayName: raw.displayName || '小鲸鱼',
    hostName: String(raw.hostName || '我的机器人').slice(0, 40),
    dataDir: rel(raw.dataDir || '../data'),
    gameExe: rel(raw.gameExe || '../CabinWorld.exe'),
    launchGame: raw.launchGame !== false,
    http: { host: '127.0.0.1', port: Number(raw.http?.port ?? 18790) },
    weather: { mode: raw.weather?.mode === 'push' ? 'push' : 'virtual' },
    waitMs: Math.max(0, Math.min(Number(raw.waitMs ?? 45000), 600000)),
    catalog: rel(raw.catalog || path.join(HERE, 'catalog.json')),
    chatLink: { enabled: raw.chatLink?.enabled !== false, log: rel(raw.chatLink?.log) || '' },
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
  // 1.1 modules (lib/update.mjs): the bot is offered only what is switched on, the same as the game reads at start.
  const descriptions = readDescriptions(cfg.modules || path.join(HERE, 'update', 'modules.json'));
  // First 1.1 start: back up a 1.0 install, move its layouts inside, and keep the "ask" modules off (lib/first-run.mjs).
  const first = firstRun({ dataDir: cfg.dataDir, installDir: path.dirname(cfg.gameExe), descriptions });
  if (!first.skipped) log(first.upgrade ? '检测到旧存档：已备份到 ' + first.backup + '；可选更新先保留原版，请安装 AI 用 cabin_update_plan 逐项介绍并按用户选择启用。' : '第一次启动 1.1：可选内容先保持关闭，请安装 AI 用 cabin_update_plan 逐项介绍，或使用 update.cmd 选择。');
  const updater = new Updater({ dataDir: cfg.dataDir, installDir:path.dirname(cfg.gameExe), descriptions });
  const catalog = filterCatalog(JSON.parse(fs.readFileSync(cfg.catalog, 'utf8')), updater.flags());
  await fsp.mkdir(path.join(cfg.dataDir, 'world'), { recursive: true });
  await clearStaleLink(cfg.dataDir);
  let pushed = null; // POST /v1/weather 推送的真实天气
  const weather = () => (cfg.weather.mode === 'push' && pushed?.reading ? pushed.reading : virtualWeather(Date.now()));
  let resident;
  const residents=new Map();let ready=false;
  const chatLink=createChatLink(cfg);
  const autonomyRows=[];
  const host = new CabinHost({ dataDir: cfg.dataDir, name: cfg.hostName, audioSettings: false,
    onPanelGet: async frame => { const merged={};let first=null;for(const r of residents.values()){const p=r.panel(frame);first??=p;Object.assign(merged,p.data?.residents||{});}return first?.ok?{...first,data:{...first.data,residents:merged}}:first; }, onPanelDo: async () => ({ ok: false, error: '这项由机器人软件自己提供' }) });
  const autonomyLoop=createAutonomy({rows:autonomyRows,host,intervalMs:cfg.autonomy.intervalMs,firstDelayMs:cfg.autonomy.firstDelayMs,log,logFile:cfg.chatLink.log||path.join(cfg.dataDir,'world','cabin-log.jsonl')});
  resident = new Resident({ host, key: cfg.resident, who: cfg.who, name: cfg.displayName, catalog, weather });
  residents.set(resident.key,resident);
  const autonomyRow={key:resident.key,name:resident.name,resident};
  autonomyRows.push(autonomyRow);
  const arcade=new Arcade(host);resident.arcade=arcade;
  const events = []; let eventSeq = 0;
  const pushEvent = e => { events.push({ seq: ++eventSeq, at: Date.now(), ...e }); if (events.length > 200) events.shift(); };
  const furniture=new CustomFurniture(host,pushEvent);
  resident.on('event',e=>{pushEvent({...e,actor:resident.key});chatLink.note(autonomyRow,e);});
  const configured=new Map([[cfg.resident,{key:cfg.resident,name:cfg.displayName}],...(cfg.residents||[]).map(r=>[r.key,r])]);
  const installResident=async row=>{
    const reply=await host.request('resident.do',{action:'register',actor:row.key,name:row.name||row.key,mapId:row.mapId||''},{replyType:'resident.result'});
    const profile=reply.resident;
    let r=residents.get(row.key);
    if(!r){r=new Resident({host,key:row.key,who:row.key,name:profile.name,catalog,weather});r.arcade=arcade;residents.set(row.key,r);r.on('event',e=>{pushEvent({...e,actor:r.key});const activity=autonomyRows.find(x=>x.key===r.key);if(activity)chatLink.note(activity,e);});}
    r.objects=new Map(catalog.objects.map(o=>[o.id,o]));
    r.name=profile.name;r.homeBoard=profile.arcade?.board;r.homeSeats=profile.arcade?.seats;
    const home=r.spaces.get('xjhome');
    r.spaces.set('xjhome',{...home,scene:profile.scene,owner:'resident:'+row.key,fullName:profile.homeName||profile.name+'的家',name:profile.homeName||profile.name+'的家',zones:Object.keys(profile.zones).map(id=>({id,name:home.zones.find(z=>z.id===id)?.name||id}))});
    for(const [id,o] of r.objects){if(o.space==='xjhome'&&!profile.zones[o.zone])r.objects.delete(id);}
    if(!r.processes||r.processes.closed)r.processes=new Processes(r,(name,args)=>TOOLS[name]({...args,actor:r.key}));
    const activity=autonomyRows.find(x=>x.key===r.key);if(activity){activity.name=r.name;activity.resident=r;}else autonomyRows.push({key:r.key,name:r.name,resident:r});
    for(const visitor of residents.values())for(const [id,space]of visitor.spaces){if(id==='visit_'+r.key)visitor.spaces.set(id,{...space,fullName:profile.homeName||profile.name+'的家',name:profile.homeName||profile.name+'的家',scene:profile.scene});}
    await r.open();return r;
  };
  // 游戏每 15 秒收到一次天气；local（城市、温度…）只用于右上角的天气牌，可选。
  // 没有推送城市天气时，天气牌显示虚拟天气（标明来源），不会显示“天气待更新”。
  const localOf = r => ({ city: '小屋世界', condition: r.name, temperature: r.temp, wind: Math.round(r.wind * 6 * 10) / 10, source: '虚拟天气（未接真实天气）', at: Date.now(), fetchedAt: Date.now() });
  const sendWeather = () => { if (!host.connected) return; const reading = weather(); host.send({ type: 'weather', reading, local: pushed?.local && Date.now() - pushed.local.at < 90 * 60000 ? pushed.local : localOf(reading) }); };
  host.on('connected', caps => {
    log('游戏已连接（' + (caps.game || 'cabin-world') + '）');
    pushEvent({ type: 'game', connected: true });
    sendWeather();
    ready=false;
    (async()=>{
      if(!caps.residentRegistry){
        const keys=new Set([cfg.resident,...(cfg.residents||[]).map(r=>r.key)]);
        if(keys.size>1)throw Error('此桥需要1.1游戏；旧游戏只支持默认住户，无法接入住户列表中的其他角色');
        const legacyProfile=(cfg.residents||[]).find(r=>r.key===cfg.resident);
        if(legacyProfile){resident.name=legacyProfile.name||resident.name;resident.who=legacyProfile.who||resident.who;}
        autonomyRow.name=resident.name;
        if(!resident.processes||resident.processes.closed)resident.processes=new Processes(resident,(name,args)=>TOOLS[name]({...args,actor:resident.key}));
        await resident.open();
        ready=true;
        log('旧版游戏兼容模式已就位：仅启用默认住户');
        if(cfg.autonomy.enabled)autonomyLoop.start();
        return;
      }
      const saved=await host.request('resident.do',{action:'list'},{replyType:'resident.result'});
      for(const key of saved.deleted||[]){configured.delete(key);const old=residents.get(key);old?.dispose();residents.delete(key);}
      for(const row of saved.residents.filter(r=>r.custom))configured.set(row.key,row);
      for(const row of configured.values())await installResident(row);
      const records=await host.request('arcade.records',{history:[]},{replyType:'arcade.history'});arcade.history=records.history;
      // Recover a disconnect between recording a result and crediting every player.
      // The game's match-id ledger makes this safe to repeat after another interruption.
      for(const record of arcade.history)for(const player of record.players){
        const r=residents.get(player.id);
        if(r&&!Object.hasOwn(r.state?.arcadePayouts||{},record.matchId))await r.lifeEvent({type:'arcade',matchId:record.matchId,kind:record.kind,name:ARCADE_NAMES[record.kind]||record.kind,result:player.result,score:record.score||0});
      }
      arcade.view();
      ready=true;log('住户已就位：'+residents.size+'位');if(cfg.autonomy.enabled)autonomyLoop.start();
    })().catch(e=>log('初始化住户失败：'+e.message));
  });
  host.on('disconnected', () => { ready=false;autonomyLoop.close();for(const r of residents.values())r.processes?.close(); log('游戏断开（关闭窗口不会关闭桥，重新打开游戏会自动连回）'); pushEvent({ type: 'game', connected: false }); });
  const detachResident=key=>{configured.delete(key);residents.get(key)?.dispose();residents.delete(key);for(const r of residents.values()){r.spaces.delete('visit_'+key);r.visits?.delete('visit_'+key);r.objects.delete('home_chess_visit_'+key);}};
  host.on('frame', f => { if(f.type==='resident.changed'&&ready){if(f.removed)detachResident(f.actor);else void installResident({key:f.actor}).catch(e=>log(e.message));} if (f.type === 'quit') log('游戏窗口关闭了'); });
  await host.start();
  const timer = setInterval(() => { sendWeather(); for(const r of residents.values())r.publish(); }, 15000); timer.unref();

  // ---- HTTP ----
  const token = randomBytes(24).toString('hex');
  const authed = req => { const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-cabin-token'] || ''); const a = Buffer.from(h), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  const waitTask = async (task, waitMs) => { if (waitMs > 0) await Promise.race([task.promise, new Promise(r => setTimeout(r, waitMs).unref())]); return taskView(task); };
  const taskView = t => ({ taskId: t.id, status: t.status, label: t.label, ...(t.status === 'done' ? { result: t.result } : {}), ...(t.status === 'failed' ? { error: t.error } : {}), ...(t.status === 'running' ? { hint: '还在进行中：用 cabin_task(taskId=' + t.id + ') 或 GET /v1/tasks/' + t.id + ' 查询，完成前不要当作已经做完' } : {}) });
  const need = () => { if (!host.connected) throw Object.assign(Error('游戏没有打开或还没连上。请先打开小屋世界。'), { status: 503 }); };
  const select=a=>{const key=a.actor||cfg.resident;const r=residents.get(key);if(!r)throw Error('没有接入这位住户：'+key);return r;};
  const TOOLS = {
    // 1.1 modules: work with the game closed; a change takes effect when the game restarts.
    cabin_update_plan: () => updater.plan(),
    cabin_update_apply: a => updater.apply(a.modules, a.reason),
    cabin_update_undo: () => updater.undo(),
    cabin_catalog: async a=>{need();const r=select(a);return discover(r,await furniture.list(r),a);},
    cabin_task: a=>{const t=select(a).tasks.get(a.taskId);if(!t)throw Error('没有这个任务，或任务不属于当前住户；重启后请查看状态与事件记录');return taskView(t);},
    cabin_furniture: async a=>{need();return {ok:true,objects:await furniture.list(select(a))};},
    cabin_residents: async a=>{need();return host.request('resident.do',{action:'list'},{replyType:'resident.result'});},
    cabin_add_resident: async a=>{need();if(!ready)throw Error('住户正在初始化');const r=await installResident({key:a.key,name:a.name,mapId:a.mapId});configured.set(r.key,{key:r.key,name:r.name});return {ok:true,key:r.key,name:r.name,home:r.spaces.get('xjhome')};},
    cabin_process: a=>{need();return select(a).processes.handle(a);},
    cabin_rename_home: async a=>{need();const r=select(a);const result=await host.request('resident.do',{action:'rename_home',actor:r.key,name:a.name},{replyType:'resident.result'});await installResident({key:r.key});return result;},
    cabin_remove_resident: async a=>{
      need();const r=select(a);const list=await host.request('resident.do',{action:'list'},{replyType:'resident.result'});
      if(!list.residents.find(p=>p.key===r.key)?.custom)throw Error('内置机器人不能删除');
      if(a.confirm!==r.key)throw Error('删除前需将 confirm 填写为目标住户的准确编号');
      const task=r.task;if(task){const stopped=r.stop('删除自建住户');if(!stopped.stopped)throw Error('活动正在提交，请完成后再删除');}
      r.processes?.close();if(task)await task.promise;
      try{const result=await host.request('resident.do',{action:'remove',actor:r.key},{replyType:'resident.result'});detachResident(r.key);return result;}
      catch(e){r.processes=new Processes(r,(name,args)=>TOOLS[name]({...args,actor:r.key}));throw e;}
    },
    cabin_assign_room: async a=>{need();const r=select(a);if(r.task)throw Error('请先完成当前活动');const trip=r.go('park');await trip.promise;if(trip.status!=='done')throw Error(trip.error);if(r.task)throw Error('前一项活动未结束');const reply=await host.request('resident.do',{action:'room',actor:r.key,mapId:a.mapId||''},{replyType:'resident.result'});await installResident({key:r.key});return reply;},
    cabin_invite: async a=>{
      need();const owner=select(a),guest=select({actor:a.guest});if(owner===guest)throw Error('不能邀请自己');
      const home=owner.spaces.get('xjhome'),id='visit_'+owner.key;
      guest.visits??=new Set();guest.visits.add(id);
      guest.spaces.set(id,{...home,id});
      const object='home_chess_'+id,base=owner.objects.get('home_chess_xjhome');
      if(base)guest.objects.set(object,{...base,id:object,space:id,arcadeBoard:owner.homeBoard,arcadeSeats:owner.homeSeats});
      return {ok:true,guest:guest.key,place:id,chessObject:base?object:null,note:'已允许来访；客人仍需自行调用工具走来或入座'};
    },
    cabin_status: a => ({ ok: true, actor:select(a).key, ...select(a).status() }),
    cabin_look: async a => ({ ok: true, actor:select(a).key, ...select(a).look(),customFurniture:await furniture.list(select(a)) }),
    cabin_go: a => { need(); return select(a).go(a.place, a.zone); },
    cabin_use: a => { need(); return String(a.object).startsWith('made/')?furniture.use(select(a),a.object,a.use):select(a).use(a.object, a.use, a); },
    cabin_buy: a => { need(); return select(a).buy(a.product, { feeling: a.feeling }); },
    cabin_eat: a => { need(); return select(a).eat(a.product, { feeling: a.feeling }); },
    cabin_stop: a => select(a).stop(a.reason||'自己决定或用户要求结束',a.action||'stop'),
    cabin_rename: async a=>{need();const r=select(a);const result=await r.rename(a.name);await installResident({key:r.key});return result;},
    cabin_restaurant: a=>{need();return select(a).restaurant(a.action,a.dish,a.feeling);},
  };
  const runTool = async (name, args = {}, waitMs = cfg.waitMs) => {
    const fn = TOOLS[name]; if (!fn) throw Object.assign(Error('没有这个工具：' + name), { status: 404 });
    if(host.connected&&!ready&&!['cabin_status','cabin_residents','cabin_update_plan','cabin_update_apply','cabin_update_undo'].includes(name))throw Object.assign(Error('住户正在初始化，请稍后重试'),{status:503});
    const target=residents.get(args.actor||cfg.resident);
    if(['cabin_go','cabin_use','cabin_buy','cabin_eat'].includes(name)&&target?.task?.source==='autonomy'){
      const task=target.task,stopped=target.stop('主人开始操作');
      if(!stopped.stopped)throw Object.assign(Error(`自主活动“${task.label}”已经进入提交阶段，暂时无法撤回；完成后请重试。`),{code:'busy'});
      await task.promise;
    }
    const out = await fn(args || {});
    // Furniture actions return a receipt immediately, so the model can choose
    // to stop while the action is still running, instead of waiting its duration.
    const wait=Number.isFinite(args.waitMs)?args.waitMs:name==='cabin_use'&&out?.kind==='use'?0:waitMs;
    return out && out.promise ? waitTask(out, Math.max(0,Math.min(wait,600000))) : out;
  };
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      // 浏览器网页不能调用（防止网页借你的浏览器操纵角色）/ refuse browser cross-site calls
      if (req.headers.origin) return send(403, { ok: false, error: 'browser requests are not allowed' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/v1/health') return send(200, { ok: true, game: host.connected, resident: cfg.resident });
      if (!authed(req)) return send(401, { ok: false, error: '缺少或错误的 token（见 data/bridge.json）' });
      let body = {};
      if (req.method === 'POST') {
        const limit=url.pathname==='/v1/furniture'?34*1024*1024:65536;
        let raw = '',bytes=0; for await (const c of req) {bytes+=c.length;if(bytes>limit)return send(413,{ok:false,error:'too large'});raw+=c;}
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { ok: false, error: 'body must be JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, error: 'body must be a JSON object' });
      }
      const route = req.method + ' ' + url.pathname;
      if(route==='GET /v1/furniture')return send(200,await runTool('cabin_furniture',{actor:url.searchParams.get('actor')}));
      if(route==='POST /v1/furniture'){need();return send(200,await furniture.upload(body.spec,body.images));}
      if(route==='POST /v1/furniture/complete'){need();return send(200,furniture.complete(select(body).key,body.requestId,body.ok,body.result));}
      if (route === 'GET /v1/status') return send(200, await runTool('cabin_status',{actor:url.searchParams.get('actor')}));
      if (route === 'GET /v1/look') return send(200, await runTool('cabin_look',{actor:url.searchParams.get('actor')}));
      if (route === 'GET /v1/catalog') {
        if(['query','space','object','offset','limit'].some(k=>url.searchParams.has(k)))return send(200,await runTool('cabin_catalog',Object.fromEntries(url.searchParams)));
        need();const r=select({actor:url.searchParams.get('actor')});return send(200,{...catalog,spaces:[...r.spaces.values()],objects:[...r.objects.values()],customFurniture:await furniture.list(r)});
      }
      if (route === 'GET /v1/tools') return send(200, JSON.parse(fs.readFileSync(path.join(HERE, 'openai-tools.json'), 'utf8')));
      if (route === 'GET /v1/events') { const after = Number(url.searchParams.get('after') || 0); return send(200, { ok: true, last: eventSeq, events: events.filter(e => e.seq > after) }); }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/tasks/')) { const t = [...residents.values()].map(r=>r.tasks.get(url.pathname.slice(10))).find(Boolean); return t ? send(200, taskView(t)) : send(404, { ok: false, error: '没有这个任务' }); }
      if(route==='GET /v1/residents')return send(200,await runTool('cabin_residents'));
      if(route==='GET /v1/update')return send(200,await runTool('cabin_update_plan'));
      if(route==='POST /v1/update')return send(200,await runTool('cabin_update_apply',body));
      if(route==='POST /v1/update/undo')return send(200,await runTool('cabin_update_undo'));
      const map = { 'POST /v1/residents':'cabin_add_resident','POST /v1/room':'cabin_assign_room','POST /v1/rename':'cabin_rename','POST /v1/invite':'cabin_invite','POST /v1/restaurant':'cabin_restaurant', 'POST /v1/go': 'cabin_go', 'POST /v1/use': 'cabin_use', 'POST /v1/buy': 'cabin_buy', 'POST /v1/eat': 'cabin_eat', 'POST /v1/stop': 'cabin_stop' };
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
  await new Promise((resolve, reject) => { server.once('error', e => reject(e.code === 'EADDRINUSE' ? Error(`端口 ${cfg.http.port} 已被占用：可能桥已经在运行；或在 bridge.config.json 里换一个 http.port（0 = 自动）`) : e)); server.listen(cfg.http.port, cfg.http.host, resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const infoFile = path.join(cfg.dataDir, 'bridge.json');
  await fsp.writeFile(infoFile, JSON.stringify({ url, token, resident: cfg.resident, pid: process.pid, at: Date.now() }, null, 2) + '\n', { mode: 0o600 });
  log('HTTP 接口：' + url + '（token 在 ' + infoFile + '）');

  let child = null;
  if (launch) {
    if (!fs.existsSync(cfg.gameExe)) log('找不到游戏：' + cfg.gameExe + '（只启动桥，可以手动打开游戏）');
    else {
      // 不传 --unit：桥退出时游戏不会被强制关闭；数据目录与桥一致。
      const owned = engineArgs.length > 0 || userArgs.length > 0; // 自检时由桥管理游戏进程
      // 1.1: furniture layouts live in <data>/layouts (1.0 wrote them into the folder above the install; first-run copied them).
      const layoutArgs = userArgs.includes('--layout') ? [] : ['--layout', path.join(cfg.dataDir, 'layouts', 'home-grid-layout.json')];
      fs.mkdirSync(path.join(cfg.dataDir, 'layouts'), { recursive: true });
      child = spawn(cfg.gameExe, [...engineArgs, '--', '--data', cfg.dataDir, ...layoutArgs, ...userArgs], { stdio: 'ignore', detached: !owned, windowsHide: owned });
      child.on('error', e => log('启动游戏失败：' + e.message)); if (!owned) child.unref();
      log('已打开游戏窗口');
    }
  }
  const close = async () => { clearInterval(timer);autonomyLoop.close();for(const r of residents.values())r.processes?.close(); await new Promise(r => server.close(r)); await host.close(); try { const row = JSON.parse(await fsp.readFile(infoFile, 'utf8')); if (row.token === token) await fsp.unlink(infoFile); } catch { /* 已删除 */ } };
  return { host, resident, residents, arcade, furniture, get ready(){return ready;}, server, url, token, close, child, runTool };
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
