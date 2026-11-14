import fs from 'node:fs';
import { beijingDay } from './resident.mjs';

const NEED_LIMIT = 38, BUY_LIMIT = 8, DAILY_LIMIT = 12;
const activities = [
  ['swing', 'swing'], ['flower_bed', 'smell_flower'], ['bench', 'watch_clouds'],
  ['xj_bookshelf', 'browse_book'], ['beanbag', 'read_comic'], ['round_window', 'look_out'],
  ['fish_tank', 'watch_fish'], ['wave_rug', 'stretch'], ['big_tree', 'shade'],
];

export function chooseAutonomyAction({ status, resident, now = Date.now(), spent = 0, last = '' }) {
  if (!status?.connected || !resident?.state || resident.task) return null;
  if (resident.lastExternalActionAt && now - resident.lastExternalActionAt < 3 * 60000) return null;
  const local = new Date(now + 8 * 3600000), hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  if (hour >= 22 || hour < 7) return null;

  const satiety = Number(status.feeling?.satiety ?? 100), hydration = Number(status.feeling?.hydration ?? 100);
  const needs = satiety <= NEED_LIMIT ? 'eat' : hydration <= NEED_LIMIT ? 'drink' : '';
  if (needs) {
    const inBag = resident.bagList().find(p => p.kind === needs);
    if (inBag) return { type: 'eat', product: inBag.id, reason: needs === 'eat' ? '有点饿了，吃点东西' : '有点渴了，喝点水' };
    const product = resident.catalog.products.filter(p => p.kind === needs && p.price <= BUY_LIMIT && p.price + spent <= DAILY_LIMIT && p.price <= (status.wallet ?? 0)).sort((a, b) => a.price - b.price)[0];
    if (product) return { type: 'buy', product: product.id, price: product.price, reason: '买些便宜的' };
  }

  const wishes = (status.wishes || []).filter(w => !w.done);
  const wishChoices = [];
  if (wishes.some(w => /钓到|大鱼/.test(w.text))) wishChoices.push(['pier', 'fish']);
  if (wishes.some(w => /书|翻一会儿/.test(w.text))) wishChoices.push(['xj_bookshelf', 'browse_book']);
  const wishOptions = wishChoices.filter(([id, use]) => `${id}:${use}` !== last && resident.objects.get(id)?.bridge === 'supported' && resident.objects.get(id).uses.some(u => u.id === use));
  if (wishOptions.length) {
    const [object, use] = wishOptions[Math.floor(now / 900000) % wishOptions.length];
    return { type: 'use', object, use, reason: '想完成一个小愿望' };
  }

  const weather = status.weather || {};
  let choices = activities.filter(([id, use]) => resident.objects.get(id)?.bridge === 'supported' && resident.objects.get(id).uses.some(u => u.id === use));
  if (weather.rain > .25) choices = choices.filter(([id]) => !['swing', 'flower_bed', 'big_tree'].includes(id));
  if (weather.wind > 2.2) choices = choices.filter(([id]) => id !== 'swing');
  if (choices.length > 1) choices = choices.filter(([id, use]) => `${id}:${use}` !== last);
  if (!choices.length) return null;
  const seed = Math.floor(now / 60000) + (status.position?.space || '').length;
  const [object, use] = choices[Math.abs(seed) % choices.length];
  return { type: 'use', object, use, reason: '随便找件喜欢的事做做' };
}

export function createAutonomy({ rows, host, intervalMs = 15 * 60000, firstDelayMs = 20000, log = () => {}, now = Date.now, logFile = '' }) {
  let timer = null, lastAction = new Map(), spentToday = new Map();
  const day = () => beijingDay(now());
  const loadSpent = key => {
    const today = day(); if (spentToday.has(key) && spentToday.get(key).day === today) return spentToday.get(key).amount;
    let amount = 0;
    try { for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) { try { const e = JSON.parse(line); if (e.fish === key && e.source === 'autonomy' && beijingDay(e.ts) === today) amount += Number(e.spent) || 0; } catch { /* 略过损坏行 */ } } } catch { /* 日志尚不存在 */ }
    spentToday.set(key, { day: today, amount }); return amount;
  };
  const act = async row => {
    if (!host.connected || !row.resident.state || row.resident.task) return;
    const status = row.resident.status(), spent = loadSpent(row.key);
    const choice = chooseAutonomyAction({ status, resident: row.resident, now: now(), spent, last: lastAction.get(row.key) || '' });
    if (!choice) return;
    const resident = row.resident;
    resident.autonomyStarting = true;
    let task;
    try {
      if (choice.type === 'buy') task = resident.buy(choice.product);
      else if (choice.type === 'eat') task = resident.eat(choice.product);
      else task = resident.use(choice.object, choice.use);
    } catch (e) { log(`${row.name} 自主活动略过：${e.message}`); return; }
    finally { resident.autonomyStarting = false; }
    lastAction.set(row.key, `${choice.object || choice.product}:${choice.use || choice.type}`);
    log(`${row.name} 自主活动开始：${task.label}（${choice.reason}）`);
    await task.promise;
    if (task.status === 'done') {
      if (choice.type === 'buy') spentToday.set(row.key, { day: day(), amount: spent + (task.result?.price ?? choice.price) });
      log(`${row.name} 自主活动完成：${task.label}`);
    } else log(`${row.name} 自主活动未完成：${task.label}（${task.error || task.status}）`);
  };
  const tick = () => { if (!host.connected) return; for (const row of rows) void act(row).catch(e => log(`自主活动异常：${e.message}`)); };
  return {
    start() { if (timer) return; timer = setTimeout(() => { tick(); timer = setInterval(tick, intervalMs); }, firstDelayMs); timer.unref?.(); },
    close() { clearTimeout(timer); clearInterval(timer); timer = null; },
    tick,
  };
}
