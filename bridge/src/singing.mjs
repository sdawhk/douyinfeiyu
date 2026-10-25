const API = 'https://api.mureka.ai';
const TERMINAL = new Set(['failed', 'timeouted', 'cancelled']);

export function parseSingCommand(text) {
  const input = String(text ?? '').trim();
  const explicit = input.match(/^\/?唱歌(?:\s+|：|:)([\s\S]+)$/);
  if (explicit) return explicit[1].trim().slice(0, 200) || null;

  const natural = input.match(/^(?:(?:我想听(?:你)?|想听(?:你)?|想让你|给我|帮我|给大家|帮大家)\s*)?(?:唱(?:一首|首|个)?(?:原创)?(?:歌|歌曲)|来(?:一首|首|个)?(?:原创)?(?:歌|歌曲))(?:吧|呗|呀|啊|嘛)?(?:[，,：:\s]+([\s\S]+))?$/);
  if (!natural) return null;
  return natural[1]?.trim().slice(0, 200) || '即兴原创短歌';
}

async function request(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(25_000) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`唱歌服务请求失败（HTTP ${response.status}）${result?.error?.message ? `：${String(result.error.message).slice(0, 120)}` : ''}`);
  if (!result || typeof result !== 'object') throw new Error('唱歌服务返回了无效数据');
  return result;
}

export async function generateSong(theme, config, { fetchImpl = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPolls = 48 } = {}) {
  const key = String(config?.apiKey || '').trim();
  if (!key) throw new Error('请先在运行设置中填写 Mureka 音乐 API Key');
  const prompt = `创作一首有真实歌声、旋律和伴奏的中文原创短歌，主题：${theme}。轻快、自然，尽量控制在30秒左右。不要念白。`;
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const submitted = await request(`${API}/v1/song/easy-generate`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'auto', n: 1, prompt })
  }, fetchImpl);
  const taskId = String(submitted.id || '');
  if (!/^[\w-]{1,100}$/.test(taskId)) throw new Error('唱歌服务未返回有效任务编号');
  for (let poll = 0; poll < maxPolls; poll++) {
    if (poll) await wait(5000);
    const task = await request(`${API}/v1/song/query/${encodeURIComponent(taskId)}`, { headers }, fetchImpl);
    if (task.status === 'succeeded') {
      const songUrl = task.choices?.[0]?.url;
      if (!songUrl) throw new Error('唱歌任务已完成，但没有歌曲音频');
      return { url: songUrl, taskId, durationMs: task.choices[0].duration ?? null };
    }
    if (TERMINAL.has(task.status)) throw new Error(`唱歌任务失败：${String(task.failed_reason || task.status).slice(0, 120)}`);
  }
  throw new Error('唱歌任务等待超时，请稍后重试');
}

export async function downloadSong(url, { fetchImpl = fetch, maxBytes = 12 * 1024 * 1024 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/(^|\.)mureka\.(ai|cn)$/.test(parsed.hostname)) {
    throw new Error('唱歌服务返回了不可信的音频地址');
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`下载歌曲失败（HTTP ${response.status}）`);
  const size = Number(response.headers.get('content-length'));
  if (size > maxBytes) { await response.body?.cancel(); throw new Error('歌曲文件过大，无法作为 QQ 语音发送'); }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > maxBytes) throw new Error('歌曲文件为空或过大');
  return audio;
}
