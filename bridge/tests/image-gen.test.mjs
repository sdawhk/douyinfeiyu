import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildImageRequest, buildPrompt, buildPromptParts, createImageGenQuota, decideImageAccess, generateImage, localDayKey,
  normalizeImageGenConfig, normalizeImageGenChain, normalizeProvider, normalizeReferenceImages, parseImageCommand,
  pickRandomTheme, pollinationsFallbackConfig, providerCapabilities, readImageDimensions, resetProviderCooldown,
  sanitizeDrawDescription, shouldDrawRandomly, sniffImageMime, stripMentionPrefix, toImageSegment,
  STYLE_PRESET_NAMES, OUTFIT_NAMES, pickOutfit, drawFailureReply, isQuotaExhausted,
  EXPRESSION_NAMES, EXPRESSIONS, resolveExpression, inferExpression, expressionLayerFor,
  VIBE_MODES, VIBES, pickVibe, resolveVibe, outfitPoolForVibe, PRIVATE_ONLY_OUTFITS,
  HAIRSTYLES, HAIRSTYLE_NAMES, DEFAULT_HAIRSTYLE, normalizeHairstyle, pickHairstyle, pickHairstyleForChat, resolveHairstyle, hairstyleLayerFor, PROMPT_LAYER_ORDER,
  FABRICS, clothingLayerFor, mergeNegativeTerms, DEFAULT_NEGATIVE_PROMPT,
  FRAMINGS, FRAMING_NAMES, DEFAULT_FRAMING, normalizeFraming, resolveFraming, framingLayerFor,
  PROMPT_BUDGET, measurePromptChars, assertPromptBudget, strengthenProportionPrompt, normalizeProportionCheckConfig,
  FACE_STYLE_NAMES, FACE_STYLES, DEFAULT_FACE_STYLE, FACE_STYLE_PRIORITY, faceStyleLayerFor, resolveFaceStyle,
  SCENE_FRAMING_NAMES, SCENE_FRAMINGS, BACKGROUND_DETAIL_NAMES, BACKGROUND_DETAILS,
  normalizeSceneFraming, normalizeBackgroundDetail
} from '../src/image-gen.mjs';
import { inspectDrawPrompt, shouldBlockImageStorage, DRAW_MODERATION_PROMPT } from '../src/image-content-policy.mjs';
import { findImageMeta, formatSelfDrawnTag, readImageMeta } from '../src/image-gen-meta.mjs';
import { recentImageFollowupContext, selfDrawnImageDescription } from '../src/recent-image-context.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
// 生成类用例显式指定 provider，避免依赖“未配置时的默认值”。
const POLL = () => normalizeImageGenConfig({ provider: 'pollinations', model: 'flux' });

function pngWithSize(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function okResponse(buffer = PNG, type = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => type },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
}

function okOpenaiResponse(buffer = PNG) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: [{ b64_json: buffer.toString('base64') }] })
  };
}

function tempState() {
  return mkdtempSync(join(tmpdir(), 'imagegen-'));
}

test('provider 解析与配置收敛', () => {
  assert.equal(normalizeProvider('pollinations'), 'pollinations');
  assert.equal(normalizeProvider('OpenAI'), 'openai');
  assert.equal(normalizeProvider('zhipu'), 'openai');
  assert.equal(normalizeProvider('dashscope'), 'dashscope');
  assert.equal(normalizeProvider('qwen'), 'dashscope');
  assert.equal(normalizeProvider(''), 'openai');
  assert.throws(() => normalizeProvider('unknown'), /不支持的图片 provider/);

  const config = normalizeImageGenConfig({
    provider: 'zhipu', width: 9999, height: 'abc', groupDailyLimit: 99, groupUserCooldownMs: -5,
    randomChance: 500, enabled: false, allowGroup: true
  });
  assert.equal(config.provider, 'openai');
  assert.equal(config.width, 1536);
  assert.equal(config.height, 1024);
  assert.equal(config.groupDailyLimit, 20);
  assert.equal(config.groupUserCooldownMs, 0);
  assert.equal(config.randomChance, 100);
  assert.equal(config.enabled, false);
  assert.equal(config.allowGroup, true);
  assert.equal(config.size, '1536x1024');
});

test('pollinations 与 openai 兼容请求格式', () => {
  const pollinations = normalizeImageGenConfig({ provider: 'pollinations' });
  const poll = buildImageRequest(pollinations, '一只蓝鲸', { seed: 42 });
  assert.match(poll.url, /^https:\/\/image\.pollinations\.ai\/prompt\//);
  assert.match(poll.url, /width=1024/);
  assert.match(poll.url, /height=1536/);
  assert.match(poll.url, /nologo=true/);
  assert.match(poll.url, /model=flux/);
  assert.match(poll.url, /seed=42/);
  assert.equal(poll.init.method, 'GET');

  const openai = normalizeImageGenConfig({ provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'cogview-3-flash', apiKey: 'k' });
  const request = buildImageRequest(openai, '一只蓝鲸');
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/images/generations');
  assert.equal(request.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(request.init.body);
  assert.equal(body.prompt, '一只蓝鲸');
  assert.equal(body.size, '1024x1536');
  assert.equal(body.model, 'cogview-3-flash');
  assert.ok(!('response_format' in body), '智谱默认不传 response_format');

  const b64Config = normalizeImageGenConfig({ provider: 'openai', baseUrl: 'https://x', responseFormat: 'b64_json' });
  assert.equal(JSON.parse(buildImageRequest(b64Config, 'p').init.body).response_format, 'b64_json');
});

test('ARK provider：别名、provider 档案、参考图与请求体', () => {
  assert.equal(normalizeProvider('ark'), 'ark');
  assert.equal(normalizeProvider('seedream'), 'ark');
  assert.equal(normalizeProvider('volcengine'), 'ark');

  const config = normalizeImageGenConfig({
    provider: 'ark',
    providers: { ark: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-0-250828', apiKey: 'k-ark' } },
    width: 1024,
    height: 1536,
    negativePrompt: '幼态、水印、紫发、紫色'
  });
  assert.equal(config.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(config.model, 'doubao-seedream-4-0-250828');
  assert.equal(config.apiKey, 'k-ark');
  assert.equal(config.referencePolicy, 'require');
  assert.equal(config.capabilities.referenceImage, true);
  assert.equal(config.capabilities.maxReferenceImages, 14);

  const request = buildImageRequest(
    config,
    { positive: '一只蓝鲸少女', negative: '幼态、水印、紫发、紫色' },
    { references: [{ mime: 'image/png', data: PNG }] }
  );
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.equal(request.init.headers.authorization, 'Bearer k-ark');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'doubao-seedream-4-0-250828');
  assert.equal(body.size, '1024x1536');
  assert.equal(body.sequential_image_generation, 'disabled');
  assert.equal(body.watermark, false);
  assert.ok(body.image[0].startsWith('data:image/png;base64,'));
  assert.match(body.prompt, /严格禁止/);
  assert.match(body.prompt, /幼态/);
  assert.ok(!body.prompt.includes('紫色'), '无关负向词不并进 ARK 提示词');

  // 5.0 pro/flash 不支持组图开关，传了会 400。
  const flash = normalizeImageGenConfig({ provider: 'ark', model: 'doubao-seedream-5-0-flash-260915' });
  const flashBody = JSON.parse(buildImageRequest(flash, 'p').init.body);
  assert.ok(!('sequential_image_generation' in flashBody));
});

test('群聊 @ 前缀剥离与命令解析', () => {
  assert.equal(stripMentionPrefix('[CQ:at,qq=123456] 画图 一只猫'), '画图 一只猫');
  assert.equal(stripMentionPrefix('@小鲸鱼 画图 一只猫'), '画图 一只猫');
  assert.equal(stripMentionPrefix('[CQ:at,qq=1][CQ:at,qq=2] /画图 海边'), '/画图 海边');
  assert.deepEqual(parseImageCommand('@小鲸鱼 画图 一只戴墨镜的橘猫'), { description: '一只戴墨镜的橘猫' });
  assert.deepEqual(parseImageCommand('[CQ:at,qq=123] /画图 海边'), { description: '海边' });
  assert.equal(parseImageCommand('@小鲸鱼 帮我看看这张图'), null);
});

test('触发权限：仅主人可用，群友在任何场景都被拒，旧开关无效', () => {
  const base = normalizeImageGenConfig({});
  assert.equal(decideImageAccess({ isGroup: true, isOwner: true, mentioned: false, target: '9', sender: '1', config: base }).allowed, true);
  assert.equal(decideImageAccess({ isGroup: false, isOwner: true, mentioned: false, target: '1', sender: '1', config: base }).allowed, true);

  const memberGroup = decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: base });
  assert.equal(memberGroup.allowed, false);
  assert.match(memberGroup.reply, /只对主人开放/);
  assert.equal(decideImageAccess({ isGroup: false, isOwner: false, mentioned: false, target: '2', sender: '2', config: base }).allowed, false);

  // 即使旧配置把 allowGroup 打开，也不再放行群友。
  const legacy = normalizeImageGenConfig({ allowGroup: true, groupDailyLimit: 99, groupUserCooldownMs: 0, groupCooldownMs: 0 });
  assert.equal(decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: legacy }).allowed, false);

  const off = normalizeImageGenConfig({ enabled: false });
  assert.match(decideImageAccess({ isGroup: false, isOwner: true, mentioned: false, target: '1', sender: '1', config: off }).reply, /关着/);
});

test('画图命令解析', () => {
  assert.deepEqual(parseImageCommand('/画图 蓝发女仆在窗边'), { description: '蓝发女仆在窗边' });
  assert.deepEqual(parseImageCommand('画图：海边'), { description: '海边' });
  assert.deepEqual(parseImageCommand(' /draw 一只鲸鱼 '), { description: '一只鲸鱼' });
  assert.equal(parseImageCommand('画图'), null);
  assert.equal(parseImageCommand('我今天想画图'), null);
  assert.equal(parseImageCommand(''), null);
  assert.equal(parseImageCommand('画图 ' + 'x'.repeat(300)).description.length, 200);
});

