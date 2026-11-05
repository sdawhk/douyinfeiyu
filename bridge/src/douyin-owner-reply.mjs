import { dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { stripStickerDirectives } from './reply-sticker-token.mjs';
import { commitmentClaimIssue, stripInternalChatMarkers } from './reply-output-safety.mjs';

const cleanHandle = (value) => String(value ?? '').trim().replace(/^@/, '');

function cleanText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function sanitizeVideoContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowedUrl = (input, directOnly = false) => {
    try {
      const url = new URL(String(input ?? ''));
      if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com', 'v.douyin.com'].includes(url.hostname)
          || url.username || url.password || url.pathname === '/') return '';
      if (directOnly && !/^\/video\/\d+$/.test(url.pathname)) return '';
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 500);
    } catch { return ''; }
  };
  const status = ['analyzed', 'partial', 'no_playback', 'unresolved', 'unavailable'].includes(value.status)
    ? value.status : 'unavailable';
  return {
    url: allowedUrl(value.url, true), shareUrl: allowedUrl(value.shareUrl),
    title: cleanText(value.title, 200), author: cleanText(value.author, 100),
    cardText: cleanText(value.cardText, 500), status,
    summary: cleanText(value.summary, 400), transcript: cleanText(value.transcript, 1000),
    tags: Array.isArray(value.tags) ? value.tags.slice(0, 5).map((tag) => cleanText(tag, 32)).filter(Boolean) : []
  };
}

/** Creates a fail-closed, idempotent gate for replies to one configured Douyin owner. */
export function createDouyinOwnerReplyGate({ configuredHandle, ownerId, statePath, generate }) {
  const expectedHandle = cleanHandle(configuredHandle);
  if (!expectedHandle || !/^\d{5,20}$/.test(String(ownerId ?? '')) || typeof generate !== 'function') {
    throw new Error('Douyin owner reply is not configured');
  }
  const inFlight = new Set();

  function readState() {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
      return { consumedMessageIds: Array.isArray(parsed.consumedMessageIds) ? parsed.consumedMessageIds : [] };
    } catch (error) {
      if (error?.code === 'ENOENT') return { consumedMessageIds: [] };
      throw new Error('Could not read Douyin reply dedupe state; refusing to reply', { cause: error });
    }
  }

  function persist(ids) {
    mkdirSync(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify({ consumedMessageIds: ids }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, statePath);
  }

  return async function replyToInbound({ handle, messageId, text, videoContext }) {
    if (cleanHandle(handle) !== expectedHandle) throw new Error('Douyin sender is not the configured owner');
    const id = String(messageId ?? '').trim();
    const content = String(text ?? '').trim();
    const safeVideoContext = sanitizeVideoContext(videoContext);
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id) || (!content && !safeVideoContext) || content.length > 4000) {
      throw new Error('Invalid Douyin inbound message');
    }
    if (inFlight.has(id)) return { ok: true, duplicate: true };
    const state = readState();
    if (state.consumedMessageIds.includes(id)) return { ok: true, duplicate: true };

    // Consume before invoking the model. A timeout or restart must never cause an automatic repeat.
    inFlight.add(id);
    try {
      state.consumedMessageIds.push(id);
      persist(state.consumedMessageIds);
      // 最后一道发送前兜底：抖音发送端只接受纯文本，任何 QQ 内部标记都不能进入消息正文。
      const generated = String(await generate({ ownerId: String(ownerId), messageId: id, text: content,
        videoContext: safeVideoContext })).trim();
      let response = stripInternalChatMarkers(stripStickerDirectives(generated)).trim();
      if (!response) throw new Error('Model returned an empty reply');
      // 没有实际结果却声称“任务已在跑/马上给你”时，纠正一次；仍不合格走明确兜底。
      if (commitmentClaimIssue(response)) {
        const retried = String(await generate({
          ownerId: String(ownerId),
          messageId: `${id}:retry`,
          text: content,
          videoContext: safeVideoContext,
          correction: '不要声称你已经在刷、任务已启动、在跑或马上给结果；你在抖音私信这边没有这些工具，没拿到结果就直说没拿到。'
        })).trim();
        response = stripInternalChatMarkers(stripStickerDirectives(retried)).trim();
        if (!response || commitmentClaimIssue(response)) {
          response = '爸，我这边还没真拿到结果，先不跟你说已经在弄了。';
        }
      }
      return { ok: true, duplicate: false, reply: response.slice(0, 4000) };
    } finally {
      inFlight.delete(id);
    }
  };
}
