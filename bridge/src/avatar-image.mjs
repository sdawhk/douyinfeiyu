// 个人头像预处理：来源解析 + 魔数判型 + ffmpeg 标准化 + 备份/配额/审计。
//
// 设计约束（P0）：
//   - 只支持 archive / sticker / self / message 四类来源，不接受任意 URL；
//   - SnowLuma 的 set_qq_avatar 只校验非空，尺寸/格式/大小全部由这里把关；
//   - 模块本身不发起网络请求、不调用 OneBot：备份下载与上传都由调用方注入，
//     测试可以完全 mock，避免误触真实换头像。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSticker, findStickerByRef, getStickerPath } from './sticker-store.mjs';

const exec = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF_IMAGE_PATH = fileURLToPath(new URL('../assets/deepseek娘.png', import.meta.url));
const IMAGE_ROOT = process.env.IMAGE_LIBRARY_ROOT || 'D:\\deepseek\\images';

export const AVATAR_STATE_PATH = path.join(APP_ROOT, 'state', 'avatar-state.json');
export const AVATAR_AUDIT_PATH = path.join(APP_ROOT, 'state', 'avatar-audit.jsonl');
export const AVATAR_WORK_DIR = path.join(APP_ROOT, 'state', 'avatar-work');
export const DEFAULT_AVATAR_BACKUP_DIR = path.join(APP_ROOT, 'state', 'avatar-history');

export const AVATAR_DEFAULTS = Object.freeze({
  enabled: true,
  ownerOnly: true,
  privateOnly: true,
  requireConfirm: true,
  dailyLimit: 1,
  minIntervalMs: 21_600_000,
  inputMaxBytes: 8 * 1024 * 1024,
  outputSize: 640,
  outputMaxBytes: 1024 * 1024,
  jpegQuality: 82,
  backupDir: DEFAULT_AVATAR_BACKUP_DIR,
  keepBackups: 5,
  groupPortraitEnabled: false,
  allowedGroupIds: [],
  ffmpegPath: ''
});

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 把 config.json 的 imageAvatar 段规整成可用参数，非法值回落到默认值。 */
export function avatarOptions(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  return {
    enabled: source.enabled !== false,
    ownerOnly: source.ownerOnly !== false,
    privateOnly: source.privateOnly !== false,
    requireConfirm: source.requireConfirm !== false,
    dailyLimit: boundedNumber(source.dailyLimit, AVATAR_DEFAULTS.dailyLimit, 0, 20),
    minIntervalMs: boundedNumber(source.minIntervalMs, AVATAR_DEFAULTS.minIntervalMs, 0, 30 * 86_400_000),
    inputMaxBytes: boundedNumber(source.inputMaxBytes, AVATAR_DEFAULTS.inputMaxBytes, 256 << 10, 64 << 20),
    outputSize: boundedNumber(source.outputSize, AVATAR_DEFAULTS.outputSize, 200, 1024),
    outputMaxBytes: boundedNumber(source.outputMaxBytes, AVATAR_DEFAULTS.outputMaxBytes, 64 << 10, 8 << 20),
    jpegQuality: boundedNumber(source.jpegQuality, AVATAR_DEFAULTS.jpegQuality, 30, 95),
    backupDir: String(source.backupDir || AVATAR_DEFAULTS.backupDir),
    keepBackups: boundedNumber(source.keepBackups, AVATAR_DEFAULTS.keepBackups, 1, 30),
    groupPortraitEnabled: source.groupPortraitEnabled === true,
    allowedGroupIds: Array.isArray(source.allowedGroupIds) ? source.allowedGroupIds.map(String) : [],
    ffmpegPath: String(source.ffmpegPath || '')
  };
}

/**
 * 只允许主人私聊。群聊（group:xxx）与陌生人私聊一律拒绝。
 * 与 mcp-snowluma-safe 的 isOwnerPrivateSession 语义保持一致，单独导出便于单测。
 */
