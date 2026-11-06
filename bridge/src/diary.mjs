// 日记模块（P0 v2）：随手记多条、文件读写、格式校验、命令解析、素材打分。
// 只做数据层，不调用模型、不发消息，便于离线单测。

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDayKey } from './daily-task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// bridge/src -> bridge -> repo -> deepseek/diary
export const DEFAULT_DIARY_DIR = path.resolve(HERE, '..', '..', '..', 'diary');
export const DIARY_ENTRY_MAX_CHARS = 200;
export const DIARY_ENTRY_MIN_CHARS = 20;
export const DIARY_DAY_MAX_BYTES = 12 * 1024;
export const DIARY_MAX_ENTRIES_PER_DAY = 8;
export const DIARY_AUTO_MAX_ENTRIES = 6;
export const DIARY_MIN_GAP_MS = 90 * 60_000;
export const DIARY_INJECTION_MAX_CHARS = 450;
export const DIARY_MAX_INPUT_TOKENS_PER_DAY = 250_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /(?:https?:\/\/|www\.)[^\s）)]*/gi;
const AT_RE = /(?:@[A-Za-z0-9_\u4e00-\u9fa5-]{2,}|\[at:[^\]]+\])/gi;
const LONG_DIGITS_RE = /\d{5,}/g;
const WEATHER_RE = /(?:天气|气温|降雨|下雨|下雪|晴天|阴天|多云|雷阵雨|大风|雾霾|摄氏度)/;
const GROUP_RE = /(?:群友|群里|群聊|QQ群|微信群)/;
const CONTROL_RE = /\[\s*(?:SILENT|SKIP|STICKER)\s*\]/i;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function weekdayCn(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return WEEKDAYS[new Date(year, month - 1, day).getDay()];
}

export function isDiaryDayKey(value) {
  return DAY_RE.test(String(value ?? ''));
}

export function isDiaryTime(value) {
  return TIME_RE.test(String(value ?? ''));
}

export function diaryFilePath(dir, dayKey) {
  if (!isDiaryDayKey(dayKey)) throw new Error(`invalid diary day key: ${dayKey}`);
  return path.join(dir, `${dayKey}.md`);
}

