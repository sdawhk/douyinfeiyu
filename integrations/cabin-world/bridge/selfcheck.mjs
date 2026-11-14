#!/usr/bin/env node
// 自检 / Self-check.
//   node selfcheck.mjs           只检查安装（文件、配置、端口），几秒钟
//   node selfcheck.mjs --live    再用“临时空存档”真实启动一次游戏，走一遍：连接→看状态→去公园→荡秋千→买东西→喝掉→回家喂鱼→叫停
//                                （不会碰你的正式存档；默认无窗口，加 --show 可以看着它跑）
//   node selfcheck.mjs --live --full   额外测试汤屋（换浴衣→泡汤），多走几个房间，约多 1 分钟
//   --report <file>              把结果写成 JSON
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path'; import os from 'node:os'; import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadConfig, startBridge } from './bridge.mjs';
import { chooseAutonomyAction } from './lib/autonomy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), live = args.includes('--live'), full = args.includes('--full'), show = args.includes('--show');
const reportFile = args.includes('--report') ? path.resolve(args[args.indexOf('--report') + 1]) : null;
const cfgFile = args.includes('--config') ? path.resolve(args[args.indexOf('--config') + 1]) : path.join(HERE, 'bridge.config.json');
const results = []; let failed = 0;
const pass = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log('  ✔ ' + name + (detail ? '  — ' + detail : '')); };
const fail = (name, detail = '') => { results.push({ name, ok: false, detail }); failed++; console.log('  ✘ ' + name + (detail ? '  — ' + detail : '')); };
const check = async (name, fn) => { try { const d = await fn(); pass(name, d || ''); return true; } catch (e) { fail(name, e.message || String(e)); return false; } };
const assert = (v, msg) => { if (!v) throw Error(msg); };

