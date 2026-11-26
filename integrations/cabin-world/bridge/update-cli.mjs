#!/usr/bin/env node
// 小屋世界 1.1 模块 / Cabin World 1.1 modules: a text menu (update.cmd), the same switches as the game's 1.1 模块 page and
// the bot's cabin_update_* tools (lib/update.mjs). Works with the game closed; changes apply after restarting the game.
// Usage: node update-cli.mjs                 interactive menu
//        node update-cli.mjs --list          print the modules
//        node update-cli.mjs --set arcade-renovated=off --set seasons=on
//        node update-cli.mjs --undo          undo the last change
//        [--config bridge.config.json]       which data folder (default: this folder's bridge.config.json)
import path from 'node:path'; import readline from 'node:readline/promises'; import { fileURLToPath } from 'node:url';
import { loadConfig } from './bridge.mjs';
import { Updater, readDescriptions } from './lib/update.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cfg = loadConfig(opt('--config') || path.join(HERE, 'bridge.config.json'));
const updater = new Updater({ dataDir: cfg.dataDir, installDir: path.dirname(cfg.gameExe), descriptions: readDescriptions(path.join(HERE, 'update', 'modules.json')) });
const show = plan => plan.modules.map((m, i) => `${String(i + 1).padStart(2)}. [${m.state === 'on' ? '开' : '关'}] ${m.name}${m.askUser ? '  ★会改变外观或玩法' : ''}\n      ${m.summary}\n      看起来：${m.looksDifferent}　存档：${m.touches}`).join('\n');

if (args.includes('--plan')) { console.log(JSON.stringify(updater.plan(),null,2)); process.exit(0); }
if (args.includes('--list')) { console.log(show(updater.plan())); process.exit(0); }
if (args.includes('--undo')) { console.log(JSON.stringify(updater.undo(), null, 2)); process.exit(0); }
const sets = args.flatMap((a, i) => a === '--set' ? [args[i + 1]] : []);
if (sets.length) {
  const choice = {};
  for (const s of sets) { const [id, v] = String(s).split('='); if (!['on', 'off'].includes(v)) { console.error('写成 模块id=on 或 模块id=off：' + s); process.exit(2); } choice[id] = v === 'on'; }
  try { console.log(JSON.stringify(updater.apply(choice, 'update-cli'), null, 2)); } catch (e) { console.error(e.message); process.exit(2); }
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const plan = updater.plan(), want = Object.fromEntries(plan.modules.map(m => [m.id, m.state === 'on']));
console.log('小屋世界 1.1 安装选项\n每一项独立选择；未选择的保留当前状态。首次未选择则保留原版功能。改完重新启动游戏生效。\n');
for (;;) {
  console.log(show({ modules: plan.modules.map(m => ({ ...m, state: want[m.id] ? 'on' : 'off' })) }));
  const a = (await rl.question('\n输入编号切换开关；s 保存；u 撤销上一次更改；q 不保存退出：')).trim().toLowerCase();
  if (a === 'q') break;
  if (a === 'u') { console.log(JSON.stringify(updater.undo(), null, 2)); break; }
  if (a === 's') { const r = updater.apply(want, 'update.cmd'); console.log(r.changed?.length ? '已保存：' + r.changed.map(c => c.id + '=' + c.state).join('，') + '\n' + r.restart : '没有变化。'); break; }
  const i = Number(a) - 1; if (plan.modules[i]) want[plan.modules[i].id] = !want[plan.modules[i].id]; else console.log('没有这个编号。');
}
rl.close();
