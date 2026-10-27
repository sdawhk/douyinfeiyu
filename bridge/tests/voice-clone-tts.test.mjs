import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { synthesizeVoiceClone, voiceCloneEndpoint } from '../src/voice-clone-tts.mjs';

test('local clone sends the fixed reference to GPT-SoVITS and returns QQ record data', async () => {
  const refAudio = path.join(tmpdir(), `voice-${randomBytes(6).toString('hex')}.wav`);
  writeFileSync(refAudio, 'sample');
  try {
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0); wav.write('WAVE', 8);
    let request;
    const file = await synthesizeVoiceClone('你好', {
      endpoint: 'http://127.0.0.1:9882', refAudio, refText: '这是参考音频。'
    }, async (url, options) => {
      request = { url, ...options };
      return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
    });
    assert.equal(request.url, 'http://127.0.0.1:9882/tts');
    assert.deepEqual(JSON.parse(request.body), {
      text: '你好', text_lang: 'zh', ref_audio_path: refAudio,
      prompt_text: '这是参考音频。', prompt_lang: 'zh',
      media_type: 'wav', streaming_mode: false, text_split_method: 'cut5', batch_size: 1
    });
    assert.equal(file, `base64://${wav.toString('base64')}`);
    assert.throws(() => voiceCloneEndpoint({ endpoint: 'http://example.com:9882' }));
  } finally { unlinkSync(refAudio); }
});
