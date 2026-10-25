import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SPEECH_BYTES, validateSpeechWave } from '../src/local-stt.mjs';

test('accepts a QQ WAV header and rejects missing or oversized audio', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  assert.doesNotThrow(() => validateSpeechWave(wav));
  assert.throws(() => validateSpeechWave(Buffer.alloc(0)), /语音为空/);
  assert.throws(() => validateSpeechWave(Buffer.alloc(MAX_SPEECH_BYTES + 1)), /超过 10 MB/);
  assert.throws(() => validateSpeechWave(Buffer.alloc(44)), /WAV/);
});
