export function classifyAffinityMessage(text) {
  const message = String(text ?? '').trim();
  return {
    insult: /(?:傻逼|傻叉|去死|滚蛋|废物|垃圾机器人)/i.test(message),
    praise: /(?:谢谢|辛苦了|帮大忙|好可爱|喜欢你|做得好|真聪明|太棒了)/i.test(message),
  };
}