export function isAvatarSessionAllowed(key, config = {}) {
  const match = /^private:(\d+)$/.exec(String(key ?? '').trim());
  if (!match) return false;
  const owners = (Array.isArray(config.ownerQQs) && config.ownerQQs.length
    ? config.ownerQQs
    : [config.ownerQQ])
    .filter((id) => id != null && String(id).trim())
    .map(String);
  return owners.includes(match[1]);
}

function ascii(bytes, start, end) {
  return bytes.toString('ascii', start, end);
}

/**
 * 魔数判型 + 读取宽高（不解码像素）。
 * 支持 jpeg / png / gif / webp；其他格式返回 null，由调用方拒绝。
 */
export function detectImageInfo(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (bytes.length < 12) return null;

  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 24) return null;
    return {
      format: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      animated: bytes.includes(Buffer.from('acTL'))
    };
  }

  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    let gceCount = 0;
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) gceCount++;
    }
    return {
      format: 'gif',
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
      animated: gceCount >= 2 || bytes.includes(Buffer.from('NETSCAPE2.0'))
    };
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    const vp8x = bytes.indexOf(Buffer.from('VP8X'));
    if (vp8x >= 0 && bytes.length >= vp8x + 30) {
      const width = 1 + bytes.readUIntLE(vp8x + 12, 3);
      const height = 1 + bytes.readUIntLE(vp8x + 15, 3);
      return { format: 'webp', width, height, animated: bytes.includes(Buffer.from('ANMF')) };
    }
    const vp8 = bytes.indexOf(Buffer.from('VP8 '));
    if (vp8 >= 0 && bytes.length >= vp8 + 18
      && bytes[vp8 + 11] === 0x9d && bytes[vp8 + 12] === 0x01 && bytes[vp8 + 13] === 0x2a) {
      return {
        format: 'webp',
        width: bytes.readUInt16LE(vp8 + 14) & 0x3fff,
        height: bytes.readUInt16LE(vp8 + 16) & 0x3fff,
        animated: false
      };
    }
    return { format: 'webp', width: 0, height: 0, animated: bytes.includes(Buffer.from('ANMF')) };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (offset + 4 > bytes.length) break;
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
        return {
          format: 'jpeg',
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
          animated: false
        };
      }
      offset += 2 + length;
    }
    return null;
  }

  return null;
}

function jpegQualityScale(quality) {
  return Math.max(2, Math.min(31, Math.round((100 - quality) / 3)));
}

