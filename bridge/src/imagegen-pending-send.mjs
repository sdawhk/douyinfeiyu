// 生图待发队列：QQ 离线或发送失败时先落盘，登录成功后统一补发。
// 独立成模块，qq-bot 与 MCP 进程共用同一份 state/imagegen/pending-send.json。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_ATTEMPTS = 3;

export function defaultPendingSendPath() {
  return fileURLToPath(new URL('../state/imagegen/pending-send.json', import.meta.url));
}

function emptyState() {
  return { version: 1, items: [] };
}

export function loadPendingSend(statePath = defaultPendingSendPath()) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return { version: 1, items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return emptyState();
  }
}

function savePendingSend(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, statePath);
}

function itemKey(filePath, target) {
  return `${resolve(filePath)}|${String(target || '')}`;
}

/** 入队；同一文件 + 同一目标只保留一条，已发/已失败的也不再重复入队。 */
export function enqueuePendingSend({ filePath, target, sha256 = '', createdAt = Date.now() }, statePath = defaultPendingSendPath()) {
  if (!filePath) return { added: false, reason: 'no-file' };
  const state = loadPendingSend(statePath);
  const key = itemKey(filePath, target);
  const existing = state.items.find((item) => itemKey(item.filePath, item.target) === key);
  if (existing) return { added: false, reason: `exists:${existing.status}`, item: existing };
  if (sha256 && state.items.some((item) => item.sha256 === sha256 && item.status !== 'pending')) {
    return { added: false, reason: 'duplicate-sha' };
  }
  const item = {
    id: key,
    filePath: resolve(filePath),
    target: String(target || ''),
    sha256,
    createdAt,
    attempts: 0,
    status: 'pending',
    messageId: '',
    sentAt: 0,
    lastError: '',
    updatedAt: createdAt
  };
  state.items.push(item);
  savePendingSend(statePath, state);
  return { added: true, item };
}

/**
 * 补发所有 pending 项。send(item) 需要返回 messageId（拿不到返回空串也算成功）。
 * 失败累计 attempts，达到上限标记 failed，避免无限重试。
 */
export async function flushPendingSends(send, { statePath = defaultPendingSendPath(), maxAttempts = DEFAULT_MAX_ATTEMPTS, now = Date.now } = {}) {
  const state = loadPendingSend(statePath);
  const summary = { sent: 0, failed: 0, skipped: 0, pending: 0, messageIds: [] };
  for (const item of state.items) {
    if (item.status !== 'pending') continue;
    if (!existsSync(item.filePath)) {
      item.status = 'failed';
      item.lastError = 'file missing';
      item.updatedAt = now();
      summary.failed += 1;
      continue;
    }
    try {
      const messageId = String((await send(item)) || '');
      item.status = 'sent';
      item.messageId = messageId;
      item.sentAt = now();
      item.attempts += 1;
      item.lastError = '';
      item.updatedAt = now();
      summary.sent += 1;
      summary.messageIds.push(messageId);
    } catch (error) {
      item.attempts += 1;
      item.lastError = String(error?.message ?? error).slice(0, 160);
      item.updatedAt = now();
      if (item.attempts >= maxAttempts) {
        item.status = 'failed';
        summary.failed += 1;
      }
    }
  }
  savePendingSend(statePath, state);
  summary.pending = state.items.filter((item) => item.status === 'pending').length;
  return summary;
}

export function pendingSendSummary(statePath = defaultPendingSendPath()) {
  const state = loadPendingSend(statePath);
  return {
    total: state.items.length,
    pending: state.items.filter((item) => item.status === 'pending'),
    sent: state.items.filter((item) => item.status === 'sent'),
    failed: state.items.filter((item) => item.status === 'failed')
  };
}
