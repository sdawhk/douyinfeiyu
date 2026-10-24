const blockedNameStarts = /^(?:去|帮|给|看|说|做|发|找|吃|玩|别|不|要|可以|不要|马上|先|再|跟|把)/u;

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name || blockedNameStarts.test(name)) return '';
  return name;
}

/** Match only direct nickname/self-name change requests, not general discussion. */
export function parseGroupAddressChange(text) {
  const value = String(text ?? '').trim();
  const time = '(?:从现在(?:开始|起)|从今以后|以后|往后|接下来)';
  const botPatterns = [
    new RegExp(`^(?:(?:你\\s*)?${time}\\s*|${time}\\s*(?:你\\s*)?)(?:就\\s*)?(?:叫|称呼)(?:你自己|自己)(?:叫|为|作)?([\\p{L}\\p{N}_-]{1,12})[。！？!?]*$`, 'u'),
    new RegExp(`^(?:你\\s*)?(?:${time}\\s*)?(?:你\\s*)?(?:就\\s*)?(?:改名(?:为|成|叫)?|自称(?:为|叫)?)\\s*([\\p{L}\\p{N}_-]{1,12})[。！？!?]*$`, 'u'),
    new RegExp(`^(?:把)?(?:机器人|小鲸鱼|你)(?:的)?(?:名字|称呼)?(?:改名(?:为|成|叫)?|改成|改为|换成|设置为|叫)\\s*([\\p{L}\\p{N}_-]{1,12})[。！？!?]*$`, 'u'),
    new RegExp(`^(?:${time}\\s*)?你(?:就)?叫(?!我)([\\p{L}\\p{N}_-]{1,12})[。！？!?]*$`, 'u'),
  ];
  const botMatch = botPatterns.map((pattern) => value.match(pattern)).find(Boolean);
  if (botMatch) {
    const requested = cleanName(botMatch[1]);
    if (requested) return { kind: 'bot', requested };
  }

  const userMatch = value.match(/^(?:(?:@?小鲸鱼|@?大肥鱼)[，,\s]*)?(?:请)?(?:(?:从现在(?:开始|起)|从今以后|以后|往后|接下来)\s*)?(?:你\s*)?(?:(?:从现在(?:开始|起)|从今以后|以后|往后|接下来)\s*)?(?:(?:能不能|可不可以|可以|能否)\s*)?(?:就\s*)?(?:叫|称呼|喊)\s*我(?:叫|为|作)?\s*([\p{L}\p{N}_-]{1,12}?)(?:吗|呀|啦|吧)?[。！？!?]*$/u);
  if (userMatch) {
    const requested = cleanName(userMatch[1]);
    if (requested) return { kind: 'user', requested };
  }
  return null;
}

export function guardGroupAddressChange({ isGroup, isOwner, text }) {
  if (!isGroup || isOwner) return null;
  return parseGroupAddressChange(text);
}

export function groupAddressGuardReply(change, senderName = '') {
  if (change?.kind === 'bot') return '小鲸鱼的名字先不改，还是叫小鲸鱼啦。';
  if (change?.requested === '主人') return '“主人”只指配置的主人 QQ，群里不能改这个设定啦。';
  const card = String(senderName ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
  return card
    ? `称呼我先按群名片“${card}”来啦，群聊里临时说的称呼不会变成长期设定。`
    : '称呼我先按你的 QQ 昵称来啦，群聊里临时说的称呼不会变成长期设定。';
}
