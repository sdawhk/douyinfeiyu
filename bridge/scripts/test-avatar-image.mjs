// 离线验证个人头像链路（P0）：判型、标准化、配额、会话拒绝、备份中止、回滚。
//
// 运行：node scripts/test-avatar-image.mjs
//
// 安全约定：本测试绝不调用真实 OneBot / 网络。
// upload、fetchAvatar、readMessage 全部由本地 mock 注入，
// 因此不会向 http://127.0.0.1:3002 发送任何 set_qq_avatar 请求。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_DEFAULTS,
  avatarOptions,
  avatarBackupUrl,
  backupCurrentAvatar,
  changeAvatar,
  checkAvatarQuota,
  detectImageInfo,
  isAvatarSessionAllowed,
  listAvatarBackups,
  normalizeAvatarImage,
  previewAvatar,
  readAvatarState,
  resolveAvatarSource,
  restoreAvatar
} from '../src/avatar-image.mjs';
import { resolveFfmpegPath } from '../src/animated-image.mjs';

const exec = promisify(execFile);
const ffmpeg = resolveFfmpegPath('');
const WORK_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');

async function run(args, timeout = 90_000) {
  await exec(ffmpeg, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

/** 直接从 JPEG 的 SOF 段读出宽高，确认不是“改了扩展名”的假 JPEG。 */
function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG SOF marker not found');
}

function localDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function makeFixtures(dir) {
  const square = path.join(dir, 'square.png');
  const wide = path.join(dir, 'wide.png');
  const big = path.join(dir, 'big.png');
  const transparent = path.join(dir, 'transparent.png');
  const animated = path.join(dir, 'animated.gif');
  const current = path.join(dir, 'current-avatar.jpg');

  await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=800x800:rate=1', '-frames:v', '1', '-pix_fmt', 'rgb24', square]);
  await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1200x400:rate=1', '-frames:v', '1', '-pix_fmt', 'rgb24', wide]);
  await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=3000x3000:rate=1', '-frames:v', '1', '-pix_fmt', 'rgb24', big]);
  await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x3366cc@0.35:size=600x600', '-frames:v', '1', '-pix_fmt', 'rgba', transparent]);
  await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x200:rate=8:duration=1',
    '-vf', 'format=rgb24', '-loop', '0', animated]);
  await run(['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x640:rate=1', '-frames:v', '1', '-q:v', '3', current]);

  return { square, wide, big, transparent, animated, current };
}

