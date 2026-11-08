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
  VIBE_MODES, VIBES, pickVibe, resolveVibe, outfitPoolForVibe
} from '../src/image-gen.mjs';
import { inspectDrawPrompt } from '../src/image-content-policy.mjs';
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
  assert.match(poll.url, /height=1024/);
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
  assert.equal(body.size, '1024x1024');
  assert.equal(body.model, 'cogview-3-flash');
  assert.ok(!('response_format' in body), '智谱默认不传 response_format');

  const b64Config = normalizeImageGenConfig({ provider: 'openai', baseUrl: 'https://x', responseFormat: 'b64_json' });
  assert.equal(JSON.parse(buildImageRequest(b64Config, 'p').init.body).response_format, 'b64_json');
});

test('群聊 @ 前缀剥离与命令解析', () => {
  assert.equal(stripMentionPrefix('[CQ:at,qq=123456] 画图 一只猫'), '画图 一只猫');
  assert.equal(stripMentionPrefix('@小鲸鱼 画图 一只猫'), '画图 一只猫');
  assert.equal(stripMentionPrefix('[CQ:at,qq=1][CQ:at,qq=2] /画图 海边'), '/画图 海边');
  assert.deepEqual(parseImageCommand('@小鲸鱼 画图 一只戴墨镜的橘猫'), { description: '一只戴墨镜的橘猫' });
  assert.deepEqual(parseImageCommand('[CQ:at,qq=123] /画图 海边'), { description: '海边' });
  assert.equal(parseImageCommand('@小鲸鱼 帮我看看这张图'), null);
});

test('群聊权限：主人放行、开关关闭拒绝群友、超限话术', () => {
  const base = normalizeImageGenConfig({ allowGroup: false });
  assert.equal(decideImageAccess({ isGroup: true, isOwner: true, mentioned: false, target: '9', sender: '1', config: base }).allowed, true);

  const blocked = decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: base });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reply, /还没对群里开放/);

  const open = normalizeImageGenConfig({ allowGroup: true, groupDailyLimit: 1, groupUserCooldownMs: 0, groupCooldownMs: 0 });
  assert.equal(decideImageAccess({ isGroup: true, isOwner: false, mentioned: false, target: '9', sender: '2', config: open }).allowed, false);
  assert.match(decideImageAccess({ isGroup: true, isOwner: false, mentioned: false, target: '9', sender: '2', config: open }).reply, /@我/);

  const whitelist = { ...open, groupWhitelist: ['111'] };
  assert.match(decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: whitelist }).reply, /这个群还没开放/);

  let now = Date.UTC(2026, 0, 1, 4);
  const quota = createImageGenQuota({ now: () => now });
  assert.equal(decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: open, quota }).allowed, true);
  quota.record('u:2');
  quota.record('g:9');
  const limited = decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: open, quota });
  assert.equal(limited.allowed, false);
  assert.match(limited.reply, /次数用完了/);

  now += 60_000;
  assert.equal(decideImageAccess({ isGroup: true, isOwner: false, mentioned: true, target: '9', sender: '2', config: open, quota }).allowed, false);

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
  assert.match(prompt, /画风硬约束/);
  assert.match(prompt, /七头身/);
  assert.match(prompt, /赛璐璐上色与厚涂混合/);
  assert.match(prompt, /严格禁止/);
  assert.match(prompt, /Q版/);
  assert.match(prompt, /三头身/);
  assert.match(prompt, /猫耳毛线帽/);
});

test('人物锁定为 DeepSeek 女化形象模板', () => {
  const prompt = buildPrompt('坐在窗边看书');
  assert.match(prompt, /【固定人物，不可替换】/);
  assert.match(prompt, /纯宝蓝、钴蓝色长发/);
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
  assert.deepEqual(OUTFIT_NAMES, ['maid', 'jk', 'hoodie', 'knit', 'yukata', 'shirt']);
  const knit = normalizeImageGenConfig({ outfit: 'knit' });
  assert.equal(knit.outfit, 'knit');
  assert.match(knit.stylePrompt, /针织开衫/);
  assert.match(knit.stylePrompt, /小鲸鱼刺绣/);
  assert.match(knit.stylePrompt, /脸型、五官、发型、发色与耳饰保持固定人物模板不变/);
  // 服装层不覆盖人物层：脸和发色必须还在。
  assert.match(knit.stylePrompt, /纯宝蓝、钴蓝色长发/);
  assert.match(knit.stylePrompt, /半杏眼/);
  // 未知值回落 auto；auto 会从池里随机。
  assert.equal(normalizeImageGenConfig({ outfit: 'bogus' }).outfit.length > 0, true);
  assert.equal(normalizeImageGenConfig({ outfit: 'none' }).outfit, 'none');
  assert.notEqual(pickOutfit(() => 0), pickOutfit(() => 0.99));
  assert.ok(OUTFIT_NAMES.every((name) => normalizeImageGenConfig({ outfit: name }).promptLayers.clothing.includes('鲸鱼')));
});

