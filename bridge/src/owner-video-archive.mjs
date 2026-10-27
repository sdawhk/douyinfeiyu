import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.VIDEO_LIBRARY_ROOT || 'D:\\deepseek\\videos';
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function videoExtension(contentType, url) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'video/webm') return '.webm';
  if (mime === 'video/quicktime') return '.mov';
  const pathExt = new URL(url).pathname.toLowerCase().match(/\.(?:mp4|mov|webm|mkv)$/)?.[0];
  return pathExt || '.mp4';
}

/** Archive a video segment only after the caller has verified its sender is an owner. */
export async function archiveOwnerVideo({ url, file } = {}) {
  const source = [url, file].find((value) => /^https?:\/\//i.test(String(value || '')));
  if (!source) return { status: 'skipped', reason: 'OneBot did not provide a video URL' };
  let parsed;
  try { parsed = new URL(source); }
  catch { return { status: 'skipped', reason: 'invalid video URL' }; }
  if (!['https:', 'http:'].includes(parsed.protocol) || /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(parsed.hostname)) {
    return { status: 'skipped', reason: 'video URL is not a public HTTP address' };
  }

  const response = await fetch(parsed, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) return { status: 'skipped', reason: `video download HTTP ${response.status}` };
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.startsWith('video/')
      && !contentType.startsWith('application/octet-stream')) {
    await response.body.cancel();
    return { status: 'skipped', reason: `unexpected video content type: ${contentType}` };
  }
  if (Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES) {
    await response.body.cancel();
    return { status: 'skipped', reason: 'video exceeds 100 MB' };
  }

  await mkdir(ROOT, { recursive: true });
  const temporary = join(ROOT, `.incoming-${randomUUID()}.part`);
  const output = await open(temporary, 'wx');
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0;
  let readError = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_VIDEO_BYTES) throw new Error('video exceeds 100 MB');
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await output.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error('video write stopped');
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    readError = error;
  } finally {
    await output.close();
  }
  if (readError) {
    await unlink(temporary).catch(() => {});
    throw readError;
  }

  if (!bytes) {
    await unlink(temporary).catch(() => {});
    return { status: 'skipped', reason: 'empty video' };
  }
  const digest = hash.digest('hex');
  const duplicate = readdirSync(ROOT).find((name) => name.startsWith(`${digest}.`));
  if (duplicate) {
    await unlink(temporary);
    return { status: 'duplicate', path: join(ROOT, duplicate) };
  }
  const target = join(ROOT, `${digest}${videoExtension(contentType, parsed)}`);
  await rename(temporary, target);
  return { status: 'saved', path: target, bytes };
}
