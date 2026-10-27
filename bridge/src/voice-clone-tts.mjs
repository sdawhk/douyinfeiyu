import { statSync } from 'node:fs';
import path from 'node:path';

export function voiceCloneEndpoint(config) {
  const url = new URL(String(config?.endpoint || '').trim());
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/', '/tts'].includes(url.pathname)) {
    throw new Error('克隆音色服务只接受本机 HTTP 地址');
  }
  return `${url.origin}/tts`;
}

export async function synthesizeVoiceClone(text, config, fetchImpl = fetch) {
  const input = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!input) throw new Error('语音文本为空');
  const refAudio = String(config?.refAudio || '').trim();
  const refText = String(config?.refText || '').trim();
  if (!path.isAbsolute(refAudio) || !refText) throw new Error('请先设置参考音频绝对路径和逐字原文');
  const reference = statSync(refAudio);
  if (!reference.isFile() || reference.size === 0 || reference.size > 32 * 1024 * 1024) {
    throw new Error('参考音频为空或超过 32 MB');
  }
  const response = await fetchImpl(voiceCloneEndpoint(config), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: input, text_lang: 'zh', ref_audio_path: refAudio,
      prompt_text: refText, prompt_lang: 'zh',
      media_type: 'wav', streaming_mode: false, text_split_method: 'cut5', batch_size: 1
    }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`克隆音色合成失败（HTTP ${response.status}）`);
  if (!response.headers.get('content-type')?.includes('audio/')) throw new Error('克隆音色服务未返回音频');
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 44 || audio.length > 10 * 1024 * 1024 || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('克隆音色服务返回的 WAV 无效或过大');
  return `base64://${audio.toString('base64')}`;
}