async function main() {
  console.log(`[test] ffmpeg=${ffmpeg || 'missing'}`);
  assert.ok(ffmpeg, 'ffmpeg 不可用，无法验证头像标准化');

  const defaults = avatarOptions({});
  assert.equal(defaults.outputSize, 640);
  assert.equal(defaults.jpegQuality, 82);
  assert.equal(defaults.outputMaxBytes, AVATAR_DEFAULTS.outputMaxBytes);
  assert.equal(defaults.dailyLimit, 0);
  assert.equal(defaults.minIntervalMs, 0);
  assert.equal(defaults.groupPortraitEnabled, false);
  assert.equal(avatarOptions({ outputSize: 99999 }).outputSize, 1024, '非法尺寸应被钳制');
  console.log('[test] 默认参数：640×640 / q82 / ≤1MB / 不限次数 / 无冷却');

  await mkdir(WORK_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(WORK_ROOT, 'test-avatar-image-'));
  try {
    const files = await makeFixtures(dir);
    const bytes = {};
    for (const [name, file] of Object.entries(files)) {
      bytes[name] = await readFile(file);
      const info = await stat(file);
      console.log(`[fixture] ${name} ${info.size} bytes`);
    }

    // ── 1. 判型 ─────────────────────────────────────────────────────────────
    const squareInfo = detectImageInfo(bytes.square);
    assert.deepEqual([squareInfo.format, squareInfo.width, squareInfo.height, squareInfo.animated],
      ['png', 800, 800, false]);
    const wideInfo = detectImageInfo(bytes.wide);
    assert.deepEqual([wideInfo.format, wideInfo.width, wideInfo.height], ['png', 1200, 400]);
    const transparentInfo = detectImageInfo(bytes.transparent);
    assert.deepEqual([transparentInfo.format, transparentInfo.width, transparentInfo.height],
      ['png', 600, 600]);
    const animatedInfo = detectImageInfo(bytes.animated);
    assert.equal(animatedInfo.format, 'gif');
    assert.equal(animatedInfo.animated, true, '两帧 GIF 应判为动图');
    const currentInfo = detectImageInfo(bytes.current);
    assert.deepEqual([currentInfo.format, currentInfo.width, currentInfo.height], ['jpeg', 640, 640]);
    assert.equal(detectImageInfo(Buffer.from('not an image at all')), null);
    console.log('[test] 判型通过：png / 非方形 / 透明 png / 动图 gif / jpeg / 未知格式=null');

    // ── 2. 标准化：640×640 cover + JPEG + ≤1MB ──────────────────────────────
    const normalize = (buffer, options = defaults) => normalizeAvatarImage(buffer, options, {
      ffmpegPath: ffmpeg,
      workRoot: dir
    });

    for (const name of ['square', 'wide', 'transparent', 'animated']) {
      const result = await normalize(bytes[name]);
      assert.equal(result.ok, true, `${name} 标准化失败：${result.reason}`);
      assert.equal(result.width, 640, `${name} 宽度应为 640`);
      assert.equal(result.height, 640, `${name} 高度应为 640`);
      assert.equal(result.mime, 'image/jpeg');
      assert.ok(result.bytes <= defaults.outputMaxBytes, `${name} 输出 ${result.bytes}B 超过 1MB`);
      const decoded = jpegSize(Buffer.from(result.b64, 'base64'));
      assert.deepEqual([decoded.width, decoded.height], [640, 640], `${name} 输出不是真 JPEG`);
      if (name === 'animated') {
        assert.equal(result.animated, true);
        assert.equal(result.format, 'gif');
      }
      console.log(`[test] ${name} → ${result.format} ${result.width}x${result.height} `
        + `${result.bytes}B${name === 'animated' ? '（动图仅首帧）' : ''}`);
    }

    // 超大输入：真实大图 + 强制收紧上限，保证一定触发守卫
    const bigBytes = bytes.big;
    const tightLimit = Math.min(defaults.inputMaxBytes, bigBytes.length - 1);
    const tooLarge = await normalizeAvatarImage(bigBytes, { ...defaults, inputMaxBytes: tightLimit }, {
      ffmpegPath: ffmpeg,
      workRoot: dir
    });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.reason, 'input-too-large');
    console.log(`[test] 超大输入 ${bigBytes.length}B（上限 ${tightLimit}B）→ input-too-large`);

    const unavailable = await normalizeAvatarImage(bytes.square, defaults, {
      ffmpegPath: null,
      workRoot: dir
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, 'ffmpeg-unavailable');

    const garbage = await normalizeAvatarImage(Buffer.from('RIFF-not-really'), defaults, {
      ffmpegPath: ffmpeg,
      workRoot: dir
    });
    assert.equal(garbage.reason, 'unsupported-format');
    console.log('[test] 降级：无 ffmpeg → ffmpeg-unavailable；未知格式 → unsupported-format');

    // ── 3. 会话与来源护栏 ───────────────────────────────────────────────────
    const owners = { ownerQQs: [1668389572, 2427256325], ownerQQ: 2427256325 };
    assert.equal(isAvatarSessionAllowed('private:1668389572', owners), true);
    assert.equal(isAvatarSessionAllowed('private:2427256325', owners), true);
    assert.equal(isAvatarSessionAllowed('group:123456', owners), false, '群聊必须拒绝');
    assert.equal(isAvatarSessionAllowed('private:999999', owners), false, '非主人必须拒绝');
    assert.equal(isAvatarSessionAllowed('', owners), false);
    await assert.rejects(
      resolveAvatarSource({ sourceType: 'archive', imageId: 'https://evil.example/a.png' }),
      /imageId 格式/,
      '外部 URL 不能当图库来源'
    );
    await assert.rejects(
      resolveAvatarSource({ sourceType: 'url', imageId: 'https://evil.example/a.png' }),
      /sourceType 只能是/,
      'URL 来源类型必须被拒绝'
    );
    console.log('[test] 会话/来源护栏通过：群聊、非主人、外部 URL 全部拒绝');

    // ── 4. 配额（纯函数）：默认不限次数、无冷却 ─────────────────────────────
    const now = Date.now();
    const day = localDay(now);
    const unlimited = avatarOptions({ dailyLimit: 0, minIntervalMs: 0 });
    for (const count of [0, 1, 5, 99]) {
      const free = checkAvatarQuota({ day, count, lastAt: now }, now, unlimited);
      assert.equal(free.ok, true, `不限次数时 count=${count} 也不应被拦`);
      assert.equal(free.remaining, null, '不限次数时 remaining 应为 null');
    }
    const legacyOpts = avatarOptions({ dailyLimit: 2, minIntervalMs: 21_600_000 });
    assert.equal(checkAvatarQuota({}, now, legacyOpts).ok, true);
    const over = checkAvatarQuota({ day, count: 2, lastAt: now }, now, legacyOpts);
    assert.equal(over.ok, false);
    assert.match(over.reason, /次数已用完/);
    const nextDay = checkAvatarQuota({ day: localDay(now - 86_400_000), count: 2, lastAt: now }, now, legacyOpts);
    assert.equal(nextDay.ok, true, '显式配置上限时跨天仍应重置');
    const tooSoon = checkAvatarQuota({ day, count: 0, lastAt: now - 60_000 }, now, legacyOpts);
    assert.equal(tooSoon.ok, false);
    assert.match(tooSoon.reason, /分钟/);
    console.log('[test] 配额通过：默认不限次数/无冷却；显式配置时才启用次数与间隔限制');

    // ── 5. 预览：不上传、不写配额 ────────────────────────────────────────────
    const previewStatePath = path.join(dir, 'preview-state.json');
    const previewUploads = [];
    const previewDeps = {
      uin: '2427256325',
      fetchAvatar: async () => bytes.current,
      upload: async (b64) => { previewUploads.push(b64); },
      ffmpegPath: ffmpeg,
      statePath: previewStatePath,
      auditPath: path.join(dir, 'preview-audit.jsonl'),
      workRoot: dir,
      now: () => now
    };
    const preview = await previewAvatar({
      input: { sourceType: 'message', messageId: 1001 },
      options: defaults,
      deps: {
        ...previewDeps,
        readMessage: async () => ({ data: bytes.wide.toString('base64'), mimeType: 'image/png' })
      }
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.preview.width, 640);
    assert.equal(previewUploads.length, 0, '预览绝不能触发上传');
    assert.equal((await readAvatarState(previewStatePath)).count, undefined, '预览不能写配额');
    console.log('[test] 预览通过：不备份、不上传、不写配额');

    // ── 6. 备份失败 → 中止，upload 绝不能被调用 ─────────────────────────────
    const abortUploads = [];
    const abort = await changeAvatar({
      input: { sourceType: 'message', messageId: 3003 },
      options: defaults,
      deps: {
        uin: '2427256325',
        readMessage: async () => ({ data: bytes.square.toString('base64'), mimeType: 'image/png' }),
        fetchAvatar: async () => { throw new Error('mock 下载失败'); },
        upload: async (b64) => { abortUploads.push(b64); },
        ffmpegPath: ffmpeg,
        statePath: path.join(dir, 'abort-state.json'),
        auditPath: path.join(dir, 'abort-audit.jsonl'),
        workRoot: dir,
        now: () => now
      }
    });
    assert.equal(abort.ok, false);
    assert.equal(abort.stage, 'backup');
    assert.equal(abortUploads.length, 0, '备份失败时必须中止，不得上传');
    console.log(`[test] 备份失败中止：stage=${abort.stage}，upload 调用 ${abortUploads.length} 次`);

    // ── 7. 成功更换（message 来源，全 mock） ────────────────────────────────
    const uploads = [];
    const statePath = path.join(dir, 'avatar-state.json');
    const auditPath = path.join(dir, 'avatar-audit.jsonl');
    const backupDir = path.join(dir, 'avatar-history');
    const deps = {
      uin: '2427256325',
      readMessage: async () => ({ data: bytes.square.toString('base64'), mimeType: 'image/png' }),
      fetchAvatar: async (url) => {
        assert.match(url, /^https:\/\/q\.qlogo\.cn\/headimg_dl/);
        assert.match(url, /dst_uin=2427256325/);
        return bytes.current;
      },
      upload: async (b64) => { uploads.push(b64); },
      ffmpegPath: ffmpeg,
      statePath,
      auditPath,
      workRoot: dir,
      now: () => now
    };
    const options = avatarOptions({ backupDir, keepBackups: 5 });
    assert.equal(avatarBackupUrl('2427256325').includes('spec=640'), true);

    const changed = await changeAvatar({
      input: { sourceType: 'message', messageId: 2002 },
      options,
      deps
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.changed, true);
    assert.equal(changed.preview.width, 640);
    assert.equal(changed.preview.height, 640);
    assert.equal(uploads.length, 1, '一次更换只能上传一次');
    const uploaded = Buffer.from(uploads[0], 'base64');
    assert.deepEqual(jpegSize(uploaded), { width: 640, height: 640 });
    assert.ok(uploaded.length <= options.outputMaxBytes);

    const state = await readAvatarState(statePath);
    assert.equal(state.day, day);
    assert.equal(state.count, 1);
    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const done = auditLines.find((item) => item.stage === 'done');
    assert.equal(done.ok, true);
    assert.equal(done.action, 'set');
    assert.equal(done.sourceType, 'message');
    assert.equal(auditLines.some((item) => typeof item.b64 === 'string'), false, '审计不能写 base64');
    console.log(`[test] 更换成功：upload=${uploads.length} 次，state=${JSON.stringify(state)}，审计 ${auditLines.length} 行`);

    // ── 8. 不限次数：同一天连续第二次仍然照常上传 ────────────────────────────
    const second = await changeAvatar({
      input: { sourceType: 'message', messageId: 2003 },
      options,
      deps: { ...deps, now: () => now + 5_000 }
    });
    assert.equal(second.ok, true, '不得再被每日次数拦住');
    assert.equal(second.changed, true);
    assert.equal(uploads.length, 2, '第二次也应真实上传');
    assert.equal((await readAvatarState(statePath)).count, 2);
    assert.equal(second.quota?.remaining, null, '成功结果不应再报剩余次数');
    console.log(`[test] 不限次数：连续更换 upload=${uploads.length} 次，未被配额拦截`);

    // ── 9. 回滚能力（内部函数，未注册工具） ─────────────────────────────────
    const backups = await listAvatarBackups(backupDir);
    assert.equal(backups.length >= 1, true, '更换前应已备份旧头像');
    const restoreUploads = [];
    const restored = await restoreAvatar({
      backupPath: backups[0].path,
      options,
      deps: { ...deps, upload: async (b64) => { restoreUploads.push(b64); } }
    });
    assert.equal(restored.ok, true);
    assert.equal(restoreUploads.length, 1);
    assert.deepEqual(jpegSize(Buffer.from(restoreUploads[0], 'base64')), { width: 640, height: 640 });
    const restoreAudit = (await readFile(auditPath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line)).find((item) => item.action === 'restore');
    assert.equal(restoreAudit.ok, true);
    console.log(`[test] 回滚可用：备份 ${backups[0].name} → 重新上传 640×640，审计含 action=restore`);

    // ── 10. keepBackups 只保留最近 5 个 ─────────────────────────────────────
    const pruneDir = path.join(dir, 'prune-history');
    for (let i = 0; i < 6; i++) {
      const result = await backupCurrentAvatar({
        uin: '2427256325',
        fetchBytes: async () => bytes.current,
        now: now + i * 1000,
        dir: pruneDir,
        keepBackups: 5
      });
      assert.equal(result.ok, true);
    }
    const kept = await listAvatarBackups(pruneDir);
    assert.equal(kept.length, 5, `keepBackups=5 时应只留 5 个，实际 ${kept.length}`);
    console.log(`[test] keepBackups=5：写入 6 个后剩 ${kept.length} 个`);

    // 备份文件写入后应能被识别为 JPEG（防止只写了个空壳）
    const lastBackup = await readFile(kept[0].path);
    assert.deepEqual(jpegSize(lastBackup), { width: 640, height: 640 });

    assert.equal((await stat(path.join(dir, 'abort-audit.jsonl'))).size > 0, true, '失败也应留审计');
    console.log('[test] all assertions passed');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[test] FAILED:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
