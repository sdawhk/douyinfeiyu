import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'song-delivery-journal.json');
const MAX_PER_CHAT = 12;
const MAX_DETAIL = 180;

export function createSongDeliveryJournal({ filePath = DEFAULT_PATH, now = () => Date.now() } = {}) {
  const records = new Map();
  try {
    const loaded = JSON.parse(readFileSync(filePath, 'utf8'));
    for (const [key, entries] of Object.entries(loaded)) {
      if (/^[gp]\d{1,20}$/.test(key) && Array.isArray(entries)) {
        records.set(key, entries.filter((entry) => entry && Number.isFinite(entry.at)
          && ['sent', 'failed', 'uncertain', 'partial'].includes(entry.status)).slice(-MAX_PER_CHAT));
      }
    }
  } catch { /* An absent or invalid journal starts empty. */ }

  function persist() {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(Object.fromEntries(records)));
    renameSync(tempPath, filePath);
  }

  return {
    record({ chatKey, title, mode = 'cover', status, seconds = null, detail = '' }) {
      const key = String(chatKey ?? '');
      if (!/^[gp]\d{1,20}$/.test(key) || !['sent', 'failed', 'uncertain', 'partial'].includes(status)) return false;
      const entries = records.get(key) ?? [];
      entries.push({ title: String(title ?? '未命名歌曲').slice(0, 120), mode: String(mode).slice(0, 24), status,
        seconds: Number.isFinite(Number(seconds)) ? Number(seconds) : null,
        detail: String(detail ?? '').slice(0, MAX_DETAIL), at: now() });
      records.set(key, entries.slice(-MAX_PER_CHAT));
      try { persist(); } catch { /* In-memory truth remains available if disk is temporarily unavailable. */ }
      return true;
    },
    recent(chatKey, { limit = 4, withinMs = 24 * 60 * 60_000 } = {}) {
      const cutoff = now() - withinMs;
      return (records.get(String(chatKey ?? '')) ?? []).filter((entry) => entry.at <= now() && entry.at >= cutoff).slice(-limit);
    }
  };
}

export const songDeliveryJournal = createSongDeliveryJournal();
