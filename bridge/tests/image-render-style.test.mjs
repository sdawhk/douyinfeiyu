import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeImageGenConfig, normalizeImageGenChain, applyRequestOverrides, resolveDrawPlan,
  buildPromptParts, buildImageRequest, assertPromptBudget, generateImage,
  RENDER_STYLE_NAMES, RENDER_STYLE_VERSION, HAIRSTYLE_NAMES, OUTFIT_NAMES, STYLE_PRESET_NAMES
} from '../src/image-gen.mjs';
import { normalizeDrawToolArgs } from '../src/image-draw-tool.mjs';

const base = { provider: 'ark', model: 'preview-model', apiKey: 'test-key',
  outfit: 'maid', framing: 'full', vibe: 'mature', hairstyle: 'none', tail: 'optional' };
const scene = '站在雪后的石桥上，轻轻回头，远处是松林与山峰。';
const partsFor = (c, description = scene) => buildPromptParts(description, c.stylePrompt, c.negativePrompt, c.characterPrompt,
  { renderStyle: c.renderStyle, logger: () => {} });

function png() {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(1024, 16);
  bytes.writeUInt32BE(1536, 20);
  return bytes;
}

test('画风参数独立于构图，默认兼容，非法值与冲突提前拒绝', () => {
  const original = normalizeImageGenConfig(base);
  const legacy = normalizeImageGenConfig({ ...base, renderStyle: 'legacy' });
  assert.equal(original.stylePrompt, legacy.stylePrompt);
  assert.equal(original.negativePrompt, legacy.negativePrompt);
  assert.equal(original.renderStyleSource, 'default');
  const request = applyRequestOverrides({ ...base, renderStyle: 'gentle_anime' }, { renderStyle: 'mono_manga', stylePreset: 'maid' });
  const c = normalizeImageGenConfig(request);
  assert.equal(c.renderStyle, 'mono_manga');
  assert.equal(c.renderStyleSource, 'request');
  assert.equal(c.stylePreset, 'maid');
  assert.equal(normalizeImageGenConfig({ ...base, renderStyle: 'battle_sketch' }).renderStyleSource, 'config');
  assert.throws(() => normalizeImageGenConfig({ ...base, renderStyle: 'unknown' }), /renderStyle/);
  assert.throws(() => normalizeImageGenConfig({ ...base, renderStyle: 'mono_manga', stylePrompt: '原半厚涂' }), /stylePrompt 冲突/);
  assert.throws(() => normalizeImageGenConfig({ ...base, renderStyle: 'mono_manga', styleNotes: '使用彩色高光' }), /画风冲突/);
  assert.doesNotThrow(() => normalizeImageGenConfig({ ...base, renderStyle: 'mono_manga', styleNotes: '禁止彩色，禁止厚涂' }));
  assert.equal(normalizeDrawToolArgs({ prompt: scene, renderStyle: 'mono_manga' }).request.renderStyle, 'mono_manga');
  assert.equal(normalizeDrawToolArgs({ prompt: scene, renderStyle: 'bad' }).ok, false);
  // 原有调用者在归一化后修改分层的行为继续兼容。
  const edited = normalizeImageGenConfig({ ...original, promptLayers: { quality: '自定义画法' } });
  assert.equal(edited.promptLayers.quality, '自定义画法');
});

test('新三档全身/胸像与重复归一化不混入旧画法；切回原画法恢复本色', () => {
  for (const renderStyle of RENDER_STYLE_NAMES.slice(1)) {
    for (const framing of ['full', 'bust']) {
      const c = normalizeImageGenConfig({ ...base, renderStyle, framing });
      const again = normalizeImageGenConfig(c);
      assert.equal(again.stylePrompt, c.stylePrompt);
      assert.equal(again.negativePrompt, c.negativePrompt);
      assert.equal(c.effectiveFaceStyle, renderStyle);
      assert.doesNotMatch(c.promptLayers.quality, /高质量日系半厚涂/);
      assert.doesNotMatch(c.promptLayers.faceStyle, /皮肤空气刷|冷粉低饱和唇|线稿1px深蓝/);
      assert.doesNotMatch(c.promptLayers.keepUnchanged, /五官画法与肤色/);
      assert.match(c.promptLayers.character, /成年女性/);
      assert.match(c.promptLayers.character, /半杏眼/);
      assert.match(c.promptLayers.character, /鲸鳍状耳/);
      assert.match(c.promptLayers.character, /鲸鱼造型发饰/);
      assert.doesNotMatch(c.promptLayers.clothing, /真实折痕|褶脊柔光/);
      if (renderStyle === 'mono_manga') {
        assert.doesNotMatch(c.promptLayers.character, /宝蓝|深海蓝/);
        assert.doesNotMatch(c.promptLayers.expression, /淡粉|泛红/);
        assert.doesNotMatch(c.negativePrompt, /(?:^|、)黑发(?:、|$)/);
      } else assert.match(c.promptLayers.character, /纯宝蓝/);
      assert.equal(new Set(c.negativePrompt.split('、')).size, c.negativePrompt.split('、').length);
      const restored = normalizeImageGenConfig({ ...c, renderStyle: 'legacy' });
      assert.match(restored.promptLayers.character, /纯宝蓝/);
      assert.match(restored.promptLayers.quality, /半厚涂/);
    }
  }
});

