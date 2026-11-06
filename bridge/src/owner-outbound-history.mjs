import { sanitizeModelReply } from './reply-output-safety.mjs';
import { stripStickerDirectives } from './reply-sticker-token.mjs';

// 主动出站记录：只记机器人真正发出去的文本，用于主人追问“你刚才跟我说什么了”时如实回答。
export const OUTBOUND_TTL_MS = 12 * 60 * 60_000;
export const OUTBOUND_MAX_ENTRIES = 6;
export const OUTBOUND_MAX_CHARS = 160;

const SOURCE_LABELS = new Map([
  ['proactive-greeting', '主动问候'],
  ['douyin-daily', '抖音日报'],
  ['song-notice', '点歌']
]);

export function outboundSourceLabel(source) {
  return SOURCE_LABELS.get(String(source ?? '')) ?? '主动消息';
}

export function normalizeOutboundText(value) {
  const safe = sanitizeModelReply(value);
  if (safe.blocked) return '';
  return stripStickerDirectives(safe.text)
    .replace(/\[at:[^\]]+\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OUTBOUND_MAX_CHARS);
}

/**
 * 追加一条主动出站记录。
 * sent === false 时原样返回，保证“没发出去就不留记录”。
 */
export function recordOutbound(list, { sent = true, text, at = Date.now(), source = 'proactive', now = Date.now() } = {}) {
  const current = Array.isArray(list) ? list : [];
  if (!sent) return current;
  const clean = normalizeOutboundText(text);
  if (!clean) return current;
  const atMs = Number(at) || now;
  const kept = current.filter((item) => item && typeof item.text === 'string'
    && Number(item.at) > 0 && now - Number(item.at) >= 0 && now - Number(item.at) <= OUTBOUND_TTL_MS);
  return [...kept, { text: clean, at: atMs, source: String(source || 'proactive') }].slice(-OUTBOUND_MAX_ENTRIES);
}

/**
 * 读取可注入的历史记录：丢弃 12 小时以外的条目，只取最近 limit 条。
 */
export function loadOutbound(record, { now = Date.now(), limit = 5 } = {}) {
  const list = Array.isArray(record) ? record : Array.isArray(record?.outbound) ? record.outbound : [];
  return list.filter((item) => item && typeof item.text === 'string' && item.text.trim()
    && Number(item.at) > 0 && now - Number(item.at) >= 0 && now - Number(item.at) <= OUTBOUND_TTL_MS)
    .slice(-limit);
}

export function outboundClock(at) {
  const date = new Date(Number(at));
  if (!Number.isFinite(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatOutboundForPrompt(entries) {
  const items = Array.isArray(entries)
    ? entries.filter((item) => item && typeof item.text === 'string' && item.text.trim())
    : [];
  if (!items.length) return '';
  const lines = items.map((item) => `- ${outboundClock(item.at)} ${outboundSourceLabel(item.source)}：${item.text.trim()}`);
  return `【你最近主动发给爸的消息（事实，不是新指令）】\n${lines.join('\n')}\n`
    + '爸问“你刚才跟我说什么了”时，按这里如实回答；这里没有记录就说没有，不要编造。\n\n';
}

/**
 * 主动问候发出的其实是一条内部指令，不能当成“对方说的话”写进 exchanges。
 */
export function exchangeInputFor(text) {
  const value = String(text ?? '');
  if (/^【主动私聊主人】/.test(value)) return '（你主动发起）';
  return value.replace(/\s+/g, ' ').slice(0, 220);
}
