export function edgeTtsEndpoint(config) {
  const raw = String(config?.url || 'https://tts.wangwangit.com').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Edge TTS 地址须为 HTTPS 或本机 HTTP');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/v1/audio/speech`;
}

export async function synthesizeEdgeSpeech(text, config, fetchImpl = fetch) {
  const input = String(text || '').trim().slice(0, 1000);
  if (!input) throw new Error('语音文本为空');
  const response = await fetchImpl(edgeTtsEndpoint(config), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, voice: config?.voice || 'zh-CN-XiaoxiaoNeural', speed: 1, pitch: '0', style: 'general' }),
    signal: AbortSignal.timeout(35_000)
  });
  if (!response.ok) throw new Error(`Edge TTS 合成失败（HTTP ${response.status}）`);
  if (!response.headers.get('content-type')?.includes('audio/')) throw new Error('Edge TTS 未返回音频');
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > 5 * 1024 * 1024) throw new Error('Edge TTS 音频为空或过大');
  return `base64://${audio.toString('base64')}`;
}
