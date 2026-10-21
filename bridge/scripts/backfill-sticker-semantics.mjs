import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { listStickerRecords, getStickerPath } from '../src/sticker-store.mjs';
import { readStickerSemantics, setStickerSemantics } from '../src/sticker-semantics.mjs';
import { inspectStickerImage } from '../src/sticker-vision.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch { /* Original bytes remain available as a fallback. */ }
const existing = readStickerSemantics();
const seen = new Set();
const queue = Object.entries(listStickerRecords()).flatMap(([key, record]) => {
  if (!record?.ref || seen.has(record.ref) || existing[record.ref]) return [];
  seen.add(record.ref);
  const path = getStickerPath(key);
  return path ? [{ key, ref: record.ref, path, mime: record.mime || 'image/jpeg' }] : [];
});
let next = 0;
let saved = 0;
let failed = 0;
let deepseek = 0;

async function worker() {
  while (next < queue.length) {
    const item = queue[next++];
    try {
      const bytes = sharp
        ? await sharp(item.path, { animated: false }).rotate()
          .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer()
        : readFileSync(item.path);
      const mime = sharp ? 'image/jpeg' : item.mime;
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await inspectStickerImage(bytes.toString('base64'), mime, {
            models: cfg.stickerVisionModels, baseUrl: cfg.stickerVisionBaseUrl
          });
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          const delay = /HTTP 503/.test(String(error?.message)) ? 65_000 : attempt * 5_000;
          console.log(`retrying ${item.key} after ${Math.round(delay / 1000)}s (${error?.message ?? error})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (result.deepseek === null) throw new Error('vision response omitted DeepSeek classification');
      setStickerSemantics(item.ref, result);
      saved++;
      if (result.deepseek && result.confidence >= 0.65) deepseek++;
      if (saved % 10 === 0) console.log(`classified ${saved}/${queue.length}; DeepSeek=${deepseek}; failed=${failed}`);
    } catch (error) {
      failed++;
      console.error(`failed ${item.key}: ${error?.message ?? error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

console.log(`Scanning ${queue.length} unclassified sticker images`);
await worker();
console.log(JSON.stringify({ scanned: queue.length, saved, deepseek, failed }));
if (failed) process.exitCode = 1;
