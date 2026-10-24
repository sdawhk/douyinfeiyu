const IMAGE_FOLLOWUP_MS = 5 * 60_000;
const UNRECOGNIZED_IMAGE = /(?:无法|不能|没法|看不清|识别不出|未能).{0,14}(?:识别|看清|辨认|图片|图像|画面|内容|文字)|(?:图片|图像|画面|内容|文字).{0,14}(?:无法|不能|没法|看不清|识别不出|未能)|看不出(?:图片|图像|画面|内容)/i;

export function hasUsableImageDescription(value) {
  const description = String(value ?? '').trim();
  return description.length >= 2 && !UNRECOGNIZED_IMAGE.test(description)
    && !/^(?:\[?图片\]?|QQ 图片|未知图片|无可用描述)$/i.test(description);
}

export function recentImageFollowupContext(image, text, now = Date.now()) {
  if (!image?.caption || now - image.at < 0 || now - image.at > IMAGE_FOLLOWUP_MS) return '';
  if (!/(?:图|照片|截图|画面|刚才|刚发|这个|那个|这样|如果是你|你会怎么|怎么看|你觉得|这事)/.test(String(text))) return '';
  return `【你刚才收到的图片，识图结果】${image.caption}\n用户正在接着谈这张图片。根据已识别内容回答；不要声称看不到图片。`;
}

export function falselyClaimsImageIsUnavailable(reply) {
  return /(?:看不[到清]|没(?:看见|看到|收到)|无法(?:看|识别)|不能(?:看|识别)).{0,12}(?:图|照片|截图|画面)|(?:图|照片|截图).{0,12}(?:看不[到清]|没(?:看见|看到|收到))/.test(String(reply));
}
