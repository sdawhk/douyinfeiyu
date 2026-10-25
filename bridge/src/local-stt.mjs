import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_SPEECH_BYTES = 10 * 1024 * 1024;
const MAX_SPEECH_SECONDS = 60;
const DEFAULT_MODEL_DIR = 'D:/deepseek/state/voice-asr';
const require = createRequire(import.meta.url);
const dshModules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dshcli/node_modules');
let recognizerPromise;
let recognizerDir;
let pending = Promise.resolve();

function sherpaModules() {
  try {
    return { sherpa: require('sherpa-onnx-node'), addon: require('sherpa-onnx-node/addon.js') };
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return {
      sherpa: require(path.join(dshModules, 'sherpa-onnx-node', 'sherpa-onnx.js')),
      addon: require(path.join(dshModules, 'sherpa-onnx-node', 'addon.js'))
    };
  }
}

export function validateSpeechWave(audio) {
  if (!Buffer.isBuffer(audio) || !audio.length || audio.length > MAX_SPEECH_BYTES) {
    throw new Error('语音为空或超过 10 MB');
  }
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF'
      || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('QQ 没有返回 WAV 语音');
  }
}

async function loadRecognizer(modelDir) {
  const model = path.join(modelDir, 'model.int8.onnx');
  const tokens = path.join(modelDir, 'tokens.txt');
  if (!existsSync(model) || !existsSync(tokens)) {
    throw new Error(`离线语音识别模型未安装：${modelDir}`);
  }
  const { sherpa, addon } = sherpaModules();
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model, language: 'zh', useInverseTextNormalization: 1 },
      tokens, numThreads: 2, provider: 'cpu', debug: 0
    }
  });
  return { addon, recognizer };
}

export async function transcribeLocalSpeech(audio, config = {}) {
  validateSpeechWave(audio);
  const modelDir = path.resolve(config.modelDir || DEFAULT_MODEL_DIR);
  const task = pending.then(async () => {
    if (!recognizerPromise || recognizerDir !== modelDir) {
      recognizerDir = modelDir;
      recognizerPromise = loadRecognizer(modelDir).catch((error) => {
        recognizerPromise = null;
        throw error;
      });
    }
    const { addon, recognizer } = await recognizerPromise;
    const wave = addon.readWaveFromBinary(audio);
    if (!wave?.sampleRate || !wave?.samples?.length) throw new Error('语音没有可识别的音频');
    if (wave.samples.length / wave.sampleRate > MAX_SPEECH_SECONDS) throw new Error('语音超过 60 秒');
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    const result = await recognizer.decodeAsync(stream);
    const text = String(result?.text ?? '').trim().slice(0, 2000);
    if (!text) throw new Error('语音识别没有返回文字');
    return text;
  });
  pending = task.catch(() => {});
  return task;
}
