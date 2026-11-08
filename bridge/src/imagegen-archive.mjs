// 出图归档：把「真正发出去」的图连同 meta 复制进私人仓库，按月生成可读索引。
// 与日记共用同一套推送实现（diary-git.mjs），只换 commit 信息与 git add 的路径。
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pushDiaryRepo } from './diary-git.mjs';

// 单张超过 5MB 不进仓库：出图上限本来就是 5MB，超过多半是异常产物。
export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

export function monthKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function stamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function oneLine(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 提示词太长，索引里只取【画面内容】那一段，取不到再退回描述。
function promptSummary(meta) {
  const prompt = String(meta?.prompt ?? '');
  const match = prompt.match(/【画面内容[^】]*】([^；]+)/);
  return match ? match[1] : String(meta?.description ?? '');
}

function indexRow(meta, imageName, archivedAt) {
  const model = [meta.model, meta.vibe, meta.hairstyle, meta.outfit].filter(Boolean).join(' / ');
  const moderation = meta?.moderation?.appropriate === true
    ? `通过 ${Number(meta.moderation.confidence ?? 0).toFixed(2)}`
    : (meta?.moderation?.appropriate === false ? `拦截 ${Number(meta.moderation.confidence ?? 0).toFixed(2)}` : '未记录');
  return `| ${stamp(meta.createdAt ? Date.parse(meta.createdAt) : archivedAt)} | ${basename(imageName)} | ${oneLine(meta.description, 60)} | ${oneLine(promptSummary(meta), 60)} | ${oneLine(model, 70)} | ${moderation} |`;
}

function writeIndex(indexPath, month, row) {
  const header = `# ${month} 出图归档\n\n| 时间 | 图名 | 一句话描述 | 提示词摘要 | 模型 / 气质 / 发型 / 服装 | 审核 |\n| --- | --- | --- | --- | --- | --- |\n`;
  const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : header;
  const body = current && current.includes('| 时间 |') ? current : header;
  if (body.includes(row)) return false;
  writeFileSync(indexPath, `${body.trimEnd()}\n${row}\n`);
  return true;
}

/**
 * 归档一张已投递的图；没有 delivery.messageId、图不存在、超限一律跳过。
 * 返回 { ok, skipped?, reason?, month?, image?, meta?, indexUpdated? }。
 */
export function archiveDeliveredImage({ metaPath, repoDir, subdir = 'images', now = Date.now(), maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  if (!repoDir) return { ok: false, skipped: true, reason: 'no-repo' };
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { ok: false, skipped: true, reason: 'meta-unreadable' };
  }
  const messageId = String(meta?.delivery?.messageId ?? '').trim();
  if (!messageId) return { ok: false, skipped: true, reason: 'not-delivered' };
  const source = String(meta.path || '');
  if (!source || !existsSync(source)) return { ok: false, skipped: true, reason: 'image-missing' };
  const bytes = statSync(source).size;
  if (bytes > maxBytes) return { ok: false, skipped: true, reason: 'too-large', bytes };

  const month = monthKey(meta.createdAt ? Date.parse(meta.createdAt) : now);
  const dir = join(repoDir, subdir, month);
  const imageName = basename(source);
  const metaName = `${imageName.replace(/\.[^.]+$/, '')}.json`;
  const relativeImage = `${subdir}/${month}/${imageName}`;
  if (meta.archive?.file === relativeImage && existsSync(join(dir, imageName))) {
    return { ok: true, skipped: true, reason: 'already-archived', month, image: relativeImage };
  }

  mkdirSync(dir, { recursive: true });
  copyFileSync(source, join(dir, imageName));
  const archivedMeta = {
    ...meta,
    archive: {
      schemaVersion: 1,
      file: relativeImage,
      meta: `${subdir}/${month}/${metaName}`,
      messageId,
      archivedAt: now
    }
  };
  writeFileSync(join(dir, metaName), JSON.stringify(archivedMeta, null, 2));
  // 回写原 meta 的归档标记，重复投递时不会重复复制。
  try { writeFileSync(metaPath, JSON.stringify(archivedMeta, null, 2)); } catch { /* 原 meta 只读也不影响仓库归档 */ }
  const indexUpdated = writeIndex(join(dir, 'index.md'), month, indexRow(meta, imageName, now));
  return { ok: true, month, image: relativeImage, meta: `${subdir}/${month}/${metaName}`, indexUpdated };
}

/**
 * 归档后异步推送：防抖合并多次出图，失败退避重试，全程不阻塞出图主流程。
 * 推送复用 pushDiaryRepo（含代理直连重试），并按仓库与日记推送串行。
 */
export function createArchivePusher({
  repoDir, subdir = 'images', debounceMs = 120_000, retryMs = 600_000, maxAttempts = 3,
  log = () => {}, push = pushDiaryRepo, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now
} = {}) {
  let timer = null;
  let running = false;
  let attempts = 0;

  function schedule(delayMs = debounceMs) {
    if (!repoDir) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      runPush();
    }, delayMs);
    timer?.unref?.();
  }

  async function runPush() {
    if (!repoDir || running) return { ok: false, reason: 'busy' };
    running = true;
    try {
      const month = monthKey(now());
      const result = await push({ dir: repoDir, dayKey: month, commitMessage: `images: ${month}`, paths: [subdir], log });
      if (result.ok) {
        attempts = 0;
        if (!result.skipped) log(`[image-archive] pushed ${subdir}/${month}${result.viaBypass ? ' (proxy bypass)' : ''}`);
      } else {
        attempts += 1;
        log(`[image-archive] push failed(${attempts}/${maxAttempts}) ${result.reason}: ${String(result.detail ?? '').slice(0, 160)}`);
        if (attempts < maxAttempts) schedule(retryMs);
      }
      return result;
    } catch (error) {
      attempts += 1;
      log(`[image-archive] push failed(${attempts}/${maxAttempts}): ${String(error?.message ?? error).slice(0, 160)}`);
      if (attempts < maxAttempts) schedule(retryMs);
      return { ok: false, reason: 'threw' };
    } finally {
      running = false;
    }
  }

  return { schedule, runPush };
}
