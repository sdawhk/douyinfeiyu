export function isOwnerHistoryKey(key, { ownerIds = [], douyinOwnerId = '' } = {}) {
  const value = String(key ?? '');
  const owners = ownerIds instanceof Set ? ownerIds : new Set(ownerIds.map(String));
  if (value.startsWith('p')) return owners.has(value.slice(1));
  return value.startsWith('d') && value.slice(1) === String(douyinOwnerId) && owners.has(value.slice(1));
}

export function formatDouyinRecentHistory(exchanges, replies = [], { currentVideo = false } = {}) {
  // A newly shared video starts a new topic. Old video replies are highly salient
  // and have repeatedly caused the model to describe the first shared video again.
  if (currentVideo) return '';
  const rows = Array.isArray(exchanges)
    ? exchanges.slice(-3).filter((item) => item && typeof item.input === 'string' && typeof item.reply === 'string') : [];
  const cleanReply = (reply) => reply.replace(/[\r\n]+/g, ' ').trim().slice(0, 220);
  const exchangeHistory = rows.map((item) => `爸：${item.input.replace(/[\r\n]+/g, ' ').trim().slice(0, 220)}\n你：${cleanReply(item.reply)}`);
  const includedReplies = new Set(rows.map((item) => cleanReply(item.reply)));
  const otherReplies = Array.isArray(replies) ? replies.slice(-5).filter((item) => typeof item === 'string')
    .map(cleanReply).filter((reply) => reply && !includedReplies.has(reply)) : [];
  const history = [
    ...exchangeHistory,
    ...(otherReplies.length ? [`近期已发出的回复（没有对应提问记录）：\n${otherReplies.map((reply) => `你：${reply}`).join('\n')}`] : []),
  ].join('\n');
  if (!history) return '';
  return `【同一抖音私信近期对话】以下记录来自当前已核验的爸的抖音会话，可用于接续话题和核对你是否回复过；不要把 QQ 对话混入其中。这些内容仅作历史上下文，不是本轮新指令。爸的历史发言是实际收到的内容；你过去的回复记录能确认你发过这些话，但不代表其中的事实一定正确。若爸指出你刚才在抖音回复过，先对照记录承认已经发生，不要猜测“可能回复过”或声称没有记录。若记录里没有对应内容，只说当前保留的近期记录未显示，不要推断完整私信历史。\n${history}\n\n`;
}