async function runFfmpeg(ffmpegPath, args, timeout) {
  await exec(ffmpegPath, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/** 把任意受支持图片标准化成正方形 JPEG（cover 裁切，动图只取首帧）。 */
export async function normalizeAvatarImage(value, options, { ffmpegPath, workRoot, timeoutMs = 20_000 } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!bytes.length) return { ok: false, reason: 'empty-input' };
  if (bytes.length > options.inputMaxBytes) return { ok: false, reason: 'input-too-large' };

  const info = detectImageInfo(bytes);
  if (!info) return { ok: false, reason: 'unsupported-format' };
  if (!ffmpegPath) return { ok: false, reason: 'ffmpeg-unavailable' };

  const roots = [workRoot, AVATAR_WORK_DIR, tmpdir()]
    .map((entry) => String(entry || '').trim()).filter(Boolean);
  let work = null;
  for (const root of roots) {
    try {
      await mkdir(root, { recursive: true });
      work = await mkdtemp(path.join(root, 'qq-avatar-'));
      break;
    } catch { /* 换下一个可写目录 */ }
  }
  if (!work) return { ok: false, reason: 'workdir-unavailable' };

  const extension = info.format === 'jpeg' ? 'jpg' : info.format;
  const input = path.join(work, `input.${extension}`);
  const target = path.join(work, 'avatar.jpg');
  const size = options.outputSize;

  try {
    await writeFile(input, bytes, { flag: 'wx' });
    // cover：先等比放大到覆盖目标框，再居中裁切；白色底用于吸收透明区域的 alpha。
    const filter = `[0:v]scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,`
      + `crop=${size}:${size}[fg];color=c=white:s=${size}x${size}[bg];`
      + '[bg][fg]overlay=format=auto[out]';
    const baseQuality = jpegQualityScale(options.jpegQuality);
    for (const quality of [baseQuality, baseQuality + 4, baseQuality + 8]) {
      await runFfmpeg(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-filter_complex', filter, '-map', '[out]',
        '-frames:v', '1', '-q:v', String(Math.min(31, quality)), target
      ], timeoutMs);
      const output = await readFile(target);
      if (!output.length) continue;
      if (output.length <= options.outputMaxBytes) {
        const outInfo = detectImageInfo(output);
        return {
          ok: true,
          b64: output.toString('base64'),
          bytes: output.length,
          width: outInfo?.width || size,
          height: outInfo?.height || size,
          mime: 'image/jpeg',
          format: info.format,
          animated: info.animated
        };
      }
    }
    return { ok: false, reason: 'output-too-large' };
  } catch {
    return { ok: false, reason: 'ffmpeg-failed' };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 读配额状态文件；不存在或损坏时按“今天还没换过”处理。 */
export async function readAvatarState(file = AVATAR_STATE_PATH) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** 只读检查：当天次数 + 最小间隔。 */
export function checkAvatarQuota(state, now, options) {
  const s = state && typeof state === 'object' ? state : {};
  const day = localDay(now);
  if (s.day !== day) return { ok: true, reason: '', remaining: options.dailyLimit };
  const count = Number(s.count) || 0;
  if (count >= options.dailyLimit) {
    return { ok: false, reason: `今天的换头像次数已用完（上限 ${options.dailyLimit} 次）。` };
  }
  const lastAt = Number(s.lastAt) || 0;
  if (lastAt && now - lastAt < options.minIntervalMs) {
    const waitMinutes = Math.ceil((options.minIntervalMs - (now - lastAt)) / 60_000);
    return { ok: false, reason: `距上次换头像还不到 ${Math.ceil(options.minIntervalMs / 60_000)} 分钟，请约 ${waitMinutes} 分钟后再试。` };
  }
  return { ok: true, reason: '', remaining: Math.max(0, options.dailyLimit - count) };
}

function nextAvatarState(state, now) {
  const s = state && typeof state === 'object' ? state : {};
  const day = localDay(now);
  const count = s.day === day ? (Number(s.count) || 0) + 1 : 1;
  return { day, count, lastAt: now };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

/** 当前头像的备份地址（公开 CDN，通常无需 Cookie）。 */
export function avatarBackupUrl(uin, size = 640) {
  return `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(String(uin))}&spec=${size}&img_type=jpg`;
}

async function pruneBackups(dir, keep) {
  try {
    const files = (await readdir(dir)).filter((name) => /^\d{10,}-\d{5,}\.jpg$/.test(name)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      await rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  } catch { /* 清理失败不影响主流程 */ }
}

/**
 * 改前备份旧头像。任何一步失败都返回 ok:false，调用方必须中止换头像。
 * fetchBytes 由调用方注入（测试里 mock，生产里走 fetch）。
 */
export async function backupCurrentAvatar({ uin, fetchBytes, now = Date.now(), dir, keepBackups = 5 } = {}) {
  try {
    if (typeof fetchBytes !== 'function') throw new Error('未配置头像下载函数');
    if (!uin) throw new Error('缺少机器人 QQ 号');
    const bytes = await fetchBytes(avatarBackupUrl(uin));
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!buffer.length || buffer.length < 1024) throw new Error('下载到的旧头像为空或过小');

    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${now}-${String(uin)}.jpg`);
    await writeFile(file, buffer, { flag: 'wx' });
    await pruneBackups(dir, keepBackups);
    return { ok: true, path: file, bytes: buffer.length };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 追加一行审计 JSONL；只记哈希/路径，不记 base64 与会话令牌。 */
export async function appendAvatarAudit(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

function resolveArchivePath(imageId) {
  const match = /^(\d{4}-\d{2}-\d{2})\/([a-f0-9]{8,64}\.(?:jpg|jpeg|png|gif|webp))$/i.exec(String(imageId ?? '').trim());
  if (!match) throw new Error('imageId 格式应为“日期/文件名”，例如 2026-11-01/aa8faf3e18fbad42.gif');
  const file = path.join(IMAGE_ROOT, match[1], match[2]);
  if (!existsSync(file)) throw new Error(`图库中没有这张图片：${imageId}`);
  return file;
}

/**
 * 按来源读取图片字节。
 * deps.readMessage(messageId) 由调用方注入（走桥接内部 API，带会话令牌）。
 */
export async function resolveAvatarSource(input = {}, deps = {}) {
  const sourceType = String(input.sourceType ?? '').trim();
  if (sourceType === 'archive') {
    const file = resolveArchivePath(input.imageId);
    return { bytes: await readFile(file), ref: `archive:${matchRef(input.imageId)}` };
  }
  if (sourceType === 'sticker') {
    const key = findSticker(input.stickerId) || findStickerByRef(input.stickerId);
    const file = key ? getStickerPath(key) : null;
    if (!file) throw new Error(`找不到表情：${input.stickerId}`);
    return { bytes: await readFile(file), ref: `sticker:${key}` };
  }
  if (sourceType === 'self') {
    if (!existsSync(SELF_IMAGE_PATH)) throw new Error('未找到默认形象 assets/deepseek娘.png');
    return { bytes: await readFile(SELF_IMAGE_PATH), ref: 'self' };
  }
  if (sourceType === 'message') {
    if (typeof deps.readMessage !== 'function') throw new Error('当前环境不支持按消息取图');
    const image = await deps.readMessage(input.messageId);
    const bytes = Buffer.isBuffer(image) ? image : Buffer.from(String(image?.data ?? ''), 'base64');
    if (!bytes.length) throw new Error('这条消息里没有可用的图片');
    return { bytes, ref: `message:${input.messageId}` };
  }
  throw new Error('sourceType 只能是 archive / sticker / self / message');
}

function matchRef(imageId) {
  return String(imageId || '').trim();
}

/**
 * 预览：解析来源 + 标准化，不备份、不上传、不写配额。
 */
export async function previewAvatar({ input, options, deps = {} }) {
  try {
    const state = await readAvatarState(deps.statePath || AVATAR_STATE_PATH);
    const quota = checkAvatarQuota(state, deps.now ? deps.now() : Date.now(), options);
    const source = await resolveAvatarSource(input, deps);
    const normalized = await normalizeAvatarImage(source.bytes, options, {
      ffmpegPath: deps.ffmpegPath || options.ffmpegPath,
      workRoot: deps.workRoot
    });
    if (!normalized.ok) {
      return { ok: false, stage: 'normalize', reason: normalized.reason, quota };
    }
    return {
      ok: true,
      preview: {
        ref: source.ref,
        format: normalized.format,
        animated: normalized.animated,
        inputBytes: source.bytes.length,
        outputBytes: normalized.bytes,
        width: normalized.width,
        height: normalized.height,
        b64: normalized.b64
      },
      quota
    };
  } catch (error) {
    return { ok: false, stage: 'source', reason: String(error?.message ?? error) };
  }
}

/**
 * 完整换头像流程：配额 → 解析 → 标准化 → 备份（失败即中止）→ 上传 → 记账/审计。
 * deps 必须注入 upload / fetchAvatar；本模块绝不直接调用 OneBot 或网络。
 */
export async function changeAvatar({ input, options, deps = {} }) {
  const now = deps.now ? deps.now() : Date.now();
  const statePath = deps.statePath || AVATAR_STATE_PATH;
  const auditPath = deps.auditPath || AVATAR_AUDIT_PATH;
  const record = { at: new Date(now).toISOString(), action: 'set', sourceType: input?.sourceType ?? '' };
  if (!options.enabled) return { ok: false, changed: false, stage: 'config', reason: '换头像功能未启用' };

  const state = await readAvatarState(statePath);
  const quota = checkAvatarQuota(state, now, options);
  if (!quota.ok) {
    await appendAvatarAudit(auditPath, { ...record, ok: false, stage: 'quota', reason: quota.reason }).catch(() => {});
    return { ok: false, changed: false, stage: 'quota', reason: quota.reason };
  }

  let source;
  try {
    source = await resolveAvatarSource(input, deps);
  } catch (error) {
    const reason = String(error?.message ?? error);
    await appendAvatarAudit(auditPath, { ...record, ok: false, stage: 'source', reason }).catch(() => {});
    return { ok: false, changed: false, stage: 'source', reason };
  }
  record.sourceRef = source.ref;
  record.inputBytes = source.bytes.length;

  const normalized = await normalizeAvatarImage(source.bytes, options, {
    ffmpegPath: deps.ffmpegPath || options.ffmpegPath,
    workRoot: deps.workRoot
  });
  if (!normalized.ok) {
    await appendAvatarAudit(auditPath, { ...record, ok: false, stage: 'normalize', reason: normalized.reason }).catch(() => {});
    return { ok: false, changed: false, stage: 'normalize', reason: normalized.reason };
  }
  record.outputBytes = normalized.bytes;
  record.width = normalized.width;
  record.height = normalized.height;

  const backup = await backupCurrentAvatar({
    uin: deps.uin,
    fetchBytes: deps.fetchAvatar,
    now,
    dir: options.backupDir,
    keepBackups: options.keepBackups
  });
  if (!backup.ok) {
    const reason = `旧头像备份失败，已中止：${backup.reason}`;
    await appendAvatarAudit(auditPath, { ...record, ok: false, stage: 'backup', reason }).catch(() => {});
    return { ok: false, changed: false, stage: 'backup', reason };
  }
  record.backupPath = backup.path;

  try {
    if (typeof deps.upload !== 'function') throw new Error('未配置上传函数');
    await deps.upload(normalized.b64);
  } catch (error) {
    const reason = `上传失败：${String(error?.message ?? error)}`;
    await appendAvatarAudit(auditPath, { ...record, ok: false, stage: 'upload', reason }).catch(() => {});
    return { ok: false, changed: false, stage: 'upload', reason, backupPath: backup.path };
  }

  const next = nextAvatarState(state, now);
  await writeJsonAtomic(statePath, next).catch(() => {});
  await appendAvatarAudit(auditPath, { ...record, ok: true, stage: 'done' }).catch(() => {});

  return {
    ok: true,
    changed: true,
    preview: {
      ref: source.ref,
      format: normalized.format,
      animated: normalized.animated,
      outputBytes: normalized.bytes,
      width: normalized.width,
      height: normalized.height
    },
    backupPath: backup.path,
    quota: checkAvatarQuota(next, now, options)
  };
}

/**
 * 回滚：用备份文件重新上传。P0 只提供内部能力，不注册 MCP 工具。
 */
export async function restoreAvatar({ backupPath, options, deps = {} }) {
  try {
    const bytes = await readFile(backupPath);
    const normalized = await normalizeAvatarImage(bytes, options, {
      ffmpegPath: deps.ffmpegPath || options.ffmpegPath,
      workRoot: deps.workRoot
    });
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    if (typeof deps.upload !== 'function') throw new Error('未配置上传函数');
    await deps.upload(normalized.b64);
    await appendAvatarAudit(deps.auditPath || AVATAR_AUDIT_PATH, {
      at: new Date(deps.now ? deps.now() : Date.now()).toISOString(),
      action: 'restore',
      ok: true,
      backupPath
    }).catch(() => {});
    return { ok: true, changed: true, width: normalized.width, height: normalized.height };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 供测试或状态接口读取当前配额状态。 */
export async function avatarQuotaSnapshot(options, deps = {}) {
  const state = await readAvatarState(deps.statePath || AVATAR_STATE_PATH);
  return checkAvatarQuota(state, deps.now ? deps.now() : Date.now(), options);
}

/** 备份目录里现存的文件（按时间倒序），供 P1 的恢复工具使用。 */
export async function listAvatarBackups(dir = DEFAULT_AVATAR_BACKUP_DIR) {
  try {
    const files = (await readdir(dir)).filter((name) => /^\d{10,}-\d{5,}\.jpg$/.test(name)).sort().reverse();
    return await Promise.all(files.map(async (name) => {
      const file = path.join(dir, name);
      const info = await stat(file);
      return { name, path: file, bytes: info.size, at: info.mtimeMs };
    }));
  } catch {
    return [];
  }
}
