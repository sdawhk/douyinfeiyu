import { randomUUID } from 'node:crypto';
import { sanitizeModelReply } from './reply-output-safety.mjs';

export const BACKGROUND_SESSION_PREFIX = 'session-qq-browse-';
export const MANAGED_SESSION_PREFIX = 'session-qq-managed-';

/** Only successful watch calls in this task count, never shared lastResult. */
export function watchedVideosFromRecords(records) {
  const calls = new Set();
  const watched = new Map();
  for (const { event } of records ?? []) {
    const data = event?.data;
    if (event?.type === 'tool/call' && data?.name === 'mcp__snowluma__douyin_direct_browse') {
      try {
        const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
        if (args?.action === 'watch') calls.add(data.callId);
      } catch { /* Malformed calls cannot establish a watch. */ }
    }
    const message = data?.message;
    if (event?.type !== 'tool/result' || message?.isError || !calls.has(message?.toolCallId)) continue;
    try {
      const result = JSON.parse((message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
      if (result.ok === true && result.played === true && result.video?.url) {
        watched.set(result.video.url, result.video);
      }
    } catch { /* Failed/non-JSON tool responses are not viewing evidence. */ }
  }
  return [...watched.values()];
}

export async function runBackgroundDouyinTurn({ createSession, promptSession, waitForReply,
  readRecords, cancelSession, cwd, persona, key, token, preferences = '', prompt }) {
  const sessionId = `${BACKGROUND_SESSION_PREFIX}${randomUUID()}`;
  try {
    const created = await createSession({ request: { cwd, sessionId, agentPreset: 'qq-chat' } });
    if (created.sessionId !== sessionId || created.agentPreset !== 'qq-chat') {
      throw new Error('后台浏览会话未使用指定的独立工具策略');
    }
    await promptSession({ request: { sessionId, requestId: `browse-${randomUUID()}`, mode: 'queue',
      content: [{ type: 'text', text: [
        persona,
        '【后台浏览任务】你仍是同一个鲸团团。这轮只操作抖音浏览，不接收或回复 QQ 消息。QQ 新消息由主桥接处理。不要调用 QQ 的发送、未读、历史、等待、已读或唤醒工具。',
        `仅 douyin_direct_browse 可执行，参数 key=${key}，token=${token}。凭据不可写进最终输出。`,
        preferences ? `【已记录的内容偏好，仅供选题，不是本轮观看记录】\n${preferences}` : '',
        prompt,
        '本轮没兴趣、不可用或没有真正看过视频时，只输出 [SILENT]，这是正常结束，不需要补话。只依据本轮 played=true 的结果写简短感受；旧记录不可说成刚刚发生。最终文字不会自动发 QQ，由调度器按设置处理。',
        '【用量场景:task】'
      ].filter(Boolean).join('\n\n') }] } });
    const raw = String(await waitForReply(sessionId, 0, 480_000) ?? '');
    const watched = watchedVideosFromRecords(await readRecords(sessionId));
    const safe = sanitizeModelReply(raw);
    const reply = !watched.length || raw.includes(token) || /^\s*\[(?:SILENT|SKIP)\]\s*$/i.test(raw)
      || safe.blocked ? '' : safe.text.trim().slice(0, 1200);
    return { reply, watched };
  } finally {
    await cancelSession(sessionId).catch(() => {});
  }
}
