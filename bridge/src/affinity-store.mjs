import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { classifyAffinityMessage } from './affinity-rules.mjs';
import { isExplicitInsult } from './group-affinity-rules.mjs';

// 状态目录默认仍是 D:\deepseek\state；测试可显式指定，避免读写真实好感度数据。
const DIR = process.env.AFFINITY_STATE_DIR || 'D:\\deepseek\\state';
const FILE = process.env.AFFINITY_STATE_PATH || `${DIR}\\affinity.json`;
const BASE_SCORE = 50;
const DAILY_LIMIT = 3;
const EVENT_COOLDOWN_MS = 20 * 60_000;

function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function load() {
  try {
    const value = JSON.parse(readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function save(state) {
  mkdirSync(DIR, { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temp, FILE);
}

function userRecord(state, qq) {
  return state[qq] || { score: BASE_SCORE, events: [], daily: { date: localDate(), positive: 0, negative: 0 } };
}

export function affinityLevel(score) {
  if (score < 25) return '刚认识';
  if (score < 50) return '普通熟悉';
  if (score < 75) return '聊得来';
  return '很亲近';
}

export function getAffinity(qq) {
  const value = userRecord(load(), String(qq));
  const storedScore = Number(value.score);
  const score = Math.max(0, Math.min(100, Number.isFinite(storedScore) ? storedScore : BASE_SCORE));
  return { qq: String(qq), score, level: affinityLevel(score), events: (value.events || []).slice(-10).reverse() };
}

/** 主人通道：只跳过“每日配额 + 冷却”，不跳过关键词/模型判定，也不改步长与封顶。 */
function ownerBypass(qq, { isOwner = false, ownerQQs = [] } = {}) {
  if (isOwner === true) return true;
  return Array.isArray(ownerQQs) && ownerQQs.map(String).includes(String(qq));
}

function applyChange(qq, delta, reason, source, now = Date.now(), { bypassLimits = false } = {}) {
  const state = load();
  const record = userRecord(state, String(qq));
  const day = localDate(new Date(now));
  if (record.daily?.date !== day) record.daily = { date: day, positive: 0, negative: 0 };
  const key = delta > 0 ? 'positive' : 'negative';
  const magnitude = Math.max(-10, Math.min(10, Math.trunc(delta)));
  if (!magnitude) return getAffinity(qq);
  if (source === 'automatic' && !bypassLimits && record.daily[key] >= DAILY_LIMIT) return getAffinity(qq);
  const bounded = source === 'automatic' ? Math.sign(magnitude) : magnitude;
  const storedScore = Number(record.score);
  const currentScore = Number.isFinite(storedScore) ? storedScore : BASE_SCORE;
  record.score = Math.max(0, Math.min(100, currentScore + bounded));
  if (source === 'automatic' && !bypassLimits) record.daily[key] += 1;
  record.events = [...(record.events || []), { delta: bounded, reason: String(reason).slice(0, 80), at: new Date(now).toISOString(), source }].slice(-100);
  state[String(qq)] = record;
  save(state);
  return {
    qq: String(qq), score: record.score, level: affinityLevel(record.score),
    delta: bounded, reason: String(reason).slice(0, 80),
    events: record.events.slice(-10).reverse()
  };
}

export function adjustAffinity(qq, delta, reason = '主人手动调整') {
  if (!/^\d{5,20}$/.test(String(qq))) throw new Error('QQ 号格式无效');
  if (!Number.isInteger(Number(delta)) || Number(delta) === 0 || Math.abs(Number(delta)) > 10) {
    throw new Error('调整值需为 -10～-1 或 1～10');
  }
  return applyChange(qq, Number(delta), reason, 'owner');
}

export function setAffinity(qq, score, reason = '主人设置分数') {
  if (!/^\d{5,20}$/.test(String(qq))) throw new Error('QQ 号格式无效');
  const value = Number(score);
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('分数需为 0～100 的整数');
  const state = load();
  const record = userRecord(state, String(qq));
  const storedScore = Number(record.score);
  const delta = value - (Number.isFinite(storedScore) ? storedScore : BASE_SCORE);
  record.score = value;
  record.daily ||= { date: localDate(), positive: 0, negative: 0 };
  record.events = [...(record.events || []), { delta, reason: String(reason).slice(0, 80), at: new Date().toISOString(), source: 'owner' }].slice(-100);
  state[String(qq)] = record;
  save(state);
  return getAffinity(qq);
}

export function resetAffinity(qq) {
  if (!/^\d{5,20}$/.test(String(qq))) throw new Error('QQ 号格式无效');
  const state = load();
  delete state[String(qq)];
  save(state);
  return getAffinity(qq);
}

/** Only directed, explicit relationship signals affect individual affinity. */
export function recordAffinityMessage(qq, text, now = Date.now(), { directed = true, isOwner = false, ownerQQs = [] } = {}) {
  const message = String(text ?? '').trim();
  if (!directed || !/^\d{5,20}$/.test(String(qq)) || !message || message.startsWith('/') || message.length > 300) return null;
  const state = load();
  const record = userRecord(state, String(qq));
  const { insult, praise, reason: signalReason } = classifyAffinityMessage(message);
  const reportedOrJokingInsult = /(?:不是(?:在)?骂你|没骂你|我没说你|我不是说你|别当真|开玩笑|引用|转述|他说|她说|有人说).{0,20}(?:傻逼|傻叉|去死|滚蛋|废物|垃圾机器人|脑残|弱智|智障)/i.test(message);
  const explicitInsult = !reportedOrJokingInsult && (insult || isExplicitInsult(message));
  const direction = explicitInsult ? -1 : praise ? 1 : 0;
  if (!direction) return null;
  const bypass = ownerBypass(qq, { isOwner, ownerQQs });
  const last = [...(record.events || [])].reverse().find((event) => event.source === 'automatic' && Math.sign(event.delta) === direction);
  if (!bypass && last && now - Date.parse(last.at) < EVENT_COOLDOWN_MS) return null;
  const reason = direction > 0 ? signalReason : '明确辱骂';
  const result = applyChange(qq, direction, reason, 'automatic', now, { bypassLimits: bypass });
  return result;
}

/** Let the conversation model assess context that the explicit keyword rules miss. */
export function shouldModelAssessAffinity(qq, text, { directed = true } = {}) {
  const message = String(text ?? '').trim();
  if (!directed || !/^\d{5,20}$/.test(String(qq)) || !message || message.startsWith('/') || message.length > 300) return false;
  const { insult, praise } = classifyAffinityMessage(message);
  return !insult && !praise && !isExplicitInsult(message);
}

/** Apply the model's contextual judgment through the same caps and cooldown as rule-based changes. */
export function recordModelAffinityAssessment(qq, delta, reason, now = Date.now(), { directed = true, isOwner = false, ownerQQs = [] } = {}) {
  if (!directed || !/^\d{5,20}$/.test(String(qq)) || !/^[+-]?1$/.test(String(delta))) return null;
  const direction = Number(delta);
  const bypass = ownerBypass(qq, { isOwner, ownerQQs });
  const last = [...(userRecord(load(), String(qq)).events || [])].reverse()
    .find((event) => event.source === 'automatic' && Math.sign(event.delta) === direction);
  if (!bypass && last && now - Date.parse(last.at) < EVENT_COOLDOWN_MS) return null;
  const cleanReason = `团团判断：${String(reason ?? '').replace(/[\r\n]/g, ' ').slice(0, 50)}`;
  return applyChange(qq, direction, cleanReason, 'automatic', now, { bypassLimits: bypass });
}
