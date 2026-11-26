import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function loadDouyinVideoMemory(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return { sent: Array.isArray(value.sent) ? value.sent : [], feedback: Array.isArray(value.feedback) ? value.feedback : [], preferences: Array.isArray(value.preferences) ? value.preferences : [] };
  } catch { return { sent: [], feedback: [], preferences: [] }; }
}

export function resolveDouyinFeedbackOwner(sessionKey, ownerIds) {
  const ownerId = String(sessionKey ?? '').match(/^private:(\d{5,20})$/)?.[1] || '';
  return ownerId && [...ownerIds].map(String).includes(ownerId) ? ownerId : '';
}

function save(file, memory) {
  mkdirSync(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(memory, null, 2), 'utf8');
    renameSync(temporaryFile, file);
  } catch (error) {
    try { unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}

export function recordDouyinVideoSends(file, memory, records) {
  const batchId = randomUUID();
  let ordinal = 0;
  for (const item of records) {
    if (!item?.messageId || !item?.url) continue;
    const id = String(item.url).match(/\/video\/(\d+)/)?.[1] || String(item.awemeId || '');
    if (!id) continue;
    memory.sent = memory.sent.filter((entry) => String(entry.videoId) !== id);
    memory.sent.push({ videoId: id, url: item.url, title: String(item.title || '').slice(0, 160), author: String(item.author || '').slice(0, 80), messageId: String(item.messageId), batchId, batchIndex: ++ordinal, at: Date.now() });
  }
  memory.sent = memory.sent.slice(-500);
  save(file, memory);
}

export function recordDouyinVideoFeedback(file, memory, { messageId, sentiment, preference }) {
  const target = memory.sent.find((entry) => String(entry.messageId) === String(messageId));
  if (!target || !['like', 'dislike'].includes(sentiment)) return { ok: false, reason: 'video-message-not-found' };
  target.sentiment = sentiment;
  target.feedbackAt = Date.now();
  const text = String(preference || '').trim().slice(0, 240);
  if (text) {
    memory.preferences = memory.preferences.filter((entry) => !(entry.sentiment === sentiment && entry.text === text));
    memory.preferences.push({ sentiment, text, at: Date.now() });
    memory.preferences = memory.preferences.slice(-100);
  }
  memory.feedback.push({ videoId: target.videoId, messageId: target.messageId, sentiment, preference: text, at: Date.now() });
  memory.feedback = memory.feedback.slice(-500);
  save(file, memory);
  return { ok: true, videoId: target.videoId, sentiment };
}

export function filterRankDouyinCandidates(candidates, memory, query = '') {
  const excluded = new Set(memory.sent.filter((entry) => entry.sentiment === 'dislike').map((entry) => String(entry.videoId)));
  const sent = new Set(memory.sent.map((entry) => String(entry.videoId)));
  const tokens = (value) => {
    const text = String(value || '').toLowerCase();
    const words = text.match(/[a-z0-9]{2,}/g) || [];
    const cjk = text.match(/[\u3400-\u9fff]+/g) || [];
    for (const run of cjk) {
      if (run.length === 1) words.push(run);
      for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
    }
    return words;
  };
  const liked = memory.preferences.filter((item) => item.sentiment === 'like').flatMap((item) => tokens(item.text));
  const disliked = memory.preferences.filter((item) => item.sentiment === 'dislike').flatMap((item) => tokens(item.text));
  const queryTokens = new Set(tokens(query));
  return candidates.filter((item) => {
    const id = String(item.url || '').match(/\/video\/(\d+)/)?.[1] || String(item.awemeId || '');
    return id && !sent.has(id) && !excluded.has(id);
  }).map((item) => {
    const haystack = new Set(tokens(`${item.title || ''} ${item.author || ''}`));
    const positiveMatches = liked.filter((token) => haystack.has(token)).length;
    const negativeMatches = disliked.filter((token) => haystack.has(token)).length;
    const queryMatches = tokens(query).filter((token) => haystack.has(token) && queryTokens.has(token)).length;
    return { ...item, preferenceScore: positiveMatches + queryMatches - negativeMatches * 2, negativeMatches };
  }).filter((item) => item.negativeMatches < 2).sort((a, b) => b.preferenceScore - a.preferenceScore);
}

export function douyinPreferencesForPrompt(memory) {
  return memory.preferences.slice(-30).map(({ sentiment, text }) => `${sentiment === 'like' ? '喜欢' : '不喜欢'}：${text}`).join('\n');
}