export function ensureDiaryDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 脱敏：去掉链接、@、长数字；尽量保留正文语义。 */
export function redactDiaryText(value) {
  return String(value ?? '')
    .replace(URL_RE, '（链接已略）')
    .replace(AT_RE, '')
    .replace(LONG_DIGITS_RE, '（数字已略）')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeForCompare(value) {
  return String(value ?? '')
    .replace(/[\s\u3000，。！？、；：,.!?;:'"“”‘’（）()《》〈〉【】[\]…—\-]/g, '')
    .trim();
}

function trigrams(value) {
  const set = new Set();
  const text = value ?? '';
  for (let index = 0; index <= text.length - 3; index += 1) set.add(text.slice(index, index + 3));
  return set;
}

function longestCommonLength(a, b) {
  if (!a || !b) return 0;
  const left = a.length > 300 ? a.slice(0, 300) : a;
  const right = b.length > 300 ? b.slice(0, 300) : b;
  let best = 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** 文本相似度：3-gram Jaccard 与最长公共子串长度。 */
export function textSimilarity(a, b) {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) return { jaccard: 0, common: 0 };
  const leftSet = trigrams(left);
  const rightSet = trigrams(right);
  let shared = 0;
  for (const item of leftSet) if (rightSet.has(item)) shared += 1;
  const union = leftSet.size + rightSet.size - shared;
  return { jaccard: union > 0 ? shared / union : 1, common: longestCommonLength(left, right) };
}

export function isDiaryDuplicate(text, existingTexts = []) {
  const normalized = normalizeForCompare(text);
  if (!normalized) return true;
  for (const candidate of existingTexts) {
    const other = normalizeForCompare(candidate);
    if (!other) continue;
    if (other === normalized || other.includes(normalized) || normalized.includes(other)) return true;
    const { jaccard, common } = textSimilarity(text, candidate);
    if (jaccard >= 0.5 || common >= 12) return true;
  }
  return false;
}

/**
 * 校验一条短记。返回空字符串表示通过。
 * @param {object} options
 * @param {string} options.dayKey 目标日期
 * @param {string[]} options.sourcePhrases 当天聊天原句，用于拒绝逐句复述
 * @param {string[]} options.existingEntries 当天已写条目
 * @param {number} options.minChars 最小字数（手动补记可放宽）
 */
export function diaryEntryIssue(text, {
  dayKey, sourcePhrases = [], existingEntries = [], minChars = DIARY_ENTRY_MIN_CHARS
} = {}) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return 'empty';
  const chars = [...body].length;
  if (chars < minChars) return 'too-short';
  if (chars > DIARY_ENTRY_MAX_CHARS) return 'too-long';
  if (/^#{1,6}\s/m.test(body)) return 'has-heading';
  if (WEATHER_RE.test(body)) return 'weather-mentioned';
  if (GROUP_RE.test(body)) return 'group-mentioned';
  if (/https?:\/\/|www\./i.test(body)) return 'link-leaked';
  AT_RE.lastIndex = 0;
  if (AT_RE.test(body)) return 'at-leaked';
  AT_RE.lastIndex = 0;
  if (/\d{5,}/.test(body)) return 'long-number-leaked';
  if (CONTROL_RE.test(body)) return 'control-marker';
  if (!isDiaryDayKey(dayKey)) return 'bad-day';
  const normalized = body.replace(/\s+/g, '');
  for (const phrase of Array.isArray(sourcePhrases) ? sourcePhrases : []) {
    const clean = String(phrase ?? '').replace(/\s+/g, '').trim();
    if (clean.length >= 12 && normalized.includes(clean)) return 'quoted-chat';
  }
  if (isDiaryDuplicate(body, existingEntries)) return 'duplicate';
  return '';
}

function splitDiaryDocument(doc) {
  const lines = String(doc ?? '').replace(/\r\n/g, '\n').split('\n');
  let header = '';
  if (lines.length && /^#\s+\S/.test(lines[0])) header = lines.shift().trim();
  const prefix = [];
  const entries = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^## (\d{2}:\d{2})\s*$/);
    if (match && isDiaryTime(match[1])) {
      current = { time: match[1], lines: [] };
      entries.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else prefix.push(line);
  }
  return { header, prefix, entries };
}

function buildDiaryDocument({ dayKey, header, prefix, entries }) {
  const parts = [header || `# ${dayKey} ${weekdayCn(dayKey)}`];
  const prefixText = prefix.join('\n').trim();
  if (prefixText) parts.push(prefixText);
  for (const entry of entries) {
    parts.push(`## ${entry.time}\n${entry.lines.join('\n').trim()}`);
  }
  return `${parts.join('\n\n').trim()}\n`;
}

function readDiaryText(dir, dayKey) {
  const file = diaryFilePath(dir, dayKey);
  if (!existsSync(file)) return { file, text: '' };
  return { file, text: readFileSync(file, 'utf8') };
}

/** 读取某天的日记条目；旧版“三小节”文档返回 legacy:true 且 entries 为空。 */
export function readDiaryEntries(dir, dayKey) {
  if (!isDiaryDayKey(dayKey)) return { dayKey, file: '', text: '', entries: [], legacy: false };
  const { file, text } = readDiaryText(dir, dayKey);
  if (!text.trim()) return { dayKey, file, text: '', entries: [], legacy: false };
  const split = splitDiaryDocument(text);
  const entries = split.entries.map((entry) => {
    const body = entry.lines.join('\n').trim();
    const mood = body.match(/心情[：:]\s*([^\n]+)/)?.[1]?.trim() ?? '';
    return { time: entry.time, text: body, mood, chars: [...body].length };
  });
  return { dayKey, file, text, entries, legacy: entries.length === 0 };
}

/**
 * 追加一条短记到当天文件。
 * 同分钟同内容跳过；同分钟不同内容并入同一小节；新时间按 HH:MM 排序。
 */
export function appendDiaryEntry({
  dir, dayKey, time, text, now = new Date(), maxEntries = DIARY_MAX_ENTRIES_PER_DAY
}) {
  if (!isDiaryDayKey(dayKey)) throw new Error(`invalid diary day key: ${dayKey}`);
  if (!isDiaryTime(time)) throw new Error(`invalid diary time: ${time}`);
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return { written: false, reason: 'empty' };
  const file = diaryFilePath(dir, dayKey);
  const existingText = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const split = splitDiaryDocument(existingText);
  const entries = split.entries.map((entry) => ({ time: entry.time, lines: [...entry.lines] }));
  const same = entries.find((entry) => entry.time === time);
  const normalized = normalizeForCompare(body);
  if (same) {
    const current = same.lines.join('\n').trim();
    if (normalizeForCompare(current) === normalized
        || normalizeForCompare(current).includes(normalized)
        || normalized.includes(normalizeForCompare(current))) {
      return { written: false, reason: 'duplicate', file };
    }
    const merged = `${current}\n\n${body}`;
    if ([...merged].length > DIARY_ENTRY_MAX_CHARS * 2) return { written: false, reason: 'too-long', file };
    same.lines = merged.split('\n');
  } else {
    if (entries.length >= maxEntries) return { written: false, reason: 'day-full', file };
    entries.push({ time, lines: body.split('\n') });
    entries.sort((a, b) => (a.time === b.time ? 0 : (a.time < b.time ? -1 : 1)));
  }
  const document = buildDiaryDocument({
    dayKey, header: split.header, prefix: split.prefix, entries
  });
  const bytes = Buffer.byteLength(document, 'utf8');
  if (bytes > DIARY_DAY_MAX_BYTES) return { written: false, reason: 'day-full', file };
  ensureDiaryDir(dir);
  const tmp = `${file}.${process.pid}.${now.getTime()}.tmp`;
  try {
    writeFileSync(tmp, document, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 临时文件清理失败不影响主流程 */ }
    throw error;
  }
  return { written: true, file, bytes, time };
}

export function readDiaryEntry(dir, dayKey) {
  if (!isDiaryDayKey(dayKey)) return null;
  const file = diaryFilePath(dir, dayKey);
  if (!existsSync(file)) return null;
  return { dayKey, file, text: readFileSync(file, 'utf8') };
}

export function listDiaryDayKeys(dir, { limit = 0 } = {}) {
  if (!existsSync(dir)) return [];
  const keys = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .reverse();
  return limit > 0 ? keys.slice(0, limit) : keys;
}

/** 提取标题、心情、正文摘要，供旧版文档和列表命令使用。 */
export function summarizeDiaryText(text, { excerptChars = 120 } = {}) {
  const raw = String(text ?? '');
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  const mood = raw.match(/心情[：:]\s*([^\n]+)/)?.[1]?.trim() ?? '';
  const body = raw
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s/.test(line) && !/^心情[：:]/.test(line) && !/^>\s*心情/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const excerpt = excerptChars > 0 ? [...body].slice(0, excerptChars).join('') : '';
  return { title, mood, excerpt };
}

function entryExcerpt(entry, chars) {
  const body = entry.text.replace(/^心情[：:][^\n]*\n?/, '').replace(/\s+/g, ' ').trim();
  return chars > 0 ? [...body].slice(0, chars).join('') : '';
}

/**
 * 私聊提示词里的“我的日记”块：今天最近 2 条 + 昨天最后 1 条，总量 ≤450 字。
 * 没写过时也返回自我认知，便于模型知道自己有写日记的习惯。
 */
export function diaryInjectionText({ dir = DEFAULT_DIARY_DIR, now = new Date() } = {}) {
  const today = localDayKey(now);
  const yesterday = localDayKey(new Date(now.getTime() - 24 * 60 * 60_000));
  const todayEntries = readDiaryEntries(dir, today);
  const yesterdayEntries = readDiaryEntries(dir, yesterday);
  const intro = `【我的日记】我习惯想到就记一笔，日记存在 ${dir}，不发给别人，只有我自己和爸能看。`;
  const tail = '这是我自己写的日记，聊到日记时可以据此回答；没写过就说没写，不要编。要看更多或全文时，由命令层读取文件回答。';

  let todayList = todayEntries.entries.slice(-2);
  if (!todayList.length && todayEntries.legacy) {
    const summary = summarizeDiaryText(todayEntries.text, { excerptChars: 60 });
    if (summary.excerpt) todayList = [{ time: '', text: summary.excerpt, mood: summary.mood, legacy: true }];
  }
  let yesterdayList = yesterdayEntries.entries.slice(-1);
  if (!yesterdayList.length && yesterdayEntries.legacy) {
    const summary = summarizeDiaryText(yesterdayEntries.text, { excerptChars: 60 });
    if (summary.excerpt) yesterdayList = [{ time: '', text: summary.excerpt, mood: summary.mood, legacy: true }];
  }

  const levels = [
    { today: 2, yesterday: 1, chars: 60 },
    { today: 2, yesterday: 1, chars: 40 },
    { today: 2, yesterday: 0, chars: 40 },
    { today: 1, yesterday: 0, chars: 40 },
    { today: 1, yesterday: 0, chars: 0 }
  ];
  for (const level of levels) {
    const lines = [];
    const pickedToday = todayList.slice(-level.today);
    if (pickedToday.length) {
      lines.push('今天已经记过：');
      for (const entry of pickedToday) {
        const head = entry.time ? `${entry.time}` : today;
        const mood = entry.mood ? `${entry.mood}｜` : '';
        const excerpt = level.chars > 0 ? entryExcerpt(entry, level.chars) : '';
        lines.push(`- ${head} ${mood}${excerpt}`.trim());
      }
    } else {
      lines.push('今天还没记。');
    }
    const pickedYesterday = yesterdayList.slice(-level.yesterday);
    if (pickedYesterday.length) {
      lines.push('昨天最后一笔：');
      for (const entry of pickedYesterday) {
        const head = entry.time ? `${yesterday} ${entry.time}` : yesterday;
        const mood = entry.mood ? `${entry.mood}｜` : '';
        const excerpt = level.chars > 0 ? entryExcerpt(entry, level.chars) : '';
        lines.push(`- ${head} ${mood}${excerpt}`.trim());
      }
    }
    const text = `${intro}\n${lines.join('\n')}\n${tail}`;
    if ([...text].length <= DIARY_INJECTION_MAX_CHARS) return text;
  }
  return `${intro}\n今天还没记。\n${tail}`;
}

/** 日记命令的权限/场景拦截；返回空字符串表示允许。 */
export function diaryCommandDenial({ isGroup = false, isOwner = false } = {}) {
  if (!isOwner) return '这个命令只有主人能用。';
  if (isGroup) return '日记只在私聊里看，群里就不念了。';
  return '';
}

export function parseDiaryCommand(value) {
  const t = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const manual = t.match(/^(?:记一下|记一笔)(?:\s+([\s\S]+))?$/);
  if (manual) return { kind: 'write', note: String(manual[1] ?? '').trim() };
  if (/^(?:日记|看日记|今天的日记|今日日记)$/.test(t)) return { kind: 'today' };
  if (/^昨天的日记$/.test(t)) return { kind: 'day', dayKey: 'yesterday' };
  if (/^日记 昨天$/.test(t)) return { kind: 'day', dayKey: 'yesterday' };
  if (/^昨天的日记 全文$/.test(t)) return { kind: 'full', dayKey: 'yesterday' };
  if (/^日记 全文$/.test(t)) return { kind: 'full' };
  if (/^日记 全文 昨天$/.test(t)) return { kind: 'full', dayKey: 'yesterday' };
  const fullDate = t.match(/^日记 全文 (\d{4}-\d{2}-\d{2})$/);
  if (fullDate && isDiaryDayKey(fullDate[1])) return { kind: 'full', dayKey: fullDate[1] };
  const date = t.match(/^日记 (\d{4}-\d{2}-\d{2})$/);
  if (date && isDiaryDayKey(date[1])) return { kind: 'day', dayKey: date[1] };
  const recent = t.match(/^日记 ?最近 ?(\d{1,2}) ?条$/);
  if (recent) return { kind: 'recent', count: Math.max(1, Math.min(20, Number(recent[1]))) };
  if (/^(?:日记列表|日记 列表|这个月写了什么|日记 清单)$/.test(t)) return { kind: 'list' };
  return null;
}

function resolveDayKey(value, now) {
  if (value === 'yesterday') return localDayKey(new Date(now.getTime() - 24 * 60 * 60_000));
  return isDiaryDayKey(value) ? value : localDayKey(now);
}

function formatEntryBlock(entry) {
  return `## ${entry.time}\n${entry.text}`;
}

function recentDiaryEntries(dir, count) {
  const out = [];
  for (const dayKey of listDiaryDayKeys(dir)) {
    const { entries, legacy, text } = readDiaryEntries(dir, dayKey);
    if (legacy) {
      const summary = summarizeDiaryText(text, { excerptChars: 60 });
      out.push({ dayKey, time: '', mood: summary.mood, excerpt: summary.excerpt });
    } else {
      for (const entry of entries.slice().reverse()) {
        out.push({ dayKey, time: entry.time, mood: entry.mood, excerpt: entryExcerpt(entry, 60) });
        if (out.length >= count) return out;
      }
      continue;
    }
    if (out.length >= count) return out;
  }
  return out.slice(0, count);
}

/** 读日记命令的确定性回复，不经过模型。 */
export function formatDiaryReply(command, { dir = DEFAULT_DIARY_DIR, now = new Date() } = {}) {
  if (!command) return '';
  if (command.kind === 'list') {
    const days = listDiaryDayKeys(dir, { limit: 14 });
    if (!days.length) return '还没写过日记。';
    const lines = days.map((dayKey) => {
      const { entries, legacy } = readDiaryEntries(dir, dayKey);
      return `- ${dayKey}｜${legacy ? '1 篇' : `${entries.length} 条`}`;
    });
    return `最近写过的日记：\n${lines.join('\n')}`;
  }
  if (command.kind === 'recent') {
    const entries = recentDiaryEntries(dir, command.count ?? 5);
    if (!entries.length) return '还没写过日记。';
    return `最近 ${entries.length} 条：\n${entries.map((item) => `- ${item.dayKey}${item.time ? ` ${item.time}` : ''}${item.mood ? `｜${item.mood}` : ''}${item.excerpt ? `｜${item.excerpt}` : ''}`).join('\n')}`;
  }
  const dayKey = command.kind === 'today' ? localDayKey(now) : resolveDayKey(command.dayKey, now);
  const { text, entries, legacy, file } = readDiaryEntries(dir, dayKey);
  if (!text.trim()) {
    if (command.kind === 'today') return '今天还没写日记，想到就记，不用等到晚上。';
    return `${dayKey} 那天没有日记。`;
  }
  if (command.kind === 'full') return text.trim();
  if (legacy) {
    const summary = summarizeDiaryText(text, { excerptChars: 300 });
    const head = [summary.title, summary.mood ? `心情：${summary.mood}` : ''].filter(Boolean).join('｜');
    return `${head}\n\n${summary.excerpt}${summary.excerpt.length >= 300 ? '…' : ''}\n\n完整版：${file}`;
  }
  const shown = command.kind === 'today' && entries.length > 5 ? entries.slice(-5) : entries;
  const rest = command.kind === 'today' && entries.length > 5
    ? `\n\n还有 ${entries.length - 5} 条，发“日记 全文”看全部。` : '';
  return `${shown.map(formatEntryBlock).join('\n\n')}${rest}`;
}

/** 23:30 兜底：仅当天 0 条且当天还没兜底过时触发。 */
export function diaryTailDue({ tailTime = '23:30', now = new Date(), dayKey, entryCount = 0, tailDoneDate = '' } = {}) {
  if (!isDiaryTime(tailTime)) return false;
  if (!isDiaryDayKey(dayKey) || tailDoneDate === dayKey || entryCount > 0) return false;
  const [hour, minute] = tailTime.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
}

/**
 * 素材打分：返回 score / reasons，阈值 2。
 * 只做纯计算，事件触发与兜底扫描共用。
 */
export function scoreDiaryMaterial({
  facts = {}, now = new Date(), lastEntryAt = 0, todayEntries = 0, affinityChanged = false, chatTurns = 0
} = {}) {
  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    if (points <= 0) return;
    score += points;
    reasons.push(reason);
  };
  if (Number(facts.songSentCount) > 0) add(2, 'song');
  if (Number(facts.douyinCount) > 0) add(Math.min(3, Number(facts.douyinCount)), 'douyin');
  if (Math.max(Number(facts.chat?.count) || 0, Number(chatTurns) || 0) >= 6) add(2, 'chat');
  if (affinityChanged) add(1, 'affinity');
  const gap = lastEntryAt > 0 ? now.getTime() - lastEntryAt : Number.POSITIVE_INFINITY;
  if (gap >= 3 * 60 * 60_000 && facts.hasFacts) add(1, 'gap');
  if (now.getHours() * 60 + now.getMinutes() >= 22 * 60 + 30 && todayEntries < 2) add(1, 'late');
  return { score, reasons, qualified: score >= 2 };
}

/** 状态迁移：v1 的 lastSuccessDate/pendingDate 等字段忽略，统一成 v2。 */
export function normalizeDiaryState(raw = {}, now = new Date()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const dayKey = (value) => (isDiaryDayKey(value) ? String(value) : '');
  const used = source.used && typeof source.used === 'object' ? source.used : {};
  return {
    version: 2,
    dayKey: dayKey(source.dayKey) || localDayKey(now),
    entries: Array.isArray(source.entries)
      ? source.entries.filter((item) => item && isDiaryTime(item.time)).map((item) => ({
        time: item.time, chars: Math.max(0, Number(item.chars) || 0)
      })).slice(-20)
      : [],
    lastEntryAt: Math.max(0, Number(source.lastEntryAt) || 0),
    autoCount: Math.max(0, Number(source.autoCount) || 0),
    chatTurns: Math.max(0, Number(source.chatTurns) || 0),
    lastScanAt: Math.max(0, Number(source.lastScanAt) || 0),
    lastAttemptAt: Math.max(0, Number(source.lastAttemptAt) || 0),
    lastError: typeof source.lastError === 'string' ? source.lastError.slice(0, 200) : '',
    lastFile: typeof source.lastFile === 'string' ? source.lastFile : '',
    tailDoneDate: dayKey(source.tailDoneDate),
    affinityBaseline: Number.isFinite(Number(source.affinityBaseline)) ? Number(source.affinityBaseline) : null,
    tokenBudgetDate: dayKey(source.tokenBudgetDate),
    inputTokensToday: Math.max(0, Number(source.inputTokensToday) || 0),
    skipped: Math.max(0, Number(source.skipped) || 0),
    used: {
      douyinAt: Math.max(0, Number(used.douyinAt) || 0),
      songAt: Math.max(0, Number(used.songAt) || 0),
      chatAt: Math.max(0, Number(used.chatAt) || 0)
    }
  };
}

// ── 只读查阅日记（给模型的工具）：路径白名单、主人私聊限定、单次 ≤800 字 ──
export const DIARY_TOOL_MAX_CHARS = 800;
export const DIARY_TOOL_MAX_RECENT = 10;
export const DEFAULT_DIARY_AUDIT_PATH = path.resolve(HERE, '..', '..', '..', 'state', 'diary-read-audit.jsonl');

/** 只读日记工具的权限拦截；返回空字符串表示允许。 */
export function diaryToolDenial({ isGroup = false, isOwner = false, channel = 'qq' } = {}) {
  if (channel !== 'qq') return '日记只能在主人 QQ 私聊里查看。';
  if (!isOwner) return '日记只有主人能查看。';
  if (isGroup) return '日记只在主人私聊里查看，群聊不提供。';
  return '';
}

/** 只允许 dir 下的 YYYY-MM-DD.md；日期不合法或越界时返回 null。 */
export function diaryToolFilePath(dir, dayKey) {
  if (!isDiaryDayKey(dayKey)) return null;
  const root = path.resolve(dir);
  const file = path.resolve(root, `${dayKey}.md`);
  return path.dirname(file) === root ? file : null;
}

function truncateWithNote(text, max = DIARY_TOOL_MAX_CHARS) {
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false, total: chars.length };
  const note = `\n……（已截断，共 ${chars.length} 字；可以按日期分段查看）`;
  const keep = Math.max(0, max - [...note].length);
  return { text: chars.slice(0, keep).join('') + note, truncated: true, total: chars.length };
}

function auditDiaryRead({ auditPath, qq, dayKey, mode, now }) {
  if (!auditPath) return;
  try {
    mkdirSync(path.dirname(auditPath), { recursive: true });
    writeFileSync(auditPath, `${JSON.stringify({
      at: now.toISOString(), qq: String(qq ?? ''), dayKey: String(dayKey ?? ''), mode: String(mode ?? '')
    })}\n`, { encoding: 'utf8', flag: 'a' });
  } catch { /* 审计失败不影响只读查询 */ }
}

/**
 * 只读查阅日记。只返回日记正文，不写入任何上下文历史。
 * @returns {{ok:true,text:string,truncated:boolean,total:number,dayKey:string}|{ok:false,error:string}}
 */
export function readDiaryForTool({
  dir = DEFAULT_DIARY_DIR, dayKey, mode = 'day', count = 5, now = new Date(),
  isGroup = false, isOwner = false, channel = 'qq', qq = '', auditPath = DEFAULT_DIARY_AUDIT_PATH
} = {}) {
  const denial = diaryToolDenial({ isGroup, isOwner, channel });
  if (denial) return { ok: false, error: denial };
  if (!['day', 'full', 'recent'].includes(mode)) {
    return { ok: false, error: '查看方式只支持 day、full 或 recent。' };
  }
  const rawDay = String(dayKey ?? '').trim();
  if (rawDay && !isDiaryDayKey(rawDay)) return { ok: false, error: '日期格式不对，只支持 YYYY-MM-DD。' };
  const targetDay = rawDay || localDayKey(now);
  if (mode === 'recent') {
    const limit = Math.max(1, Math.min(DIARY_TOOL_MAX_RECENT, Number(count) || 5));
    const entries = recentDiaryEntries(dir, limit);
    auditDiaryRead({ auditPath, qq, dayKey: '', mode, now });
    if (!entries.length) return { ok: true, text: '还没写过日记。', truncated: false, total: 0, dayKey: '' };
    const text = `最近 ${entries.length} 条：\n${entries.map((item) => `- ${item.dayKey}${item.time ? ` ${item.time}` : ''}｜${item.excerpt}`).join('\n')}`;
    const out = truncateWithNote(text);
    return { ok: true, text: out.text, truncated: out.truncated, total: out.total, dayKey: '' };
  }
  const file = diaryToolFilePath(dir, targetDay);
  if (!file) return { ok: false, error: '日期格式不对，只支持 YYYY-MM-DD。' };
  const { text, entries, legacy } = readDiaryEntries(dir, targetDay);
  auditDiaryRead({ auditPath, qq, dayKey: targetDay, mode, now });
  if (!text.trim()) return { ok: true, text: `${targetDay} 那天没有日记。`, truncated: false, total: 0, dayKey: targetDay };
  if (mode === 'full') {
    const out = truncateWithNote(text.trim());
    return { ok: true, text: out.text, truncated: out.truncated, total: out.total, dayKey: targetDay };
  }
  if (legacy) {
    const summary = summarizeDiaryText(text, { excerptChars: 300 });
    const body = summary.excerpt ? `${summary.excerpt}${summary.excerpt.length >= 300 ? '…' : ''}` : text.trim();
    const out = truncateWithNote(`${targetDay}\n\n${body}`);
    return { ok: true, text: out.text, truncated: out.truncated, total: out.total, dayKey: targetDay };
  }
  const body = entries.map(formatEntryBlock).join('\n\n');
  const out = truncateWithNote(`${targetDay} ${weekdayCn(targetDay)}（${entries.length} 条）\n\n${body}`);
  return { ok: true, text: out.text, truncated: out.truncated, total: out.total, dayKey: targetDay };
}
