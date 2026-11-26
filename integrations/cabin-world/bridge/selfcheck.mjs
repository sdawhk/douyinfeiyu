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

const HERE = path.dirname(fileURLToPath(import.meta.url));
//   node selfcheck.mjs --live --multi  1.1：再加一位住户，测试两位一起玩（两台方块机、贪吃蛇/象棋/五子棋双人、对电脑、邀请、餐厅、分开的钱包）
const args = process.argv.slice(2), live = args.includes('--live'), full = args.includes('--full'), show = args.includes('--show'), multi = args.includes('--multi');
const reportFile = args.includes('--report') ? path.resolve(args[args.indexOf('--report') + 1]) : null;
const cfgFile = args.includes('--config') ? path.resolve(args[args.indexOf('--config') + 1]) : path.join(HERE, 'bridge.config.json');
const results = []; let failed = 0;
const pass = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log('  ✔ ' + name + (detail ? '  — ' + detail : '')); };
const fail = (name, detail = '') => { results.push({ name, ok: false, detail }); failed++; console.log('  ✘ ' + name + (detail ? '  — ' + detail : '')); };
const check = async (name, fn) => { try { const d = await fn(); pass(name, d || ''); return true; } catch (e) { fail(name, e.message || String(e)); return false; } };
const assert = (v, msg) => { if (!v) throw Error(msg); };

