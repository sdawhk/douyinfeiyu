import fs from 'node:fs';
import path from 'node:path';
import { beijingDay } from './resident.mjs';

// 自主活动只受单件不超过 8 元和钱包余额约束；每日累计上限已取消
// （主人给的是每天 50 元零花钱，12 元的自我限额会让他饿一整天）。
const NEED_LIMIT = 38, BUY_LIMIT = 8;
// 刚吃过/喝过就别马上再来一次：饱腹增益不够大时，光看阈值会一个小时买四五次，
// 上午就把一天的零花钱花光。真掉到 10 以下则不受冷却限制。
const NEED_COOLDOWN_MS = 45 * 60000;
// 饿渴单独一条快线：每 3 分钟看一次，不必等到十五分钟那一轮自主活动。
const NEED_CHECK_MS = 3 * 60_000;
// 低于这个温度就不买冰的：之前 12℃ 的天也照吃西瓜冰棍，日志里写着“冰得牙齿一酸”。
const COLD_WEATHER_C = 18;
// 高于这个温度就不买热的：夏天 30℃ 端一杯热咖啡同样不合理。
const HOT_WEATHER_C = 26;
// 口味分掉到 -2 就是游戏自己判定的“吃腻了”，选品时先避开。
const TIRED_SCORE = -2;
const TICK_MS = 900000;
const activities = [
  ['swing', 'swing'], ['flower_bed', 'smell_flower'], ['bench', 'watch_clouds'],
  ['xj_bookshelf', 'browse_book'], ['beanbag', 'read_comic'], ['round_window', 'look_out'],
  ['fish_tank', 'watch_fish'], ['wave_rug', 'stretch'], ['big_tree', 'shade'],
];

// 真正能当一顿饭的商品；其余 snack 只是嘴馋（薯片 6 块也不顶饱）。
const MEAL_IDS = new Set(['zongzi', 'mooncake', 'tangyuan', 'hot_pot_snack', 'roast_chestnut', 'qingtuan']);

/** 吃掉之后能不能顶饱：冰品最差，正餐/主食最好，普通零食居中。 */
function fillingRank(product) {
  if (product.shelf === 'icecream') return 1;
  return MEAL_IDS.has(product.id) ? 3 : 2;
}

