import { dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const cleanHandle = (value) => String(value ?? '').trim().replace(/^@/, '');

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

  return async function replyToInbound({ handle, messageId, text }) {
    if (cleanHandle(handle) !== expectedHandle) throw new Error('Douyin sender is not the configured owner');
    const id = String(messageId ?? '').trim();
    const content = String(text ?? '').trim();
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id) || !content || content.length > 4000) {
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
      const response = String(await generate({ ownerId: String(ownerId), messageId: id, text: content })).trim();
      if (!response) throw new Error('Model returned an empty reply');
      return { ok: true, duplicate: false, reply: response.slice(0, 4000) };
    } finally {
      inFlight.delete(id);
    }
  };
}
