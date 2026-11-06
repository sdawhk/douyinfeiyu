// 日记事实层：只读现有状态文件，汇总“当天真实发生的事”，不调用模型。
// 所有事实都带时间窗口 + sinceAt 过滤；群聊内容完全不采集。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outboundSourceLabel } from './owner-outbound-history.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_STATE_DIR = path.resolve(HERE, '..', 'state');

export const DEFAULT_RECENT_REPLIES_PATH = 'D:\\deepseek\\state\\recent-chat-replies.json';
export const DEFAULT_DOUYIN_MEMORY_PATH = path.join(BRIDGE_STATE_DIR, 'douyin-interest-memory.json');
export const DEFAULT_SONG_JOURNAL_PATH = path.join(BRIDGE_STATE_DIR, 'song-delivery-journal.json');

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dayWindow(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return {
    start: new Date(year, month - 1, day, 0, 0, 0, 0).getTime(),
    end: new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime()
  };
}

function inWindow(at, window, sinceAt = 0) {
  const value = Number(at);
  return Number.isFinite(value) && value >= window.start && value < window.end && value >= sinceAt;
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join('');
}

export function cleanVideoTitle(value) {
  return String(value ?? '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/\s*\d+\s*(?:秒|分钟|小时|天|周|个月|年)前\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 收集指定日期、指定时间点之后的真实素材。
 * @param {object} options
 * @param {string} options.dayKey 目标日期 YYYY-MM-DD
 * @param {string} options.ownerId 主人 QQ
 * @param {number} options.sinceAt 只取这个时间戳之后的素材；0 表示整天的素材
 */
export function collectDiaryFacts({
  dayKey,
  ownerId,
  sinceAt = 0,
  recentRepliesPath = DEFAULT_RECENT_REPLIES_PATH,
  douyinMemoryPath = DEFAULT_DOUYIN_MEMORY_PATH,
  songJournalPath = DEFAULT_SONG_JOURNAL_PATH
} = {}) {
  const window = dayWindow(dayKey);
  const key = `p${ownerId}`;
  const cut = Math.max(0, Number(sinceAt) || 0);
  const facts = {
    dayKey,
    chat: { lines: [], count: 0, updatedAt: 0 },
    outbound: [],
    outboundLastAt: 0,
    douyin: [],
    douyinCount: 0,
    douyinLastAt: 0,
    songs: [],
    songCount: 0,
    songSentCount: 0,
    songLastAt: 0,
    hasFacts: false
  };

  const replies = readJson(recentRepliesPath);
  const record = replies?.[key];
  if (record && inWindow(record.at, window, cut)) {
    const exchanges = Array.isArray(record.exchanges) ? record.exchanges.slice(-4) : [];
    facts.chat.lines = exchanges.map((item) => ({
      input: clip(item?.input, 120),
      reply: clip(item?.reply, 120)
    })).filter((item) => item.input || item.reply);
    facts.chat.count = facts.chat.lines.length;
    facts.chat.updatedAt = Number(record.at) || 0;
  }
  if (record) {
    // 主动消息按自己的时间戳过滤：即使当天没有聊天，主动问候也要能进日记素材。
    facts.outbound = (Array.isArray(record.outbound) ? record.outbound : [])
      .filter((item) => item && inWindow(item.at, window, cut))
      .slice(-6)
      .map((item) => ({
        at: Number(item.at),
        label: outboundSourceLabel(item.source),
        text: clip(item.text, 120)
      }));
    facts.outboundLastAt = facts.outbound.reduce((max, item) => Math.max(max, item.at), 0);
  }

  const douyin = readJson(douyinMemoryPath);
  const videos = Array.isArray(douyin?.watchedVideos) ? douyin.watchedVideos : [];
  const douyinHits = videos
    .map((item) => ({ item, at: new Date(item?.observedAt ?? 0).getTime() }))
    .filter(({ item, at }) => item && inWindow(at, window, cut))
    .sort((a, b) => a.at - b.at);
  facts.douyin = douyinHits
    .slice(-6)
    .map(({ item }) => ({
      title: clip(cleanVideoTitle(item.title), 50),
      summary: clip(item.contentSummary, 140)
    }))
    .filter((item) => item.title || item.summary);
  facts.douyinCount = douyinHits.length;
  facts.douyinLastAt = douyinHits.reduce((max, { at }) => Math.max(max, at), 0);

  const journal = readJson(songJournalPath);
  const songs = Array.isArray(journal?.[key]) ? journal[key] : [];
  const songHits = songs
    .filter((item) => item && inWindow(item.at, window, cut))
    .sort((a, b) => Number(a.at) - Number(b.at));
  const seen = new Set();
  facts.songs = songHits
    .filter((item) => {
      const title = clip(item.title, 40);
      if (!title || seen.has(title)) return false;
      seen.add(title);
      return true;
    })
    .slice(-6)
    .map((item) => ({
      title: clip(item.title, 40),
      status: item.status === 'sent' ? '已发出' : item.status === 'failed' ? '没发成' : clip(item.status, 10) || '处理过'
    }));
  facts.songCount = songHits.length;
  facts.songSentCount = songHits.filter((item) => item.status === 'sent').length;
  facts.songLastAt = songHits.reduce((max, item) => Math.max(max, Number(item.at) || 0), 0);

  facts.hasFacts = facts.chat.lines.length > 0 || facts.outbound.length > 0
    || facts.douyin.length > 0 || facts.songs.length > 0;
  return facts;
}

/** 交给模型的“事实清单”文本；没有素材时明确写“没有”。 */
export function factsToPromptText(facts) {
  const lines = [];
  if (facts.chat?.lines?.length) {
    lines.push('【和爸的真实聊天】');
    for (const item of facts.chat.lines) {
      const parts = [];
      if (item.input) parts.push(`爸说：${item.input}`);
      if (item.reply) parts.push(`我回：${item.reply}`);
      lines.push(`- ${parts.join('；')}`);
    }
  }
  if (facts.outbound?.length) {
    lines.push('【我主动发给爸的消息】');
    for (const item of facts.outbound) {
      lines.push(`- ${item.label}：${item.text}`);
    }
  }
  if (facts.douyin?.length) {
    lines.push('【刷到的抖音内容】');
    for (const item of facts.douyin) {
      const title = item.title ? `《${item.title}》` : '一个视频';
      lines.push(`- ${title}${item.summary ? `：${item.summary}` : ''}`);
    }
  }
  if (facts.songs?.length) {
    lines.push('【唱过的歌】');
    for (const item of facts.songs) {
      lines.push(`- 《${item.title}》（${item.status}）`);
    }
  }
  return lines.length ? lines.join('\n') : '- 这段时间没有可用的真实记录。';
}

/** 当天聊天原句（去空白），用于拒绝逐句复述。 */
export function collectSourcePhrases(facts) {
  const phrases = [];
  for (const item of facts.chat?.lines ?? []) {
    if (item.input) phrases.push(item.input);
    if (item.reply) phrases.push(item.reply);
  }
  return phrases;
}
