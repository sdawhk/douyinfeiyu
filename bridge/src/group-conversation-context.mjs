const DEFAULT_WINDOW_MS = 2 * 60_000;
const DEFAULT_MAX_ENTRIES = 10;
const DEFAULT_MAX_TEXT_LENGTH = 180;

/** Keeps recent incoming group messages so rate-limited turns still provide context. */
export class GroupConversationContext {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxTextLength = DEFAULT_MAX_TEXT_LENGTH } = {}) {
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.maxTextLength = maxTextLength;
    this.groups = new Map();
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
    }
    this.groups.set(key, recent.slice(-this.maxEntries));
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  format(groupId, now = Date.now(), { senderId = null } = {}) {
    const key = String(groupId);
    const recent = (this.groups.get(key) ?? []).filter((item) => now - item.at <= this.windowMs);
    this.groups.set(key, recent);
    if (!recent.length) return '';
    // A short window helps resolve follow-ups without carrying several parallel topics.
    const latest = recent.slice(-2);
    const sameSpeaker = senderId == null ? [] : recent.slice(0, -2)
      .filter((item) => item.senderId === String(senderId)).slice(-1);
    const lines = [...sameSpeaker, ...latest].map((item) => {
      const time = new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const speaker = item.senderName
        ? item.senderName
        : item.senderId === String(senderId) ? '当前发言人' : '其他群友';
      return `- ${time} ${speaker}${item.directionHint ? `（${item.directionHint}）` : ''}：${JSON.stringify(item.text)}`;
    });
    return [
      '【本群近期消息背景】只用于理解本轮明确的追问或引用；可能属于别人的话题，不要抢答或接错对象。',
      ...lines
    ].join('\n');
  }

  version(groupId) {
    return this.versions.get(String(groupId)) ?? 0;
  }
}
