// 本机 Python edge-tts 直连微软端点合成语音。
//
// 背景：原先 18902 的 /v1/audio/speech 把合成转发到 Cloudflare Worker
// （edge-tts1.<qq>.workers.dev）。workers.dev 在国内被 DNS 污染，解析到了
// Facebook 网段，TCP 443 连不通，于是每次语音都返回 502，
// qq-bot 的 sendReply 静默回退成文字——表现为"要求语音却只发文字"。
//
// speech.platform.bing.com 本机直连实测 TLS 可达，所以改用 venv 里的
// edge-tts 包直接合成，不再依赖任何外部中转。
//
// 注意：这台机器设了用户级 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:12450，
// 而代理软件经常没在运行。Python 会照用这些变量，于是全部请求会
// "ConnectionRefusedError 10061"。这里用 childEnv() 在代理不通时剔除变量直连。

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv, proxyAlive } from './proxy-env.mjs';

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// 独立 venv，不跟唱歌的 RVC 环境混用，避免依赖互相干扰。
export const EDGE_TTS_PYTHON = path.resolve(
  process.env.EDGE_TTS_PYTHON || path.join(APP_ROOT, 'state', 'edge-tts', 'venv', 'Scripts', 'python.exe')
);

const MAX_TEXT_CHARS = 1000;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const WORK_ROOT = path.join(APP_ROOT, 'state', 'edge-tts', 'work');

export function edgeTtsLocalReady() {
  return existsSync(EDGE_TTS_PYTHON);
}

function runPython(python, args, timeoutMs, env, errFile) {
  return new Promise((resolve, reject) => {
    // stderr 重定向到文件而不是管道：命名管道在受限环境下不可用，
    // 且长文本合成时管道缓冲也可能阻塞子进程。
    const fd = openSync(errFile, 'w');
    const child = spawn(python, args, { windowsHide: true, env, stdio: ['ignore', 'ignore', fd] });
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; try { closeSync(fd); } catch {} fn(); };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`本机 Edge TTS 合成超时（${Math.round(timeoutMs / 1000)} 秒）`)));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`本机 Edge TTS 无法启动 Python：${error.message}`)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return finish(() => resolve());
      let detail = '';
      try { detail = readFileSync(errFile, 'utf8'); } catch {}
      const tail = detail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300);
      finish(() => reject(new Error(`本机 Edge TTS 合成失败（exit ${code}）${tail ? `：${tail}` : ''}`)));
    });
  });
}

/**
 * 用本机 edge-tts 合成语音。
 * 先直连微软（这台机器实测 speech.platform.bing.com 直连可达）；
 * 失败且本机代理恰好在运行时再走一次代理，覆盖只允许代理出网的网络环境。
 * @param {string} text 待合成文本
 * @param {{ voice?: string, timeoutMs?: number }} config
 * @returns {Promise<string>} `base64://<mp3>`
 */
export async function synthesizeEdgeSpeechLocal(text, config = {}) {
  const input = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!input) throw new Error('语音文本为空');
  if (!edgeTtsLocalReady()) {
    throw new Error(`本机 Edge TTS 环境未就绪：缺少 ${EDGE_TTS_PYTHON}（请运行 repo/bridge/scripts/setup-edge-tts.ps1）`);
  }
  const voice = String(config.voice || 'zh-CN-XiaoxiaoNeural');
  // 默认 20 秒：qq-bot 侧 synthesizeEdgeSpeech 对本机 18902 的 fetch 上限是 35 秒，
  // 合成必须明显快于它才会真正发出语音，而不是被上游超时掐断回退成文字。
  // 直连失败时只有本机代理确实在运行才会再重试一次，两次合计仍在预算内。
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 20_000;
  const directEnv = await childEnv({ PYTHONUTF8: '1' });
  for (const key of PROXY_KEYS) delete directEnv[key];
  directEnv.NO_PROXY = '*';
  directEnv.no_proxy = '*';

  let firstError;
  try {
    return await synthesize(input, voice, timeoutMs, directEnv);
  } catch (error) {
    firstError = error;
  }
  if (!await proxyAlive()) throw firstError;
  const proxiedEnv = await childEnv({ PYTHONUTF8: '1' });
  try {
    return await synthesize(input, voice, timeoutMs, proxiedEnv);
  } catch (error) {
    throw new Error(`${String(firstError.message).slice(0, 140)}；代理重试也失败（${String(error.message).slice(0, 140)}）`);
  }
}

async function synthesize(input, voice, timeoutMs, env) {
  await mkdir(WORK_ROOT, { recursive: true });
  const work = await mkdtemp(path.join(WORK_ROOT, 'tts-'));
  const media = path.join(work, 'speech.mp3');
  try {
    // 文本走文件传，避免命令行引号/换行/长度问题。
    const textFile = path.join(work, 'input.txt');
    await writeFile(textFile, input, 'utf8');
    await runPython(EDGE_TTS_PYTHON, [
      '-m', 'edge_tts',
      '--voice', voice,
      '--file', textFile,
      '--write-media', media
    ], timeoutMs, env, path.join(work, 'stderr.txt'));
    const audio = await readFile(media);
    if (!audio.length) throw new Error('本机 Edge TTS 返回了空音频');
    if (audio.length > MAX_AUDIO_BYTES) throw new Error('本机 Edge TTS 音频过大');
    return `base64://${audio.toString('base64')}`;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