test('提示词锚定成人比例日系立绘并写死负向禁忌', () => {
  const prompt = buildPrompt('蓝发少女');
  assert.match(prompt, /蓝发少女/);
  assert.match(prompt, /画质与风格/);
  assert.match(prompt, /头高占全身 1\/6\.5–1\/7/);
  assert.match(prompt, /腰线在全高 33%–35%/);
  assert.match(prompt, /膝在 72%–74%/);
  assert.match(prompt, /腿长（胯到脚底）占 43%–46%/);
  assert.doesNotMatch(prompt, /略高于中点|略低于中点/);
  assert.doesNotMatch(prompt, /约七头身/);
  assert.match(prompt, /肩宽 1\.9 头宽、胯宽 1\.5 头宽/);
  assert.doesNotMatch(prompt, /肩宽胯宽各约 2 头宽/);
  assert.match(prompt, /赛璐璐上色与厚涂混合/);
  assert.match(prompt, /严格禁止/);
  assert.match(prompt, /Q版/);
  assert.match(prompt, /三头身/);
  assert.match(prompt, /猫耳毛线帽/);
});

test('人物锁定为 DeepSeek 女化形象模板', () => {
  const prompt = buildPrompt('坐在窗边看书');
  assert.match(prompt, /【固定人物，不可替换】/);
  assert.match(prompt, /纯宝蓝长发/);
  assert.match(prompt, /鲸鳍状耳/);
  assert.match(prompt, /半杏眼/);
  // 新锚点没有呆毛：正向不出现，负向里明确禁止。
  assert.match(prompt, /【严格禁止】[^]*呆毛/);
  assert.match(prompt, /深蓝色旗袍式长裙/);
  assert.doesNotMatch(prompt, /蓝发蓝瞳/);
  // 模型描述里写别的发色会被清掉，避免换人。
  assert.equal(sanitizeDrawDescription('银白长发的少女'), '长发的少女');
});

test('额度不足时统一回复画图额度不足', () => {
  assert.equal(drawFailureReply({ reason: 'provider', error: 'HTTP 402' }), '画图额度不足，这次没有画。');
  assert.equal(drawFailureReply({ reason: 'rate-limit' }), '画图额度不足，这次没有画。');
  assert.match(drawFailureReply({ reason: 'moderation', analysis: { safetyReason: '露点' } }), /露点/);
});

test('画面描述里的 Q 版词会被清洗掉', () => {
  assert.equal(
    sanitizeDrawDescription('蓝发蓝瞳的Q版鲸鱼拟人角色，头戴白色鲸鱼装饰毛线帽，身穿白色毛衣'),
    '蓝发蓝瞳的鲸鱼拟人角色，头戴白色鲸鱼装饰，身穿白色毛衣'
  );
  assert.equal(sanitizeDrawDescription('三头身萌系少女，猫耳帽'), '少女');
  assert.equal(sanitizeDrawDescription('成年女性立绘，及腰长发'), '成年女性立绘，及腰长发');
  const prompt = buildPrompt('Q版鲸鱼拟人角色');
  assert.doesNotMatch(prompt.split('严格禁止')[0], /Q版/);
});

test('画风预设：五档可切换，默认成人比例立绘', () => {
  assert.deepEqual(STYLE_PRESET_NAMES, ['keyvisual', 'closeup', 'maid', 'jk', 'qipao']);
  assert.equal(normalizeImageGenConfig({}).stylePreset, 'keyvisual');
  assert.equal(normalizeImageGenConfig({ stylePreset: 'maid' }).stylePreset, 'maid');
  assert.equal(normalizeImageGenConfig({ stylePreset: 'nope' }).stylePreset, 'keyvisual');
  const closeup = normalizeImageGenConfig({ stylePreset: 'closeup' });
  assert.match(closeup.stylePrompt, /半身特写/);
  assert.match(closeup.negativePrompt, /Q版/);
  const maid = normalizeImageGenConfig({ stylePreset: 'maid', outfit: 'none' });
  assert.match(maid.stylePrompt, /女仆装/);
  assert.match(maid.negativePrompt, /三头身/);
  const jk = normalizeImageGenConfig({ stylePreset: 'jk', outfit: 'none' });
  assert.match(jk.stylePrompt, /水手服制服/);
  assert.match(jk.stylePrompt, /衣着完整/);
  assert.match(jk.negativePrompt, /超短裙/);
  const qipao = normalizeImageGenConfig({ stylePreset: 'qipao', outfit: 'none' });
  assert.match(qipao.stylePrompt, /旗袍/);
  assert.match(qipao.stylePrompt, /白色丝袜/);
  assert.match(qipao.negativePrompt, /Q版/);
  // 显式 stylePrompt 仍然优先，便于控制台临时覆盖。
  assert.equal(normalizeImageGenConfig({ stylePreset: 'maid', stylePrompt: '自定义' }).stylePrompt, '自定义');
});

test('服装池：六套可切换，换装不改脸与发型', () => {
  assert.deepEqual(OUTFIT_NAMES, ['maid', 'jk', 'hoodie', 'knit', 'yukata', 'shirt', 'swim', 'dress', 'bikini', 'nightgown']);
  const knit = normalizeImageGenConfig({ outfit: 'knit' });
  assert.equal(knit.outfit, 'knit');
  assert.match(knit.stylePrompt, /针织开衫/);
  // 服装不再绑定鲸鱼图案，默认是纯色/无图案。
  assert.doesNotMatch(knit.promptLayers.clothing, /鲸鱼|刺绣|印花/);
  assert.match(knit.stylePrompt, /五官发色瞳色不变/);
  // 服装层不覆盖人物层：脸和发色必须还在。
  assert.match(knit.stylePrompt, /纯宝蓝长发/);
  assert.match(knit.stylePrompt, /半杏眼/);
  // 未知值回落 auto；auto 会从池里随机。
  assert.equal(normalizeImageGenConfig({ outfit: 'bogus' }).outfit.length > 0, true);
  assert.equal(normalizeImageGenConfig({ outfit: 'none' }).outfit, 'none');
  assert.notEqual(pickOutfit(() => 0), pickOutfit(() => 0.99));
  // 每套服装都不带鲸鱼图案，身份只由人物层承担。
  assert.ok(OUTFIT_NAMES.every((name) => !/鲸鱼|刺绣|印花/.test(normalizeImageGenConfig({ outfit: name }).promptLayers.clothing)));
  assert.ok(OUTFIT_NAMES.every((name) => /鲸鳍状耳/.test(normalizeImageGenConfig({ outfit: name }).promptLayers.character)));
  // 可选图案入口：显式给了才出现，且只出现一处。
  const motif = normalizeImageGenConfig({ outfit: 'dress', clothingMotif: '小星星刺绣' });
  assert.match(motif.promptLayers.clothing, /只有一处小星星刺绣/);
  assert.match(normalizeImageGenConfig({ outfit: 'dress' }).promptLayers.clothing, /纯色无图案/);
  // 泳装与连衣裙：保守款，三档气质通用。
  const swim = normalizeImageGenConfig({ outfit: 'swim' });
  assert.match(swim.stylePrompt, /连体运动泳装/);
  assert.match(swim.stylePrompt, /不透光/);
  // 服装类负向词已按放宽规则整体移除，不再自相矛盾。
  assert.doesNotMatch(swim.negativePrompt, /比基尼/);
  assert.doesNotMatch(swim.negativePrompt, /高叉泳装/);
  const dress = normalizeImageGenConfig({ outfit: 'dress' });
  assert.match(dress.stylePrompt, /连衣裙/);
  assert.match(dress.stylePrompt, /及膝/);
  assert.doesNotMatch(dress.negativePrompt, /超短裙/);
  for (const vibe of ['cute', 'youth', 'mature']) {
    assert.ok(outfitPoolForVibe(vibe).includes('swim'));
    assert.ok(outfitPoolForVibe(vibe).includes('dress'));
  }
});

test('布料质感：按款式声明材质，描述拼接进服装层', () => {
  assert.equal(FABRICS.cotton.label, '棉麻');
  assert.equal(FABRICS.stiff.label, '制服呢');
  // JK 走硬挺面料：褶裥立得住、有厚度，并保持版型挺括。
  const jk = clothingLayerFor('jk');
  assert.match(jk, /制服呢硬挺有骨架/);
  assert.match(jk, /褶裥挺括有厚度/);
  assert.match(jk, /受光边留窄缎面微光/);
  // 睡裙走雪纺：层叠透感但轮廓完整，且内衬不透明。
  const nightgown = clothingLayerFor('nightgown');
  assert.match(nightgown, /外层雪纺轻薄有层次/);
  assert.match(nightgown, /内衬不透明有投影/);
  assert.match(nightgown, /内衬不透明/);
  // 连衣裙走丝绸：柔和方向性高光，不是整块平涂。
  const dress = clothingLayerFor('dress');
  assert.match(dress, /丝绸轻薄却有垂坠/);
  assert.match(dress, /方向性光泽/);
  // 针织走粗针织：罗纹与针脚立体感。
  const knit = clothingLayerFor('knit');
  assert.match(knit, /罗纹与针脚立体/);
  assert.match(knit, /柔和高光/);
  // 泳装走高弹锦纶：贴身张力与压痕。
  const swim = clothingLayerFor('swim');
  assert.match(swim, /贴身有张力/);
  assert.match(swim, /肩带侧缝有压痕/);
  // 布料描述与身份锁、图案入口互不覆盖。
  const fabricTexts = Object.values(FABRICS).map((fabric) => fabric.text);
  for (const name of OUTFIT_NAMES) {
    const text = clothingLayerFor(name);
    assert.match(text, /只换衣服/);
    assert.doesNotMatch(text, /鲸鱼|刺绣|印花/);
    assert.ok(fabricTexts.some((fabricText) => text.includes(fabricText)), `${name} 缺少材质描述`);
  }
  // quality 层不被服装层覆盖。
  const quality = normalizeImageGenConfig({ outfit: 'jk' }).promptLayers.quality;
  assert.match(quality, /赛璐璐上色与厚涂混合/);
  assert.doesNotMatch(quality, /细节丰富/, '画质同义词已删，给头身比约束腾预算');
});

