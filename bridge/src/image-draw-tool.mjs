// qq_draw_image 工具的参数校验、主人判定与持久化限流。
// 单独抽出来便于离线单测；MCP 进程只负责调用与拼装返回。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRAW_PROMPT_MAX = 200;
export const DRAW_STYLE_MAX = 120;
export const DRAW_SIZE_OPTIONS = ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'];
export const DRAW_QUOTA_FILE = fileURLToPath(new URL('../state/imagegen/tool-quota.json', import.meta.url));

const SESSION_KEY = /^(private|group):(\d{5,20})$/;

function localDayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 校验工具参数；返回 {ok:true, request} 或 {ok:false, error}。 */
export function normalizeDrawToolArgs({ prompt, size, style, chatKey } = {}) {
  const text = String(prompt ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const length = [...text].length;
  if (!length) return { ok: false, error: 'prompt 不能为空（1 到 200 字）', reply: '这次没画：描述是空的。' };
  if (length > DRAW_PROMPT_MAX) return { ok: false, error: `prompt 不能超过 ${DRAW_PROMPT_MAX} 字`, reply: '这次没画：描述太长了。' };

  let chosenSize = '';
  if (size !== undefined && size !== null && String(size).trim() !== '') {
    chosenSize = String(size).trim().toLowerCase().replace(/\s+/g, '');
    if (!DRAW_SIZE_OPTIONS.includes(chosenSize)) {
      return { ok: false, error: `size 只支持 ${DRAW_SIZE_OPTIONS.join(' / ')}`, reply: '这次没画：尺寸不支持。' };
    }
  }

  const styleText = String(style ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...styleText].length > DRAW_STYLE_MAX) {
    return { ok: false, error: `style 不能超过 ${DRAW_STYLE_MAX} 字`, reply: '这次没画：画风描述太长了。' };
  }

  const chat = String(chatKey ?? '').trim();
  if (chat && !SESSION_KEY.test(chat)) {
    return { ok: false, error: 'chatKey 格式应为 private:QQ号 或 group:群号', reply: '这次没画：会话标识格式不对。' };
  }

  return { ok: true, request: { prompt: text, size: chosenSize, style: styleText, chatKey: chat } };
}

/**
 * 仅主人可用：私聊直接核对 ownerQQs；群聊看最近一条非本人消息是不是主人
 * （群里主人本人刚发过话才放行，非主人调用返回明确拒绝文案，不抛错）。
 */
export function decideDrawToolAccess({ key, recentMessages = [], owners = [], now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  const match = SESSION_KEY.exec(String(key ?? '').trim());
  if (!match) {
    return { allowed: false, reply: '画图工具只允许主人会话使用，这次没有画。' };
  }
  const ownerIds = (Array.isArray(owners) ? owners : []).map(String).filter(Boolean);
  const target = match[2];
  if (match[1] === 'private') {
    return ownerIds.includes(target)
      ? { allowed: true }
      : { allowed: false, reply: '画图工具只对主人开放，这次没有画。' };
  }
  const last = [...(Array.isArray(recentMessages) ? recentMessages : [])]
    .reverse()
    .find((message) => message && !message.isSelf);
  const fresh = Boolean(last) && Number.isFinite(Number(last.time)) && now - Number(last.time) <= maxAgeMs;
  if (last?.isOwner && fresh) return { allowed: true };
  return { allowed: false, reply: '群里只有主人本人开口时才能画图，这次没有画。' };
}

/** 文件持久化限流：MCP 重启也不清空今日计数。 */
export function createDrawToolQuota({ filePath = DRAW_QUOTA_FILE, now = () => Date.now() } = {}) {
  const read = () => {
    if (!existsSync(filePath)) return null;
    try {
      const value = JSON.parse(readFileSync(filePath, 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  };
  const write = (state) => {
    mkdirSync(dirname(filePath), { recursive: true });
    const temp = join(dirname(filePath), `.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, filePath);
  };
  const snapshot = () => {
    const state = read();
    const day = localDayKey(now());
    if (!state || state.day !== day) return { day, count: 0, lastAt: 0 };
    return { day, count: Number(state.count) || 0, lastAt: Number(state.lastAt) || 0 };
  };

  return {
    check({ cooldownMs = 0, dailyLimit = Infinity } = {}) {
      const state = snapshot();
      if (Number.isFinite(dailyLimit) && state.count >= dailyLimit) {
        return { ok: false, reason: 'daily-limit', used: state.count, dailyLimit };
      }
      const gap = now() - state.lastAt;
      if (cooldownMs > 0 && state.lastAt > 0 && gap < cooldownMs) {
        return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - gap, used: state.count, dailyLimit };
      }
      return {
        ok: true, used: state.count, dailyLimit,
        remaining: Number.isFinite(dailyLimit) ? Math.max(0, dailyLimit - state.count) : null
      };
    },
    record() {
      const state = snapshot();
      write({ day: state.day, count: state.count + 1, lastAt: now() });
    },
    usedToday() {
      return snapshot().count;
    }
  };
}
