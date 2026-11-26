export function voiceStudioSpeechEndpoint(config) {
  const url = new URL(String(config?.endpoint || '').trim());
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('VoiceStudio 服务地址只接受本机 HTTP 地址');
  }
  return `${url.origin}/v1/audio/speech`;
}

export async function synthesizeVoiceStudio(text, config, fetchImpl = fetch, externalSignal) {
  const input = String(text || '').replace(/\s+/g, ' ').trim();
  if (!input) throw new Error('语音文本为空');
  if (Array.from(input).length > 300) throw new Error('VoiceStudio 单段最多支持 300 字；请先分段');
  const model = String(config?.model || 'omnivoice').trim();
  const voice = String(config?.voiceId || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(model)) throw new Error('VoiceStudio 模型 ID 无效');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(voice)) throw new Error('请填写 VoiceStudio 音色 ID');
  const response = await fetchImpl(voiceStudioSpeechEndpoint(config), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input, language: 'zh', speed: 0.95, response_format: 'wav' }),
    // The local VoiceStudio CPU backend can take several minutes to synthesize.
    signal: externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`VoiceStudio 语音合成失败（HTTP ${response.status}）`);
  if (!response.headers.get('content-type')?.includes('audio/')) throw new Error('VoiceStudio 未返回音频');
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 44 || audio.length > 10 * 1024 * 1024 || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('VoiceStudio 返回的 WAV 无效或过大');
  return `base64://${audio.toString('base64')}`;
}
