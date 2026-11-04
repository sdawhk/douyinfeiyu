import test from 'node:test';
import assert from 'node:assert/strict';
import { azureSpeechSsml, escapeXml, synthesizeAzureSpeech, wantsVoiceReply } from '../src/azure-tts.mjs';

test('Azure TTS escapes chat text and constructs Chinese SSML', () => {
  assert.equal(escapeXml(`小鲸 <你好 & "朋友"`), '小鲸 &lt;你好 &amp; &quot;朋友&quot;');
  assert.match(azureSpeechSsml('你好 <世界>', { voice: 'zh-CN-XiaoxiaoNeural', rate: '+15%' }), /xml:lang="zh-CN"/);
  assert.match(azureSpeechSsml('你好 <世界>', { voice: 'zh-CN-XiaoxiaoNeural', rate: '+15%' }), /你好 &lt;世界&gt;/);
});

test('Azure synthesis uses TrueSilk output and returns a OneBot base64 record file', async () => {
  let request;
  const file = await synthesizeAzureSpeech('你好', { key: 'secret', region: 'eastus', voice: 'zh-CN-XiaoxiaoNeural' }, async (url, options) => {
    request = { url, options };
    return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  });
  assert.equal(request.url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(request.options.headers['X-Microsoft-OutputFormat'], 'raw-24khz-16bit-mono-truesilk');
  assert.equal(request.options.headers['Ocp-Apim-Subscription-Key'], 'secret');
  assert.equal(file, 'base64://AQID');
});

test('speech is opt-in by phrase unless automatic mode is selected', () => {
  assert.equal(wantsVoiceReply('今天天气不错'), false);
  assert.equal(wantsVoiceReply('请用语音说出来'), true);
  assert.equal(wantsVoiceReply('发句语音'), true);
  assert.equal(wantsVoiceReply('给我发个语音'), true);
  assert.equal(wantsVoiceReply('语音回答我'), true);
  assert.equal(wantsVoiceReply('背一首静夜思语音背'), true);
  assert.equal(wantsVoiceReply('语音朗读静夜思'), true);
  assert.equal(wantsVoiceReply('朗读静夜思给我听'), true);
  assert.equal(wantsVoiceReply('语音功能怎么样'), false);
  assert.equal(wantsVoiceReply('今天天气不错', 'always'), true);
  assert.equal(wantsVoiceReply('今天天气不错', 'probability', 20, () => 0.19), true);
  assert.equal(wantsVoiceReply('今天天气不错', 'probability', 20, () => 0.2), false);
  assert.equal(wantsVoiceReply('今天天气不错', 'probability', 0, () => 0), false);
  assert.equal(wantsVoiceReply('请用语音说出来', 'probability', 0, () => 0.9), true);
});
