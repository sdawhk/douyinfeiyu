const DEFAULT_MODELS = [
  'nvidia/nemotron-3.5-super-vl:free',
  'trae/multimodal_image_kimi-k2.5'
];
const modelCooldownUntil = new Map();
const modelCooldownReason = new Map();

const PROMPT = '判断图片是不是聊天用的表情包或梗图。真人照片、风景、聊天记录截图、文档、商品图和二维码都不算。'
  + '同时判断它是否明显是 DeepSeek 小鲸鱼/DeepSeek 娘主题：看 DeepSeek 文字或标志、蓝白鲸鱼形象、蓝发且有鲸鱼尾巴等组合特征；只有普通蓝发人物或普通鲸鱼时不要武断认定。'
  + '描述画面中的动作和情绪，供聊天时挑选合适的表情。'
  + '只输出一行 JSON，格式 {"sticker":true或false,"name":"2到4个汉字的动作或情绪关键词","caption":"图片内容","deepseek":true或false,"confidence":0到1的数字,"action":"具体动作","emotion":"情绪"}。'
  + '聊天截图的 caption 要按顺序写出能看清的关键对话、说话人和图片信息；看不清的文字不要猜。其他图片用一两句话描述。不是表情包时 name 留空。';

export async function inspectStickerImage(b64, mime, options = {}) {
  const baseUrl = String(options.baseUrl || 'http://127.0.0.1:18901/v1').replace(/\/+$/, '');
  const models = options.models || DEFAULT_MODELS;
  const fetcher = options.fetcher || fetch;
  let lastFailure = 'no vision model configured';

  for (const model of models) {
    if (Date.now() < (modelCooldownUntil.get(model) || 0)) {
      lastFailure = `${model}: ${modelCooldownReason.get(model) || 'cooling down'}`;
      continue;
    }
    try {
      const response = await fetcher(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 350, stream: false,
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
          ] }]
        }),
        signal: AbortSignal.timeout(50_000)
      });
      const data = await response.json();
      if (!response.ok) {
        lastFailure = `${model}: HTTP ${response.status}`;
        if ([429, 500, 502, 503, 504].includes(response.status) || model.includes(':free')) {
          modelCooldownUntil.set(model, Date.now() + (model.includes(':free') ? 10 : 3) * 60_000);
          modelCooldownReason.set(model, `HTTP ${response.status}; cooling down`);
        }
        continue;
      }
      // The local pool can silently switch to text-only free models. Their
      // answers cannot be trusted as visual classifications.
      const servedBy = String(data.model || model);
      if (!models.includes(servedBy) && servedBy !== 'nemotron-3.5-super-vl-free') {
        lastFailure = `${model}: served by non-vision model ${servedBy}`;
        modelCooldownUntil.set(model, Date.now() + 10 * 60_000);
        modelCooldownReason.set(model, `served by non-vision model ${servedBy}; cooling down`);
        continue;
      }
      const content = data.choices?.[0]?.message?.content;
      const answer = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((part) => part.text || '').join('') : '';
      const json = answer.match(/\{[\s\S]*\}/)?.[0];
      const result = json ? JSON.parse(json) : null;
      if (typeof result?.sticker !== 'boolean' || typeof result?.caption !== 'string') {
        lastFailure = `${model}: invalid vision response`;
        continue;
      }
      return {
        sticker: result.sticker,
        name: String(result.name || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 8),
        caption: result.caption.trim().slice(0, 600),
        deepseek: typeof result.deepseek === 'boolean' ? result.deepseek : null,
        confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
        action: String(result.action || '').trim().slice(0, 24),
        emotion: String(result.emotion || '').trim().slice(0, 24),
        model: servedBy
      };
    } catch (error) {
      lastFailure = `${model}: ${error?.message || error}`;
      modelCooldownUntil.set(model, Date.now() + (model.includes(':free') ? 10 : 3) * 60_000);
      modelCooldownReason.set(model, `${error?.message || error}; cooling down`);
    }
  }
  throw new Error(`vision unavailable (${lastFailure})`);
}
