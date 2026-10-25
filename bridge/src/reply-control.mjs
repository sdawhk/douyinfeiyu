export function canReply(replyControl, isGroup, target) {
  const control = replyControl || {};
  if (isGroup ? control.groupEnabled === false : control.privateEnabled === false) return false;
  const disabled = isGroup ? control.disabledGroups : control.disabledPrivate;
  return !Array.isArray(disabled) || !disabled.includes(String(target));
}
