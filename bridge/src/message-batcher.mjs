/** Collect a short burst of messages from one speaker before one model turn. */
export function createMessageBatcher(deliver, onError = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now) {
  const pending = new Map();

  function flush(key) {
    const batch = pending.get(key);
    if (!batch) return;
    pending.delete(key);
    timers.clearTimeout(batch.timer);
    Promise.resolve().then(() => deliver(key, batch.messages)).catch((error) => onError(error, key));
  }

  return {
    add(key, message, idleMs, maxMs, maxCount = 8) {
      let batch = pending.get(key);
      if (batch && now() - batch.startedAt >= maxMs) {
        flush(key);
        batch = null;
      }
      if (!batch) {
        batch = { messages: [], startedAt: now(), timer: null };
        pending.set(key, batch);
      }
      batch.messages.push(message);
      timers.clearTimeout(batch.timer);
      if (batch.messages.length >= maxCount) {
        flush(key);
        return;
      }
      const remaining = Math.max(0, maxMs - (now() - batch.startedAt));
      batch.timer = timers.setTimeout(() => flush(key), Math.min(idleMs, remaining));
    },
    drop(key) {
      const batch = pending.get(key);
      if (!batch) return 0;
      pending.delete(key);
      timers.clearTimeout(batch.timer);
      return batch.messages.length;
    },
    flush
  };
}
