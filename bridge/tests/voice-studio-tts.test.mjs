import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeVoiceStudio, voiceStudioSpeechEndpoint } from '../src/voice-studio-tts.mjs';

test('VoiceStudio uses its loopback OpenAI-compatible endpoint and returns a validated WAV', async () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.write('WAVE', 8);
  let request;
  const file = await synthesizeVoiceStudio('  你好\n世界  ', {
    endpoint: 'http://127.0.0.1:3900', model: 'omnivoice', voiceId: '86ee630c'
  }, async (url, options) => {
    request = { url, ...options };
    return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
  });
  assert.equal(request.url, 'http://127.0.0.1:3900/v1/audio/speech');
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), {
    model: 'omnivoice', voice: '86ee630c', input: '你好 世界', response_format: 'wav'
  });
  assert.equal(file, `base64://${wav.toString('base64')}`);
});

test('VoiceStudio endpoint is restricted to loopback HTTP and IDs are validated', async () => {
  assert.equal(voiceStudioSpeechEndpoint({ endpoint: 'http://localhost:3900/' }), 'http://localhost:3900/v1/audio/speech');
  assert.throws(() => voiceStudioSpeechEndpoint({ endpoint: 'https://127.0.0.1:3900' }));
  assert.throws(() => voiceStudioSpeechEndpoint({ endpoint: 'http://example.com:3900' }));
  await assert.rejects(() => synthesizeVoiceStudio('你好', {
    endpoint: 'http://127.0.0.1:3900', voiceId: 'bad/id'
  }, async () => { throw new Error('request should not run'); }));
});

test('VoiceStudio combines its timeout with an external cancellation signal', async () => {
  const controller = new AbortController();
  let observedSignal;
  const pending = synthesizeVoiceStudio('你好', {
    endpoint: 'http://127.0.0.1:3900', model: 'omnivoice', voiceId: '86ee630c'
  }, async (_url, options) => {
    observedSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  }, controller.signal);
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(pending, /cancelled by caller/);
  assert.equal(observedSignal.aborted, true);
});
