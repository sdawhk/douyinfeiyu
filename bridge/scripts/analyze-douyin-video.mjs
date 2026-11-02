import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { understandDouyinVideo } from '../src/douyin-video-understanding.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8'));
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 14_000_000) throw new Error('视频分析输入过大');
}
const payload = JSON.parse(input);
const frames = Array.isArray(payload.frames) ? payload.frames : [];
const audioWav = typeof payload.audioWav === 'string' ? Buffer.from(payload.audioWav, 'base64') : Buffer.alloc(0);
const result = await understandDouyinVideo({ frames, audioWav }, config);
process.stdout.write(JSON.stringify(result));
