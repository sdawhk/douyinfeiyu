import fsp from 'node:fs/promises';

const LIMITS = { identityFacts: 6, facts: 8, events: 5, corrections: 5 };
const MAX_TEXT = 240;
const OMIT_STATUS = new Set(['corrected', 'superseded', 'forgotten', 'retracted', 'expired']);

function emptyData() {
  return {
    report: {
      events: 0,
      knowledge: { hot: 0, warm: 0, cold: 0, pending: 0, superseded: 0 },
      commitments: { open: 0, fulfilled: 0, broken: 0 },
      metrics: { coldQueries: 0 },
      anchors: { confirmed: [], proposals: [] },
    },
    parts: {}, entries: [],
  };
}

function cleanText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function validItem(item, now) {
  if (typeof item === 'string') return true;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (OMIT_STATUS.has(String(item.status ?? '').toLowerCase())) return false;
  if (item.expiresAt != null && Number.isFinite(Number(item.expiresAt)) && Number(item.expiresAt) <= now) return false;
  const confidence = item.confidence;
  return confidence == null || confidence === 'confirmed'
    || (Number.isFinite(Number(confidence)) && Number(confidence) >= 0.75);
}

function mapEntries(items, category, limit, now) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => validItem(item, now)).map(item => {
    const text = cleanText(typeof item === 'string'
      ? item
      : item.content ?? item.text ?? item.summary ?? item.fact ?? '');
    if (!text || /(?:api[_ -]?key|access[_ -]?token|secret|password|密码|密钥)\s*[:=：]/i.test(text)) return null;
    const at = typeof item === 'object' && item
      ? cleanText(item.occurredAt ?? item.at ?? item.recordedAt ?? item.updatedAt).slice(0, 32)
      : '';
    return { category, text, at };
  }).filter(Boolean).slice(-limit);
}

/** Read the owner's private memory for the sole authorized cabin resident. */
export async function readOwnerMemory(ownerMemoryFile, who, residentKey, now = Date.now()) {
  if (who !== 'xiaojingyu' || residentKey !== 'xiaojingyu') {
    return { ok: false, error: 'resident_not_authorized', data: emptyData() };
  }
  if (typeof ownerMemoryFile !== 'string' || !ownerMemoryFile.trim()) {
    return { ok: false, error: 'memory_source_unconfigured', data: emptyData() };
  }
  let state;
  try {
    state = JSON.parse(await fsp.readFile(ownerMemoryFile, 'utf8'));
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? 'memory_source_missing' : 'memory_source_unavailable', data: emptyData() };
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 2) {
    return { ok: false, error: 'memory_schema_invalid', data: emptyData() };
  }
  const identity = mapEntries(state.identityFacts ?? state.identity, 'identity', LIMITS.identityFacts, now);
  const facts = mapEntries(state.facts, 'fact', LIMITS.facts, now);
  const events = mapEntries(state.events, 'event', LIMITS.events, now);
  const corrections = mapEntries(state.corrections, 'correction', LIMITS.corrections, now);
  const entries = [...identity, ...facts, ...events, ...corrections].slice(0, 24);
  const data = emptyData();
  data.entries = entries;
  data.report.events = events.length;
  data.report.knowledge.hot = facts.length + corrections.length;
  // Identity facts are displayed as entries, not as legacy approval anchors.
  return { ok: true, data };
}
