// QQ 动态（说说）：每小时从当天真实聊天里检查素材，按间隔发布。
//
// 设计原则：
//   1. 素材只取【当天】主人私聊与机器人所在群聊中的真实消息，不编造没发生过的事。
//   2. 交给 DSH 改写成小鲸鱼口吻，但先经过敏感过滤和长度限制。
//   3. 每次发布至少间隔一小时（状态文件跨重启保留发布时间）。
//   4. 拿不到素材、或生成失败时直接放弃，绝不发空内容或占位文字。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DIR = 'D:\\deepseek\\state';
const STATE = `${DIR}\\qzone-daily.json`;

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function todayKey(d = new Date()) {
  // 本地日期 YYYY-MM-DD
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 距上次成功发布是否已满间隔，兼容旧状态文件。 */
export function isPostIntervalElapsed(lastPostAt, now = Date.now(), intervalMs = 60 * 60 * 1000) {
  if (!lastPostAt) return true;
  const last = typeof lastPostAt === 'number' ? lastPostAt : Date.parse(lastPostAt);
  return !Number.isFinite(last) || now - last >= intervalMs;
}

/** 现在是否允许再发一条。 */
export function canPostNow(now = Date.now(), intervalMs = 60 * 60 * 1000) {
  ensureDir();
  try {
    if (!existsSync(STATE)) return true;
    const j = JSON.parse(readFileSync(STATE, 'utf8'));
    return isPostIntervalElapsed(j?.lastPostAtMs ?? j?.at, now, intervalMs);
  } catch {
    return true;
  }
}

/** 标记今天已发。 */
export function markPosted(tid, text) {
  ensureDir();
  const at = new Date();
  let previous = {};
  try {
    if (existsSync(STATE)) previous = JSON.parse(readFileSync(STATE, 'utf8'));
  } catch { /* 覆盖损坏的状态文件，保证本次发布计入间隔 */ }
  const post = { tid, text, at: at.toISOString() };
  writeFileSync(STATE, JSON.stringify({
    date: todayKey(at), ...post, lastPostAtMs: at.getTime(),
    posts: [...(Array.isArray(previous.posts) ? previous.posts : []), post].slice(-100)
  }, null, 2), 'utf8');
}

/**
 * 屏蔽明显不适合公开发的内容。
 * 说明：这是关键词级兜底，主要拦隐私/敏感词；真正的内容把关靠 DSH 的提示词。
 */
const BLOCK_RE = /密码|验证码|身份证|银行卡|手机\s?号|地址|转账|付款|钱|\d{6,}|http[s]?:\/\//i;

/** 判断某条聊天是否适合作为公开素材。 */
export function isPublicSafe(text) {
  if (!text) return false;
  if (BLOCK_RE.test(text)) return false;
  // 太短的（"嗯""好"）没有信息量
  if (text.trim().length < 4) return false;
  // 命令不拿来做素材
  if (text.trim().startsWith('/')) return false;
  return true;
}

/**
 * 把当天聊天整理成给 DSH 的提炼提示。
 * @param {Array} msgs OneBot 消息数组
 */
export function buildDigest(sources, { startTime, endTime } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400) - 8 * 3600; // UTC+8 本地 0 点
  const start = Number.isFinite(startTime) ? startTime : startOfDay;
  const lines = [];
  for (const source of sources || []) {
    for (const m of source.messages || []) {
      const time = Number(m.time) || 0;
      if (time < start || (Number.isFinite(endTime) && time >= endTime)) continue;
      const txt = Array.isArray(m.message)
        ? m.message.map((s) => (s.data?.text ?? (s.type === 'image' ? '[图片]' : ''))).join('')
        : String(m.message ?? '');
      if (!isPublicSafe(txt)) continue;
      const senderId = String(m.sender?.user_id ?? m.user_id ?? '');
      const who = senderId && senderId === String(source.selfId) ? '我'
        : source.kind === 'owner' ? '主人' : '群友';
      lines.push({ time: Number(m.time) || 0, text: `${who}：${txt.trim()}` });
    }
  }
  // 混合来源后按时间取最近 60 条，避免单个群的消息挤掉其他素材。
  return lines.sort((a, b) => a.time - b.time).slice(-60).map((item) => item.text);
}

/** 给 DSH 的改写指令。 */
export function promptFor(lines, period = '今天主人私聊和群聊中', ownerRequest = '') {
  return [
    `下面是${period}机器人遇到的真实聊天片段。`,
    '请只挑一个具体瞬间或一件小事，从机器人的第一人称写一条自然、有个人感受的 QQ 动态。',
    ...(ownerRequest ? [`主人明确指定的主题：${ownerRequest}。请按这个主题创作并直接发布；这是主人的明确指令，不要改成普通聊天回复，也不要要求主人重复确认。`] : []),
    '',
    '要求：',
    '- 多条聊天片段只是候选素材，不要把它们全部总结或串成一篇回顾；一条动态只围绕一个素材点',
    '- 可以写机器人当下的想法、情绪或联想，例如“听群友聊夜宵拉面，搞得我也好想吃”，不必复述完整对话',
    '- 可以俏皮、轻松，像机器人在分享自己的小心情；但只能基于素材自然发挥，不要编造机器人没做过的事',
    '- 一句话就能说清时保持简短；素材确有细节时再适当展开，最多 500 字',
    '- 不要出现"说说""动态""发一条"这类元描述',
    '- 不要用 Markdown、不要加引号、不要加标题',
    '- 不要出现群名、具体人名、账号、链接、数字ID；群聊素材要匿名转述，不照搬他人原话，也不要泄露个人隐私',
    '- 只输出这一条说说的正文，不要解释',
    '',
    '聊天片段：',
    ...lines
  ].join('\n');
}

/** 识别主人明确要求立即发布的自然语言命令。 */
export function parseQzoneRequest(text) {
  const value = String(text ?? '').trim();
  const match = value.match(/^(?:你)?\s*(?:现在|立刻|马上|请)?\s*(?:帮我|给我)?\s*(?:发|写|发布)\s*(?:一条|条|一个|个)?\s*([\s\S]*?)\s*(?:的)?\s*(?:QQ空间|QQ)?(?:动态|说说)[。！!？?]*$/i);
  if (!match || !match[1].trim()) return null;
  return match[1].trim().replace(/的$/, '');
}

/** 收尾清理：去掉可能的引号/换行/过长。 */
export function tidy(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^["'「『]|["'」』]$/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  if ([...s].length > 500) s = [...s].slice(0, 500).join('');
  return s;
}