test('尾巴三档：required/optional/off 重写人物层并调整负向词', () => {
  assert.equal(normalizeImageGenConfig({}).tail, 'optional');
  const required = normalizeImageGenConfig({ tail: 'required' });
  assert.match(required.characterPrompt, /只有一条鲸尾/);
  assert.match(required.characterPrompt, /cetacean_tail/);
  const optional = normalizeImageGenConfig({ tail: 'optional' });
  assert.match(optional.characterPrompt, /鲸尾可选/);
  assert.doesNotMatch(optional.characterPrompt, /只有一条鲸尾/);
  const off = normalizeImageGenConfig({ tail: 'off' });
  assert.doesNotMatch(off.characterPrompt, /鲸尾|cetacean_tail/);
  assert.match(off.characterPrompt, /鲸鳍状耳/);
  assert.match(off.characterPrompt, /小鲸鱼刺绣/);
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
  assert.match(base.characterPrompt, /静态五官结构固定/);
  assert.match(base.stylePrompt, /【表情】/);
  // 每种表情都有可执行的眉眼嘴描述，且都带身份锁。
  for (const name of EXPRESSION_NAMES) {
    const layer = expressionLayerFor(name);
    assert.match(layer, /眉毛/);
    assert.match(layer, /眼睛/);
    assert.match(layer, /瞳孔高光/);
    assert.match(layer, /嘴角/);
    assert.match(layer, /脸红/);
    assert.match(layer, /脸型、眼型基础形状、五官位置、发型发色与耳饰保持固定人物模板不变/);
  }
  const happy = normalizeImageGenConfig({ expression: 'happy' });
  assert.match(happy.stylePrompt, /开心大笑/);
  assert.match(happy.stylePrompt, /【表情】/);
  // 换表情时人物特征必须原样保留。
  assert.match(happy.characterPrompt, /纯宝蓝、钴蓝色长发/);
  assert.match(happy.characterPrompt, /鹅蛋脸/);
  assert.match(happy.characterPrompt, /鲸鳍状耳/);
  // 表情相关负向词防止“一笑就换脸”。
  assert.match(happy.negativePrompt, /表情改变脸型/);
  assert.match(happy.negativePrompt, /大笑拉宽脸型/);
  assert.match(happy.negativePrompt, /眼睛变成大圆眼/);
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
  assert.match(cute.stylePrompt, /成年女性体型与比例/);
  assert.match(cute.characterPrompt, /成年女性/);
  assert.match(cute.negativePrompt, /萌系画成小孩/);
  assert.match(cute.negativePrompt, /儿童体型/);
  assert.match(cute.negativePrompt, /未发育/);
  const mature = normalizeImageGenConfig({ vibe: 'mature', outfit: 'knit', tail: 'optional' });
  assert.match(mature.stylePrompt, /成熟御姐/);
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
  const order = ['画质与风格', '固定人物，不可替换', '服装', '构图与视角', '光影', '背景与氛围'];
  const indexes = order.map((label) => config.stylePrompt.indexOf(`【${label}】`));
  assert.ok(indexes.every((index) => index >= 0), '六层标签都要存在');
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, '层顺序必须固定');
  assert.match(config.stylePrompt, /【光影】顶光，硬阴影/);
  assert.match(config.stylePrompt, /【画质与风格】测试画质层/);
  assert.match(config.stylePrompt, /鲸鱼/);
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
    assert.equal(result.height, 1024);
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
    assert.equal(meta.size, '1024x1024');
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
  assert.equal(textOnly.parameters.size, '1024*1024');
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
    assert.equal(result.meta.negativePrompt, 'Q版');
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

test('提示词闸门：未成年/真人/IP 角色拦截，正常描述放行且不打后端', async () => {
  assert.equal(inspectDrawPrompt('画一个成年女性在海边').ok, true);
  assert.equal(inspectDrawPrompt('画一个幼女').ok, false);
  assert.equal(inspectDrawPrompt('真人写真').ok, false);
  assert.equal(inspectDrawPrompt('初音未来').ok, false);

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
