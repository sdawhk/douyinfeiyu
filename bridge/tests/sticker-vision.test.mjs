import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStickerImage, visionRetryAfterMs } from '../src/sticker-vision.mjs';

test('vision result includes DeepSeek theme, action and emotion', async () => {
  const result = await inspectStickerImage('abc', 'image/png', {
    models: ['vision-test'], baseUrl: 'http://localhost:1/v1',
    fetcher: async () => ({
      ok: true,
      json: async () => ({ model: 'vision-test', choices: [{ message: { content:
        JSON.stringify({ sticker: true, appropriate: true, sexual_suggestive: false, gross_or_graphic: false,
          name: '开心挥手', caption: '蓝发鲸鱼少女挥手',
          deepseek: true, confidence: 0.91, action: '挥手', emotion: '开心' }) } }] })
    })
  });
  assert.deepEqual({ deepseek: result.deepseek, action: result.action, emotion: result.emotion },
    { deepseek: true, action: '挥手', emotion: '开心' });
  assert.equal(result.confidence, 0.91);
  assert.equal(result.appropriate, true);
  assert.equal(result.sexualSuggestive, false);
  assert.equal(result.grossOrGraphic, false);
});

test('vision results expose sexualized and graphic content flags', async () => {
  const result = await inspectStickerImage('abc', 'image/png', {
    models: ['vision-safety-test'], baseUrl: 'http://localhost:1/v1',
    fetcher: async () => ({
      ok: true,
      json: async () => ({ model: 'vision-safety-test', choices: [{ message: { content:
        JSON.stringify({ sticker: true, appropriate: false, sexual_suggestive: true,
          gross_or_graphic: false, safety_reason: '明显性暗示', caption: '图片', confidence: 0.91 }) } }] })
    })
  });
  assert.equal(result.sexualSuggestive, true);
  assert.equal(result.grossOrGraphic, false);
  assert.equal(result.safetyReason, '明显性暗示');
});

test('a failing visual route cools down instead of being called for every image', async () => {
  let calls = 0;
  const options = {
    models: ['vision-http-503-test'], baseUrl: 'http://localhost:1/v1',
    fetcher: async () => {
      calls++;
      return { ok: false, status: 503, json: async () => ({}) };
    }
  };
  await assert.rejects(inspectStickerImage('abc', 'image/png', options), /HTTP 503/);
  await assert.rejects(inspectStickerImage('abc', 'image/png', options), /cooling down/);
  assert.equal(calls, 1);
  assert.ok(visionRetryAfterMs(options.models) > 0);
  assert.equal(visionRetryAfterMs(['vision-available-test']), 0);
});
