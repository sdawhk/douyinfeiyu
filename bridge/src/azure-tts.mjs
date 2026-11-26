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
      'X-Microsoft-OutputFormat': config?.outputFormat || 'raw-24khz-16bit-mono-truesilk',
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

export function wantsVoiceReply(input, mode = 'requested', probability = 20, random = Math.random) {
  const text = String(input ?? '').toLowerCase().replace(/[\s，。！？、,.!?：:；;“”"'‘’（）()【】\[\]<>《》]/g, '');
  const directCue = /^(?:语音|声音|音频|语音一下|发语音|发个语音|来段语音|来个语音)$/i.test(text);
  const voiceIntent = /(?:用|换成|改用|以).{0,8}(?:语音|声音|音频|音色).{0,8}(?:说|讲|读|念|回|回复|回答|告诉|解释|播报)|(?:语音|声音|音频)(?:回复|回答|说|讲|读|念|播报|复述)(?:我|一下|一遍|出来)?|(?:给我|帮我)?(?:发|录|来|说|回|生成|做|整)(?:一个|一段|一条|一句|个|段|条|句)?(?:语音|声音|音频)|(?:说|讲|读|念|朗读|背|背诵|复述|播报).{0,12}(?:给我听|让我听|听听|一遍|出来|出声|开口|用语音|用声音)|(?:读|念|朗读|背|背诵).{0,12}(?:一下|一遍|出来|给我听)|(?:别|不要|不想)(?:再)?(?:打字|发文字)(?:了)?|(?:开口|出声)(?:说|讲|读|念|回答|回复)?/i.test(text);
  return directCue || voiceIntent
    || mode === 'always' || (mode === 'probability' && random() * 100 < probability);
}