test('三套画风跨服装、景别和预设满足预算，场景在模板接近上限时仍保留', () => {
  for (const renderStyle of RENDER_STYLE_NAMES.slice(1)) {
    for (const outfit of OUTFIT_NAMES) {
      for (const framing of ['full', 'medium', 'closeup', 'bust']) {
        for (const stylePreset of STYLE_PRESET_NAMES) {
          const c = normalizeImageGenConfig({ ...base, renderStyle, outfit, framing, stylePreset, tail: 'required' });
          const parts = partsFor(c);
          assertPromptBudget(parts);
          assert.equal(parts.descriptionTrimmed, false, `${renderStyle}/${outfit}/${framing}/${stylePreset}`);
          assert.ok(parts.positive.endsWith(scene));
        }
      }
    }
    const c = normalizeImageGenConfig({ ...base, renderStyle });
    const short = '奔跑回头看向桥边，松树积雪被风吹落，桥下流水清晰';
    const almostFull = `【画质与风格】${'画'.repeat(730)}；【背景与氛围】${'景'.repeat(24)}`;
    const reserved = buildPromptParts(short, almostFull, '', '', { renderStyle, logger: () => {} });
    assert.equal(reserved.descriptionTrimmed, false);
    assert.ok(reserved.positive.endsWith(short));
    assert.deepEqual(reserved.droppedLayers, ['background']);
    assertPromptBudget(partsFor(c, '动作与环境细节'.repeat(80)));
  }
});

test('风格负向真正进入 Ark / Qwen / 文本请求，备用后端不改变全局画风', () => {
  const c = normalizeImageGenConfig({ ...base, renderStyle: 'mono_manga' });
  const parts = partsFor(c);
  const ark = JSON.parse(buildImageRequest(c, parts).init.body);
  assert.match(ark.prompt, /【严格禁止】.*彩色.*厚涂/);
  const qwen = normalizeImageGenConfig({ ...base, provider: 'dashscope', renderStyle: 'mono_manga' });
  const dash = JSON.parse(buildImageRequest(qwen, parts).init.body);
  assert.match(dash.parameters.negative_prompt, /彩色/);
  const text = JSON.parse(buildImageRequest({ ...c, provider: 'openai' }, parts).init.body);
  assert.match(text.prompt, /【严格禁止】.*彩色/);
  const chain = normalizeImageGenChain({ ...base, renderStyle: 'mono_manga', chain: [
    { provider: 'ark', renderStyle: 'gentle_anime' },
    { provider: 'dashscope', renderStyle: 'battle_sketch' }
  ], providers: { dashscope: { renderStyle: 'legacy' } } });
  assert.ok(chain.every((entry) => entry.renderStyle === 'mono_manga'));
});

test('真实生成流程的备用后端、动态发型/表情、灰阶检测与落盘元数据一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-style-'));
  const bytes = png();
  const reference = `data:image/png;base64,${bytes.toString('base64')}`;
  const seen = [];
  let ratioCalls = 0;
  try {
    const result = await generateImage({
      description: scene, expression: 'happy', hairstyle: HAIRSTYLE_NAMES[0],
      renderStyle: 'mono_manga', isOwner: true, isGroup: false,
      config: { ...base, defaultReferenceImages: [reference], renderStyle: 'gentle_anime', maxRetries: 0,
        chain: [{ provider: 'ark' }, { provider: 'dashscope', apiKey: 'test-key', when: 'onError' }] }
    }, {
      stateDir: dir, logger: () => {}, inspectImage: async () => ({ appropriate: true }),
      measureHeadBodyRatio: () => { ratioCalls++; return { headBodyRatio: 9 }; },
      ensureMonochrome: async (buffer) => ({ buffer, mime: 'image/png', method: 'test-grayscale' }),
      fetchImpl: async (url, init) => {
        if (String(url).includes('cdn.example')) return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes };
        const body = JSON.parse(init.body);
        seen.push(body);
        if (body.model === 'preview-model') return { ok: false, status: 400, text: async () => 'test failure' };
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({
          output: { choices: [{ message: { content: [{ image: 'https://cdn.example/out.png' }] } }] }
        }) };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 2);
    assert.equal(result.provider, 'dashscope');
    assert.equal(result.meta.renderStyle, 'mono_manga');
    assert.equal(result.meta.renderStyleSource, 'request');
    assert.equal(result.meta.renderStyleVersion, RENDER_STYLE_VERSION);
    assert.equal(result.meta.effectiveFaceStyle, 'mono_manga');
    assert.equal(result.meta.expression, 'happy');
    assert.doesNotMatch(result.meta.prompt, /脸颊与鼻尖泛红/);
    assert.equal(ratioCalls, 0);
    assert.equal(result.meta.proportion.applicable, false);
    assert.equal(result.meta.proportion.retried, false);
    assert.equal(result.meta.colorProcessing.applied, true);
    assert.equal(result.meta.providerPrompts.length, 2);
    assert.equal(result.meta.providerPrompts[0].positive, seen[0].prompt);
    assert.match(result.meta.providerPrompts[1].negative, /彩色/);
    assert.ok(result.meta.providerPrompts.every((item) => item.seedSent === false));
    assert.doesNotMatch(JSON.stringify(result.meta), /test-key|headers|data:image/);
    const saved = JSON.parse(readFileSync(result.metaPath, 'utf8'));
    assert.equal(saved.renderStyle, 'mono_manga');
    assert.equal(resolveDrawPlan({ config: normalizeImageGenConfig(base) }).renderStyle, 'legacy');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('黑白后处理失败不会保存不合格的彩色结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-style-failure-'));
  try {
    const result = await generateImage({ description: scene, renderStyle: 'mono_manga',
      config: { ...base, referencePolicy: 'optional' }
    }, {
      stateDir: dir, logger: () => {}, inspectImage: async () => ({ appropriate: true }),
      ensureMonochrome: async () => { throw new Error('test processing unavailable'); },
      fetchImpl: async () => ({ ok: true, headers: { get: () => 'application/json' },
        json: async () => ({ data: [{ b64_json: png().toString('base64') }] }) })
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'render-style-processing');
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
