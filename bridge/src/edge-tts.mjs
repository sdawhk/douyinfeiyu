export function edgeTtsEndpoint(config) {
  const raw = String(config?.url || 'https://tts.wangwangit.com').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Edge TTS 地址须为 HTTPS 或本机 HTTP');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/v1/audio/speech`;
}

const EDGE_VOICE_STYLES = {
  'zh-CN-XiaoxiaoNeural': new Set(['affectionate', 'angry', 'assistant', 'calm', 'chat', 'chat-casual', 'cheerful', 'customerservice', 'disgruntled', 'excited', 'fearful', 'friendly', 'gentle', 'lyrical', 'newscast', 'poetry-reading', 'sad', 'serious', 'sorry', 'whispering']),
  'zh-CN-XiaoyiNeural': new Set(['affectionate', 'angry', 'cheerful', 'disgruntled', 'embarrassed', 'fearful', 'gentle', 'sad', 'serious'])
};

export function inferEdgeSpeechStyle(text, voice = 'zh-CN-XiaoxiaoNeural') {
  const input = String(text ?? '').trim();
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let style = 'chat';
  if (lines.length >= 3 && lines.length <= 12 && lines.every((line) => line.length <= 32)) {
    style = 'lyrical';
  } else if (/(?:辛苦了|难过|伤心|害怕|担心|抱歉|对不起|心疼|遗憾|失望|别怕|慢慢来|没关系)/.test(input)) {
    style = 'gentle';
  } else if (/(?:恭喜|好耶|太好了|开心|期待|惊喜|哈哈|笑死|有趣|可爱|真棒|厉害|成功啦|太感谢)/.test(input)) {
    style = 'cheerful';
  }
  const supported = EDGE_VOICE_STYLES[String(voice)] || new Set(['general']);
  return supported.has(style) ? style : 'general';
}

export async function synthesizeEdgeSpeech(text, config, fetchImpl = fetch) {
  const input = String(text || '').trim().slice(0, 1000);
  if (!input) throw new Error('语音文本为空');
  const voice = config?.voice || 'zh-CN-XiaoxiaoNeural';
  const style = config?.style || inferEdgeSpeechStyle(input, voice);
  const response = await fetchImpl(edgeTtsEndpoint(config), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, voice, speed: 1, pitch: '0', style }),
    signal: AbortSignal.timeout(35_000)
  });
  if (!response.ok) throw new Error(`Edge TTS 合成失败（HTTP ${response.status}）`);
  if (!response.headers.get('content-type')?.includes('audio/')) throw new Error('Edge TTS 未返回音频');
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > 5 * 1024 * 1024) throw new Error('Edge TTS 音频为空或过大');
  return `base64://${audio.toString('base64')}`;
}
