// Keep real owner IDs out of group messages. The bot account is not a human owner.
export function protectedOwnerQQs(config = {}) {
  const configured = [...(Array.isArray(config.ownerQQs) ? config.ownerQQs : []),
    config.ownerQQ, config.dailyQzone?.ownerQQ];
  const self = String(config.selfQQ ?? '');
  return [...new Set(configured.filter((id) => id != null).map(String)
    .filter((id) => /^\d{5,20}$/.test(id) && id !== self))];
}

const CHINESE_DIGITS = { '〇': '0', '零': '0', '○': '0', '一': '1', '壹': '1', '二': '2', '贰': '2',
  '三': '3', '叁': '3', '四': '4', '肆': '4', '五': '5', '伍': '5', '六': '6', '陆': '6',
  '七': '7', '柒': '7', '八': '8', '捌': '8', '九': '9', '玖': '9' };
const DIGIT_RUN = /\d(?:[\d\s.,，、·_\-—－（）()]*\d)?/g;
const POSSIBLE_DIGIT_RUN = /[0-9０-９〇零○一壹二贰三叁四肆五伍六陆七柒八捌九玖](?:[0-9０-９〇零○一壹二贰三叁四肆五伍六陆七柒八捌九玖\s.,，、·_\-—－（）()]*[0-9０-９〇零○一壹二贰三叁四肆五伍六陆七柒八捌九玖])?/g;

function containsProtectedId(text, protectedIds) {
  const normalized = normalizeDigits(text);
  for (const run of normalized.matchAll(DIGIT_RUN)) {
    const digits = run[0].replace(/\D/g, '');
    if (protectedIds.some((id) => digits.includes(id))) return true;
  }
  return false;
}

function normalizeDigits(text) {
  return String(text ?? '').normalize('NFKC')
    .replace(/[〇零○一壹二贰三叁四肆五伍六陆七柒八捌九玖]/g, (char) => CHINESE_DIGITS[char]);
}

export function redactProtectedGroupIds(text, protectedIds = []) {
  if (!protectedIds.length) return String(text ?? '');
  return String(text ?? '').replace(POSSIBLE_DIGIT_RUN, (run) => {
    const digits = normalizeDigits(run).replace(/\D/g, '');
    return protectedIds.some((id) => digits.includes(id)) ? '[已隐藏账号]' : run;
  });
}

export function groupIdentityLeak(message, protectedIds = []) {
  if (!protectedIds.length) return false;
  if (typeof message === 'string') return containsProtectedId(message, protectedIds);
  if (!Array.isArray(message)) return false;
  return message.some((segment) => {
    if (segment?.type === 'at') return protectedIds.includes(String(segment.data?.qq ?? ''));
    return segment?.type === 'text' && containsProtectedId(segment.data?.text, protectedIds);
  });
}

export function assertGroupIdentityPrivate(message, protectedIds = []) {
  if (groupIdentityLeak(message, protectedIds)) {
    throw new Error('群消息包含受保护的主人 QQ 号，已阻止发送');
  }
}
