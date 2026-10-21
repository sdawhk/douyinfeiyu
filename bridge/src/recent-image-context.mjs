const IMAGE_FOLLOWUP_MS = 5 * 60_000;

export function recentImageFollowupContext(image, text, now = Date.now()) {
  if (!image?.caption || now - image.at < 0 || now - image.at > IMAGE_FOLLOWUP_MS) return '';
  if (!/(?:图|照片|截图|画面|刚才|刚发|这个|那个|这样|如果是你|你会怎么|怎么看|你觉得|这事)/.test(String(text))) return '';
  return `【你刚才收到的图片，识图结果】${image.caption}\n用户正在接着谈这张图片。根据已识别内容回答；不要声称看不到图片。`;
}

export function falselyClaimsImageIsUnavailable(reply) {
  return /(?:看不[到清]|没(?:看见|看到|收到)|无法(?:看|识别)|不能(?:看|识别)).{0,12}(?:图|照片|截图|画面)|(?:图|照片|截图).{0,12}(?:看不[到清]|没(?:看见|看到|收到))/.test(String(reply));
}