console.log('小屋世界 · 安装自检');
const cfg = loadConfig(cfgFile);
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
  const t = { ...cfg, dataDir: path.join(temp, 'data'), http: { host: '127.0.0.1', port: 0 }, waitMs: 0 };
  // The optional multiplayer suite explicitly selects all features in its disposable fixture only.
  if (multi) { const desc=JSON.parse(fs.readFileSync(path.join(HERE,'update/modules.json'),'utf8'));await fsp.mkdir(t.dataDir,{recursive:true});await fsp.writeFile(path.join(t.dataDir,'features.json'),JSON.stringify({version:1,modules:Object.fromEntries(desc.modules.map(m=>[m.id,true]))})); }
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
    if (multi) {
      // 1.1: several bots in one world, without any owner-edition resident. Blocks the release if any of these fails.
      const R = k => b.residents.get(k), wait = (task, ms = 180000) => Promise.race([task.promise, new Promise((_, j) => setTimeout(() => j(Error('超过 ' + ms / 1000 + ' 秒没有完成')), ms))]);
      const runA = async (actor, name, a, ms) => { const r = await b.runTool(name, { ...a, actor }, 0); if (!r.taskId) return r; const t = R(actor).tasks.get(r.taskId); await wait(t, ms); if (t.status !== 'done') throw Error(t.error || t.status); return t.result; };
      const startA = (actor, name, a) => b.runTool(name, { ...a, actor }, 0);
      const playing = (kind, n) => until(() => [...b.arcade.sessions.values()].find(s => s.kind === kind && s.status === 'playing' && s.members.length === n), 150000, kind + ' 开局（' + n + ' 人）');
      const here = () => ['xiaojingyu', 'bot_2'].filter(k => R(k));
      const idle = async () => { for (const a of here()) { try { await b.runTool('cabin_stop', { actor: a }, 0); } catch { /* 本来就空闲 */ } } await until(() => ![...b.arcade.sessions.values()].some(s => ['waiting', 'playing'].includes(s.status)) && here().every(k => !R(k).task), 60000, '住户都停下'); };
      await check('新增第二位住户 bot_2（有自己的家）', async () => { await idle(); const r = await b.runTool('cabin_add_resident', { key: 'bot_2', name: '小蓝' }); assert(r.ok && R('bot_2'), '没有加上'); await until(() => R('bot_2').state?.wallet, 30000, 'bot_2 经济初始化'); return r.name + ' · ' + (r.home?.fullName || '自己的家'); });
      await check('两位的钱包和背包分开', async () => {
        const xjBefore = R('xiaojingyu').state.wallet.coins, b2 = R('bot_2').state.wallet.coins;
        const drink = b.resident.catalog.products.filter(p => p.kind === 'drink' && p.price <= b2).sort((x, y) => x.price - y.price)[0];
        await runA('bot_2', 'cabin_buy', { product: drink.id });
        assert(R('bot_2').state.bag[drink.id] === 1, 'bot_2 背包里没有'); assert(!R('xiaojingyu').state.bag?.[drink.id], '东西进了小鲸鱼的背包'); assert(R('xiaojingyu').state.wallet.coins === xjBefore, '扣了小鲸鱼的钱');
        return `bot_2 买了${drink.name}，小鲸鱼的钱和背包没变`;
      });
      await check('两台俄罗斯方块机同时开局', async () => { await idle(); await startA('xiaojingyu', 'cabin_use', { object: 'arcade_blocks', use: 'play', mode: 'solo' }); await playing('blocks', 1); await startA('bot_2', 'cabin_use', { object: 'arcade_blocks', use: 'play', mode: 'solo' }); await until(() => [...b.arcade.sessions.values()].filter(s => s.kind === 'blocks' && s.status === 'playing').length === 2, 150000, '第二台方块机开局'); await idle(); return '1 号、2 号各一位'; });
      for (const [label, object, use] of [['贪吃蛇双人', 'arcade_snake', 'play'], ['象棋双人', 'arcade_xiangqi', 'play'], ['五子棋双人', 'arcade_xiangqi', 'play_gomoku']])
        await check(label + '（duo 开桌，join 入座）', async () => { await idle(); await startA('xiaojingyu', 'cabin_use', { object, use, mode: 'duo' }); await until(() => [...b.arcade.sessions.values()].some(s => s.status === 'waiting'), 30000, '开桌'); await startA('bot_2', 'cabin_use', { object, use, mode: 'join' }); const s = await playing(use === 'play_gomoku' ? 'gomoku' : object === 'arcade_snake' ? 'snake' : 'xiangqi', 2); await idle(); return s.members.map(m => m.r.key).join(' vs '); });
      await check('五子棋对电脑（npc）', async () => { await idle(); await startA('bot_2', 'cabin_use', { object: 'arcade_xiangqi', use: 'play_gomoku', mode: 'npc' }); const s = await playing('gomoku', 1); const sides = s.board?.sides || s.board?.players || []; assert(sides.includes('computer'), '对手不是电脑：' + JSON.stringify(sides)); await idle(); return 'bot_2 vs 电脑'; });
      await check('家中棋盘邀请', async () => { const r = await b.runTool('cabin_invite', { actor: 'xiaojingyu', guest: 'bot_2' }); assert(r.ok && r.chessObject, '没有给出棋盘'); return r.chessObject; });
      await check('餐厅同时接待两位', async () => {
        await idle(); const menu = await b.runTool('cabin_restaurant', { actor: 'xiaojingyu', action: 'menu' }); const dish = (menu.dishes || []).find(d => d.price == null || d.price <= Math.min(R('xiaojingyu').state.wallet.coins, R('bot_2').state.wallet.coins)) || menu.dishes?.[0];
        assert(dish, '菜单是空的');
        // one counter, one staff member: the two orders are served one after the other, so allow time for both
        const t0 = Date.now(), took = {};
        await Promise.all(['xiaojingyu', 'bot_2'].map(k => runA(k, 'cabin_restaurant', { action: 'order', dish: dish.id }, 480000).then(() => { took[k] = Math.round((Date.now() - t0) / 1000); })));
        assert(R('xiaojingyu').state.bag?.[dish.id] >= 1 && R('bot_2').state.bag?.[dish.id] >= 1, '菜没有分别进两位的背包');
        return `两位各点了一份${dish.name || dish.id}（${took.xiaojingyu} 秒 / ${took.bot_2} 秒）`;
      });
    }
    await check('存档只写在临时目录', async () => { const files = await fsp.readdir(path.join(temp, 'save')); assert(files.includes('economy.json'), '没有经济存档'); return files.join(', '); });
    await check('关闭桥后游戏仍在运行（窗口归用户管）', async () => { await b.close(); await new Promise(r => setTimeout(r, 1200)); assert(b.child && b.child.exitCode === null, '游戏跟着退出了'); return '游戏仍在运行'; });
  } catch (e) { fail('实机测试中断', e.message); }
  finally { try { b?.child?.kill(); } catch { /* 已退出 */ } try { await b?.close(); } catch { /* 已关闭 */ } }
}
console.log(failed ? `\n有 ${failed} 项没通过，请按提示处理后再试。` : '\n全部通过。' + (live ? '' : '想真实跑一遍可以加 --live。'));
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({ ok: !failed, live, full, node: process.version, at: new Date().toISOString(), results }, null, 2) + '\n');
process.exit(failed ? 1 : 0);
