/** Serialize group turns while keeping only the newest useful pending turn. */
export function createLatestGroupTurnQueue(onError = () => {}, onSkip = () => {}) {
  const queues = new Map();

  return function enqueue(key, work, priority = false, metadata = {}) {
    let state = queues.get(key);
    if (!state) {
      state = { revision: 0, pending: null, running: false, promise: null };
      queues.set(key, state);
    }

    if (!(state.pending?.priority && !priority)) {
      const revision = ++state.revision;
      if (state.pending) onSkip(key, state.pending.metadata, metadata);
      state.pending = { work, priority, revision, metadata };
    } else {
      onSkip(key, metadata, state.pending.metadata);
    }

    if (!state.running) {
      state.running = true;
      state.promise = (async () => {
        while (state.pending) {
          const current = state.pending;
          state.pending = null;
          try {
            await current.work(() => state.revision === current.revision);
          } catch (error) {
            onError(error, key);
          }
        }
      })().finally(() => {
        if (queues.get(key) === state) queues.delete(key);
      });
    }

    return state.promise;
  };
}
