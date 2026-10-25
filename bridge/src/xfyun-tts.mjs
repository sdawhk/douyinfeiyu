import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

export const XFYUN_TTS_URL = 'wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6';

export function xfyunTtsAuth(config, date = new Date().toUTCString()) {
  const apiPassword = String(config?.apiPassword || '').trim();
  if (config?.authMode !== 'signature' && apiPassword) return { url: XFYUN_TTS_URL, headers: { 'x-api-key': apiPassword } };
  const apiKey = String(config?.apiKey || '').trim();
  const apiSecret = String(config?.apiSecret || '').trim();
  if (!apiKey || !apiSecret) throw new Error('讯飞语音合成需要 APIPassword，或 APIKey 与 APISecret');
  const endpoint = new URL(XFYUN_TTS_URL);
  const source = `host: ${endpoint.host}\ndate: ${date}\nGET ${endpoint.pathname} HTTP/1.1`;
  const signature = createHmac('sha256', apiSecret).update(source).digest('base64');
  const authorization = Buffer.from(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`).toString('base64');
  endpoint.searchParams.set('authorization', authorization);
  endpoint.searchParams.set('date', date);
  endpoint.searchParams.set('host', endpoint.host);
  return { url: endpoint.href, headers: {} };
}

export function xfyunTtsRequest(text, config) {
  const content = String(text ?? '').trim();
  if (!content || Buffer.byteLength(content, 'utf8') > 8000 || content.length > 2000) {
    throw new Error('讯飞语音文本需为 1～2000 字，且不超过 8000 字节');
  }
  const appId = String(config?.appId || '').trim();
  if (!appId) throw new Error('讯飞语音合成 APPID 尚未配置');
  return {
    header: { app_id: appId, status: 2 },
    parameter: { tts: {
      vcn: config.voice || 'x5_lingxiaoxuan_flow',
      speed: config.speed ?? 50,
      volume: 50,
      pitch: 50,
      audio: { encoding: 'lame', sample_rate: 24000, channels: 1, bit_depth: 16, frame_size: 0 }
    } },
    payload: { text: {
      encoding: 'utf8', compress: 'raw', format: 'plain', status: 2, seq: 0,
      text: Buffer.from(content).toString('base64')
    } }
  };
}

export async function synthesizeXfyunSpeech(text, config, WebSocketImpl = WebSocket) {
  const request = xfyunTtsRequest(text, config);
  const { url, headers } = xfyunTtsAuth(config);
  return new Promise((resolve, reject) => {
    const chunks = new Map();
    let totalBytes = 0;
    let settled = false;
    const socket = new WebSocketImpl(url, { headers });
    const timeout = setTimeout(() => finish(new Error('讯飞语音合成超时')), 30_000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (socket.readyState === WebSocketImpl.OPEN) socket.close();
        else socket.terminate?.();
      } catch { /* The request is already finishing. */ }
      if (error) return reject(error);
      const audio = Buffer.concat([...chunks.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk));
      if (!audio.length) return reject(new Error('讯飞语音合成返回了空音频'));
      resolve(`base64://${audio.toString('base64')}`);
    }
    socket.on('open', () => socket.send(JSON.stringify(request)));
    socket.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data));
        if (frame.header?.code !== 0) return finish(new Error(`讯飞语音合成失败 (${frame.header?.code ?? '未知错误'})`));
        const part = frame.payload?.audio;
        if (part?.audio) {
          const chunk = Buffer.from(part.audio, 'base64');
          const seq = Number.isInteger(part.seq) ? part.seq : chunks.size;
          totalBytes += chunk.length - (chunks.get(seq)?.length || 0);
          if (totalBytes > 12 * 1024 * 1024) return finish(new Error('讯飞语音合成音频超过大小限制'));
          chunks.set(seq, chunk);
        }
        if (frame.header?.status === 2 || part?.status === 2) finish();
      } catch { finish(new Error('讯飞语音合成返回了无效数据')); }
    });
    socket.on('error', () => finish(new Error('讯飞语音合成连接失败')));
    socket.on('unexpected-response', (_request, response) => finish(new Error(`讯飞语音合成鉴权失败 (${response.statusCode})`)));
    socket.on('close', () => finish(new Error('讯飞语音合成连接提前关闭')));
  });
}
