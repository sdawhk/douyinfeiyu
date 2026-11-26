// 模型先按漫画画法生成，最后保证输出没有脸红、彩光等残留颜色。
import { spawn } from 'node:child_process';
import { resolveFfmpegPath } from './animated-image.mjs';

export async function ensureMonochrome(buffer, { ffmpegPath, timeoutMs = 15_000, maxOutputBytes = 5 * 1024 * 1024 } = {}) {
  const executable = ffmpegPath || resolveFfmpegPath();
  if (!executable) throw new Error('黑白画风需要项目现有的 ffmpeg，当前未找到可执行文件');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-frames:v', '1', '-vf', 'format=gray', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false;
    let length = 0;
    const chunks = [];
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve({ buffer: Buffer.concat(chunks), mime: 'image/png', method: 'ffmpeg-gray' });
    };
    const timer = setTimeout(() => finish(new Error('黑白画风后处理超时')), timeoutMs);
    child.on('error', () => finish(new Error('无法启动黑白画风后处理程序')));
    child.stdin.on('error', () => finish(new Error('黑白画风后处理读取图片失败')));
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxOutputBytes) return finish(new Error('黑白画风输出超过图片体积上限'));
      chunks.push(chunk);
    });
    child.on('close', (code) => finish(code === 0 && length > 0 ? null : new Error('黑白画风后处理失败')));
    child.stdin.end(buffer);
  });
}
