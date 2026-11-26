// 用项目真实生图/审核链路生成预览并保存到本地，供画风验收。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateImage, RENDER_STYLES } from '../src/image-gen.mjs';
import { inspectStickerImage } from '../src/sticker-vision.mjs';
import { DRAW_MODERATION_PROMPT } from '../src/image-content-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback = '') {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return args[i + 1];
}
const output = resolve(option('--output', join(root, 'state/render-style-previews')));
const selected = option('--style');
const scenes = [
  { renderStyle: 'gentle_anime', expression: 'gentle', description: '雪后清晨，站在石桥上轻轻回头，手扶栏杆，远处松林与山峰，清新通透的自然光。' },
  { renderStyle: 'battle_sketch', expression: 'serious', description: '雨天城市废墟中站稳蓄势，衣摆被风吹动，脚边有少量蓝黑能量，碎石与断墙形成纵深。' },
  { renderStyle: 'mono_manga', expression: 'gentle', description: '在复古日式小巷侧身静立，手轻扶石墙，石板路与远处建筑形成纵深，神情平静。' }
].filter((item) => !selected || item.renderStyle === selected);
if (!scenes.length) throw new Error('--style 只支持 gentle_anime / battle_sketch / mono_manga');
const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
mkdirSync(output, { recursive: true });
const reportPath = join(output, 'previews.json');
const results = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : [];

for (const scene of scenes) {
  console.log(`[preview] start ${scene.renderStyle}`);
  let summary;
  try {
    const result = await generateImage({
      ...scene, config: cfg.imageGen || {},
      outfit: 'maid', vibe: 'mature', framing: 'full', hairstyle: 'none', tail: 'required',
      isOwner: true, isGroup: false, target: 'preview', chatKey: 'local:render-style-preview', trigger: 'tool'
    }, {
      stateDir: join(output, 'generated'),
      inspectImage: (b64, mime) => inspectStickerImage(b64, mime, {
        baseUrl: cfg.stickerVisionBaseUrl || 'http://127.0.0.1:18901/v1',
        prompt: DRAW_MODERATION_PROMPT,
        models: Array.isArray(cfg.stickerVisionModels) && cfg.stickerVisionModels.length ? cfg.stickerVisionModels : undefined
      })
    });
    if (result.ok) {
      const path = join(output, `${scene.renderStyle}${extname(result.filePath)}`);
      copyFileSync(result.filePath, path);
      summary = { renderStyle: scene.renderStyle, label: RENDER_STYLES[scene.renderStyle].label,
        ok: true, path, metaPath: result.metaPath, provider: result.provider, model: result.model,
        width: result.width, height: result.height, ms: result.ms, promptChars: result.meta.promptChars,
        descriptionTrimmed: result.meta.descriptionTrimmed, droppedLayers: result.meta.droppedLayers,
        moderation: result.meta.moderation, proportion: result.meta.proportion, colorProcessing: result.meta.colorProcessing };
    } else summary = { renderStyle: scene.renderStyle, ok: false, reason: result.reason, error: result.error, attempts: result.attempts };
  } catch (error) {
    summary = { renderStyle: scene.renderStyle, ok: false, error: String(error.message) };
  }
  const previous = results.findIndex((item) => item.renderStyle === scene.renderStyle);
  if (previous < 0) results.push(summary); else results[previous] = summary;
  writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
}
