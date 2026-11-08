// 图片发送端点的纯逻辑：鉴权闸门 + 图片载荷校验（base64 / state/imagegen 本地路径）。
// 抽出来便于离线单测；bridge.js 只负责取 header/状态并调用这里。
import { realpathSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export function parseSendKey(value) {
  const match = /^(group|private):(\d{5,20})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { kind: match[1], id: Number(match[2]) };
}

/**
 * 与文本发送同一套闸门：模式、agent token、工具开关、静音、目标白名单。
 * 任一条不过都返回 4xx，不进入发送。
 */
export function decideImageSendAccess({
  mode = '', token = '', tokenValid = false, toolEnabled = true,
  silentBlocked = false, targetAllowed = true
} = {}) {
  if (mode === 'chat' || mode === 'reserved') {
    return { ok: false, status: 403, error: '图片发送仅限 closed-agent / reserved2 模式使用' };
  }
  if (mode === 'reserved2' && !token) {
    return { ok: false, status: 403, error: 'reserved2 模式发送必须携带 agent token' };
  }
  if (token && !tokenValid) return { ok: false, status: 403, error: 'agent token 无效' };
  if (token && !toolEnabled) return { ok: false, status: 403, error: '工具未启用' };
  if (silentBlocked) return { ok: false, status: 403, error: '静默模式已开启，当前不允许发送' };
  if (!targetAllowed) return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
  return { ok: true };
}

function finish(buffer, source) {
  if (!buffer?.length) return { ok: false, status: 400, error: '图片内容为空' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 限制` };
  }
  return { ok: true, buffer, source };
}

/**
 * image 入参三种形态：
 *   1. data:image/...;base64,xxxx
 *   2. 纯 base64（长度 > 64）
 *   3. 本地路径：必须落在 rootDir 内（默认 state/imagegen），拒绝任意路径/路径穿越。
 */
export function loadImagePayload(input, { rootDir, readFile = readFileSync, realpath = realpathSync } = {}) {
  const value = String(input ?? '').trim();
  if (!value) return { ok: false, status: 400, error: 'image 不能为空（base64 或 state/imagegen/ 下的路径）' };

  const dataUri = /^data:image\/[a-z0-9+.-]+;base64,(.+)$/i.exec(value);
  if (dataUri) return finish(Buffer.from(dataUri[1], 'base64'), 'base64');
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, '').length > 64) {
    return finish(Buffer.from(value.replace(/\s+/g, ''), 'base64'), 'base64');
  }

  let root;
  let target;
  try {
    root = realpath(resolve(rootDir));
    target = realpath(resolve(value));
  } catch {
    return { ok: false, status: 400, error: '本地图片不存在或不可读' };
  }
  if (target !== root && !target.startsWith(root + sep)) {
    return { ok: false, status: 403, error: '本地图片必须位于 state/imagegen/ 目录内' };
  }
  if (!IMAGE_EXT.test(extname(target))) return { ok: false, status: 400, error: '只允许发送图片文件' };
  try {
    return finish(readFile(target), 'path');
  } catch (error) {
    return { ok: false, status: 400, error: `读取图片失败：${error?.message ?? error}` };
  }
}
