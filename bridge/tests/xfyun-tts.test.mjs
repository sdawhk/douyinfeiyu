import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { xfyunTtsAuth, xfyunTtsRequest, synthesizeXfyunSpeech, XFYUN_TTS_URL } from '../src/xfyun-tts.mjs';

test('讯飞超拟人合成请求使用独立凭据和 base64 文本', () => {
  const config = { appId: '12345678', authMode: 'password', apiPassword: 'tts-password', voice: 'x5_lingxiaoxuan_flow', speed: 55 };
  assert.deepEqual(xfyunTtsAuth(config), { url: XFYUN_TTS_URL, headers: { 'x-api-key': 'tts-password' } });
  const request = xfyunTtsRequest('你好', config);
  assert.equal(request.header.app_id, '12345678');
  assert.equal(request.header.status, 2);
  assert.equal(request.parameter.tts.audio.encoding, 'lame');
  assert.equal(request.parameter.tts.vcn, 'x5_lingxiaoxuan_flow');
  assert.equal(Buffer.from(request.payload.text.text, 'base64').toString(), '你好');
  assert.equal(request.payload.text.status, 2);
});

test('APIKey 与 APISecret 签名鉴权不把密钥放入请求头', () => {
  const auth = xfyunTtsAuth({ authMode: 'signature', apiKey: 'key', apiSecret: 'secret', apiPassword: 'old-password' }, 'Sun, 25 Oct 2026 00:00:00 GMT');
  assert.deepEqual(auth.headers, {});
  const url = new URL(auth.url);
  assert.equal(url.origin + url.pathname, XFYUN_TTS_URL);
  assert.equal(url.searchParams.get('date'), 'Sun, 25 Oct 2026 00:00:00 GMT');
  assert.match(Buffer.from(url.searchParams.get('authorization'), 'base64').toString(), /api_key="key".*signature="[A-Za-z0-9+/=]+"/);
});

test('讯飞返回乱序音频帧时按 seq 拼接 QQ 语音', async () => {
  let observed;
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor(url, options) { super(); observed = { url, options }; queueMicrotask(() => this.emit('open')); }
    send(value) {
      observed.request = JSON.parse(value);
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ header: { code: 0, status: 1 }, payload: { audio: { seq: 1, status: 1, audio: Buffer.from('B').toString('base64') } } }));
        this.emit('message', JSON.stringify({ header: { code: 0, status: 2 }, payload: { audio: { seq: 0, status: 2, audio: Buffer.from('A').toString('base64') } } }));
      });
    }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const file = await synthesizeXfyunSpeech('你好', { appId: '12345678', apiPassword: 'tts-password' }, FakeSocket);
  assert.equal(file, `base64://${Buffer.from('AB').toString('base64')}`);
  assert.equal(observed.options.headers['x-api-key'], 'tts-password');
  assert.equal(Buffer.from(observed.request.payload.text.text, 'base64').toString(), '你好');
});

test('讯飞未配置语音凭据或连接提前关闭时明确失败', async () => {
  await assert.rejects(synthesizeXfyunSpeech('你好', { appId: '12345678' }), /需要 APIPassword/);
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send() { queueMicrotask(() => this.emit('close')); }
    close() {}
  }
  await assert.rejects(synthesizeXfyunSpeech('你好', { appId: '12345678', apiPassword: 'password' }, FakeSocket), /提前关闭/);
});
