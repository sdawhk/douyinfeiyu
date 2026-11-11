// 库存图：非主人要画时不触发新生成，从已经生成过的自绘图（state/imagegen）里挑一张发出去。
//
// 挑选策略：
//   1) 先按请求里的关键词匹配 meta（描述/服装/景别/发型），命中越多越优先；
//   2) 同一张图给同一个会话发过就短期不再发（默认 7 天），避免反复发同一个人/同一个群；
//   3) 匹配不到就退化成「最久没发过的那张」。
// 去重记录落盘到 state/imagegen/stock-sends.json，重启不丢。
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_STATE_ROOT, readImageMeta } from './image-gen-meta.mjs';
import { PRIVATE_ONLY_OUTFITS } from './image-gen.mjs';

export const DEFAULT_STOCK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_STOCK_SEND_PATH = fileURLToPath(new URL('../state/imagegen/stock-sends.json', import.meta.url));

const IMAGE_FILE = /^gen-\d+-[0-9a-f]{8}\.(?:png|jpe?g|webp)$/i;
const MAX_RECORDS = 800;
const MAX_RECORD_AGE_MS = 60 * 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  '画', '一张', '图片', '照片', '帮我', '给我', '来个', '来一张', '生成', '画个', '画一张',
  '大肥鱼', '鲸小团', '小鲸鱼', '你', '我', '的', '吧', '呀', '呢', '啊', '请', '可以',
  '能不能', '可不可以', '一下', '看看', '要', '想要', '想', '那个', '这个', '现在', '主人',
  '可以吗', '好吗', '行吗', '谢谢', '麻烦'
]);

/** 从自然语言里抠关键词：中文取 2 字切片（避开命令词），字母数字整段保留。 */
export function parseStockKeywords(text) {
  const raw = String(text ?? '').toLowerCase();
  const tokens = raw.match(/[\u4e00-\u9fa5a-z0-9]+/g) || [];
  const out = [];
  const seen = new Set();
  const push = (word) => {
    if (word.length < 2 || STOPWORDS.has(word) || seen.has(word)) return;
    seen.add(word);
    out.push(word);
  };
  for (const token of tokens) {
    if (/^[a-z0-9]+$/.test(token)) {
      push(token);
      continue;
    }
    // 中文串切 2 字窗口：「画个猫娘」→ 画个 / 个猫 / 猫娘，能命中 meta 里的「猫娘」。
    for (let i = 0; i + 2 <= token.length; i += 1) push(token.slice(i, i + 2));
  }
  return out;
}

/** 关键词命中打分：描述/服装/景别/发型/标签里出现了就加分，服装精确相等再加分。 */
export function scoreStockCandidate(candidate, keywords = []) {
  if (!keywords.length) return 0;
  const outfit = String(candidate?.outfit ?? '').toLowerCase();
  const hay = [
    candidate?.description, candidate?.outfit, candidate?.framing, candidate?.hairstyle,
    ...(Array.isArray(candidate?.tags) ? candidate.tags : [])
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');
  let score = 0;
  for (const keyword of keywords) {
    if (!hay.includes(keyword)) continue;
    score += 2;
    if (outfit === keyword) score += 3;
  }
  return score;
}

/**
 * 纯选图逻辑：不碰文件系统，便于单测。
 * @returns 选中的候选（带 score/lastSentAt）或 null
 */
export function selectStockImage(candidates, {
  keywords = [], chatKey = '', sends = [], now = Date.now(),
  cooldownMs = DEFAULT_STOCK_COOLDOWN_MS, isGroup = false
} = {}) {
  const lastByChat = new Map();
  const lastByKey = new Map();
  for (const send of Array.isArray(sends) ? sends : []) {
    const key = String(send?.fileKey ?? '');
    if (!key) continue;
    const at = Number(send?.at) || 0;
    if (String(send?.chatKey ?? '') === chatKey) lastByChat.set(key, Math.max(lastByChat.get(key) || 0, at));
    lastByKey.set(key, Math.max(lastByKey.get(key) || 0, at));
  }
  const pool = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.key || !candidate?.path) continue;
    // 群里不发仅主人私聊可用的服装（泳装/睡裙）。
    if (isGroup && candidate.privateOnly) continue;
    const sentToChatAt = lastByChat.get(candidate.key) || 0;
    if (sentToChatAt && now - sentToChatAt < cooldownMs) continue;
    pool.push({
      ...candidate,
      score: scoreStockCandidate(candidate, keywords),
      lastSentAt: lastByKey.get(candidate.key) || 0
    });
  }
  if (!pool.length) return null;
  pool.sort((a, b) => b.score - a.score
    || a.lastSentAt - b.lastSentAt
    || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return pool[0];
}

/** 扫描 state/imagegen 下所有已生成的自绘图，附带同名 meta。 */
export function listStockCandidates({ root = IMAGE_STATE_ROOT } = {}) {
  const out = [];
  let days = [];
  try { days = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const day of days) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    const dir = join(root, day.name);
    let files = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !IMAGE_FILE.test(file.name)) continue;
      const path = join(dir, file.name);
      const meta = readImageMeta(path) || {};
      if (meta?.moderation?.appropriate === false) continue;
      out.push({
        key: `${day.name}/${file.name}`,
        day: day.name,
        file: file.name,
        path,
        description: String(meta.description || meta.prompt || '').trim(),
        outfit: String(meta.outfit ?? ''),
        framing: String(meta.framing ?? ''),
        hairstyle: String(meta.hairstyle ?? ''),
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        createdAt: Number(meta.createdAt) || Number(meta.createdAtMs) || 0,
        privateOnly: PRIVATE_ONLY_OUTFITS.includes(String(meta.outfit ?? ''))
      });
    }
  }
  return out;
}

export function loadStockSends(statePath = DEFAULT_STOCK_SEND_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return { version: 1, items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return { version: 1, items: [] };
  }
}

function saveStockSends(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, statePath);
}

/** 记住「这张图发过这个会话」，下次同会话挑选时避开。 */
export function recordStockSend({ fileKey, chatKey, senderId = '', at = Date.now() }, statePath = DEFAULT_STOCK_SEND_PATH) {
  if (!fileKey || !chatKey) return { added: false, reason: 'missing-args' };
  const state = loadStockSends(statePath);
  state.items.push({ fileKey: String(fileKey), chatKey: String(chatKey), senderId: String(senderId || ''), at });
  const cutoff = at - MAX_RECORD_AGE_MS;
  state.items = state.items.filter((item) => (Number(item?.at) || 0) >= cutoff).slice(-MAX_RECORDS);
  saveStockSends(statePath, state);
  return { added: true, items: state.items.length };
}

/**
 * 组合入口：列表 + 去重记录 + 选中。返回 { key, path, score, ... } 或 null。
 */
export function pickStockImageForRequest({
  request = '', chatKey = '', isGroup = false, now = Date.now(),
  root = IMAGE_STATE_ROOT, statePath = DEFAULT_STOCK_SEND_PATH,
  cooldownMs = DEFAULT_STOCK_COOLDOWN_MS
} = {}) {
  const candidates = listStockCandidates({ root });
  if (!candidates.length) return null;
  const sends = loadStockSends(statePath).items;
  return selectStockImage(candidates, {
    keywords: parseStockKeywords(request), chatKey, sends, now, cooldownMs, isGroup
  });
}
