export function isOwnerImageReplyRequest(text) {
  const value = String(text ?? '');
  return /群/.test(value) && /(?:回复|回一下|评价|评一下|评论)/.test(value) && /(?:图片|照片|图)/.test(value);
}

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[\s_\-（）()【】\[\]]/g, '');
}

export function resolveGroupMention(text, groups) {
  const query = normalize(text);
  const matches = (groups || []).filter((group) => {
    const id = String(group.group_id ?? '');
    const name = normalize(group.group_name);
    const prefix = name.split(/md\d|群/)[0];
    return (id && query.includes(id)) || (name.length >= 3 && query.includes(name))
      || (prefix.length >= 3 && query.includes(prefix));
  });
  return matches.length === 1 ? matches[0] : null;
}

export function latestOwnerImage(messages, ownerId, nowSeconds = Math.floor(Date.now() / 1000)) {
  return (messages || [])
    .filter((message) => String(message.user_id ?? message.sender?.user_id ?? '') === String(ownerId))
    .filter((message) => nowSeconds - Number(message.time) >= 0 && nowSeconds - Number(message.time) <= 2 * 60 * 60)
    .map((message) => ({ message, image: (Array.isArray(message.message) ? message.message : [])
      .find((part) => part?.type === 'image' && part.data?.file) }))
    .filter((row) => row.image)
    .sort((a, b) => Number(b.message.time) - Number(a.message.time))[0] || null;
}

export function recentGroupSummary(messages, limit = 14) {
  return (messages || []).slice().sort((a, b) => Number(a.time) - Number(b.time)).slice(-limit).map((message) => {
    const who = String(message.sender?.card || message.sender?.nickname || message.user_id || '群友').slice(0, 30);
    const text = (Array.isArray(message.message) ? message.message : [])
      .map((part) => part?.type === 'text' ? String(part.data?.text || '')
        : part?.type === 'image' ? '[图片]' : '')
      .join('').trim().slice(0, 180);
    return `${who}：${text || '[非文本消息]'}`;
  }).join('\n');
}
