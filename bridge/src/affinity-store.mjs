import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { classifyAffinityMessage } from './affinity-rules.mjs';
import { isExplicitInsult } from './group-affinity-rules.mjs';

const DIR = 'D:\\deepseek\\state';
const FILE = `${DIR}\\affinity.json`;
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

function applyChange(qq, delta, reason, source, now = Date.now()) {
  const state = load();
  const record = userRecord(state, String(qq));
  const day = localDate(new Date(now));
  if (record.daily?.date !== day) record.daily = { date: day, positive: 0, negative: 0 };
  const key = delta > 0 ? 'positive' : 'negative';
  const magnitude = Math.max(-10, Math.min(10, Math.trunc(delta)));
  if (!magnitude) return getAffinity(qq);
  if (source === 'automatic' && record.daily[key] >= DAILY_LIMIT) return getAffinity(qq);
  const bounded = source === 'automatic' ? Math.sign(magnitude) : magnitude;
  const storedScore = Number(record.score);
  const currentScore = Number.isFinite(storedScore) ? storedScore : BASE_SCORE;
  record.score = Math.max(0, Math.min(100, currentScore + bounded));
  if (source === 'automatic') record.daily[key] += 1;
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

/** Only clear insults, repeated character-specific taboo teasing, and explicit praise affect scores. */
export function recordAffinityMessage(qq, text, now = Date.now()) {
  const message = String(text ?? '').trim();
  if (!/^\d{5,20}$/.test(String(qq)) || !message || message.startsWith('/') || message.length > 300) return null;
  const state = load();
  const record = userRecord(state, String(qq));
  const { insult, praise } = classifyAffinityMessage(message);
  const direction = (insult || isExplicitInsult(message)) ? -1 : praise ? 1 : 0;
  if (!direction) return null;
  const last = [...(record.events || [])].reverse().find((event) => event.source === 'automatic' && Math.sign(event.delta) === direction);
  if (last && now - Date.parse(last.at) < EVENT_COOLDOWN_MS) return null;
  const reason = direction > 0 ? '明确感谢或赞美' : '明确辱骂';
  const result = applyChange(qq, direction, reason, 'automatic', now);
  return result;
}
