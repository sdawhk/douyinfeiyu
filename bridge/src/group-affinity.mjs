import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isExplicitInsult } from './group-affinity-rules.mjs';

const FILE = 'D:\\deepseek\\state\\group-affinity.json';
const BASE_SCORE = 50;
const SENDER_COOLDOWN_MS = 20 * 60_000;

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

export function groupAffinityTransition(record, { groupId, senderId, text, directed, now = Date.now(), warnAt = 25, leaveAt = 10, dropAfterWarning = 5 }) {
  if (!directed || !isExplicitInsult(text)) return { record, action: null };
  const state = record && typeof record === 'object' ? structuredClone(record) : {};
  const group = state[String(groupId)] || { score: BASE_SCORE, warnedAt: null, leftAt: null, penalties: {} };
  if (group.leftAt) return { record: state, action: null };
  const last = Number(group.penalties?.[String(senderId)] || 0);
  if (now - last < SENDER_COOLDOWN_MS) return { record: state, action: null };
  group.score = Math.max(0, Number(group.score ?? BASE_SCORE) - 1);
  group.penalties ||= {};
  group.penalties[String(senderId)] = now;
  group.events = [...(group.events || []), { senderId: String(senderId), delta: -1, at: new Date(now).toISOString() }].slice(-100);
  let action = null;
  if (!group.warnedAt && group.score <= warnAt) {
    group.warnedAt = now;
    group.warnedScore = group.score;
    action = { type: 'warn', score: group.score };
  } else if (group.warnedAt && (group.score <= leaveAt || group.score <= Number(group.warnedScore) - dropAfterWarning)) {
    action = { type: 'leave', score: group.score };
  }
  state[String(groupId)] = group;
  return { record: state, action };
}

export function getGroupAffinity(groupId) {
  const group = load()[String(groupId)] || { score: BASE_SCORE, warnedAt: null, leftAt: null };
  const score = Number(group.score);
  return { groupId: String(groupId), score: Math.max(0, Math.min(100, Number.isFinite(score) ? score : BASE_SCORE)), warnedAt: group.warnedAt, leftAt: group.leftAt };
}

export function recordGroupInsult(input, settings) {
  const state = load();
  const { record, action } = groupAffinityTransition(state, {
    ...input,
    warnAt: settings.warnAt,
    leaveAt: settings.leaveAt,
    dropAfterWarning: settings.dropAfterWarning
  });
  if (record !== state) save(record);
  return { action, status: getGroupAffinity(input.groupId) };
}

export function markGroupLeft(groupId, now = Date.now()) {
  const state = load();
  const group = state[String(groupId)] || { score: BASE_SCORE, warnedAt: null, penalties: {} };
  group.leftAt = now;
  state[String(groupId)] = group;
  save(state);
}
