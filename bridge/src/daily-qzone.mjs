// 每日 QQ 动态（说说）：从当天真实聊天里提炼内容，生成一条说说。
//
// 设计原则：
//   1. 素材只取【当天】和【主人】的真实聊天，不编造没发生过的事。
//   2. 交给 DSH 改写成小鲸鱼口吻，但先经过敏感过滤和长度限制。
//   3. 每天只发一条（用状态文件记录日期，重启/重复触发也不会刷屏）。
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

/** 今天是否已经发过。 */
export function alreadyPostedToday() {
  ensureDir();
  try {
    if (!existsSync(STATE)) return false;
    const j = JSON.parse(readFileSync(STATE, 'utf8'));
    return j?.date === todayKey();
  } catch {
    return false;
  }
}

/** 标记今天已发。 */
export function markPosted(tid, text) {
  ensureDir();
  writeFileSync(STATE, JSON.stringify({
    date: todayKey(), tid, text, at: new Date().toISOString()
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
export function buildDigest(msgs) {
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400) - 8 * 3600; // 粗略按本地 0 点（UTC+8）
  const lines = [];
  for (const m of msgs) {
    if (m.time < startOfDay) continue;
    const txt = Array.isArray(m.message)
      ? m.message.map((s) => (s.data?.text ?? (s.type === 'image' ? '[图片]' : ''))).join('')
      : String(m.message ?? '');
    if (!isPublicSafe(txt)) continue;
    const who = m.sender?.nickname ?? '?';
    lines.push(`${who}：${txt.trim()}`);
  }
  // 最多取最近 40 条，避免 prompt 过长
  return lines.slice(-40);
}

/** 给 DSH 的改写指令。 */
export function promptFor(lines) {
  return [
    '下面是今天我和主人（Komorebi）在 QQ 上的真实聊天片段。',
    '请从中挑一件有意思的事，用"我"的第一人称写成一条 QQ 说说。',
    '',
    '要求：',
    '- 只写真实发生过的事，不要编造',
    '- 口语化、简短，不超过 60 字',
    '- 不要出现"说说""动态""发一条"这类元描述',
    '- 不要用 Markdown、不要加引号、不要加标题',
    '- 不要出现具体人名、账号、链接、数字ID',
    '- 只输出这一条说说的正文，不要解释',
    '',
    '聊天片段：',
    ...lines
  ].join('\n');
}

/** 收尾清理：去掉可能的引号/换行/过长。 */
export function tidy(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^["'「『]|["'」』]$/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}
