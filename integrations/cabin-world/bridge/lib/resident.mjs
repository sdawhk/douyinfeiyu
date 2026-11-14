// 一位住户的身体工具 / High-level body tools for one resident.
//
// 这里把“去哪里、用什么、买什么、吃什么”翻译成游戏协议（见 docs/PROTOCOL.md）：
//   walk.go → walk.arrived                     走路，等游戏确认真的走到
//   action.start → action.phase/… → action.finished   分阶段动作，游戏掌管时钟和动画
//   economy.do (top_up/buy/consume/play/use_record/experience/life_event/options) → economy.result
//   seat.claim / seat.release                  座位（长椅、浅池、淋浴、跷跷板）
//   world {presence}                           告诉游戏卡片上显示什么（正在做什么、特效、零花钱、心情）
// Every result returned here is the game's committed answer. Nothing is invented by the bridge.
// 规则：动作被拒绝、替换、超时或断线都不算完成；只有 action.finished 之后才把经历交给机器人记忆。
import { EventEmitter } from 'node:events';

const LONG_MS_CAP = 6000;   // 汤屋 / 长椅这种长时间活动，游戏里最多演 6 秒（与 VADS 一致）
const PICK_MS = 3200, PAY_MS = 2200, EAT_MS = 4000;
export const beijingDay = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export class Resident extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../cabin-host.mjs').CabinHost} o.host  已启动的协议宿主
   * @param {string} o.key     角色 key（game/assets/residents.json 的 key），公开版是 "xiaojingyu"
   * @param {string} o.who     生活规则用的 flavor（residents.json 的 flavor），通常与 key 相同
   * @param {string} o.name    卡片名
   * @param {object} o.catalog catalog.json
   * @param {() => object} o.weather 当前天气读数（见 weather.mjs）
   */
  constructor({ host, key, who = key, name = key, catalog, weather, now = Date.now }) {
    super();
    Object.assign(this, { host, key, who, name, catalog, weatherNow: weather, now });
    this.scope = host.forResident(key);
    this.pos = { scene: null, zone: null, x: null, y: null };
    this.state = null; this.view = null;              // 游戏 economy.result 的 state / view（只读镜像）
    this.effect = null; this.outfit = ''; this.items = { phone: 'dock', headphones: 'dock' }; this.lamps = 'auto';
    this.task = null; this.tasks = new Map(); this.seq = 0; this.log = [];
    this.objects = new Map(catalog.objects.map(o => [o.id, o]));
    this.products = new Map(catalog.products.map(p => [p.id, p]));
    this.spaces = new Map(catalog.spaces.map(s => [s.id, s]));
    host.on('frame', f => {
      if (f.type === 'walk.position' && f.actor === key) { this.pos = { scene: f.scene, zone: f.zone || null, x: f.x ?? null, y: f.y ?? null }; this.emit('event', { type: 'position', ...this.pos }); }
      if (f.type === 'economy.social' && f.actor === key) this.emit('event', { type: 'social', frame: f });
    });
  }

  // ---- 连接后初始化 / after the game connects -------------------------------------------
  async open() {
    await this.scope.request('body.open', { seed: {}, patch: {} }, { replyType: 'body.saved' });
    await this.eco('sync', { rev: 0 });   // rev 0：游戏已有存档时以游戏为准，不覆盖
    await this.eco('top_up');            // 每天的零花钱，由游戏按北京日期发放，同一天不会重复
    this.publish();
  }

  async eco(op, fields = {}) {
    const { result } = await this.scope.request('economy.do', { op, ...fields }, { replyType: 'economy.result', timeoutMs: 15000 });
    if (result.state && Object.keys(result.state).length) this.state = result.state;
    if (result.view) this.view = result.view;
    return result;
  }

  spaceOfScene(scene) { return [...this.spaces.values()].find(s => s.scene === scene) || null; }
  get space() { return this.spaceOfScene(this.pos.scene)?.id || null; }

  /** 找地点：空间 id（park）、场景 id（qianxia-park）或中文名（公园）。 */
  findSpace(where) {
    const w = String(where || '').trim();
    return this.spaces.get(w) || [...this.spaces.values()].find(s => s.scene === w || s.name === w || s.fullName === w || (w && s.fullName.includes(w))) || null;
  }

  // ---- 告诉游戏卡片上显示什么 / presence row ---------------------------------------------
  publish() {
    if (!this.host.connected) return;
    const space = this.spaceOfScene(this.pos.scene), now = this.now();
    const e = this.effect && this.effect.until > now ? this.effect : null;
    const zone = space?.zones.find(z => z.id === this.pos.zone);
    const row = {
      name: this.name, sceneId: this.pos.scene, space: space?.id || '', zone: this.pos.zone || '', place: zone?.name || '',
      label: this.task?.label || e?.label || '', sleeping: false, items: this.items, lamps: this.lamps,
      outfit: space?.id === 'onsen' ? this.outfit : '', travel: null,
      effect: e ? { kind: e.kind, zone: e.zone, module: e.module, use: e.use, seconds: e.seconds, at: e.at, outcome: e.outcome || null, item: e.item || null, slot: e.slot || null } : null,
      coins: this.state?.wallet?.coins ?? null,
      mood: this.view?.life?.mood ? { icon: this.view.life.mood.icon, word: this.view.life.mood.word } : undefined,
      at: now,
    };
    this.host.send({ type: 'world', presence: { [this.key]: row } });
  }
  setEffect(fx) { const at = this.now(); this.effect = fx ? { ...fx, at, until: at + (fx.seconds || 5) * 1000 + 8000 } : null; this.publish(); }

  // ---- 走路 / walking --------------------------------------------------------------------
  // walk.go → walk.arrived（replaced/denied 算失败）；叫停时发 walk.cancel，身体原地停下。
  walkTo(scene, zone) {
    const host = this.host, id = 'walk-' + this.now().toString(36) + '-' + (++this.seq);
    return new Promise((resolve, reject) => {
      let timer;
      const done = () => { clearTimeout(timer); host.off('frame', onFrame); host.off('disconnected', onLost); if (this.walking?.id === id) this.walking = null; };
      const onFrame = f => {
        if (f.type !== 'walk.arrived' || f.id !== id) return; done();
        if (f.replaced || f.denied || f.ok === false) return reject(Error(f.error || '走路被新的指令替换了，没有走到'));
        this.pos = { scene: f.scene || scene, zone: zone || null, x: f.x ?? null, y: f.y ?? null }; this.publish(); resolve(this.pos);
      };
      const onLost = () => { done(); reject(Error('游戏断开了，没有走到')); };
      const cancel = reason => { try { host.send({ type: 'walk.cancel', id, actor: this.key }); } catch { /* 已断开 */ } done(); reject(Error(reason || '走路被叫停了')); };
      this.walking = { id, cancel };
      host.on('frame', onFrame); host.once('disconnected', onLost);
      timer = setTimeout(() => cancel('走了两分钟还没到，已停下（可能被挡住了）'), 120000); timer.unref?.();
      try { host.send({ type: 'walk.go', id, actor: this.key, scene, ...(zone ? { zone } : {}) }); } catch (error) { done(); reject(error); }
    });
  }

  // ---- 分阶段动作 / phased action on the game clock -------------------------------------------
  runAction(kind, label, phases) {
    const id = `${kind}-${this.now().toString(36)}-${++this.seq}`, host = this.host;
    return new Promise((resolve, reject) => {
      let index = -1, committed = false, over = false, result, watchdog;
      const total = phases.reduce((n, p) => n + (p.ms || 0), 0) + 240000;
      const end = (fn, v) => { if (over) return; over = true; clearTimeout(watchdog); host.off('frame', onFrame); host.off('disconnected', onLost); this.current = null; fn(v); };
      const onLost = () => end(reject, Error(committed ? '游戏断开了；这一步已经提交，结果以游戏存档为准' : '游戏断开了，动作没有完成'));
      const onFrame = f => {
        if (f.id !== id) return;
        if (f.type === 'action.finished') return end(resolve, result);
        if (f.type !== 'action.phase' || f.index !== index + 1) return;
        index = f.index; const ph = phases[index];
        Promise.resolve(ph.run ? ph.run() : undefined).then(v => {
          if (over) return; if (v !== undefined) result = v; if (ph.commit) committed = true;
          host.send({ type: 'action.done', id, index, ok: true });
        }, error => { if (over) return; try { host.send({ type: 'action.done', id, index, ok: false }); } catch { /* 已断开 */ } end(reject, error); });
      };
      this.current = { id, interrupt: reason => { if (committed) return false; try { host.send({ type: 'action.interrupt', id }); } catch { /* 已断开 */ } end(reject, Error(reason || '被打断了')); return true; } };
      host.on('frame', onFrame); host.once('disconnected', onLost);
      watchdog = setTimeout(() => this.current?.interrupt('游戏太久没有回应'), total); watchdog.unref?.();
      try { host.send({ type: 'action.start', id, actor: this.key, kind, label, phases: phases.map(p => ({ id: p.id, label: p.label || label, ms: p.ms || 0, pose: -1 })) }); }
      catch (error) { end(reject, error); }
    });
  }

  // ---- 任务队列：一个身体同一时间只做一件事 / one body action at a time -----------------------
  startTask(kind, label, fn) {
    if (this.task) throw Object.assign(Error(`正在${this.task.label}，先做完这件事（或调用 stop）`), { code: 'busy' });
    const id = `${kind}-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const task = { id, kind, label, status: 'running', startedAt: this.now(), ...(this.autonomyStarting ? { source: 'autonomy' } : {}) };
    if (!this.autonomyStarting) this.lastExternalActionAt = this.now();
    this.task = task; this.tasks.set(id, task); this.publish();
    task.promise = (async () => fn())().then(result => {
      Object.assign(task, { status: 'done', result, endedAt: this.now() });
      this.addLog(kind, label, (result?.happened || []).filter(Boolean)[0] || '');
    }, error => Object.assign(task, { status: 'failed', error: String(error?.message || error), endedAt: this.now() }))
      .finally(() => { if (this.task === task) this.task = null; this.publish(); this.emit('event', { type: 'task', id, kind, status: task.status, label, error: task.error, result: task.result, ...(task.source ? { source: task.source } : {}) }); if (this.tasks.size > 100) this.tasks.delete(this.tasks.keys().next().value); });
    return task;
  }
  stop(reason = '被叫停了') {
    if (!this.task) return { ok: true, stopped: false, note: '现在没有在做事' };
    const walking = this.walking;
    let stopped = this.current ? this.current.interrupt(reason) : false;
    if (walking && (stopped || !this.current)) { walking.cancel(reason); stopped = true; }
    return { ok: true, stopped, note: stopped ? '已叫停，这件事不算完成' : '已经到了提交阶段，无法撤回，等它做完' };
  }
  // 游戏侧边栏“记录”页的一行：name 标题、action 类别、detail 说明。
  addLog(kind, label, detail) { const action = { walk: '走路', use: '使用', buy: '购物', eat: '吃喝', lamp: '开关灯' }[kind] || '活动'; this.log.unshift({ id: 'log-' + (++this.seq), at: this.now(), name: label, action, category: action, status: '完成', detail: String(detail || '').slice(0, 120) }); this.log.length = Math.min(this.log.length, 60); }

  // ---- 工具 / tools ---------------------------------------------------------------------
  go(where, zone) {
    const space = this.findSpace(where); if (!space) throw Error('没有这个地方。可以去：' + [...this.spaces.values()].map(s => `${s.id}（${s.fullName}）`).join('、'));
    // owner 可以是 "resident:key"，也可以是几位居民共用的数组（一个家里住两个人）
    const owners = Array.isArray(space.owner) ? space.owner : (space.owner ? [space.owner] : []);
    if (owners.length && !owners.includes('resident:' + this.key)) throw Error(space.fullName + '是别人的家，需要主人邀请');
    if (zone && !space.zones.some(z => z.id === zone)) throw Error(`${space.fullName}里没有 ${zone}。可以去：` + space.zones.map(z => `${z.id}（${z.name}）`).join('、'));
    return this.startTask('walk', '走去' + space.fullName, async () => { const pos = await this.walkTo(space.scene, zone || undefined); return { ok: true, happened: ['到了' + space.fullName], position: pos }; });
  }

  use(objectId, use, { item = '', feeling = '' } = {}) {
    const object = this.objects.get(objectId);
    if (!object) throw Error('没有这个东西。用 look 或 catalog 查看可以用的东西。');
    if (object.id === 'bag') return this.eat(item, { feeling, as: use });
    const spec = object.uses.find(u => u.id === use);
    if (!spec) throw Error(`${object.name}可以：` + object.uses.map(u => `${u.id}（${u.label}）`).join('、') || `${object.name}没有可做的事`);
    if (object.bridge !== 'supported') throw Error(`${object.name}需要高级协议（电玩城、棋盘、餐厅），参考桥暂未实现，见 docs/PROTOCOL.md`);
    if (spec.shelf) return this.buy(item, { feeling, objectId: object.id });
    if (object.id === 'xj_lamp') return this.startTask('lamp', spec.label, async () => { await this.eco('options', { lamps: use }); this.lamps = use; this.publish(); return { ok: true, happened: [spec.label], lamps: use }; });
    return this.startTask('use', spec.label, () => this.performUse(object, spec, feeling));
  }

  async performUse(object, spec, feeling) {
    await this.eco('top_up');
    const space = this.spaces.get(object.space);
    if (object.space === 'onsen' && object.id !== 'onsen_locker' && this.outfit !== 'yukata')
      await this.performUse(this.objects.get('onsen_locker'), this.objects.get('onsen_locker').uses.find(u => u.id === 'change'), '');
    const long = object.space === 'onsen' || object.id === 'long_bench';
    const ms = long ? Math.min(spec.seconds * 1000, LONG_MS_CAP) : spec.seconds * 1000;
    const ctx = {};
    return this.runAction('use', spec.label, [
      { id: 'walk', label: '走去' + object.name, run: async () => {
        ctx.slot = await this.claimSeat(object.id, spec.seconds);
        ctx.zone = object.seats && ctx.slot ? object.seats[ctx.slot] : object.zone;
        if (this.pos.scene !== space.scene || this.pos.zone !== ctx.zone) { this.effect = null; await this.walkTo(space.scene, ctx.zone); }
        if (object.id === 'onsen_locker') this.outfit = spec.id === 'change' ? 'yukata' : '';
        if (object.id === 'xj_phone') this.items = { ...this.items, phone: spec.id === 'take' ? 'hand' : 'dock' };
        if (object.id === 'xj_headphones') this.items = { ...this.items, headphones: spec.id === 'wear' ? 'worn' : 'dock' };
        this.publish();
      } },
      { id: 'begin', run: async () => {
        const weather = this.weatherNow(), now = this.now();
        ctx.history = structuredClone(this.state?.uses || {}); ctx.weather = weather;
        // 公园的结果（钓到多大的鱼、风筝飞多高…）由游戏决定 / the game decides park outcomes
        ctx.play = object.space === 'park' ? await this.eco('play', { use: spec.id, weather, umbrella: false, day: beijingDay(now) }) : null;
        await this.eco('use_record', { objectId: object.id, use: spec.id, label: spec.label, at: now });
        this.setEffect({ slot: ctx.slot, kind: spec.effect, module: spec.module, zone: ctx.zone, use: spec.id, label: spec.label, seconds: spec.seconds, outcome: ctx.play?.outcome || null, item: null });
      } },
      { id: 'doing', ms },
      { id: 'finish', commit: true, run: async () => {
        const outdoor = object.space === 'park' || object.space === 'onsen';
        const r = await this.eco('experience', { who: this.who, args: { now: this.now(), objectId: object.id, use: spec.id, label: spec.label, history: ctx.history, weather: outdoor ? ctx.weather : {}, companions: [], outcome: ctx.play?.outcome || null } });
        ctx.feeling = r.state?.feeling;
      } },
      { id: 'settle', label: '收好', run: async () => {
        const notes = await this.lifeEvent({ type: 'use', objectId: object.id, use: spec.id, outcome: ctx.play?.outcome || null, label: spec.label, space: object.space, ...(feeling ? { thought: String(feeling).slice(0, 200) } : {}) });
        this.releaseSeat();
        return { ok: true, label: spec.label, happened: [ctx.feeling?.last, ...(ctx.play?.lines || []), ...notes].filter(Boolean), outcome: ctx.play?.outcome || null, ...this.summary() };
      } },
    ]);
  }

  buy(productId, { feeling = '', objectId = '' } = {}) {
    const p = this.products.get(productId);
    if (!p) throw Error('小卖部有：' + [...this.products.values()].map(x => `${x.id}（${x.name} ${x.price}元）`).join('、'));
    const at = this.objects.get(objectId) && this.objects.get(objectId).uses.some(u => u.shelf === p.shelf) ? { object: objectId, use: 'buy', zone: this.objects.get(objectId).zone } : p.buyAt;
    const object = this.objects.get(at.object), spec = object.uses.find(u => u.id === at.use), shop = this.spaces.get(object.space);
    const coins = this.state?.wallet?.coins ?? 0, used = Object.values(this.state?.bag || {}).reduce((a, b) => a + b, 0);
    if (p.price > coins) throw Error(`零花钱只剩 ${coins} 元（${p.name}要 ${p.price} 元；价格以游戏当天为准）`);
    if (used >= (this.catalog.wallet?.bagSlots || 12)) throw Error('包已装满');
    const ctx = {};
    return this.startTask('buy', '去买' + p.name, async () => { await this.eco('top_up'); return this.runAction('buy', '去买' + p.name, [
      { id: 'walk_shelf', label: `走去挑${p.name}`, run: async () => { ctx.slot = await this.claimSeat(object.id, spec.seconds); this.effect = null; await this.walkTo(shop.scene, at.zone); } },
      { id: 'pick', label: `挑选${p.name}`, ms: PICK_MS, run: () => { ctx.history = structuredClone(this.state?.uses || {}); this.setEffect({ slot: ctx.slot, kind: spec.effect, module: spec.module, zone: at.zone, use: spec.id, label: `挑选${p.name}`, seconds: spec.seconds, item: { id: p.id, shelf: p.shelf } }); } },
      { id: 'walk_counter', label: '走去收银台', run: () => this.walkTo(shop.scene, 'counter') },
      { id: 'pay_wait', label: '在收银台排队', ms: PAY_MS },
      { id: 'pay', commit: true, run: async () => { const r = await this.eco('buy', { product: p.id }); ctx.paid = r.price ?? p.price; this.setEffect({ kind: 'coins', module: 'counter', zone: 'counter', use: 'pay', label: `付了${ctx.paid}元`, seconds: 5, item: { id: p.id, shelf: p.shelf } }); } },
      { id: 'settle', label: '买好了', run: async () => {
        await this.eco('use_record', { objectId: object.id, use: spec.id, label: spec.label, at: this.now() });
        const r = await this.eco('experience', { who: this.who, args: { now: this.now(), objectId: object.id, use: spec.id, label: spec.label, history: ctx.history || {}, weather: {}, companions: [], outcome: null } });
        const notes = await this.lifeEvent({ type: 'use', objectId: object.id, use: spec.id, outcome: null, label: spec.label, space: object.space, ...(feeling ? { thought: String(feeling).slice(0, 200) } : {}) });
        this.releaseSeat();
        return { ok: true, label: `买了${p.name}`, product: p.id, price: ctx.paid, happened: [r.state?.feeling?.last, `花了${ctx.paid}元`, ...notes].filter(Boolean), ...this.summary() };
      } },
    ]); });
  }

  eat(productId, { feeling = '', as = '' } = {}) {
    const p = this.products.get(productId);
    if (!p || !(this.state?.bag?.[p.id] > 0)) throw Error('包里没有这个。包里有：' + (this.bagList().map(b => `${b.id}（${b.name}×${b.count}）`).join('、') || '什么都没有'));
    const use = p.kind; if (as && as !== use && ['eat', 'drink', 'use'].includes(as)) throw Error(`${p.name}要用 ${use}`);
    const label = (use === 'eat' ? '吃' : use === 'drink' ? '喝' : '用') + p.name, ctx = {};
    return this.startTask('eat', label, () => this.runAction('eat', label, [
      { id: 'start', run: () => this.setEffect({ kind: use === 'drink' ? 'drink' : use === 'eat' ? 'eat' : 'sparkle', module: null, zone: this.pos.zone, use, label, seconds: 7, item: { id: p.id, name: p.name, shelf: p.shelf } }) },
      { id: 'eating', ms: EAT_MS },
      { id: 'finish', label: '吃完了', commit: true, run: async () => {
        const weather = this.weatherNow(), history = structuredClone(this.state?.uses || {});
        const r = await this.eco('consume', { product: p.id, kind: use === 'use' ? 'used' : 'eaten', weather, space: this.space || '' });
        ctx.lines = r.lines || [p.taste];
        const f = await this.eco('experience', { who: this.who, args: { now: this.now(), objectId: 'bag', use, taste: ctx.lines.join('，'), product: p, history, weather } });
        ctx.feeling = f.state?.feeling;
      } },
      { id: 'settle', label: '收好', run: async () => {
        const liked = Number(ctx.feeling?.tastes?.[p.id]?.score || 0) > 0;
        const notes = use === 'use' ? [] : await this.lifeEvent({ type: 'eat', product: { id: p.id, name: p.name }, liked, ...(feeling ? { thought: String(feeling).slice(0, 200) } : {}) });
        return { ok: true, label, taste: ctx.lines.join('，'), happened: [ctx.feeling?.last, ...notes].filter(Boolean), ...this.summary() };
      } },
    ]));
  }

  async lifeEvent(event) {
    try { const now = this.now(); const r = await this.eco('life_event', { who: this.who, event, day: beijingDay(now), now, weather: this.weatherNow() }); return r.notes || []; }
    catch { return []; } // 生活记录失败不影响动作本身 / a failed note never undoes the action
  }
  async claimSeat(objectId, seconds) {
    const { result } = await this.scope.request('seat.claim', { owner: this.key, object: objectId, seconds }, { replyType: 'seat.result', timeoutMs: 5000 })
      .catch(error => { throw Error(error.frame?.error || '这个设施正在被使用，请等一会儿或选择其他活动'); });
    return result.slot ?? null;
  }
  releaseSeat() { try { this.host.send({ type: 'seat.release', owner: this.key }); } catch { /* 已断开 */ } }

  // ---- 读取 / reading ---------------------------------------------------------------------
  bagList() { return Object.entries(this.state?.bag || {}).filter(([, n]) => n > 0).map(([id, n]) => ({ id, name: this.products.get(id)?.name || id, count: n, kind: this.products.get(id)?.kind })); }
  summary() { return { wallet: this.state?.wallet?.coins ?? null, bag: this.bagList() }; }
  status() {
    const f = this.view?.feeling || {}, life = this.view?.life || {}, space = this.spaceOfScene(this.pos.scene);
    return {
      resident: this.key, name: this.name, connected: this.host.connected,
      position: { space: space?.id || null, place: space?.fullName || null, zone: this.pos.zone, zoneName: space?.zones.find(z => z.id === this.pos.zone)?.name || null },
      wallet: this.state?.wallet?.coins ?? null, bag: this.bagList(), bagSlots: this.catalog.wallet?.bagSlots || 12,
      feeling: { joy: f.joy, energy: f.energy, calm: f.calm, satiety: f.satiety, hydration: f.hydration, warmth: f.warmth, last: f.last },
      hunger: this.view?.hunger ?? null, mood: life.mood || null, wishes: (life.wishes || []).map(w => ({ id: w.id, text: w.text, done: w.done })),
      environment: life.environment ? { note: life.environment.note, indoors: life.environment.indoors } : null,
      doing: this.task ? { id: this.task.id, label: this.task.label, since: this.task.startedAt } : null,
      outfit: this.outfit || null, items: this.items, lamps: this.lamps, weather: this.weatherNow(),
    };
  }
  look() {
    const space = this.spaceOfScene(this.pos.scene);
    if (!space) return { known: false, note: '还不知道在哪里（游戏未连接或尚未报告位置）' };
    const here = this.catalog.objects.filter(o => o.space === space.id || o.space === 'any');
    return { space: space.id, place: space.fullName, zone: this.pos.zone, exits: space.links.map(id => ({ id, name: this.spaces.get(id)?.fullName })),
      objects: here.map(o => ({ id: o.id, name: o.name, description: o.description, supported: o.bridge === 'supported', uses: o.uses.map(u => ({ id: u.id, label: u.label, ...(u.shelf ? { buys: this.catalog.products.filter(p => p.shelf === u.shelf).map(p => `${p.id}（${p.name}）`) } : {}) })) })) };
  }

  // ---- 游戏侧边栏的数据 / data for the in-game side panel (panel.get) ------------------------------
  panel(frame) {
    if (frame.panel === 'activity') return { ok: true, data: { activity: [], pluginActivity: [], residents: { [this.key]: this.log } } };
    if (frame.panel === 'usage') {
      const s = this.state || {}, v = this.view || {}, day = beijingDay(this.now());
      const usedToday = Object.values(s.usage || {}).filter(u => u && u.day === day);
      const today = { count: this.log.filter(r => beijingDay(r.at) === day).length, props: usedToday.length };
      return { ok: true, data: { products: this.catalog.products, residents: { [this.key]: { log: this.log.slice(0, 20).map(r => ({ at: r.at, text: r.name + (r.detail ? '，' + r.detail : '') })), recent: [], today, life: { ...(v.life || {}), diary: [] }, usage: s.usage || {}, foods: s.foods || {}, uses: s.uses || {}, bag: s.bag || {}, satiety: v.feeling?.satiety ?? null, hunger: v.hunger ?? null, likes: v.likes || [] } } } };
    }
    // 相册、记忆、日记属于机器人软件自己的功能（本插件不含记忆层）。
    return { ok: false, error: '这项由机器人软件自己提供（相册、记忆、日记不在本插件内）' };
  }
}
