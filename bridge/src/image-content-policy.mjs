export const IMAGE_SAFETY_CONFIDENCE = 0.75;

/**
 * 自绘图的审核口径（2026-11 放宽后）：只拦真正的两类越线——露点与真实性行为。
 * 臀部、半透明/薄纱透出轮廓、贴身剪裁、湿身、走光感、强烈性暗示倾向都不再判越线。
 * 输出字段沿用 inspectStickerImage 的解析结构（sticker/caption 必填）。
 */
export const DRAW_MODERATION_PROMPT = '只做一件事：判断这张自绘插画是否越线。'
  + '越线只指两类：(1) 露点——乳头、女性生殖器、男性生殖器裸露可见；(2) 真实性行为画面（性交、口交、指交等明确性行为动作）。'
  + '除此之外一律判 appropriate=true：露出臀部、半透明或薄纱透出身体轮廓、贴身剪裁、湿身、走光感、强烈性暗示倾向、坐姿靠姿、露肩锁骨、白色丝袜、旗袍侧开叉、日常表情，都不算越线。'
  + '只输出 JSON：{"sticker":false,"caption":"一句话描述画面主体、姿态与服装","appropriate":true,"safety_reason":"","confidence":0.0}；'
  + 'caption 必填且为一句话；越线时 appropriate=false 并在 safety_reason 写明属于哪一类（如“露点：乳头裸露”“真实性行为”）；没有越线时 safety_reason 留空。';

/**
 * 生成前的提示词闸门：新后端（本地/第三方）没有服务端输入过滤，
 * 未成年必须在进模型前拦掉。真人照片与其他 IP 角色已放开，不再检查。
 * 只检查调用方写的画面描述，不检查固定人物模板与负向词。
 */
export const DRAW_PROMPT_RULES = [
  {
    reason: '疑似未成年角色',
    pattern: /(幼女|萝莉|正太|儿童|小孩|小女孩|小男孩|小学生|初中生|未成年|幼儿|婴儿|loli|child|minor|underage|toddler)/i
  }
];

export function inspectDrawPrompt(text) {
  const value = String(text ?? '');
  for (const rule of DRAW_PROMPT_RULES) {
    const match = rule.pattern.exec(value);
    if (match) return { ok: false, reason: rule.reason, matched: match[0] };
  }
  return { ok: true };
}

/** Keep over-line images (露点 / 真实性行为) out of persistent storage. */
export function shouldBlockImageStorage(analysis) {
  const confidence = Number(analysis?.confidence);
  if (!analysis || !Number.isFinite(confidence) || confidence < IMAGE_SAFETY_CONFIDENCE) return false;
  return analysis.appropriate === false;
}
