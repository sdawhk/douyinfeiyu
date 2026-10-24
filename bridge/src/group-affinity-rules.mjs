const INSULTS = [
  /(?:傻逼|傻屄|傻笔|傻币|沙比|煞笔|煞逼|傻比|傻b|shabi)/i,
  /(?:脑残|脑can|脑惨|弱智|智障|蠢货|蠢蛋|废物|垃圾机器人)/i,
  /(?:去死|滚蛋|滚开|狗东西|狗屎|操你妈|草泥马|曹尼玛|你妈的|他妈的)/i
];

export function normalizeForInsultCheck(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

export function isExplicitInsult(text) {
  const normalized = normalizeForInsultCheck(text);
  return normalized.length > 0 && (INSULTS.some((pattern) => pattern.test(normalized))
    || /\b(?:sb|nmsl|cnm)\b/i.test(String(text ?? '')));
}
