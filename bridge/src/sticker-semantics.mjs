import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SEMANTICS_PATH = 'D:\\deepseek\\stickers\\semantics.json';

export function readStickerSemantics(file = SEMANTICS_PATH) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

export function setStickerSemantics(ref, classification, file = SEMANTICS_PATH) {
  if (!/^[a-f0-9]{16}\.(?:png|jpg|jpeg|gif|webp)$/i.test(ref)) throw new Error('invalid sticker reference');
  const current = readStickerSemantics(file);
  const previous = current[ref];
  if (previous?.overridden && !classification.overridden) return previous;
  const next = {
    deepseek: classification.deepseek === true,
    confidence: Math.max(0, Math.min(1, Number(classification.confidence) || 0)),
    action: String(classification.action || '').trim().slice(0, 24),
    emotion: String(classification.emotion || '').trim().slice(0, 24),
    caption: String(classification.caption || '').trim().slice(0, 300),
    model: String(classification.model || '').slice(0, 100),
    classifiedAt: new Date().toISOString(),
    overridden: classification.overridden === true
  };
  current[ref] = next;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(current, null, 2), 'utf8');
  try { renameSync(temp, file); }
  catch (error) { if (existsSync(temp)) unlinkSync(temp); throw error; }
  return next;
}

export function deepSeekStickerCatalog(records, semantics) {
  const seen = new Set();
  return Object.entries(records).flatMap(([key, record]) => {
    const ref = record?.ref;
    const info = semantics[ref];
    if (!ref || seen.has(ref) || info?.deepseek !== true || info.confidence < 0.65) return [];
    seen.add(ref);
    return [{ key, ref, action: info.action || key, emotion: info.emotion || '', caption: info.caption || '' }];
  });
}

export function parseDeepSeekStickerRequest(value) {
  const text = String(value ?? '').trim();
  if (/^(?:\/表情|表情)\s*(?:deepseek|深度求索|小鲸鱼|ds)$/i.test(text)) return { count: 1 };
  if (/(?:别|不要|不许|禁止|没让|为什么|为何|先|然后|顺便|讲个|说个|回答|解释|评价)/.test(text)) return null;
  if (!/(?:deepseek|深度求索|小鲸鱼|ds)/i.test(text)
      || !/(?:表情包?|贴纸|梗图)/.test(text)
      || !/(?:发|来|整|给|想要|求|看看)/.test(text)) return null;
  const quantity = text.match(/([1-3一二三])\s*(?:张|个)/)?.[1];
  const numbers = { 一: 1, 二: 2, 三: 3 };
  const count = quantity ? (numbers[quantity] || Number(quantity))
    : /(?:一些|几张|几个|一组|来点|来些|发点|发些)/.test(text) ? 3 : 1;
  return { count };
}

export function parsePersonalStickerRequest(value) {
  const text = String(value ?? '').trim();
  if (/(?:别|不要|不许|禁止|没让|为什么|为何|先|然后|顺便|回答|解释|评价)/.test(text)) return null;
  if (!/(?:表情包|贴纸)/.test(text) || !/(?:发|来|整|给|想要|求|看看)/.test(text)) return null;
  if (/(?:deepseek|深度求索|小鲸鱼|ds)/i.test(text)) return null;
  const quantity = text.match(/([1-3一二三])\s*(?:张|个)/)?.[1];
  const numbers = { 一: 1, 二: 2, 三: 3 };
  return { count: quantity ? (numbers[quantity] || Number(quantity))
    : /(?:一些|几张|几个|一组|来点|来些|发点|发些)/.test(text) ? 3 : 1 };
}

export function selectDeepSeekStickerKeys(catalog, text, count = 1, random = Math.random) {
  const cues = String(text).match(/开心|高兴|笑|委屈|难过|哭|生气|害羞|困|发呆|无语|吃|跳|挥手|加油|可爱/gi) || [];
  return catalog.map((item) => ({
    item,
    score: cues.reduce((score, cue) => score
      + Number(`${item.key}${item.action}${item.emotion}${item.caption}`.includes(cue)), 0),
    random: random()
  })).sort((a, b) => b.score - a.score || a.random - b.random)
    .slice(0, Math.max(1, Math.min(3, count)))
    .map(({ item }) => item.key);
}
