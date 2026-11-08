export const IMAGE_SAFETY_CONFIDENCE = 0.75;

/**
 * 自绘图的审核口径：只拦真正的越线画面。
 * 普通立绘、旗袍开叉、白丝、坐姿/靠姿、贴身剪裁都不算越线。
 * 输出字段沿用 inspectStickerImage 的解析结构（sticker/caption 必填）。
 */
export const DRAW_MODERATION_PROMPT = '只做一件事：判断这张自绘插画是否越线。'
  + '越线仅指：露点、裸露性器官或臀部、真实性行为、强烈性暗示（例如明显性交姿势或暴露性器官的特写）。'
  + '普通人物立绘、坐姿或靠姿、贴身服装、旗袍侧开叉、白色丝袜、露肩或锁骨、日常表情，都不算越线，sexual_suggestive=false。'
  + '如果画面是成年女性角色穿着完整或正常程度的服装，appropriate=true。'
  + '只输出 JSON：{"sticker":false,"caption":"一句话描述画面主体、姿态与服装","appropriate":true,"sexual_suggestive":false,"gross_or_graphic":false,"safety_reason":"","confidence":0.0}；'
  + 'caption 必填且为一句话；越线时 sexual_suggestive=true 并在 safety_reason 写明具体原因（如“露点”“裸露性器官”）；没有越线时 safety_reason 留空。';

/**
 * 生成前的提示词闸门：新后端（本地/第三方）没有服务端输入过滤，
 * 未成年、真人照片、其他 IP 角色必须在进模型前拦掉。
 * 只检查调用方写的画面描述，不检查固定人物模板与负向词。
 */
export const DRAW_PROMPT_RULES = [
  {
    reason: '疑似未成年角色',
    pattern: /(幼女|萝莉|正太|儿童|小孩|小女孩|小男孩|小学生|初中生|未成年|幼儿|婴儿|loli|child|minor|underage|toddler)/i
  },
  {
    reason: '真人照片',
    pattern: /(真人照片|真人写真|真人cos|photorealistic|real person|realistic photo|实拍照片)/i
  },
  {
    reason: '其他 IP 角色',
    pattern: /(原神|崩坏|星穹铁道|初音未来|初音|miku|火影|鸣人|海贼王|路飞|鬼灭之刃|炭治郎|咒术回战|五条悟|明日方舟|阿米娅|碧蓝航线|fate|saber|恋与深空)/i
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

/** Keep sexualized or graphic/disgusting images out of persistent storage. */
export function shouldBlockImageStorage(analysis) {
  const confidence = Number(analysis?.confidence);
  if (!analysis || !Number.isFinite(confidence) || confidence < IMAGE_SAFETY_CONFIDENCE) return false;
  return analysis.appropriate === false
    || analysis.sexualSuggestive === true
    || analysis.grossOrGraphic === true;
}
