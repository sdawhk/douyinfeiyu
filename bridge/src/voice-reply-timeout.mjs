export async function runBoundedVoiceReply(operation, timeoutMs = null) {
  if (timeoutMs == null) return operation(() => {}, () => {}, undefined);
  let expired = false;
  let committed = false;
  let timer;
  const controller = new AbortController();
  const timeoutError = new Error('语音回复超过等待时限');
  const ensureActive = () => {
    if (expired) throw timeoutError;
  };
  const commit = () => {
    ensureActive();
    committed = true;
    clearTimeout(timer);
  };
  const work = Promise.resolve().then(() => operation(ensureActive, commit, controller.signal));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (committed) return;
      expired = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