test('负向词：布料质感词已并入且整体去重', () => {
  assert.deepEqual(mergeNegativeTerms('甲、乙', ['乙', '丙'], '丙、丁'), ['甲', '乙', '丙', '丁']);
  assert.deepEqual(mergeNegativeTerms('', [], '  '), []);

  const config = normalizeImageGenConfig({ outfit: 'dress' });
  for (const word of ['纸片感', '贴图感', '无褶皱', '衣缘生硬', '悬浮在身体外']) {
    assert.match(config.negativePrompt, new RegExp(`(^|、)${word}(、|$)`));
  }
  // 比例上限词：只封下限会让模型往八头身、超长腿画。
  for (const word of ['八头身', '九头身', '超长腿', '筷子腿', '腿长超过三个半头高']) {
    assert.match(config.negativePrompt, new RegExp(`(^|、)${word}(、|$)`));
  }
  // 为腾预算删掉的重复项不应再出现。
  assert.doesNotMatch(config.negativePrompt, /平面剪裁|像贴纸|淡紫发|薰衣草色头发|白色羽状耳饰/);
  const terms = config.negativePrompt.split('、');
  assert.equal(new Set(terms).size, terms.length, '负向词不应有重复项');
  assert.equal(terms.length, 93, '86 条基础词 + 7 条全身景别词（预设不含背景杂乱）');
  assert.equal(new Set(DEFAULT_NEGATIVE_PROMPT.split('、')).size, 87, '默认清单含背景杂乱共 87 条');
});

test('提示词预算：正向 700–780、负向 450–480，超限断言报错', () => {
  assert.deepEqual(PROMPT_BUDGET.positive, { min: 700, max: 780 });
  assert.deepEqual(PROMPT_BUDGET.negative, { min: 450, max: 480 });

  // 覆盖所有服装 × 气质 × 景别 × 发型 × 表情，正向都不超 780。
  for (const outfit of OUTFIT_NAMES) {
    for (const vibe of Object.keys(VIBES)) {
      for (const framing of FRAMING_NAMES) {
        const config = normalizeImageGenConfig({ outfit, vibe, framing, tail: 'required' });
        const parts = buildPromptParts('海边散步', config.stylePrompt, config.negativePrompt, config.characterPrompt);
        const chars = assertPromptBudget(parts);
        assert.ok(chars.positive <= PROMPT_BUDGET.positive.max, `${outfit}/${vibe}/${framing} 正向 ${chars.positive}`);
        assert.ok(chars.negative <= PROMPT_BUDGET.negative.max, `${outfit}/${vibe}/${framing} 负向 ${chars.negative}`);
      }
    }
  }

  // 典型配置落在目标区间内，而不是压得越小越好。
  const config = normalizeImageGenConfig({ outfit: 'maid', vibe: 'mature', framing: 'full' });
  const parts = buildPromptParts('海边散步', config.stylePrompt, config.negativePrompt, config.characterPrompt);
  const chars = measurePromptChars(parts);
  assert.ok(chars.positive >= PROMPT_BUDGET.positive.min, `正向 ${chars.positive} 低于下限`);
  assert.ok(chars.positive <= PROMPT_BUDGET.positive.max, `正向 ${chars.positive} 超上限`);
  assert.ok(chars.negative >= PROMPT_BUDGET.negative.min, `负向 ${chars.negative} 低于下限`);
  assert.ok(chars.negative <= PROMPT_BUDGET.negative.max, `负向 ${chars.negative} 超上限`);

  // 构图层必须排在服装、光影、背景之前，确保送达。
  const order = config.stylePrompt;
  assert.ok(order.indexOf('【构图与视角】') < order.indexOf('【服装】'));
  assert.ok(order.indexOf('【构图与视角】') < order.indexOf('【光影】'));
  assert.ok(order.indexOf('【构图与视角】') < order.indexOf('【背景与氛围】'));

  // 超限直接抛错，不静默截断。
  assert.throws(() => assertPromptBudget({ positive: 'x'.repeat(781), negative: 'y'.repeat(10) }), /正向 781 字符/);
  assert.throws(() => assertPromptBudget({ positive: 'x', negative: 'y'.repeat(481) }), /负向 481 字符/);

  // 比例重画的强化提示词也必须落在预算内（丢背景/光影层腾位置）。
  for (const outfit of OUTFIT_NAMES) {
    const cfg = normalizeImageGenConfig({ outfit, vibe: 'youth', framing: 'full', tail: 'required' });
    const base = buildPromptParts('海边散步', cfg.stylePrompt, cfg.negativePrompt, cfg.characterPrompt);
    const retry = strengthenProportionPrompt(base);
    const retryChars = assertPromptBudget(retry);
    assert.match(retry.positive, /【严格比例】/);
    assert.ok(retryChars.positive <= PROMPT_BUDGET.positive.max, `${outfit} 重画正向 ${retryChars.positive}`);
  }
  assert.deepEqual(normalizeProportionCheckConfig({}), { enabled: true, maxHeads: 7.6 });

  // 长描述只裁描述，不裁身份锁与构图。
  const long = buildPromptParts('海边'.repeat(120), config.stylePrompt, config.negativePrompt, config.characterPrompt);
  assert.equal(long.descriptionTrimmed, true);
  assert.ok(measurePromptChars(long).positive <= PROMPT_BUDGET.positive.max);
  assert.match(long.positive, /固定人物，不可替换/);
  assert.match(long.positive, /从头到脚完整入画/);
});

test('景别：默认全身/七分身，写进构图层并调整画幅', () => {
  assert.deepEqual(FRAMING_NAMES, ['full', 'medium', 'closeup']);
  assert.equal(normalizeFraming('auto'), 'auto');
  assert.equal(normalizeFraming('全身'), 'full');
  assert.equal(normalizeFraming('bad'), 'auto');
  assert.equal(resolveFraming('auto', 'dress').name, 'full');
  assert.equal(resolveFraming('auto', 'swim').name, 'medium');
  assert.equal(resolveFraming('closeup', 'swim').name, 'closeup');

  // 默认不再贴脸：auto + 普通服装 → 全身，人物占比与留白都写清楚。
  const config = normalizeImageGenConfig({ outfit: 'dress', framing: 'auto', tail: 'off' });
  assert.equal(config.framing, 'full');
  assert.equal(config.framingSource, 'auto');
  const composition = config.promptLayers.composition;
  assert.match(composition, /从头到脚完整入画/);
  assert.match(composition, /65%–72%/);
  // 口径：头顶 12%–15%、脚底 15%–20%，不再写 9%/7%。
  assert.match(composition, /头顶留白 12%–15%/);
  assert.match(composition, /15%–20% 落地空间/);
  assert.doesNotMatch(composition, /头顶留白 9%/);
  assert.match(composition, /落地空间/);
  assert.match(composition, /双脚踩地/);
  // 方形画幅塞不下全身，自动改竖幅。
  assert.equal(config.size, '1024x1536');
  assert.equal(config.width, 1024);
  assert.equal(config.height, 1536);
  // 背景层有纵深，不是一块背景板。
  assert.match(config.promptLayers.background, /三层纵深/);
  assert.match(config.promptLayers.background, /人物在场景里/);
  // 层级顺序不变。
  const order = PROMPT_LAYER_ORDER.indexOf('composition');
  assert.ok(order < PROMPT_LAYER_ORDER.indexOf('lighting'));
  assert.ok(order < PROMPT_LAYER_ORDER.indexOf('background'));

  // 显式景别：半身保持方图，七分身也走竖幅。
  const closeup = normalizeImageGenConfig({ outfit: 'dress', framing: 'closeup' });
  assert.equal(closeup.framing, 'closeup');
  assert.equal(closeup.size, '1024x1024');
  assert.match(closeup.promptLayers.composition, /半身景别/);
  assert.match(closeup.promptLayers.composition, /70%–85%/);
  const medium = normalizeImageGenConfig({ outfit: 'swim', framing: 'auto' });
  assert.equal(medium.framing, 'medium');
  assert.equal(medium.size, '1024x1536');
  assert.match(medium.promptLayers.composition, /七分身景别/);

  // 显式非方形尺寸不被改写；重复归一化不会叠加景别句。
  const fixed = normalizeImageGenConfig({ outfit: 'dress', framing: 'full', width: 864, height: 1152 });
  assert.equal(fixed.size, '864x1152');
  const twice = normalizeImageGenConfig({ outfit: 'dress', framing: 'full', promptLayers: fixed.promptLayers });
  assert.equal(twice.promptLayers.composition.split('从头到脚完整入画').length - 1, 1);
  assert.match(framingLayerFor('closeup'), /半身景别/);
});

test('景别命令解析：/画图 景别=全身 与 framing=medium', () => {
  assert.deepEqual(parseImageCommand('画图 景别=全身 海边'), { description: '海边', framing: 'full' });
  assert.deepEqual(parseImageCommand('画图 framing=medium 在图书馆看书'), { description: '在图书馆看书', framing: 'medium' });
  assert.deepEqual(parseImageCommand('画图 景别=半身，kitchen'), { description: 'kitchen', framing: 'closeup' });
  assert.deepEqual(parseImageCommand('画图 景别=全身 发型=丸子头 海边'), { description: '海边', framing: 'full', hairstyle: 'bun' });
  assert.deepEqual(parseImageCommand('画图 景别=不存在 海边'), { description: '景别=不存在 海边' });
});

