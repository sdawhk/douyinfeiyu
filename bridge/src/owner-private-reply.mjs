/** Parse an explicit owner request to answer an unanswered private message. */
export function parseOwnerPrivateReplyRequest(text) {
  const value = String(text ?? '').trim();
  if (!/(?:私聊|私信|好友消息|漏回|没回|未回复|之前.*消息)/i.test(value)
    || !/(?:回复|回一下|回覆|补回|补个回复|答复)/i.test(value)) return null;

  const numeric = value.match(/(?:QQ\s*)?(\d{5,20})/i)?.[1] ?? null;
  let targetHint = numeric;
  if (!targetHint) {
    const namedPatterns = [
      /(?:回复|回一下|回覆|补回|答复)\s*(?:一下\s*)?(?:给\s*)?([\p{L}\p{N}_-]{2,24}?)(?=\s*(?:之前|前几天|最近|发来的?|私聊|私信|漏回|没回|未回复|的消息|消息|$))/u,
      /([\p{L}\p{N}_-]{2,24}?)\s*(?:之前|前几天|最近)?\s*(?:给你|向你)发(?:了)?(?:消息|信息)/u
    ];
    for (const pattern of namedPatterns) {
      const candidate = value.match(pattern)?.[1]?.trim();
      if (candidate && !/^(?:之前|前几天|最近|私聊|私信|消息|信息|一下|那个|这个|漏掉|漏回)$/u.test(candidate)) {
        targetHint = candidate;
        break;
      }
    }
  }
  return { targetHint };
}

/** Messages are chronological; return the incoming run after the last bot reply. */
export function findUnansweredPrivateMessages(messages, selfId, { now = Date.now(), maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  const ordered = (Array.isArray(messages) ? messages : [])
    .map((message, index) => ({ message, index, time: Number(message?.time) || 0 }))
    .sort((a, b) => a.time && b.time ? a.time - b.time || a.index - b.index : a.index - b.index);
  let lastBotIndex = -1;
  for (let i = 0; i < ordered.length; i += 1) {
    const sender = String(ordered[i].message?.user_id ?? ordered[i].message?.sender?.user_id ?? '');
    if (sender === String(selfId)) lastBotIndex = i;
  }
  const pending = ordered.slice(lastBotIndex + 1).map(({ message }) => message)
    .filter((message) => String(message?.user_id ?? message?.sender?.user_id ?? '') !== String(selfId));
  if (!pending.length) return { messages: [], reason: 'none' };
  const latest = pending.at(-1);
  const timestamp = Number(latest?.time) * 1000;
  if (timestamp > 0 && now - timestamp > maxAgeMs) return { messages: [], reason: 'stale' };
  return { messages: pending.slice(-8), reason: 'unanswered' };
}

/** Let the model decline a stale conversational gap instead of forcing a message. */
export function decideMissedPrivateReply(raw, safeReply) {
  if (/^\s*\[SILENT\]\s*$/i.test(String(raw ?? ''))) return { action: 'skip' };
  const text = String(safeReply?.text ?? '').trim();
  if (safeReply?.blocked || !text || /^\[SILENT\]$/i.test(text)) return { action: 'invalid' };
  return { action: 'reply', text };
}
