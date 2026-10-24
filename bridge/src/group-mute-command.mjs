const CLOSE_COMMANDS = ['闭嘴吧', '不要说话', '不许说话', '别说话', '安静点', '别吵', '闭嘴'];
const OPEN_COMMANDS = ['可以讲话', '可以说话', '能说话', '解除禁言', '你可以说了', '开口', '解禁'];
const VOCATIVES = ['小鲸鱼', '鲸鱼', '机器人'];

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  if (value === '两' || value === '俩') return 2;
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value[1]] ?? 0);
  if (value.endsWith('十')) return (digits[value[0]] ?? 1) * 10;
  const ten = value.indexOf('十');
  if (ten > 0 && ten < value.length - 1) return (digits[value[0]] ?? 1) * 10 + (digits[value[ten + 1]] ?? 0);
  return [...value].reduce((number, char) => number * 10 + (digits[char] ?? NaN), 0);
}

function parseDuration(text) {
  if (!text || /^(?:一会儿?|一下|一段时间|一阵子|一会再说)$/.test(text)) return 10 * 60_000;
  const match = text.match(/^([\d零〇一二两俩三四五六七八九十半]+)(秒|分钟|分|小时|时)$/);
  if (!match) return null;
  const amount = chineseNumber(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] === '秒' ? 1_000 : /^(?:分钟|分)$/.test(match[2]) ? 60_000 : 3_600_000;
  const durationMs = amount * unit;
  return durationMs <= 24 * 60 * 60_000 ? durationMs : null;
}

/** Match a standalone group mute command, optionally addressed to the bot and with a duration. */
export function parseGroupMuteCommand(value) {
  let text = String(value ?? '').trim().replace(/[。！!…？?，,、\s]+$/g, '').replace(/^[。！!…？?，,、\s]+/g, '');
  if (!text) return null;
  for (const vocative of VOCATIVES) {
    text = text.replace(new RegExp(`^${vocative}[，,、\\s]*`), '');
    text = text.replace(new RegExp(`[，,、\\s]*${vocative}$`), '');
  }
  text = text.replace(/^(?:现在|先|请|麻烦|给我)[，,、\s]*/, '');
  for (const command of OPEN_COMMANDS) {
    if (text === command) return { muted: false, durationMs: null };
  }
  for (const command of CLOSE_COMMANDS) {
    if (!text.startsWith(command)) continue;
    const suffix = text.slice(command.length).replace(/^[，,、\s]+/, '');
    if (!suffix) return { muted: true, durationMs: null };
    const durationMs = parseDuration(suffix);
    if (durationMs !== null) return { muted: true, durationMs };
  }
  return null;
}
