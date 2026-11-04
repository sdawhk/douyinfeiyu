import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { classifyAffinityMessage } from './affinity-rules.mjs';
import { isExplicitInsult } from './group-affinity-rules.mjs';

const FILE = 'D:\\deepseek\\state\\group-affinity.json';
const BASE_SCORE = 50;
const SENDER_COOLDOWN_MS = 20 * 60_000;
const DAILY_PRAISE_LIMIT = 3;

function singaporeDate(now) {
  return new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

export function parseGroupAffinityQuery(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const command = text.match(/^\/?群(?:聊)?好感度(?:\s+(全部|所有|\d{5,20}))?[?。！!]*$/);
  if (command) return { groupId: /^\d+$/.test(command[1] ?? '') ? command[1] : null,
    all: /^(?:全部|所有)$/.test(command[1] ?? '') };
  const compact = text.replace(/[\s，,?。！!]/g, '');
  if (/^(?:请|麻烦)?(?:帮我)?(?:看看|查看|查下|查一下|查询|查)?(?:你对)?(?:所有|全部)(?:的)?群(?:聊)?(?:的)?好感度(?:是多少)?$/.test(compact)) {
    return { groupId: null, all: true };
  }
  if (/^(?:请|麻烦)?(?:帮我)?(?:看看|查看|查下|查一下|查询|查)?(?:你对)?(?:这个|当前|本)(?:群|群聊)(?:的)?好感度(?:是多少)?$/.test(compact)) {
    return { groupId: null, all: false };
  }
  return null;
}

function load() {
  try {
    const value = JSON.parse(readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function save(state) {
  mkdirSync('D:\\deepseek\\state', { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temp, FILE);
}

export function groupAffinityTransition(record, { groupId, senderId, text, directed, allowPenalty = true,
  now = Date.now(), warnAt = 25, leaveAt = 10, dropAfterWarning = 5 }) {
  const message = String(text ?? '').trim();
  if (!directed || !message || message.length > 300 || message.startsWith('/')) return { record, action: null };
  const classified = classifyAffinityMessage(message);
  const direction = isExplicitInsult(message) ? (allowPenalty ? -1 : 0) : classified.insult ? 0 : classified.praise ? 1 : 0;
  if (!direction) return { record, action: null };
  const state = record && typeof record === 'object' ? structuredClone(record) : {};
  const group = state[String(groupId)] || { score: BASE_SCORE, warnedAt: null, leftAt: null, penalties: {}, praises: {} };
  if (group.leftAt) return { record, action: null };
  const sender = String(senderId);
  if (direction < 0) {
    const last = Number(group.penalties?.[sender] || 0);
    if (now - last < SENDER_COOLDOWN_MS) return { record, action: null };
    group.penalties ||= {};
    group.penalties[sender] = now;
  } else {
    const day = singaporeDate(now);
    const praise = group.praises?.[sender];
    if (Number(group.score ?? BASE_SCORE) >= 100
        || (praise && now - Number(praise.at || 0) < SENDER_COOLDOWN_MS)
        || (praise?.day === day && Number(praise.count || 0) >= DAILY_PRAISE_LIMIT)) {
      return { record, action: null };
    }
    group.praises ||= {};
    group.praises[sender] = { at: now, day, count: praise?.day === day ? Number(praise.count || 0) + 1 : 1 };
  }
  group.score = Math.max(0, Math.min(100, Number(group.score ?? BASE_SCORE) + direction));
  group.events = [...(group.events || []), { senderId: sender, delta: direction, at: new Date(now).toISOString() }].slice(-100);
  if (direction > 0 && group.score > warnAt) {
    group.warnedAt = null;
    group.warnedScore = null;
  }
  let action = null;
  if (direction < 0 && !group.warnedAt && group.score <= warnAt) {
    group.warnedAt = now;
    group.warnedScore = group.score;
    action = { type: 'warn', score: group.score };
  } else if (direction < 0 && group.warnedAt && (group.score <= leaveAt || group.score <= Number(group.warnedScore) - dropAfterWarning)) {
    action = { type: 'leave', score: group.score };
  }
  state[String(groupId)] = group;
  return { record: state, action, delta: direction };
}

export function getGroupAffinity(groupId) {
  const group = load()[String(groupId)] || { score: BASE_SCORE, warnedAt: null, leftAt: null };
  const score = Number(group.score);
  return { groupId: String(groupId), score: Math.max(0, Math.min(100, Number.isFinite(score) ? score : BASE_SCORE)), warnedAt: group.warnedAt, leftAt: group.leftAt };
}

export function recordGroupAffinityMessage(input, settings) {
  const state = load();
  const { record, action, delta = 0 } = groupAffinityTransition(state, {
    ...input,
    warnAt: settings.warnAt,
    leaveAt: settings.leaveAt,
    dropAfterWarning: settings.dropAfterWarning
  });
  if (record !== state) save(record);
  return { action, status: getGroupAffinity(input.groupId), delta };
}

export function markGroupLeft(groupId, now = Date.now()) {
  const state = load();
  const group = state[String(groupId)] || { score: BASE_SCORE, warnedAt: null, penalties: {} };
  group.leftAt = now;
  state[String(groupId)] = group;
  save(state);
}
