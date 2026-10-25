import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const modelDir = path.resolve(process.env.ASR_MODEL_DIR || 'D:/deepseek/state/voice-asr');
const base = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/';
const assets = [
  ['model.int8.onnx', 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'],
  ['tokens.txt', 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc']
];

mkdirSync(modelDir, { recursive: true });
for (const [name, expectedHash] of assets) {
  const target = path.join(modelDir, name);
  if (existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') === expectedHash) {
    console.log(`${name}: already verified`);
    continue;
  }
  const temporary = `${target}.part`;
  try {
    const response = await fetch(`${base}${name}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const hash = createHash('sha256');
    const output = createWriteStream(temporary);
    let bytes = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    if (hash.digest('hex') !== expectedHash) throw new Error(`${name}: SHA-256 mismatch`);
    renameSync(temporary, target);
    console.log(`${name}: verified (${bytes} bytes)`);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