export function chooseAutonomyAction({ status, resident, now = Date.now(), spent = 0, last = '', blocked = [], skipNeeds = false, needsOnly = false }) {
  if (!status?.connected || !resident?.state || resident.task) return null;
  if (resident.lastExternalActionAt && now - resident.lastExternalActionAt < 3 * 60000) return null;
  const local = new Date(now + 8 * 3600000), hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  if (hour >= 22 || hour < 7) return null;

  const dead = new Set(blocked);

  const satiety = Number(status.feeling?.satiety ?? 100), hydration = Number(status.feeling?.hydration ?? 100);
  const weather = status.weather || {};
  const tastes = status.feeling?.tastes || {};
  const wallet = Number(status.wallet ?? 0);
  const temp = Number(weather.temp);
  const coldWeather = Number.isFinite(temp) && temp <= COLD_WEATHER_C;
  const warmWeather = Number.isFinite(temp) && temp >= HOT_WEATHER_C;
  const tiredOf = id => Number(tastes?.[id]?.score ?? 0) <= TIRED_SCORE;
  const beats = product => !dead.has(product.id) && !tiredOf(product.id)
    && !(coldWeather && product.cold === true)
    && !(warmWeather && product.shelf === 'hotdrink');
  // 饮品按“冷天喝热的、热天喝凉的”排，别拿 fillingRank 把热咖啡顶到夏天第一位。
  const fitRank = product => needs === 'drink'
    ? (coldWeather ? (product.shelf === 'hotdrink' ? 3 : 2) : warmWeather ? (product.shelf === 'drink' ? 3 : 2) : 2)
    : fillingRank(product);
  const needEat = satiety <= NEED_LIMIT, needDrink = hydration <= NEED_LIMIT;
  // 饿了渴了谁更低先补谁：补上去自然就轮到另一个，不会像按时段交替那样
  // 明明饿得慌还去买第二杯饮料。
  const needs = skipNeeds ? '' : needEat && needDrink
    ? (satiety <= hydration ? 'eat' : 'drink')
    : needEat ? 'eat' : needDrink ? 'drink' : '';
  if (needsOnly && !needs) return null;
  if (needs) {
    const bagList = resident.bagList();
    const inBag = bagList.filter(p => p.kind === needs && beats(p))[0]
      || bagList.find(p => p.kind === needs);
    if (inBag) return { type: 'eat', product: inBag.id, reason: needs === 'eat' ? '有点饿了，吃点东西' : '有点渴了，喝点水' };

    const affordable = resident.catalog.products.filter(p => p.kind === needs
      && p.price <= BUY_LIMIT && p.price <= wallet);
    const preferred = affordable.filter(beats);
    // 有得挑就买能顶饱的（粽子、关东煮、面包），没得挑才退回最便宜的；
    // 同一档里挑便宜的，一天 12 币的额度才够吃上两顿；按时段轮换，别顿顿一样。
    // 退回时也要避开游戏里根本不存在的商品，否则会反复撞同一堵墙。
    const fallbackPool = affordable.filter(p => !dead.has(p.id));
    const pool = (preferred.length ? preferred : fallbackPool)
      .sort((a, b) => fitRank(b) - fitRank(a) || a.price - b.price || a.id.localeCompare(b.id));
    const top = pool.slice(0, Math.min(3, pool.length));
    const product = top.length ? top[Math.floor(now / TICK_MS) % top.length] : null;
    if (product) {
      return { type: 'buy', product: product.id, price: product.price,
        reason: needs === 'drink' ? '有点渴，买点喝的'
          : fillingRank(product) >= 3 ? '饿了，想吃点顶饱的' : '饿了，买点吃的' };
    }
  }

  if (needsOnly) return null;

  const wishes = (status.wishes || []).filter(w => !w.done);
  const wishChoices = [];
  if (wishes.some(w => /钓到|大鱼/.test(w.text))) wishChoices.push(['pier', 'fish']);
  if (wishes.some(w => /书|翻一会儿/.test(w.text))) wishChoices.push(['xj_bookshelf', 'browse_book']);
  const wishOptions = wishChoices.filter(([id, use]) => `${id}:${use}` !== last && resident.objects.get(id)?.bridge === 'supported' && resident.objects.get(id).uses.some(u => u.id === use));
  if (wishOptions.length) {
    const [object, use] = wishOptions[Math.floor(now / 900000) % wishOptions.length];
    return { type: 'use', object, use, reason: '想完成一个小愿望' };
  }

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
  let timer = null, needTimer = null, lastAction = new Map(), spentToday = new Map(), lastNeedAt = new Map();
  const day = () => beijingDay(now());
  // 桥接目录里的商品表可能比游戏新：买一次报“没有这个东西”，就把这个 id 记下来，
  // 免得每次重启都对着同一件不存在的商品白跑一趟。
  const blockedFile = logFile ? path.join(path.dirname(logFile), 'autonomy-blocked.json') : '';
  const blocked = new Set();
  if (blockedFile) {
    try { for (const id of JSON.parse(fs.readFileSync(blockedFile, 'utf8'))) blocked.add(String(id)); } catch { /* 还没记录过 */ }
  }
  const rememberBlocked = id => {
    if (!blockedFile || blocked.has(id)) return;
    blocked.add(id);
    try { fs.writeFileSync(blockedFile, JSON.stringify([...blocked], null, 1), 'utf8'); } catch { /* 写不进去不影响本轮 */ }
  };
  // “没有这个东西”是真不存在，可以永久拉黑；节令商品报的是“本月暂未上架”，
  // 只是这个月不卖，下个月还得再试，所以按月份记，跨月自动恢复。
  const outOfSeasonFile = logFile ? path.join(path.dirname(logFile), 'autonomy-out-of-season.json') : '';
  const outOfSeason = new Map();
  if (outOfSeasonFile) {
    try { for (const [id, month] of Object.entries(JSON.parse(fs.readFileSync(outOfSeasonFile, 'utf8')))) outOfSeason.set(String(id), String(month)); } catch { /* 还没记录过 */ }
  }
  const monthKey = () => beijingDay(now()).slice(0, 7);
  const skippedThisMonth = () => [...outOfSeason].filter(([, month]) => month === monthKey()).map(([id]) => id);
  const rememberOutOfSeason = id => {
    if (!outOfSeasonFile || outOfSeason.get(id) === monthKey()) return;
    outOfSeason.set(id, monthKey());
    try { fs.writeFileSync(outOfSeasonFile, JSON.stringify(Object.fromEntries(outOfSeason), null, 1), 'utf8'); } catch { /* 同上 */ }
  };
  const loadSpent = key => {
    const today = day(); if (spentToday.has(key) && spentToday.get(key).day === today) return spentToday.get(key).amount;
    let amount = 0;
    try { for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) { try { const e = JSON.parse(line); if (e.fish === key && e.source === 'autonomy' && beijingDay(e.ts) === today) amount += Number(e.spent) || 0; } catch { /* 略过损坏行 */ } } } catch { /* 日志尚不存在 */ }
    spentToday.set(key, { day: today, amount }); return amount;
  };
  const act = async (row, attempt = 0, needsOnly = false) => {
    if (!host.connected || !row.resident.state || row.resident.task) return;
    const status = row.resident.status(), spent = loadSpent(row.key);
    // 刚吃完/喝完还在冷却里，就跳过进食需求去挑件别的事做。
    // 以前是直接 return，结果它会站在小卖部收银台一动不动地等满 45 分钟。
    const lastMeal = Math.max(lastNeedAt.get(`${row.key}:eat`) || 0, lastNeedAt.get(`${row.key}:drink`) || 0);
    const satietyNow = Number(status.feeling?.satiety ?? 100), hydrationNow = Number(status.feeling?.hydration ?? 100);
    // 阈值跟 mood 的「饿得慌 / 渴得慌」对齐：到她觉得难受的程度就不再等冷却。
    const critical = satietyNow <= 20 || hydrationNow <= 20;
    const cooling = !critical && now() - lastMeal < NEED_COOLDOWN_MS;
    const choice = chooseAutonomyAction({ status, resident: row.resident, now: now(), spent, skipNeeds: cooling, needsOnly,
      last: lastAction.get(row.key) || '', blocked: [...blocked, ...skippedThisMonth()] });
    if (!choice) return;
    const resident = row.resident;
    if (attempt === 0 && choice.type === 'buy') {
      const product = resident.catalog.products.find(p => p.id === choice.product);
      const need = product?.kind;
      if (need === 'eat' || need === 'drink') lastNeedAt.set(`${row.key}:${need}`, now());
    }
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
    } else {
      log(`${row.name} 自主活动未完成：${task.label}（${task.error || task.status}）`);
      // 游戏端不认这件商品：记下来，并在同一个时段里换下一个候选，不用再等十五分钟。
      if (choice.type === 'buy') {
        const error = String(task.error || '');
        if (/没有这个东西|不存在|not found|unknown/i.test(error)) rememberBlocked(choice.product);
        else if (/暂未上架|未上架|时令/i.test(error)) rememberOutOfSeason(choice.product);
        else return;
        if (attempt < 2) return act(row, attempt + 1, needsOnly);
      }
    }
  };
  const tick = () => { if (!host.connected) return; for (const row of rows) void act(row).catch(e => log(`自主活动异常：${e.message}`)); };
  // 饿和渴不等十五分钟那一轮：单独每 3 分钟看一次，只处理吃喝，处理完就收工。
  const needTick = () => {
    if (!host.connected) return;
    for (const row of rows) {
      if (!row.resident.state) { log(`[need] ${row.name} 状态还没同步，跳过`); continue; }
      if (row.resident.task) { log(`[need] ${row.name} 手上还有动作，跳过`); continue; }
      void act(row, 0, true).catch(e => log(`进食检查异常：${e.message}`));
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setTimeout(() => { tick(); timer = setInterval(tick, intervalMs); }, firstDelayMs); timer.unref?.();
      needTimer = setInterval(needTick, NEED_CHECK_MS); needTimer.unref?.();
      log(`饿渴快线已启动：每 ${Math.round(NEED_CHECK_MS / 60000)} 分钟检查一次`);
    },
    close() { clearTimeout(timer); clearInterval(timer); timer = null; clearInterval(needTimer); needTimer = null; },
    tick,
  };
}
