import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const IMAGE_ROOT = process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images';
const ANALYSIS_PATH = process.env.IMAGE_ANALYSIS_PATH || 'D:\\deepseek\\state\\image-analysis.json';

function readAll() {
  try {
    const value = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf8'));
    return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writeAll(value) {
  mkdirSync(dirname(ANALYSIS_PATH), { recursive: true });
  const temp = `${ANALYSIS_PATH}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  try { renameSync(temp, ANALYSIS_PATH); }
  catch (error) { try { unlinkSync(temp); } catch { /* temporary file may be gone */ } throw error; }
}

export function readImageAnalyses() {
  return readAll();
}

export function saveImageAnalysis(ref, analysis) {
  if (!/^[a-f0-9]{16}\.(?:jpg|jpeg|png|gif|webp)$/i.test(String(ref))) return false;
  const index = readAll();
  const tags = [...new Set((Array.isArray(analysis.tags) ? analysis.tags : [])
    .map((tag) => String(tag ?? '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 32))
    .filter(Boolean))].slice(0, 8);
  index[ref] = {
    kind: String(analysis.kind || '其他').trim().slice(0, 24),
    appropriate: typeof analysis.appropriate === 'boolean' ? analysis.appropriate : null,
    sexualSuggestive: analysis.sexualSuggestive === true,
    grossOrGraphic: analysis.grossOrGraphic === true,
    safetyReason: String(analysis.safetyReason || '').trim().slice(0, 120),
    isPhoto: typeof analysis.isPhoto === 'boolean' ? analysis.isPhoto : null,
    valuable: typeof analysis.valuable === 'boolean' ? analysis.valuable : null,
    valueReason: String(analysis.valueReason || '').trim().slice(0, 120),
    tags,
    caption: String(analysis.caption || '').trim().slice(0, 600),
    duplicate: typeof analysis.duplicate === 'boolean' ? analysis.duplicate : null,
    duplicateOf: analysis.duplicateOf ? String(analysis.duplicateOf).slice(0, 120) : null,
    duplicateReason: String(analysis.duplicateReason || '').trim().slice(0, 120),
    duplicateConfidence: Math.max(0, Math.min(1, Number(analysis.duplicateConfidence) || 0)),
    exactDuplicate: analysis.exactDuplicate === true,
    duplicateHits: Math.max(0, Math.trunc(Number(analysis.duplicateHits) || 0)),
    confidence: Math.max(0, Math.min(1, Number(analysis.confidence) || 0)),
    model: String(analysis.model || '').slice(0, 100),
    classifiedAt: new Date().toISOString()
  };
  writeAll(index);
  return true;
}

function bigrams(value) {
  const text = String(value ?? '').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu, '');
  const chars = [...text];
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  if (chars.length === 1) out.add(chars[0]);
  return out;
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const item of left) if (right.has(item)) common++;
  return common / (left.size + right.size - common);
}

/** Retrieve only a few semantically close, previously analyzed images for the AI to compare. */
export function findImageDuplicateCandidates(current, excludeRef, limit = 3) {
  const index = readAll();
  const currentTags = new Set((current.tags || []).map((tag) => String(tag).toLocaleLowerCase('zh-CN')));
  const currentWords = bigrams(`${current.caption || ''} ${(current.tags || []).join(' ')}`);
  const candidates = [];
  for (const [ref, analysis] of Object.entries(index)) {
    if (!/^[a-f0-9]{16}\.(?:jpg|jpeg|png|gif|webp)$/i.test(ref) || ref === excludeRef || !analysis?.caption) continue;
    const tagSet = new Set((analysis.tags || []).map((tag) => String(tag).toLocaleLowerCase('zh-CN')));
    const tagScore = overlap(currentTags, tagSet);
    const textScore = overlap(currentWords, bigrams(`${analysis.caption} ${(analysis.tags || []).join(' ')}`));
    const sameKind = current.kind && analysis.kind === current.kind;
    const score = textScore * 0.75 + tagScore * 0.2 + (sameKind ? 0.05 : 0);
    if (score < 0.025 && !sameKind) continue;
    const matching = [];
    try {
      for (const day of requireDays()) {
        const candidatePath = join(IMAGE_ROOT, day, ref);
        if (existsSync(candidatePath)) matching.push({ day, path: candidatePath });
      }
    } catch { /* a missing image is not a usable comparison candidate */ }
    if (!matching.length) continue;
    matching.sort((a, b) => b.day.localeCompare(a.day));
    candidates.push({
      ref,
      day: matching[0].day,
      path: matching[0].path,
      kind: String(analysis.kind || '其他'),
      caption: String(analysis.caption || '').slice(0, 240),
      tags: Array.isArray(analysis.tags) ? analysis.tags.slice(0, 6) : [],
      classifiedAt: String(analysis.classifiedAt || ''),
      score
    });
  }
  return candidates.sort((a, b) => b.score - a.score
    || String(b.classifiedAt).localeCompare(String(a.classifiedAt))).slice(0, limit);
}

function requireDays() {
  return readdirSync(IMAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name);
}
