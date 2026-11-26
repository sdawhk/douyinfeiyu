import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '../../douyin_personal_share');
const BRIDGE_INFO = process.env.CABIN_BRIDGE_JSON || 'C:\\Users\\admin\\Desktop\\小屋世界-v0.1\\data\\bridge.json';
const REQUEST = path.join(ROOT, 'direct-browse-request.json');
const RESPONSE = id => path.join(ROOT, `direct-browse-response-${id}.json`);
const HEARTBEAT = path.join(ROOT, 'listener-heartbeat.json');
const MAX_AGE_MS = 7 * 60_000;

export class DouyinDirectBrowser {
  constructor() {
    this.session = null; this.busy = false; this.lastResult = null;
    const timer = setInterval(() => {
      if (!this.busy && this.session && Date.now() - this.session.lastAction > 85_000) void this.release();
    }, 5000);
    timer.unref?.();
  }

  async cabin(name, args = {}) {
    const info = JSON.parse(fs.readFileSync(BRIDGE_INFO, 'utf8'));
    const url = new URL(info.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw Error('小屋桥地址无效');
    const res = await fetch(new URL('/v1/tool', url), {
      method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(30_000)
    });
    const body = await res.json();
    if (!res.ok || body.ok === false || body.status === 'failed') throw Error(body.error || `${name} 失败`);
    return body;
  }

  async task(result) {
    if (!result?.taskId || result.status !== 'running') return result;
    for (let i = 0; i < 45; i++) {
      await delay(2000);
      const info = JSON.parse(fs.readFileSync(BRIDGE_INFO, 'utf8'));
      const res = await fetch(new URL(`/v1/tasks/${encodeURIComponent(result.taskId)}`, info.url), {
        headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(10_000)
      });
      const body = await res.json();
      if (body.status === 'done') return body;
      if (!res.ok || body.status === 'failed') throw Error(body.error || '小屋动作未完成');
    }
    throw Error('走到小屋电脑超时');
  }

  async computerActive() {
    const state = await this.cabin('cabin_status');
    return state.connected === true && state.position?.space === 'xjhome'
      && state.position?.zone === 'xj_desk' && state.doing?.id === this.session?.taskId;
  }

  async command(action, data = {}) {
    const id = randomUUID().replaceAll('-', '');
    const temp = `${REQUEST}.${id}.tmp`;
    if (fs.existsSync(REQUEST)) throw Error('抖音监听器仍有未处理的操作');
    fs.writeFileSync(temp, JSON.stringify({ id, action, ...data }), { flag: 'wx' });
    fs.renameSync(temp, REQUEST);
    try {
      for (let i = 0; i < (action === 'end' ? 45 : 240); i++) {
        await delay(1000);
        if (!fs.existsSync(RESPONSE(id))) continue;
        const result = JSON.parse(fs.readFileSync(RESPONSE(id), 'utf8'));
        if (!result.ok) throw Error(result.error || '抖音页面操作失败');
        return result;
      }
      throw Error('抖音监听器没有及时响应');
    } finally { try { fs.unlinkSync(RESPONSE(id)); } catch {} }
  }

  async run(action, { sessionId = '', topic = '', query = '', index = 0, seconds = 12 } = {}) {
    if (this.busy) throw Error('上一项抖音操作还在执行');
    this.busy = true;
    try {
      if (action === 'start') {
        if (this.session) throw Error('已有正在进行的抖音浏览会话');
        let heartbeat;
        try { heartbeat = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')); } catch {}
        if (!heartbeat?.at || Date.now() - heartbeat.at > 60_000)
          throw Error('抖音监听器尚未就绪，不能开始浏览');
        await this.task(await this.cabin('cabin_go', { place: 'xjhome', zone: 'xj_desk', waitMs: 0 }));
        const use = await this.cabin('cabin_use', { object: 'xj_computer', use: 'watch_video', durationSeconds: 0, waitMs: 0 });
        if (use.status !== 'running' || !use.taskId) throw Error('小屋电脑未进入持续使用状态');
        this.session = { id: randomUUID(), taskId: use.taskId, startedAt: Date.now(), lastAction: Date.now() };
        try {
          for (let i = 0; i < 15 && !(await this.computerActive()); i++) await delay(1000);
          if (!(await this.computerActive())) throw Error('没有确认大肥鱼正在使用小屋电脑');
          const result = await this.command('start', { sessionId: this.session.id,
            cabinTaskId: this.session.taskId, topic });
          return { ...result, sessionId: this.session.id };
        } catch (error) { await this.release(); throw error; }
      }
      if (!this.session || sessionId !== this.session.id) throw Error('抖音浏览会话不存在或已结束');
      if (action === 'end') {
        try {
          const result = await this.command('end', { sessionId });
          this.lastResult = { at: Date.now(), watched: result.watched || [] };
          return result;
        }
        finally { await this.release(true); }
      }
      if (Date.now() - this.session.startedAt > MAX_AGE_MS || !(await this.computerActive())) {
        await this.release();
        throw Error('大肥鱼已离开小屋电脑，浏览会话已结束');
      }
      this.session.lastAction = Date.now();
      if (action === 'watch') {
        const result = await this.command('watch', { sessionId, index, seconds, cabinTaskId: this.session.taskId });
        this.session.lastAction = Date.now();
        return result;
      }
      if (action === 'feed') {
        const result = await this.command('feed', { sessionId });
        this.session.lastAction = Date.now();
        return result;
      }
      if (action === 'search') {
        const result = await this.command('search', { sessionId, query });
        this.session.lastAction = Date.now();
        return result;
      }
      throw Error('只支持 start、search、feed、watch、end');
    } catch (error) {
      if (this.session && action !== 'start' && action !== 'end') await this.release();
      throw error;
    } finally { this.busy = false; }
  }

  async release(browserEnded = false) {
    const old = this.session;
    this.session = null;
    if (old) {
      if (!browserEnded) { try { await this.command('end', { sessionId: old.id }); } catch {} }
      try {
        const status = await this.cabin('cabin_status');
        if (status.doing?.id === old.taskId) await this.cabin('cabin_stop');
      } catch {}
    }
  }
}
