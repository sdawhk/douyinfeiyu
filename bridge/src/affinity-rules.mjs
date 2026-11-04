export function classifyAffinityMessage(text) {
  const message = String(text ?? '').trim();
  const insult = /(?:傻逼|傻叉|去死|滚蛋|废物|垃圾机器人)/i.test(message);
  const praiseType = [
    { reason: '表达感谢', pattern: /(?:谢谢|感谢|辛苦了)/i },
    { reason: '认可实际帮助', pattern: /(?:帮大忙|帮上大忙|多亏你|解决了|真靠谱|太有用了)/i },
    { reason: '直接夸奖', pattern: /(?:好可爱|做得好|真聪明|太棒了|真厉害|你真好)/i },
    { reason: '表达亲近', pattern: /(?:喜欢你|有你真好|跟你聊天很开心|和你聊天很开心|想跟你聊聊天|你真懂我)/i }
  ];
  const sarcasticOrNegated = /(?:不是|并不|没|没有|别).{0,5}(?:谢谢|感谢|喜欢你|好可爱|做得好|真聪明|太棒了|真厉害|你真好)|(?:谢谢|感谢).{0,8}(?:个鬼|个屁|你个|没用|但|不过)/i.test(message);
  const praise = !insult && !sarcasticOrNegated ? praiseType.find(({ pattern }) => pattern.test(message)) : null;
  return {
    insult,
    praise: Boolean(praise),
    reason: insult ? '明确辱骂' : praise?.reason ?? ''
  };
}
