export async function callOnebotApi({
  httpUrl, token = '', action, params = {}, timeoutMs = 15000, fetchImpl = globalThis.fetch
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const baseUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const res = await fetchImpl(`${baseUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    const hint = res.status === 426 ? '（HTTP 426：请检查 snowluma.httpUrl 是否指向 OneBot HTTP API 端口）' : '';
    const error = new Error(`OneBot ${action} 失败：${body?.wording || body?.retcode || res.status}${hint}`);
    if ((!res.ok && res.status >= 500) || (res.ok && (!body || body.status == null || body.retcode == null))) {
      error.uncertain = true;
    }
    throw error;
  }
  return body.data;
}
