export function normalizePokeNotice(event, botSelf) {
  if (event?.post_type !== 'notice' || event?.sub_type !== 'poke') return null;
  const senderId = String(event.sender_id ?? event.user_id ?? event.sender?.user_id ?? '');
  const targetId = String(event.target_id ?? event.targetId ?? '');
  const selfId = String(botSelf ?? event.self_id ?? '');
  if (!senderId || !targetId || !selfId || senderId === selfId) return null;
  const groupId = event.group_id ?? event.groupId ?? null;
  return {
    senderId, targetId,
    targetIsSelf: targetId === selfId,
    isGroup: groupId != null,
    chatId: String(groupId ?? senderId)
  };
}

export function choosePokeReply(text, random = Math.random) {
  const options = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!options.length) return '';
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

// Count only direct pokes from the same person in the same chat.
export function registerDirectPoke(pairs, chatKey, senderId, now = Date.now()) {
  const key = `${chatKey}:${senderId}`;
  const firstAt = pairs.get(key);
  if (firstAt != null && now - firstAt <= 60_000) {
    pairs.delete(key);
    return true;
  }
  pairs.set(key, now);
  return false;
}
