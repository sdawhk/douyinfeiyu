export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[char]);
}

export function azureSpeechSsml(text, { voice = 'zh-CN-XiaoxiaoNeural', rate = '0%' } = {}) {
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"><prosody rate="${escapeXml(rate)}">${escapeXml(text)}</prosody></voice></speak>`;
}

export async function synthesizeAzureSpeech(text, config, fetchImpl = fetch) {
  const region = String(config?.region || '').trim();
  const key = String(config?.key || '').trim();
  if (!region || !key) throw new Error('Azure Speech 区域或 Key 尚未配置');
  const response = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-truesilk',
      'User-Agent': 'qq-bridge'
    },
    body: azureSpeechSsml(text, config),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Azure Speech 请求失败 (${response.status})`);
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error('Azure Speech 返回了空音频');
  return `base64://${audio.toString('base64')}`;
}

export function wantsVoiceReply(input, mode = 'requested') {
  return mode === 'always' || /(?:语音说|用语音|发语音|说出来|语音回复)/i.test(String(input ?? ''));
}
