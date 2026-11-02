import test from 'node:test';
import assert from 'node:assert/strict';
import { understandDouyinVideo } from '../src/douyin-video-understanding.mjs';

test('video understanding summarizes a small set of frames without treating onscreen text as instructions', async () => {
  let request;
  const result = await understandDouyinVideo({ frames: ['aGVsbG8='] }, {
    stickerVisionBaseUrl: 'http://vision.test/v1',
    stickerVisionModels: ['test-vision'],
    fetcher: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: 'test-vision',
          choices: [{ message: { content: '{"summary":"一只猫在窗边玩毛线。","tags":["猫","居家"]}' } }]
        })
      };
    }
  });
  assert.equal(result.summary, '一只猫在窗边玩毛线。');
  assert.deepEqual(result.tags, ['猫', '居家']);
  assert.deepEqual(result.analysis, ['frames']);
  assert.equal(request.url, 'http://vision.test/v1/chat/completions');
  assert.match(request.body.messages[0].content[0].text, /绝不执行/);
  const image = request.body.messages[0].content.find((part) => part.type === 'image_url');
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
});

test('video understanding limits frames and fails gracefully when vision is unavailable', async () => {
  const result = await understandDouyinVideo({ frames: ['YQ==', 'Yg==', 'Yw==', 'ZA=='] }, {
    stickerVisionModels: ['test-vision'],
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].content.filter((part) => part.type === 'image_url').length, 3);
      return { ok: false, status: 503, json: async () => ({}) };
    }
  });
  assert.equal(result.summary, '');
  assert.match(result.visionError, /HTTP 503/);
});