test('尾巴三档：required/optional/off 重写人物层并调整负向词', () => {
  assert.equal(normalizeImageGenConfig({}).tail, 'optional');
  const required = normalizeImageGenConfig({ tail: 'required' });
  assert.match(required.characterPrompt, /只有一条鲸尾/);
  assert.match(required.characterPrompt, /画面里只有一条尾、两只手、两只脚/);
  const optional = normalizeImageGenConfig({ tail: 'optional' });
  assert.match(optional.characterPrompt, /可省略鲸尾/);
  assert.doesNotMatch(optional.characterPrompt, /只有一条鲸尾/);
  const off = normalizeImageGenConfig({ tail: 'off' });
  assert.doesNotMatch(off.characterPrompt, /只有一条鲸尾|可省略鲸尾/);
  assert.match(off.characterPrompt, /不画鲸尾/);
  assert.match(off.characterPrompt, /鲸鳍状耳/);
  // 尾巴关闭时不再要求服装上的鲸鱼刺绣补辨识度。
  assert.doesNotMatch(off.characterPrompt, /刺绣|服装上的/);
  assert.match(off.negativePrompt, /鲸鱼尾/);
  // 自定义人物层里写死的旧尾巴也会按档位重写，避免同段自相矛盾。
  const custom = normalizeImageGenConfig({
    tail: 'off',
    promptLayers: { character: '蓝发少女，只有一条鲸尾，从裙摆伸出，温柔浅笑' }
  });
  assert.doesNotMatch(custom.characterPrompt, /只有一条鲸尾/);
  assert.match(custom.characterPrompt, /温柔浅笑/);
});

test('表情层：八种表情独立成层，换表情不改脸与发型', () => {
  assert.deepEqual(EXPRESSION_NAMES, ['gentle', 'happy', 'shy', 'pout', 'smug', 'surprised', 'sleepy', 'serious']);
  // 人物层不再写死表情，只锁五官结构。
  const base = normalizeImageGenConfig({});
  assert.equal(base.expression, 'gentle');
  assert.doesNotMatch(base.characterPrompt, /温柔浅笑|笑脸|腮红/);
  assert.match(base.characterPrompt, /五官发色瞳色不变/);
  assert.match(base.stylePrompt, /【表情】/);
  // 每种表情都有可执行的眉眼嘴描述，且都带身份锁。
  for (const name of EXPRESSION_NAMES) {
    const layer = expressionLayerFor(name);
    assert.match(layer, /眉毛/);
    assert.match(layer, /眼睛/);
    // 画法词（瞳孔高光、上眼睑）已迁到 faceStyle 层，表情层只写动作。
    assert.doesNotMatch(layer, /高光|上眼睑/);
    assert.match(layer, /嘴巴|嘴角/);
    assert.match(layer, /脸颊|脸红|浅红/);
    assert.match(layer, /只动表情不动脸型/);
  }
  // 画法归属：渐变柔光脸提供高光/空气刷，且两层职责写死。
  assert.match(faceStyleLayerFor('grad_soft'), /多层高光/);
  assert.match(faceStyleLayerFor('grad_soft'), /表情动作优先，脸部画法只决定表现方式/);
  assert.doesNotMatch(expressionLayerFor('gentle'), /高光/);
  const happy = normalizeImageGenConfig({ expression: 'happy' });
  assert.match(happy.stylePrompt, /开心大笑/);
  assert.match(happy.stylePrompt, /【表情】/);
  // 换表情时人物特征必须原样保留。
  assert.match(happy.characterPrompt, /纯宝蓝长发/);
  assert.match(happy.characterPrompt, /鹅蛋脸/);
  assert.match(happy.characterPrompt, /鲸鳍状耳/);
  // 表情相关负向词防止“一笑就换脸”。
  assert.match(happy.negativePrompt, /表情改变脸型/);
  assert.match(happy.negativePrompt, /大笑拉宽脸型/);
  assert.match(happy.negativePrompt, /眼睛变成大圆眼/);
});

test('脸部画法层：六档均有词条，位置在人物之后表情之前', () => {
  assert.equal(DEFAULT_FACE_STYLE, 'grad_soft');
  assert.deepEqual(FACE_STYLE_NAMES, ['grad_soft', 'closed_arc', 'cel_clean', 'sharp_mature', 'round_sweet', 'ink_minimal', 'film_natural']);
  assert.equal(FACE_STYLE_PRIORITY, '表情动作优先，脸部画法只决定表现方式');
  for (const name of FACE_STYLE_NAMES) {
    assert.ok(FACE_STYLES[name].text, `${name} 应有词条`);
    const resolved = resolveFaceStyle(name);
    assert.equal(resolved.name, name);
    assert.equal(resolved.source, 'explicit');
  }
  // 未知档名回到 auto，落默认的渐变柔光脸。
  assert.equal(resolveFaceStyle('不存在的脸').name, 'grad_soft');

  const arc = normalizeImageGenConfig({ faceStyle: 'closed_arc' });
  assert.equal(arc.faceStyle, 'closed_arc');
  assert.match(arc.promptLayers.faceStyle, /闭眼用两条下弯粗弧线/);
  assert.match(arc.stylePrompt, /【脸部画法】/);
  assert.equal(PROMPT_LAYER_ORDER.indexOf('faceStyle'), PROMPT_LAYER_ORDER.indexOf('character') + 1);
  assert.ok(PROMPT_LAYER_ORDER.indexOf('faceStyle') < PROMPT_LAYER_ORDER.indexOf('expression'));

  // 关闭后整层不出现，而不是留一个空标签。
  const off = normalizeImageGenConfig({ faceStyle: 'none' });
  assert.equal(off.faceStyle, 'none');
  assert.ok(!off.stylePrompt.includes('【脸部画法】'));

  // 中文档名也可直接选。
  assert.equal(normalizeImageGenConfig({ faceStyle: '渐变柔光脸' }).faceStyle, 'grad_soft');
});

test('画幅与背景密度：wide_scene 走 16:9，rich 只虚化最远层且幂等', () => {
  assert.deepEqual(SCENE_FRAMING_NAMES, ['portrait', 'wide_scene']);
  assert.deepEqual(BACKGROUND_DETAIL_NAMES, ['minimal', 'mid', 'rich']);
  assert.equal(normalizeSceneFraming('bad'), 'portrait');
  assert.equal(normalizeBackgroundDetail('bad'), 'mid');

  // wide_scene：16:9 横幅 + 广角纵深 + 前景物件 + 人物不占满。
  const wide = normalizeImageGenConfig({ outfit: 'dress', framing: 'full', sceneFraming: 'wide_scene' });
  assert.equal(wide.size, '1536x864');
  assert.equal(wide.sceneFraming, 'wide_scene');
  assert.match(wide.promptLayers.composition, /16:9 横幅/);
  assert.match(wide.promptLayers.composition, /广角纵深/);
  assert.match(wide.promptLayers.composition, /前景有物件/);
  assert.match(wide.promptLayers.composition, /人物不占满画面/);
  // 显式非方形尺寸不被 wide_scene 改写。
  assert.equal(normalizeImageGenConfig({ sceneFraming: 'wide_scene', width: 864, height: 1152 }).size, '864x1152');

  // rich：高密度实景，只虚化最远一层；重复归一化不叠加。
  const rich = normalizeImageGenConfig({ backgroundDetail: 'rich' });
  assert.equal(rich.backgroundDetail, 'rich');
  assert.match(rich.promptLayers.background, /高密度实景背景/);
  assert.match(rich.promptLayers.background, /只虚化最远一层/);
  assert.doesNotMatch(rich.promptLayers.background, /三层纵深/);
  const twice = normalizeImageGenConfig({ backgroundDetail: 'rich', promptLayers: rich.promptLayers });
  assert.equal(measurePromptChars({ positive: twice.promptLayers.background }).positive,
    measurePromptChars({ positive: rich.promptLayers.background }).positive);
  const minimal = normalizeImageGenConfig({ backgroundDetail: 'minimal' });
  assert.match(minimal.promptLayers.background, /大面积纯色与强虚化/);
  assert.doesNotMatch(minimal.promptLayers.background, /高密度实景/);

  // 默认仍是竖幅 + 三层纵深。
  const normal = normalizeImageGenConfig({ outfit: 'dress', framing: 'full' });
  assert.equal(normal.sceneFraming, 'portrait');
  assert.equal(normal.backgroundDetail, 'mid');
  assert.match(normal.promptLayers.background, /三层纵深/);
});

test('发型层：九款可切换，层级在人物之后，换发型不改脸与发色', () => {
  assert.deepEqual(HAIRSTYLE_NAMES, ['bun', 'high_ponytail', 'low_ponytail', 'twintails', 'half_up', 'side_braid', 'low_updo', 'short_bob', 'shoulder_straight']);
  assert.equal(DEFAULT_HAIRSTYLE, 'auto');
  // 层级顺序：构图前置到第 3 位，发型与其余层相对顺序不变
  assert.deepEqual(PROMPT_LAYER_ORDER, ['quality', 'character', 'faceStyle', 'composition', 'hairstyle', 'vibe', 'expression', 'clothing', 'lighting', 'background']);

  const bun = normalizeImageGenConfig({ hairstyle: 'bun' });
  assert.equal(bun.hairstyle, 'bun');
  assert.equal(bun.hairstyleMode, 'explicit');
  assert.match(bun.promptLayers.hairstyle, /丸子头/);
  assert.match(bun.promptLayers.hairstyle, /小鲸鱼发夹/);
  // 发型层不碰人物层：发色、瞳色、鳍耳仍在
  assert.match(bun.stylePrompt, /宝蓝/);
  assert.match(bun.stylePrompt, /深海蓝/);
  assert.match(bun.stylePrompt, /鲸鳍状耳/);
  assert.match(bun.stylePrompt, /【发型（可变）】/);
  // 中文标签也能解析
  assert.equal(normalizeHairstyle('丸子头'), 'bun');
  assert.equal(normalizeImageGenConfig({ hairstyle: 'high_ponytail' }).promptLayers.hairstyle.includes('高马尾'), true);
  // 齐肩直发必须带可判定的长度上限，否则会被画成过腰长发。
  const shoulder = normalizeImageGenConfig({ hairstyle: 'shoulder_straight' }).promptLayers.hairstyle;
  assert.match(shoulder, /发尾止于肩线/);
  assert.match(shoulder, /不超过肩线/);
});

