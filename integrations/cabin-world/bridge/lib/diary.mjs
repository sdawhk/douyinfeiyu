import fsp from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 86400000;
const MAX_DAYS = 30, MAX_ROW_CHARS = 1200, MAX_TOTAL_CHARS = 12000;

// Read-only import for the xiaojingyu diary panel. Missing/unreadable files are skipped.
export async function readDiaryRows(dir, now = Date.now()) {
  if (!dir) return [];
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const rows = [];
  for (let age = 0; age < MAX_DAYS; age++) {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) - age * DAY_MS).toISOString().slice(0, 10);
    let markdown;
    try { markdown = await fsp.readFile(path.join(dir, `${day}.md`), 'utf8'); } catch { continue; }
    const text = markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '')
      .split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !/^#{1,2}\s*\d{4}-\d{2}-\d{2}\s*$/.test(line))
      .map(line => line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').replace(/\s+/g, ' '))
      .join('\n').trim();
    if (text) rows.push({ day, text: text.length > MAX_ROW_CHARS ? text.slice(0, MAX_ROW_CHARS - 1) + '…' : text });
  }
  let size = 0;
  return rows.filter(row => {
    if (size >= MAX_TOTAL_CHARS) return false;
    const remaining = MAX_TOTAL_CHARS - size;
    if (row.text.length > remaining) row.text = row.text.slice(0, Math.max(0, remaining - 1)) + '…';
    size += row.text.length;
    return Boolean(row.text);
  });
}

export function createDiaryReader(dir, now = Date.now, ttlMs = 30000) {
  let cachedAt = 0, cached = [];
  return async () => {
    const current = now();
    if (current - cachedAt < ttlMs) return cached;
    try { cached = await readDiaryRows(dir, current); } catch { cached = []; }
    cachedAt = current;
    return cached;
  };
}
