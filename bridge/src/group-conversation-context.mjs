const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_LATEST_ENTRIES = 8;
const DEFAULT_MAX_TEXT_LENGTH = 180;
const DEFAULT_ECHO_WINDOW_MS = 12 * 60 * 60_000;
const DEFAULT_ECHO_MAX_ENTRIES = 60;

/** Keeps recent incoming group messages so rate-limited turns still provide context. */
export class GroupConversationContext {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
    echoWindowMs = DEFAULT_ECHO_WINDOW_MS, echoMaxEntries = DEFAULT_ECHO_MAX_ENTRIES } = {}) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.maxTextLength = maxTextLength;
    this.echoWindowMs = echoWindowMs;
    this.echoMaxEntries = echoMaxEntries;
    this.groups = new Map();
    this.echoHistory = new Map();
    this.versions = new Map();
  }

  remember(groupId, { senderId, senderName = '', text = '', directionHint = '' }, at = Date.now()) {
    const key = String(groupId);
    const recent = (this.groups.get(key) ?? []).filter((item) => at - item.at <= this.windowMs);
    const cleanedText = String(text).replace(/[\r\n\t]+/g, ' ').trim().slice(0, this.maxTextLength);
    if (cleanedText) {
      const contextText = /^(?:\[(?:图片|表情|动画表情|语音|视频)\]\s*)+$/u.test(cleanedText)
        ? '发送了媒体内容（内容未识别）' : cleanedText;
      recent.push({
        at,
        senderId: String(senderId ?? ''),
        senderName: String(senderName).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60),
        text: contextText,
        directionHint: String(directionHint).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100)
      });
      // 只为出站回声检测保留更长窗口，不参与 prompt 注入。
      const echoRecent = (this.echoHistory.get(key) ?? []).filter((item) => at - item.at <= this.echoWindowMs);
      echoRecent.push({
        at,
        senderName: String(senderName).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60),
        text: contextText
      });
      this.echoHistory.set(key, echoRecent.slice(-this.echoMaxEntries));
    }
    this.groups.set(key, recent.slice(-this.maxEntries));
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  format(groupId, now = Date.now(), { senderId = null, extra = '' } = {}) {
    const key = String(groupId);
    const recent = (this.groups.get(key) ?? []).filter((item) => now - item.at <= this.windowMs);
    this.groups.set(key, recent);
    if (!recent.length) return String(extra ?? '').trim();
    // 保留最近 8 条，足以接住当前话题和多话题并行；更早的只补该发言人最近 1 条。
    const latest = recent.slice(-DEFAULT_LATEST_ENTRIES);
    const sameSpeaker = senderId == null ? [] : recent.slice(0, -DEFAULT_LATEST_ENTRIES)
      .filter((item) => item.senderId === String(senderId)).slice(-1);
    const lines = [...sameSpeaker, ...latest].map((item) => {
      const time = new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const speaker = item.senderName
        ? item.senderName
        : item.senderId === String(senderId) ? '当前发言人' : '其他群友';
      return `- ${time} ${speaker}${item.directionHint ? `（${item.directionHint}）` : ''}：${JSON.stringify(item.text)}`;
    });
    return [
      extra,
      '【本群近期消息背景】这是本群最近的真实对话，用来判断在跟谁说话、在聊什么；能自然接上就接，拿不准对象时只回应明确找你的那条。',
      ...lines
    ].filter((line) => String(line ?? '').trim()).join('\n');
  }

  version(groupId) {
    return this.versions.get(String(groupId)) ?? 0;
  }

  /** 仅用于出站回声检测的长窗口原始记录，不影响 prompt 注入格式。 */
  echoLines(groupId, now = Date.now()) {
    return (this.echoHistory.get(String(groupId)) ?? [])
      .filter((item) => now - item.at <= this.echoWindowMs)
      .map(({ senderName, text }) => ({ senderName, text }));
  }

  /** 取同一发言人在短时间内的最近消息，用于合并「先说话再 @」的空正文。 */
  recentFromSender(groupId, senderId, { withinMs = 60_000, limit = 2 } = {}, now = Date.now()) {
    const key = String(groupId);
    return (this.groups.get(key) ?? [])
      .filter((item) => now - item.at <= withinMs && item.senderId === String(senderId))
      .slice(-limit);
  }
}