console.log('小屋世界 · 安装自检');
const cfg = loadConfig(cfgFile);
await check('自主选择遵守忙碌、断线、夜间和预算边界', () => {
  const catalog = JSON.parse(fs.readFileSync(cfg.catalog, 'utf8'));
  const resident = { state: {}, catalog, objects: new Map(catalog.objects.map(o => [o.id, o])), bagList: () => [] };
  const base = { connected: true, feeling: { satiety: 70, hydration: 70 }, wishes: [], weather: { rain: 0, wind: 1 }, wallet: 30, position: { space: 'park' } };
  const daytime = Date.UTC(2026, 10, 14, 4); // 北京中午
  assert(chooseAutonomyAction({ status: { ...base, connected: false }, resident, now: daytime }) === null, '断线时仍选出动作');
  resident.task = { label: '主人正在操作' };
  assert(chooseAutonomyAction({ status: base, resident, now: daytime }) === null, '忙碌时仍选出动作');
  resident.task = null;
  assert(chooseAutonomyAction({ status: base, resident, now: Date.UTC(2026, 10, 14, 16) }) === null, '夜间仍选出动作'); // 北京午夜
  const hungry = { ...base, feeling: { satiety: 20, hydration: 70 } };
  assert(chooseAutonomyAction({ status: hungry, resident, now: daytime, spent: 11 })?.type !== 'buy', '达到每日预算后仍购买');
  resident.bagList = () => [{ id: 'bread', kind: 'eat' }];
  assert(chooseAutonomyAction({ status: hungry, resident, now: daytime }).product === 'bread', '没有优先消耗背包食品');
  resident.bagList = () => [];
  const wishes = [{ text: '钓到一条15厘米以上的鱼', done: false }, { text: '翻一会儿书', done: false }];
  const wish = chooseAutonomyAction({ status: { ...base, wishes }, resident, now: daytime });
  assert(wish?.object === 'pier' && wish.use === 'fish', '没有按钓鱼愿望选择玩法');
  const nextWish = chooseAutonomyAction({ status: { ...base, wishes }, resident, now: daytime, last: 'pier:fish' });
  assert(nextWish?.object === 'xj_bookshelf', '没有轮换到读书愿望');
  resident.lastExternalActionAt = daytime - 60000;
  assert(chooseAutonomyAction({ status: base, resident, now: daytime }) === null, '主人刚操作完时没有安静期');
  return '忙碌/断线/夜间/主人操作后跳过，预算拦截，背包优先，愿望轮换';
});
await check('Node.js 版本 ≥ 18', () => { const major = Number(process.versions.node.split('.')[0]); assert(major >= 18, '当前 ' + process.version + '，请安装 Node.js 18 或更新版本（https://nodejs.org）'); return process.version; });
await check('找到游戏 CabinWorld.exe', () => { assert(fs.existsSync(cfg.gameExe), '没有 ' + cfg.gameExe + '：请确认解压完整，或在 bridge.config.json 设置 gameExe'); return cfg.gameExe; });
await check('世界目录 catalog.json 可读', () => { const c = JSON.parse(fs.readFileSync(cfg.catalog, 'utf8')); assert(c.objects?.length && c.products?.length, '内容不完整'); return `${c.spaces.length} 个地方，${c.objects.length} 件东西，${c.products.length} 种商品`; });
await check('游戏与桥使用同一个数据目录', () => {
  const ini = path.join(path.dirname(cfg.gameExe), 'cabinworld.ini');
  if (!fs.existsSync(ini)) return '没有 cabinworld.ini；桥启动游戏时会传 --data，手动打开游戏前请补上';
  const line = fs.readFileSync(ini, 'utf8').split(/\r?\n/).find(l => l.trim().startsWith('data='));
  const data = line ? path.resolve(path.dirname(cfg.gameExe), line.split('=')[1].trim()) : path.join(path.dirname(cfg.gameExe), 'data');
  assert(path.resolve(data).toLowerCase() === path.resolve(cfg.dataDir).toLowerCase(), `cabinworld.ini 的 data=${data}，桥的 dataDir=${cfg.dataDir}：两者必须相同，否则游戏找不到桥`);
  return cfg.dataDir;
});
await check('HTTP 端口可用', async () => {
  if (cfg.http.port === 0) return '自动分配';
  const inUse = await new Promise(r => { const s = net.connect({ host: '127.0.0.1', port: cfg.http.port }); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
  if (inUse) { const info = path.join(cfg.dataDir, 'bridge.json'); return fs.existsSync(info) ? `端口 ${cfg.http.port} 已在使用（桥可能已经在运行，见 ${info}）` : (() => { throw Error(`端口 ${cfg.http.port} 被别的程序占用，请在 bridge.config.json 改 http.port`); })(); }
  return String(cfg.http.port);
});

if (live && !failed) {
  console.log('\n实机测试（临时空存档，不碰正式数据）');
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cabinworld-selfcheck-'));
  const t = { ...cfg, autonomy: { enabled: false }, residents: cfg.residents.map(r => ({ ...r, port: 0 })), dataDir: path.join(temp, 'data'), http: { host: '127.0.0.1', port: 0 }, waitMs: 0, chatLink: { enabled: false } };
  let b;
  const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('等待超时：' + what); await new Promise(r => setTimeout(r, 300)); } };
  const run = async (name, args) => { const r = await b.runTool(name, args, 0); if (!r.taskId) return r; const task = b.resident.tasks.get(r.taskId); await Promise.race([task.promise, new Promise((_, j) => setTimeout(() => j(Error('超过 3 分钟没有完成')), 180000))]); if (task.status !== 'done') throw Error(task.error || task.status); return task.result; };
  try {
    b = await startBridge(t, { launch: true, quiet: true, engineArgs: show ? [] : ['--headless'], userArgs: ['--save', path.join(temp, 'save')] });
    await check('游戏启动并通过 token 握手连上桥', () => until(() => b.host.connected, 60000, '游戏连接').then(() => '127.0.0.1 + 一次性 token'));
    await check('住户就位，游戏发放了零花钱', async () => { await until(() => b.resident.state?.wallet, 20000, '经济初始化'); const s = b.resident.status(); assert(s.wallet > 0, '零花钱为 0'); assert(s.bag.length === 0, '新存档的背包应为空'); return `${s.wallet} 元，背包空`; });
    await check('HTTP 接口要求 token', async () => {
      const no = await fetch(b.url + '/v1/status'); assert(no.status === 401, '没有 token 也能访问');
      const ok = await fetch(b.url + '/v1/status', { headers: { authorization: 'Bearer ' + b.token } }); assert(ok.status === 200, 'token 正确却被拒绝 ' + ok.status);
      const page = await fetch(b.url + '/v1/status', { headers: { authorization: 'Bearer ' + b.token, origin: 'https://example.com' } }); assert(page.status === 403, '网页跨站请求没有被拒绝');
      return '无 token 401，有 token 200，网页 403';
    });
    await check('走去公园（游戏确认到达）', async () => { const r = await run('cabin_go', { place: 'park' }); assert(b.resident.space === 'park', '位置不是公园'); return r.happened[0]; });
    await check('荡秋千：分阶段动作完成，游戏记下了使用', async () => { const r = await run('cabin_use', { object: 'swing', use: 'swing', feeling: '自检' }); assert(b.resident.state.usage?.swing?.count >= 1, '没有使用记录'); return (r.happened || []).join('；').slice(0, 60); });
    const before = b.resident.state.wallet.coins;
    const drink = b.resident.catalog.products.filter(p => p.kind === 'drink' && p.price <= before).sort((a, c) => a.price - c.price)[0];
    await check('去小卖部买一瓶饮料（付钱后进背包）', async () => { const r = await run('cabin_buy', { product: drink.id }); assert(b.resident.state.bag[drink.id] === 1, '背包里没有'); assert(b.resident.state.wallet.coins === before - r.price, '扣钱不对'); return `${drink.name} ${r.price} 元，剩 ${b.resident.state.wallet.coins} 元`; });
    await check('喝掉它（完成后才从背包扣掉）', async () => { const r = await run('cabin_eat', { product: drink.id }); assert(!b.resident.state.bag[drink.id], '还在背包里'); return r.taste?.slice(0, 40); });
    await check('包里没有的东西会被游戏拒绝', async () => { try { b.resident.eat('fishcookie'); } catch (e) { return e.message.slice(0, 30); } throw Error('没有拒绝'); });
    await check('回家喂鱼', async () => { await run('cabin_use', { object: 'fish_tank', use: 'feed_fish' }); assert(b.resident.space === 'xjhome', '不在家'); return '小鲸鱼家 · 鱼缸'; });
    await check('一个身体同时只做一件事 + 可以叫停', async () => {
      const first = await b.runTool('cabin_go', { place: 'park', zone: 'pier' }, 0);
      let busy = ''; try { await b.runTool('cabin_use', { object: 'beanbag', use: 'sink_in' }, 0); } catch (e) { busy = e.message; }
      assert(/先做完/.test(busy), '第二件事没有被拒绝');
      await new Promise(r => setTimeout(r, 800)); const s = await b.runTool('cabin_stop', {});
      const task = b.resident.tasks.get(first.taskId); await task.promise; assert(s.stopped && task.status === 'failed', '叫停没有生效：' + task.status);
      return '第二件事被拒绝；走到一半叫停成功（' + task.error + '）';
    });
    if (full) {
      await check('汤屋：先换浴衣，再泡汤', async () => { await until(() => !b.resident.task, 30000, '空闲'); const r = await run('cabin_use', { object: 'onsen_soak', use: 'soak' }); assert(b.resident.outfit === 'yukata', '没换浴衣'); return r.label; });
      await check('开关吊灯', async () => { await run('cabin_use', { object: 'xj_lamp', use: 'on' }); return 'on'; });
    }
    await check('存档只写在临时目录', async () => { const files = await fsp.readdir(path.join(temp, 'save')); assert(files.includes('economy.json'), '没有经济存档'); return files.join(', '); });
    await check('关闭桥后游戏仍在运行（窗口归用户管）', async () => { await b.close(); await new Promise(r => setTimeout(r, 1200)); assert(b.child && b.child.exitCode === null, '游戏跟着退出了'); return '游戏仍在运行'; });
  } catch (e) { fail('实机测试中断', e.message); }
  finally { try { b?.child?.kill(); } catch { /* 已退出 */ } try { await b?.close(); } catch { /* 已关闭 */ } }
}
console.log(failed ? `\n有 ${failed} 项没通过，请按提示处理后再试。` : '\n全部通过。' + (live ? '' : '想真实跑一遍可以加 --live。'));
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ ok: !failed, live, full, node: process.version, at: new Date().toISOString(), results }, null, 2) + '\n');
process.exit(failed ? 1 : 0);
