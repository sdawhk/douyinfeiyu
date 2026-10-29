export async function callOnebotApi({
  httpUrl, token = '', action, params = {}, timeoutMs = 15000, fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const baseUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const audioMessage = /^send_(?:private|group)_msg$/.test(action)
    && Array.isArray(params?.message) && params.message.some((segment) => segment?.type === 'record');
  const maxAttempts = audioMessage ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (audioMessage) error.uncertain = true;
      console.error(`[onebot] ${action} request failed attempt=${attempt}/${maxAttempts} delivery=${audioMessage ? 'uncertain' : 'unknown'}:`, error?.message ?? error);
      throw error;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) {
      const wording = String(body?.wording ?? '');
      const highwayTransportFailed = audioMessage && /highway upload transport failed/i.test(wording);
      const definiteFailure = res.status < 500 && (!res.ok
        || (body?.retcode != null && body.retcode !== 0)
        || (body?.status != null && body.status !== 'ok'));
      if (audioMessage && (definiteFailure || highwayTransportFailed) && attempt < maxAttempts) {
        console.warn(`[onebot] retrying rejected audio send action=${action} attempt=${attempt + 1}/${maxAttempts} reason=${wording || body?.retcode || res.status}`);
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }
      const hint = res.status === 426 ? '（HTTP 426：请检查 snowluma.httpUrl 是否指向 OneBot HTTP API 端口）' : '';
      const error = new Error(`OneBot ${action} 失败：${body?.wording || body?.retcode || res.status}${hint}`);
      if ((!res.ok && res.status >= 500) || (res.ok && (!body || body.status == null || body.retcode == null))) {
        error.uncertain = true;
      }
      if (definiteFailure || highwayTransportFailed) error.definiteDeliveryFailure = true;
      console.error(`[onebot] ${action} rejected attempt=${attempt}/${maxAttempts} delivery=${error.uncertain ? 'uncertain' : error.definiteDeliveryFailure ? 'not-delivered' : 'unknown'}:`, error.message);
      throw error;
    }
    if (attempt > 1) console.info(`[onebot] ${action} audio retry succeeded attempt=${attempt}/${maxAttempts}`);
    return body.data;
  }
}