test('发型选型：会话内去重、显式覆盖、关闭开关回落固定长发', () => {
  // 同一会话连续两次不重复
  const first = pickHairstyleForChat('private:1', () => 0);
  const second = pickHairstyleForChat('private:1', () => 0);
  assert.notEqual(first, second);
  // 显式参数优先于自动
  assert.deepEqual(resolveHairstyle('short_bob', { chatKey: 'private:1' }), { name: 'short_bob', source: 'explicit' });
  assert.equal(resolveHairstyle('auto', { chatKey: 'private:1', random: () => 0 }).source, 'auto');
  // 关闭开关：回到固定长发
  const off = normalizeImageGenConfig({ hairstyleEnabled: false });
  assert.equal(off.hairstyleMode, 'off');
  assert.equal(off.hairstyle, '');
  assert.match(off.promptLayers.hairstyle, /长发自然披落/);
  const none = normalizeImageGenConfig({ hairstyle: 'none' });
  assert.equal(none.hairstyleMode, 'off');
  assert.match(none.promptLayers.hairstyle, /长发自然披落/);
  // 收窄池子后只在池内选
  const narrowed = normalizeImageGenConfig({ hairstylePool: ['bun', 'short_bob'] });
  assert.ok(['bun', 'short_bob'].includes(pickHairstyle(() => 0.99, { pool: narrowed.hairstylePool, vibe: 'youth' })));
  // 气质/服装参与选型：泳装只给清爽类
  assert.ok(['bun', 'high_ponytail', 'low_updo'].includes(pickHairstyle(() => 0.5, { vibe: 'youth', outfit: 'swim' })));
});

test('发型入口：/画图 支持 发型=xxx 前缀并可显式覆盖', () => {
  assert.deepEqual(parseImageCommand('画图 发型=丸子头 在窗边晒太阳'), { description: '在窗边晒太阳', hairstyle: 'bun' });
  assert.deepEqual(parseImageCommand('画图 在窗边晒太阳'), { description: '在窗边晒太阳' });
  // 无法识别的发型不吞描述，原样当描述处理
  assert.deepEqual(parseImageCommand('画图 发型=不存在的发型 在窗边'), { description: '发型=不存在的发型 在窗边' });
});

test('发型落地：显式参数覆盖配置，元数据记录发型来源', async () => {
  const dir = tempState();
  try {
    const result = await generateImage({
      description: '在窗边晒太阳', config: POLL(), target: '1', isGroup: false, chatKey: 'private:1', hairstyle: 'short_bob'
    }, {
      stateDir: dir,
      logger: () => {},
      inspectImage: async () => ({ appropriate: true, confidence: 0.95, caption: '成年女性站在窗边' }),
      fetchImpl: async () => okResponse()
    });
    assert.equal(result.ok, true);
    const meta = JSON.parse(readFileSync(result.metaPath, 'utf8'));
    assert.equal(meta.hairstyle, 'short_bob');
    assert.equal(meta.hairstyleSource, 'explicit');
    assert.match(meta.prompt, /短内扣/);
    assert.match(meta.prompt, /【发型（可变）】/);
    assert.match(meta.prompt, /宝蓝/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('表情优先级：显式传参 > 语境推断 > 默认温柔浅笑', () => {
  assert.deepEqual(resolveExpression({ expression: 'shy', context: '哈哈哈太好了' }), { name: 'shy', source: 'explicit' });
  assert.deepEqual(resolveExpression({ context: '你真的好可爱，太棒了' }), { name: 'happy', source: 'context' });
  assert.deepEqual(resolveExpression({ context: '呜呜你欺负我' }), { name: 'pout', source: 'context' });
  assert.deepEqual(resolveExpression({ context: '我好困，晚安' }), { name: 'sleepy', source: 'context' });
  assert.deepEqual(resolveExpression({ context: '今天天气不错' }), { name: 'gentle', source: 'default' });
  assert.deepEqual(inferExpression(''), { name: 'gentle', source: 'default' });
  // 中文表情名也认。
  assert.deepEqual(resolveExpression({ expression: '害羞脸红' }), { name: 'shy', source: 'explicit' });
});

test('气质层：三档独立成层，成年体型不变，auto 避开上一档', () => {
  assert.deepEqual(VIBE_MODES, ['cute', 'youth', 'mature']);
  const cute = normalizeImageGenConfig({ vibe: 'cute', outfit: 'hoodie', tail: 'optional' });
  assert.match(cute.stylePrompt, /【气质与年龄表现】/);
  assert.match(cute.stylePrompt, /萌系/);
  assert.match(cute.stylePrompt, /成年女性/);
  assert.match(cute.characterPrompt, /成年女性/);
  assert.match(cute.negativePrompt, /萌系画成小孩/);
  assert.match(cute.negativePrompt, /儿童体型/);
  assert.match(cute.negativePrompt, /未成年|儿童体型/);
  assert.match(cute.negativePrompt, /幼女/);
  assert.match(cute.negativePrompt, /未成年/);
  // 纤细可以有，但不能变成幼态。
  const youth = normalizeImageGenConfig({ vibe: 'youth', outfit: 'hoodie', tail: 'optional' });
  assert.match(youth.stylePrompt, /青春少女/);
  assert.match(youth.stylePrompt, /头高占全身 1\/6\.5–1\/7/);
  // 泳装/比基尼把成年约束再收紧一档。
  const swimYouth = normalizeImageGenConfig({ vibe: 'youth', outfit: 'swim', tail: 'optional' });
  assert.match(swimYouth.stylePrompt, /年龄外观必须明确成年/);
  const mature = normalizeImageGenConfig({ vibe: 'mature', outfit: 'knit', tail: 'optional' });
  assert.match(mature.stylePrompt, /成熟御姐/);
  // 不再写“脸部修长”：那会把脸缩小、身体拉长。
  assert.doesNotMatch(mature.stylePrompt, /脸部修长/);
  assert.match(mature.stylePrompt, /下颌清晰但头高不变/);
  // 气质只改表现参数，人物层必须完全一致。
  assert.equal(cute.characterPrompt, mature.characterPrompt);
  // auto 会避开上一档，且来源标记为 auto。
  assert.notEqual(pickVibe(() => 0.99, 'mature'), 'mature');
  assert.equal(resolveVibe('auto', 'chat-x').source, 'auto');
  assert.equal(resolveVibe('cute', '').source, 'explicit');
  // 服装适配：萌系不排女仆装，御姐不排 JK。
  assert.ok(outfitPoolForVibe('cute').includes('hoodie'));
  assert.ok(!outfitPoolForVibe('cute').includes('maid'));
  assert.ok(!outfitPoolForVibe('mature').includes('jk'));
});

test('比基尼：仅主人私聊可用，群聊直接拒绝且不放行负向词', async () => {
  const config = normalizeImageGenConfig({
    provider: 'pollinations', model: 'flux', outfit: 'bikini', vibe: 'youth', tail: 'optional', width: 256, height: 256
  });
  assert.equal(config.outfit, 'bikini');
  assert.match(config.stylePrompt, /两件式泳装/);
  assert.match(config.stylePrompt, /面料厚实不透明/);
  assert.match(config.stylePrompt, /年龄外观必须明确成年/);
  // 服装类负向词已整体移除，配置里不再压这些词。
  assert.doesNotMatch(config.negativePrompt, /(^|、)比基尼(、|$)/);
  assert.doesNotMatch(config.negativePrompt, /高叉泳装/);
  assert.doesNotMatch(config.negativePrompt, /湿身/);
  // 比基尼不进 auto 服装池。
  for (const vibe of ['cute', 'youth', 'mature']) assert.ok(!outfitPoolForVibe(vibe).includes('bikini'));

  const group = await generateImage(
    { config, description: '海边测试', isGroup: true, isOwner: true, target: '1', chatKey: 'group:1' },
    { logger() {} }
  );
  assert.equal(group.ok, false);
  assert.equal(group.reason, 'outfit-private-only');
  assert.match(drawFailureReply(group), /私聊/);

  const stranger = await generateImage(
    { config, description: '海边测试', isGroup: false, isOwner: false, target: '2', chatKey: 'private:2' },
    { logger() {} }
  );
  assert.equal(stranger.reason, 'outfit-private-only');
});

test('薄纱睡裙：不透明内衬 + 仅主人私聊，群聊拒绝且负向词补齐', async () => {
  assert.deepEqual(PRIVATE_ONLY_OUTFITS, ['bikini', 'nightgown']);
  const config = normalizeImageGenConfig({
    provider: 'pollinations', model: 'flux', outfit: 'nightgown', vibe: 'youth', tail: 'optional', width: 256, height: 256
  });
  assert.equal(config.outfit, 'nightgown');
  assert.match(config.stylePrompt, /薄纱/);
  assert.match(config.stylePrompt, /内层不透明纯白棉衬/);
  assert.doesNotMatch(config.promptLayers.clothing, /鲸鱼|刺绣|印花/);
  assert.match(config.stylePrompt, /年龄外观必须明确成年/);
  // 服装类负向词已移除，睡裙只保留未成年与风格类约束。
  for (const term of ['薄纱透肉', '内衬透明', '高叉', '内衣外露', '透视', '湿身', '走光']) {
    assert.ok(!config.negativePrompt.split('、').includes(term), `负向词不应再包含 ${term}`);
  }
  assert.ok(config.negativePrompt.split('、').includes('幼女'));
  // 睡裙同样不进 auto 服装池。
  for (const vibe of ['cute', 'youth', 'mature']) assert.ok(!outfitPoolForVibe(vibe).includes('nightgown'));

  const group = await generateImage(
    { config, description: '卧室里站着', isGroup: true, isOwner: true, target: '1', chatKey: 'group:1' },
    { logger() {} }
  );
  assert.equal(group.ok, false);
  assert.equal(group.reason, 'outfit-private-only');
  assert.match(drawFailureReply(group), /私聊/);

  const nonOwnerPrivate = await generateImage(
    { config, description: '卧室里站着', isGroup: false, isOwner: false, target: '2', chatKey: 'private:2' },
    { logger() {} }
  );
  assert.equal(nonOwnerPrivate.reason, 'outfit-private-only');
});

test('参考图策略：dashscope 缺参考图直接拒绝，不降级纯文生图', async () => {
  const required = await generateImage({
    description: '海边散步',
    config: { provider: 'dashscope', apiKey: 'test-key', width: 1024, height: 1536 }
  });
  assert.equal(required.ok, false);
  assert.equal(required.reason, 'reference-required');
  assert.match(drawFailureReply(required), /参考图/);
  // 锚点读不到也拒绝，而不是偷偷走纯文生图。
  const brokenAnchor = await generateImage({
    description: '海边散步',
    config: { provider: 'dashscope', apiKey: 'test-key', defaultReferenceImage: 'D:/nope/anchor.png' }
  });
  assert.equal(brokenAnchor.ok, false);
  assert.equal(brokenAnchor.reason, 'reference-required');
  assert.equal(normalizeImageGenConfig({ provider: 'dashscope' }).referencePolicy, 'require');
  assert.equal(normalizeImageGenConfig({ provider: 'dashscope', referencePolicy: 'optional' }).referencePolicy, 'optional');
});

test('分层提示词：六层按固定顺序拼装，promptLayers 可整层覆盖', () => {
  const config = normalizeImageGenConfig({
    provider: 'dashscope',
    promptLayers: { lighting: '顶光，硬阴影', quality: '测试画质层' }
  });
  const order = ['画质与风格', '固定人物，不可替换', '构图与视角', '服装', '光影', '背景与氛围'];
  const indexes = order.map((label) => config.stylePrompt.indexOf(`【${label}】`));
  assert.ok(indexes.every((index) => index >= 0), '六层标签都要存在');
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, '层顺序必须固定');
  assert.match(config.stylePrompt, /【光影】顶光，硬阴影/);
  assert.match(config.stylePrompt, /【画质与风格】测试画质层/);
  assert.match(config.stylePrompt, /鲸鱼造型发饰/);
  assert.equal(config.promptLayers.character, config.characterPrompt);
  // 未知字段不能混进拼装结果。
  assert.equal(normalizeImageGenConfig({ promptLayers: { nonsense: 'x' } }).stylePrompt.includes('nonsense'), false);
});

test('冷却与每日限额', () => {
  let now = Date.UTC(2026, 0, 1, 4);
  const quota = createImageGenQuota({ now: () => now });
  assert.equal(quota.check('u:1', { cooldownMs: 60_000 }).ok, true);
  quota.record('u:1');
  const cooling = quota.check('u:1', { cooldownMs: 60_000 });
  assert.equal(cooling.ok, false);
  assert.equal(cooling.reason, 'cooldown');
  assert.ok(cooling.retryAfterMs > 0);
  now += 61_000;
  assert.equal(quota.check('u:1', { cooldownMs: 60_000 }).ok, true);

  quota.check('g:9', { dailyLimit: 2 });
  quota.record('g:9');
  quota.record('g:9');
  const limited = quota.check('g:9', { dailyLimit: 2 });
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'daily-limit');
  assert.equal(limited.used, 2);
  assert.equal(quota.check('g:9', { dailyLimit: 0 }).ok, false);
  assert.equal(quota.check('g:10', { dailyLimit: 0 }).ok, false);

  now += 24 * 60 * 60_000;
  assert.equal(quota.check('g:9', { dailyLimit: 2 }).ok, true);
  assert.equal(quota.usedToday('g:9'), 0);
});

test('随机画图开关与频率', () => {
  const config = normalizeImageGenConfig({ randomChance: 100, randomMinGapMs: 3_600_000, randomDailyLimit: 1 });
  const now = Date.UTC(2026, 0, 1, 4);
  assert.equal(shouldDrawRandomly({ config, now, lastAt: 0, usedToday: 0, random: () => 0.1 }), true);
  assert.equal(shouldDrawRandomly({ config, now, lastAt: now - 1000, usedToday: 0, random: () => 0.1 }), false);
  assert.equal(shouldDrawRandomly({ config, now, lastAt: 0, usedToday: 1, random: () => 0.1 }), false);
  assert.equal(shouldDrawRandomly({ config: { ...config, enabled: false }, now, random: () => 0.1 }), false);
  assert.equal(shouldDrawRandomly({ config: { ...config, randomEnabled: false }, now, random: () => 0.1 }), false);
  const theme = pickRandomTheme(() => 0);
  assert.equal(typeof theme, 'string');
  assert.ok(theme.length > 10);
});

test('MIME 嗅探与 base64 发送段', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('RIFF0000WEBPxxxx')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), 'image/png'), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), 'text/html'), 'image/jpeg');

  const segment = toImageSegment(PNG);
  assert.equal(segment.type, 'image');
  assert.match(segment.data.file, /^base64:\/\//);
  assert.deepEqual(Buffer.from(segment.data.file.slice('base64://'.length), 'base64'), PNG);
});

