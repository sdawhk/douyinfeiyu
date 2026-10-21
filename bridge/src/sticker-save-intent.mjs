// Explicit requests from the owner override automatic sticker classification.
export function parseStickerSaveIntent(value) {
  const text = String(value ?? '').trim();
  const command = text.match(/^(?:\/存表情|\/sticker-save|存表情包?|保存表情包?)\s*(.{0,30})$/i);
  if (command) return { key: command[1].trim() || null };

  const named = text.match(/^(.{1,30}?)(?:你)?(?:存下|存起来|保存为表情包|存成表情包)[。！!]?$/);
  if (named) {
    const key = named[1].replace(/^(?:帮我)?(?:把|将)?(?:这张|这个|图片|表情包)(?:图)?(?:叫|命名为|存为)?/, '').trim();
    return { key: key || null };
  }

  if (/^(?:快存|存一下|存起来|保存这张|把这张存了|把这张图存了)[。！!]?$/.test(text)) {
    return { key: null };
  }
  return null;
}

export function isStickerName(value) {
  const text = String(value ?? '').trim();
  return text.length > 0 && text.length <= 30 && !/[\r\n/\\:*?"<>|]/.test(text)
    && !/^(?:算了|取消|不用了|别存了|快存|存一下)$/.test(text);
}