test('生成成功：落盘、审核通过、日志与 base64', async () => {
  const dir = tempState();
  const logs = [];
  try {
    const result = await generateImage({ description: '蓝发少女', config: POLL(), target: '10001', isGroup: false }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      fetchImpl: async () => okResponse(),
      inspectImage: async () => ({ appropriate: true, confidence: 0.92 }),
      logger: (line) => logs.push(line)
    });
    assert.equal(result.ok, true);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.provider, 'pollinations');
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1536);
    assert.ok(result.ms >= 0);
    assert.ok(existsSync(result.filePath));
    assert.deepEqual(readFileSync(result.filePath), PNG);
    assert.match(result.filePath, /2026-01-01[\\/]gen-.*\.png$/);
    assert.ok(logs.some((line) => /^\[imagegen\] ok /.test(line)));
    assert.ok(logs.some((line) => /moderation=pass/.test(line)));
    assert.ok(logs.every((line) => !line.includes('蓝发少女')), '日志不应包含完整 prompt');
    assert.deepEqual(Buffer.from(toImageSegment(result.buffer).data.file.slice(9), 'base64'), PNG);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('审核拒绝：不落盘、不发送', async () => {
  const dir = tempState();
  const logs = [];
  try {
    const result = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      fetchImpl: async () => okResponse(),
      inspectImage: async () => ({ appropriate: false, confidence: 0.9, safetyReason: 'sexual' }),
      logger: (line) => logs.push(line)
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'moderation');
    assert.equal(readdirSync(dir).length, 0);
    assert.ok(logs.some((line) => /reject reason=moderation/.test(line)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('审核服务不可用：fail closed', async () => {
  const dir = tempState();
  try {
    const result = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      fetchImpl: async () => okResponse(),
      inspectImage: async () => { throw new Error('vision unavailable'); },
      logger: () => {}
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'moderation-unavailable');
    assert.match(result.error, /vision unavailable/);
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider 失败：返回原因且不落盘', async () => {
  const dir = tempState();
  const logs = [];
  try {
    const result = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => '' } }),
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      sleep: async () => {},
      logger: (line) => logs.push(line)
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'provider');
    assert.match(result.error, /502/);
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
    assert.ok(logs.some((line) => /fail reason=provider/.test(line)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider 临时 503：自动重试后成功', async () => {
  const dir = tempState();
  let calls = 0;
  const waits = [];
  try {
    const result = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 503, headers: { get: () => 'text/plain' }, text: async () => 'busy' };
        return okResponse();
      },
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      sleep: async (ms) => { waits.push(ms); },
      logger: () => {}
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1500]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('免费额度 402：不把错误卡片当图，进入冷却并快速失败', async () => {
  resetProviderCooldown();
  const dir = tempState();
  let calls = 0;
  const logs = [];
  try {
    const first = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 402, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]) };
      },
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      sleep: async () => {},
      logger: (line) => logs.push(line)
    });
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'rate-limit');
    assert.ok(first.retryAfterMs > 40_000);

    const second = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      fetchImpl: async () => { calls += 1; return okResponse(); },
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      logger: () => {}
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'rate-limit');
    assert.equal(calls, 1, '冷却期间不应再打 provider');
    assert.ok(logs.some((line) => /fail reason=rate-limit/.test(line)));
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    resetProviderCooldown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('智谱 provider：url 与 b64 双响应解析', async () => {
  const dir = tempState();
  const config = normalizeImageGenConfig({
    provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-3-flash', apiKey: 'test-key'
  });
  let calls = 0;
  try {
    const viaUrl = await generateImage({ description: '蓝发少女', config, target: '1', isGroup: false }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      fetchImpl: async (url) => {
        calls += 1;
        if (calls === 1) {
          assert.match(url, /\/images\/generations$/);
          return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data: [{ url: 'https://cdn.example/x.png' }] }) };
        }
        return okResponse(PNG);
      },
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      logger: () => {}
    });
    assert.equal(viaUrl.ok, true);
    assert.equal(viaUrl.mime, 'image/png');
    assert.equal(calls, 2, 'url 响应需要再下载一次图片');

    calls = 0;
    const viaB64 = await generateImage({ description: '蓝发少女', config, target: '1', isGroup: false }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      fetchImpl: async () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => { calls += 1; return { data: [{ b64_json: PNG.toString('base64') }] }; }
      }),
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      logger: () => {}
    });
    assert.equal(viaB64.ok, true);
    assert.equal(calls, 1);
    assert.deepEqual(readFileSync(viaB64.filePath), PNG);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('401 错误不把 Key 带进日志或返回值', async () => {
  const dir = tempState();
  const logs = [];
  try {
    const result = await generateImage({
      description: '测试', config: normalizeImageGenConfig({
        provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'secret-key-123'
      }), target: '1', isGroup: false
    }, {
      stateDir: dir,
      fetchImpl: async () => ({
        ok: false, status: 401, headers: { get: () => 'application/json' },
        text: async () => '{"error":{"message":"invalid key secret-key-123, Authorization: Bearer secret-key-123"}}'
      }),
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      sleep: async () => {},
      logger: (line) => logs.push(line)
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'provider');
    assert.match(result.error, /401/);
    assert.ok(!result.error.includes('secret-key-123'), '返回值不能含 Key');
    assert.ok(logs.every((line) => !line.includes('secret-key-123')), '日志不能含 Key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('自绘图元数据：同名 JSON 字段完整，可按文件名与 sha256 反查', async () => {
  const dir = tempState();
  try {
    const result = await generateImage({
      description: '蓝发少女在窗边', config: POLL(), target: '1668389572', isGroup: false,
      trigger: 'tool', senderId: '1668389572', chatKey: 'private:1668389572'
    }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      fetchImpl: async () => okResponse(),
      inspectImage: async () => ({ appropriate: true, confidence: 0.95 }),
      logger: () => {}
    });
    assert.equal(result.ok, true);
    assert.ok(result.metaPath && existsSync(result.metaPath));
    assert.equal(result.metaPath, result.filePath.replace(/\.png$/, '.json'));
    const meta = readImageMeta(result.filePath);
    for (const field of ['prompt', 'provider', 'model', 'size', 'createdAt', 'chatKey', 'trigger', 'senderId', 'file', 'sha256']) {
      assert.ok(meta[field] !== undefined && meta[field] !== '', `元数据缺少 ${field}`);
    }
    assert.equal(meta.file, result.filePath.split(/[\\/]/).pop());
    assert.equal(meta.trigger, 'tool');
    assert.equal(meta.chatKey, 'private:1668389572');
    assert.equal(meta.senderId, '1668389572');
    assert.equal(meta.size, '1024x1536');
    assert.equal(meta.moderation.confidence, 0.95);

    assert.equal(findImageMeta({ file: meta.file, root: dir }).file, meta.file);
    assert.equal(findImageMeta({ sha256: meta.sha256, root: dir }).file, meta.file);
    assert.equal(findImageMeta({ sha256: 'deadbeef', root: dir }), null);

    const tag = formatSelfDrawnTag(meta);
    assert.match(tag, /^\[我自己画的图｜/);
    assert.match(tag, /提示词：蓝发少女在窗边/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('审核拒绝时不写元数据', async () => {
  const dir = tempState();
  try {
    const result = await generateImage({ description: '测试', config: POLL(), target: '1', isGroup: false, trigger: 'tool' }, {
      stateDir: dir,
      fetchImpl: async () => okResponse(),
      inspectImage: async () => ({ appropriate: false, confidence: 0.9, safetyReason: 'sexual' }),
      logger: () => {}
    });
    assert.equal(result.ok, false);
    assert.equal(readdirSync(dir).length, 0, '审核拒绝后目录里不应有图片或元数据');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pollinations 兜底配置不带 Key', () => {
  const primary = normalizeImageGenConfig({ provider: 'openai', baseUrl: 'https://x', apiKey: 'secret-key-123', model: 'cogview-3-flash' });
  const fallback = pollinationsFallbackConfig(primary);
  assert.equal(fallback.provider, 'pollinations');
  assert.equal(fallback.model, 'flux');
  assert.equal(fallback.apiKey, '');
  assert.equal(fallback.responseFormat, '');
  assert.equal(buildImageRequest(fallback, 'p').init.method, 'GET');
});

test('provider 链：配置解析与降级顺序', async () => {
  const config = {
    provider: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'free-model',
    chain: [
      { name: 'free', provider: 'openai', model: 'free-model', tier: 'free', when: 'always' },
      { name: 'paid', provider: 'openai', model: 'paid-model', tier: 'paid', when: 'onQuotaExhausted' },
      { name: 'fallback', provider: 'pollinations', model: 'flux', tier: 'fallback', when: 'onError' }
    ]
  };
  const chain = normalizeImageGenChain(config);
  assert.deepEqual(chain.map((item) => item.name), ['free', 'paid', 'fallback']);
  assert.equal(chain[0].when, 'always');
  assert.equal(chain[1].tier, 'paid');
  assert.equal(chain[2].provider, 'pollinations');

  assert.equal(normalizeImageGenChain({ provider: 'openai' }).length, 1, '未配置 chain 时保持单 provider');
  assert.equal(normalizeImageGenChain({ chain: [{ provider: 'openai', enabled: false }] })[0].when, 'always');
  const normalizedOnce = normalizeImageGenConfig(config);
  assert.equal(normalizedOnce.chain?.length, 3, 'normalize 后 chain 不应丢失');
  assert.deepEqual(normalizeImageGenChain(normalizedOnce).map((item) => item.name), ['free', 'paid', 'fallback']);

  assert.equal(isQuotaExhausted({ reason: 'rate-limit' }), true);
  assert.equal(isQuotaExhausted({ status: 402 }), true);
  assert.equal(isQuotaExhausted({ providerCode: '1113' }), true);
  assert.equal(isQuotaExhausted({ error: 'provider HTTP 429: 余额不足' }), true);
  assert.equal(isQuotaExhausted({ status: 401, error: 'provider HTTP 401 身份验证失败' }), false);
});

function routedFetch(routes) {
  return async (url, init) => {
    const model = init?.body ? JSON.parse(init.body).model : '';
    const key = model || (String(url).includes('pollinations') ? 'pollinations' : 'other');
    const route = routes[key];
    if (!route) throw new Error(`unexpected provider ${key}`);
    return route();
  };
}

const failResponse = (status, body) => ({ ok: false, status, text: async () => body });

test('provider 链：401 鉴权失败跳过付费档，直接落 pollinations', async () => {
  resetProviderCooldown();
  const dir = tempState();
  const seen = [];
  try {
    const result = await generateImage({
      description: '蓝发少女', target: '1', isGroup: false,
      config: {
        provider: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'free-model',
        chain: [
          { name: 'free', provider: 'openai', model: 'free-model', tier: 'free', when: 'always' },
          { name: 'paid', provider: 'openai', model: 'paid-model', tier: 'paid', when: 'onQuotaExhausted' },
          { name: 'fallback', provider: 'pollinations', model: 'flux', tier: 'fallback', when: 'onError' }
        ]
      }
    }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      logger: () => {},
      fetchImpl: routedFetch({
        'free-model': () => { seen.push('free-model'); return failResponse(401, '{"error":{"code":"1000","message":"身份验证失败"}}'); },
        'paid-model': () => { seen.push('paid-model'); return okResponse(); },
        pollinations: () => { seen.push('pollinations'); return okResponse(); }
      })
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'pollinations');
    assert.equal(result.tier, 'fallback');
    assert.deepEqual(seen, ['free-model', 'pollinations'], '401 不是额度问题，不应尝试付费档');
    assert.deepEqual(result.attempts.map((item) => [item.tier, item.ok]), [['free', false], ['fallback', true]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider 链：免费额度耗尽切付费档', async () => {
  resetProviderCooldown();
  const dir = tempState();
  const seen = [];
  try {
    const result = await generateImage({
      description: '蓝发少女', target: '1', isGroup: false,
      config: {
        provider: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'free-model',
        chain: [
          { name: 'free', provider: 'openai', model: 'free-model', tier: 'free', when: 'always' },
          { name: 'paid', provider: 'openai', model: 'paid-model', tier: 'paid', when: 'onQuotaExhausted' },
          { name: 'fallback', provider: 'pollinations', model: 'flux', tier: 'fallback', when: 'onError' }
        ]
      }
    }, {
      stateDir: dir,
      now: () => Date.UTC(2026, 0, 1, 4),
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      logger: () => {},
      fetchImpl: routedFetch({
        'free-model': () => { seen.push('free-model'); return failResponse(402, '{"error":{"code":"1113","message":"余额不足"}}'); },
        'paid-model': () => { seen.push('paid-model'); return okOpenaiResponse(); },
        pollinations: () => { seen.push('pollinations'); return okResponse(); }
      })
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai');
    assert.equal(result.tier, 'paid');
    assert.equal(result.model, 'paid-model');
    assert.deepEqual(seen, ['free-model', 'paid-model']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider 链：全挂时返回失败且记录每一档', async () => {
  resetProviderCooldown();
  const dir = tempState();
  const seen = [];
  try {
    const result = await generateImage({
      description: '蓝发少女', target: '1', isGroup: false,
      config: {
        provider: 'openai', baseUrl: 'https://x', apiKey: 'k', model: 'free-model',
        chain: [
          { name: 'free', provider: 'openai', model: 'free-model', tier: 'free', when: 'always' },
          { name: 'paid', provider: 'openai', model: 'paid-model', tier: 'paid', when: 'onQuotaExhausted' },
          { name: 'fallback', provider: 'pollinations', model: 'flux', tier: 'fallback', when: 'onError' }
        ]
      }
    }, {
      stateDir: dir,
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      logger: () => {},
      fetchImpl: routedFetch({
        'free-model': () => { seen.push('free-model'); return failResponse(402, '{"error":{"code":"1113","message":"余额不足"}}'); },
        'paid-model': () => { seen.push('paid-model'); return failResponse(402, '{"error":{"code":"1113","message":"余额不足"}}'); },
        pollinations: () => { seen.push('pollinations'); return failResponse(400, 'bad request'); }
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'provider');
    assert.deepEqual(seen, ['free-model', 'paid-model', 'pollinations']);
    assert.deepEqual(result.attempts.map((item) => item.tier), ['free', 'paid', 'fallback']);
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider 注册表：未知值报错，链项不继承跨 provider 的 baseUrl/apiKey', () => {
  assert.throws(() => normalizeImageGenConfig({ provider: 'midjourney' }), /不支持的图片 provider/);
  const chain = normalizeImageGenChain({
    provider: 'openai', baseUrl: 'https://zhipu.example', apiKey: 'zhipu-key', model: 'free-model',
    chain: [
      { name: 'a', provider: 'openai', model: 'free-model', when: 'always' },
      { name: 'b', provider: 'dashscope', model: 'qwen-image-edit', when: 'onError' }
    ]
  });
  assert.equal(chain[0].apiKey, 'zhipu-key');
  assert.equal(chain[1].apiKey, '');
  assert.equal(chain[1].baseUrl, 'https://dashscope.aliyuncs.com/api/v1');
  assert.equal(chain[1].textModel, 'qwen-image-3.0');
});

test('能力声明与正/负向词拆分', () => {
  const parts = buildPromptParts('坐姿', '立绘', 'Q版', '固定人物');
  assert.match(parts.positive, /固定人物/);
  assert.equal(parts.negative, 'Q版');
  assert.ok(!parts.positive.includes('Q版'));
  assert.match(buildPrompt('坐姿', '立绘', 'Q版', '固定人物'), /【严格禁止】Q版/);
  assert.equal(providerCapabilities('dashscope').referenceImage, true);
  assert.equal(providerCapabilities('dashscope').negativePrompt, true);
  assert.equal(providerCapabilities('openai').referenceImage, false);
});

test('dashscope 请求：参考图转 data url，编辑/文生图模型与参数正确', () => {
  const config = normalizeImageGenConfig({
    provider: 'dashscope', apiKey: 'k', model: 'qwen-image-edit', textModel: 'qwen-image'
  });
  const reference = { mime: 'image/png', data: pngWithSize(768, 1024) };
  const request = buildImageRequest(config, { positive: '换到夜晚街头', negative: 'Q版' }, { references: [reference] });
  assert.equal(request.url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(request.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'qwen-image-edit');
  assert.equal(body.parameters.negative_prompt, 'Q版');
  assert.equal(body.parameters.watermark, false);
  assert.equal(body.parameters.prompt_extend, false);
  assert.match(body.input.messages[0].content[0].image, /^data:image\/png;base64,/);
  assert.equal(body.input.messages[0].content.at(-1).text, '换到夜晚街头');

  const textOnly = JSON.parse(buildImageRequest(config, { positive: '只画人', negative: '' }, { references: [] }).init.body);
  assert.equal(textOnly.model, 'qwen-image');
  assert.equal(textOnly.parameters.size, '1024*1536');
  assert.ok(!('negative_prompt' in textOnly.parameters));
});

test('dashscope 返回：解析多模态 choices 并下载，meta 记录 requestId/参考图/真实模型', async () => {
  resetProviderCooldown();
  const dir = tempState();
  try {
    const calls = [];
    const result = await generateImage({
      description: '换到夜晚街头', target: '1', isGroup: false,
      referenceImage: pngWithSize(768, 1024).toString('base64'),
      config: {
        provider: 'dashscope', apiKey: 'k', baseUrl: 'https://dashscope.example/api/v1',
        model: 'qwen-image-edit', maxRetries: 0, stylePrompt: '立绘', negativePrompt: 'Q版'
      }
    }, {
      stateDir: dir,
      logger: () => {},
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes('multimodal-generation')) {
          return {
            ok: true, status: 200,
            json: async () => ({
              request_id: 'req-1',
              output: { choices: [{ message: { content: [{ image: 'https://cdn.example/out.png' }] } }] },
              usage: { input_tokens: 10, output_tokens: 20 }
            })
          };
        }
        return okResponse();
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'dashscope');
    assert.equal(result.meta.providerRequestId, 'req-1');
    assert.equal(result.meta.references.length, 1);
    assert.match(result.meta.negativePrompt, /^裁切脚部、脚部出画/);
    assert.ok(result.meta.seed > 0);
    assert.equal(calls.filter((url) => url.includes('multimodal-generation')).length, 1);
  } finally { resetProviderCooldown(); rmSync(dir, { recursive: true, force: true }); }
});

test('参考图校验：base64/路径可用，张数、格式、边长越界拒绝', () => {
  const dir = tempState();
  try {
    const ok = normalizeReferenceImages(pngWithSize(1024, 1536).toString('base64'));
    assert.equal(ok.ok, true);
    assert.equal(ok.images[0].width, 1024);
    assert.equal(ok.images[0].height, 1536);

    const file = join(dir, 'ref.png');
    writeFileSync(file, pngWithSize(768, 1024));
    assert.equal(normalizeReferenceImages(file).ok, true);

    assert.equal(normalizeReferenceImages(Array(4).fill(pngWithSize(512, 512))).ok, false);
    assert.equal(normalizeReferenceImages(pngWithSize(128, 128)).ok, false);
    assert.equal(normalizeReferenceImages(Buffer.from('GIF89a', 'ascii')).ok, false);
    assert.equal(normalizeReferenceImages(join(dir, 'missing.png')).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('提示词闸门：未成年仍拦截，真人照片与 IP 角色放行', async () => {
  assert.equal(inspectDrawPrompt('画一个成年女性在海边').ok, true);
  assert.equal(inspectDrawPrompt('画一个幼女').ok, false);
  assert.equal(inspectDrawPrompt('萝莉风格').ok, false);
  assert.equal(inspectDrawPrompt('loli').ok, false);
  // 已放开的两类
  assert.equal(inspectDrawPrompt('真人写真风格').ok, true);
  assert.equal(inspectDrawPrompt('photorealistic portrait').ok, true);
  assert.equal(inspectDrawPrompt('real person photo').ok, true);
  assert.equal(inspectDrawPrompt('实拍照片质感').ok, true);
  assert.equal(inspectDrawPrompt('初音未来').ok, true);
  assert.equal(inspectDrawPrompt('原神风格').ok, true);
  assert.equal(inspectDrawPrompt('fate 里的角色').ok, true);
  assert.equal(inspectDrawPrompt('明日方舟 阿米娅').ok, true);

  const dir = tempState();
  let called = 0;
  try {
    const result = await generateImage({ description: '画一个萝莉', config: POLL(), target: '1', isGroup: false }, {
      stateDir: dir,
      logger: () => {},
      fetchImpl: async () => { called += 1; return okResponse(); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'prompt-blocked');
    assert.equal(called, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('视觉审核口径：只拦最私密部位暴露与真实性行为，其余放行', () => {
  // 仍拦：appropriate=false 且置信度达标
  assert.equal(shouldBlockImageStorage({ appropriate: false, confidence: 0.9 }), true);
  // 放行：轻薄材质、贴身、潮湿、姿态暗示等不再单独构成拦截
  assert.equal(shouldBlockImageStorage({ appropriate: true, confidence: 0.99 }), false);
  assert.equal(shouldBlockImageStorage({ appropriate: true, sexualSuggestive: true, confidence: 0.99 }), false);
  // 阈值 0.75：低于阈值的判定视为不确定，按放行处理
  assert.equal(shouldBlockImageStorage({ appropriate: false, confidence: 0.5 }), false);
  assert.equal(shouldBlockImageStorage({ appropriate: false, confidence: 0.74 }), false);
  assert.equal(shouldBlockImageStorage({ appropriate: false, confidence: 0.75 }), true);
  assert.match(DRAW_MODERATION_PROMPT, /露点/);
  assert.match(DRAW_MODERATION_PROMPT, /真实.*行为/);
  assert.doesNotMatch(DRAW_MODERATION_PROMPT, /sexual_suggestive/);
});

test('冷却按 provider+model 隔离：一个后端 429 不影响另一个', async () => {
  resetProviderCooldown();
  const dir = tempState();
  try {
    const a = { provider: 'openai', baseUrl: 'https://a.example', apiKey: 'k', model: 'm-a', maxRetries: 0 };
    const b = { provider: 'openai', baseUrl: 'https://b.example', apiKey: 'k', model: 'm-b', maxRetries: 0 };
    const first = await generateImage({ description: '测试', config: a, target: '1', isGroup: false }, {
      stateDir: dir, logger: () => {},
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '' }, text: async () => 'slow down' })
    });
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'rate-limit');

    let calls = 0;
    const second = await generateImage({ description: '测试', config: b, target: '1', isGroup: false }, {
      stateDir: dir, logger: () => {},
      inspectImage: async () => ({ appropriate: true, confidence: 0.9 }),
      fetchImpl: async () => { calls += 1; return okOpenaiResponse(); }
    });
    assert.equal(second.ok, true);
    assert.equal(calls, 1);
  } finally { resetProviderCooldown(); rmSync(dir, { recursive: true, force: true }); }
});

test('重试降为 0 时只打一次后端；体积超限在审核前拒绝', async () => {
  resetProviderCooldown();
  const dir = tempState();
  try {
    let calls = 0;
    const failed = await generateImage({
      description: '测试', target: '1', isGroup: false,
      config: { provider: 'openai', baseUrl: 'https://a.example', apiKey: 'k', maxRetries: 0 }
    }, {
      stateDir: dir, logger: () => {},
      fetchImpl: async () => { calls += 1; return { ok: false, status: 502, headers: { get: () => '' }, text: async () => 'bad gateway' }; }
    });
    assert.equal(failed.ok, false);
    assert.equal(calls, 1);

    let inspected = 0;
    const tooLarge = await generateImage({
      description: '测试', target: '1', isGroup: false,
      config: {
        provider: 'pollinations', model: 'flux',
        chain: [{ provider: 'pollinations', model: 'flux', tier: 'free', when: 'always', maxOutputBytes: 1_048_576 }]
      }
    }, {
      stateDir: dir, logger: () => {},
      inspectImage: async () => { inspected += 1; return { appropriate: true, confidence: 0.9 }; },
      fetchImpl: async () => okResponse(Buffer.alloc(1_048_577))
    });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.reason, 'image-too-large');
    assert.equal(inspected, 0);
  } finally { resetProviderCooldown(); rmSync(dir, { recursive: true, force: true }); }
});

test('最近图片上下文：自绘图注入来源标记', () => {
  const now = Date.UTC(2026, 0, 1, 4);
  const meta = { description: '蓝发少女在窗边', createdAt: new Date(now).toISOString() };
  const tagged = recentImageFollowupContext({ caption: '一个蓝发少女', at: now - 1000, selfDrawn: meta }, '你觉得这张图怎么样', now);
  assert.match(tagged, /\[我自己画的图｜/);
  assert.match(tagged, /这张图是你自己画的/);
  assert.match(tagged, /一个蓝发少女/);

  const plain = recentImageFollowupContext({ caption: '一个蓝发少女', at: now - 1000 }, '你觉得这张图怎么样', now);
  assert.ok(!plain.includes('我自己画的图'));
  assert.equal(selfDrawnImageDescription('一个蓝发少女', meta).startsWith('[我自己画的图｜'), true);
  assert.equal(selfDrawnImageDescription('一个蓝发少女', null), '一个蓝发少女');
});
