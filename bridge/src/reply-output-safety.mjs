import { hasStickerDirective, stripStickerDirectives } from './reply-sticker-token.mjs';

const FINAL_MARKER = /<\|final\|>|<final>|(?:最终(?:回复|回答)|给用户的回复)\s*[:：]/i;
const REASONING_MARKER = /<\|(?:analysis|think|reasoning)\|>|<(?:analysis|think|thinking|reasoning)\b|(?:^|\n)\s*(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/i;
const INTERNAL_NARRATION = /(?:当前(?:这)?轮(?:消息|内容|对话)?\s*[，,:：]|本轮(?:消息|内容|对话|说)\s*[，,:：]?|等等[，,]\s*我(?:需要|要|得)|让我(?:先)?(?:分析|想|仔细想)|我(?:需要|要|得)(?:先)?(?:仔细)?(?:分析|判断|思考|推理|想想)|用户(?:说|提到|想要|可能|的意思是|是在)|我(?:应该|需要|要|得)(?:如何|怎么|直接)?(?:回复|回答)|先(?:分析|推理)一下|(?:the user (?:said|means|wants|is asking)|user message|current turn|we need to|I should (?:answer|reply|respond)|let me think|let's think|let's analyze|need to understand)\b)/i;
const ENGLISH_RECAP_ANALYSIS = /(?:^[^.!?\n]{1,100}\bsaid\s+["“][\s\S]{0,260}?\b(?:and then|then)\b[\s\S]{0,220}\b(?:hmm|the previous message|previous message)\b|\b(?:hmm|let me think)\b[\s\S]{0,160}\b(?:the )?(?:previous|preceding|earlier) message\b[\s\S]{0,120}\b(?:my|our)\s+(?:雷点|trigger|weak spot|sore spot)\b)/i;
const MEDIA_PLACEHOLDER = /\[(?:图片|动画表情|表情|语音|视频|文件|非文本消息)\]/g;
const GROUP_CONTEXT_LEAK = /\[(?:Image|图片)\s*:\s*\d{1,2}:\d{2}\b[^\]\n]{0,200}\]|(?:QQ\s*)?\d{5,20}[）)]\s*刚刚发了一条消息\s*[:：]|看不到原文图片里的内容[\s\S]{0,100}从语境来看/i;
const CONTROL_MARKER = /\[\s*(?:SILENT|SKIP)\s*\]/i;
const INTERNAL_STATUS_MARKER = /\[\s*sl\s*:\s*\d{1,3}\s*%\s*\]/gi;
const PROMPT_OR_DRAFT_LEAK = /DeepSeek\s*主题表情及动作\s*[\/／]\s*情[绪緒]|(?:过|過)长的提示[词詞]内容已忽略|聚焦[于於]核心回[应應]|回复听话的内容|\*{1,2}\s*(?:回复|最终回复)\s*[:：]\s*\*{1,2}|【(?:回复格式|QQ 工具会话|本会话近期已经回复)】|系统提示[，,]不要复述给用户|表情包仓库[，,]可用关键词/i;

export function sanitizeModelReply(value) {
  let text = String(value ?? '').trim();
  if (!text) return { text: '', leaked: false, blocked: true };

  // This is bridge status text, not a user-facing reply. Models may repeat it
  // after seeing diagnostic output, so never let it reach QQ.
  const originalText = text;
  text = text.split(/\r?\n/)
    .filter((line) => !/^\s*\[sticker\]\s*sent\b/i.test(line))
    .join('\n').trim();
  const stickerStatusLeaked = text !== originalText;
  text = text.replace(/\[sticker\]\s*sent\b/gi, '').trim();
  if (!text) return { text: '', leaked: true, blocked: true };

  const beforeStatusCleanup = text;
  text = text.replace(INTERNAL_STATUS_MARKER, '').replace(/[ \t]{2,}/g, ' ').trim();
  const statusMarkerLeaked = text !== beforeStatusCleanup;
  if (!text) return { text: '', leaked: true, blocked: true };

  // QQ history uses these labels for media. They are not images or useful replies.
  const beforeMediaCleanup = text;
  text = text.replace(MEDIA_PLACEHOLDER, '');
  const mediaPlaceholderLeaked = text !== beforeMediaCleanup;
  if (mediaPlaceholderLeaked) text = text.replace(/[ \t]{2,}/g, ' ').trim();
  if (!text) return { text: '', leaked: true, blocked: true };

  // Control markers are never part of a QQ reply, even with spaces or other
  // text around them. Reject the whole output so the retry can start cleanly.
  if (CONTROL_MARKER.test(text)) {
    return { text: '', leaked: true, blocked: true };
  }

  const reasoning = text.search(REASONING_MARKER);
  const final = text.match(FINAL_MARKER);
  let leaked = stickerStatusLeaked || mediaPlaceholderLeaked || statusMarkerLeaked;
  if (reasoning >= 0 && final && final.index > reasoning) {
    text = text.slice(final.index + final[0].length).trim();
    leaked = true;
  }

  text = text.replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, () => {
    leaked = true;
    return '';
  });
  const unclosed = text.search(/<(?:think|thinking|analysis|reasoning)\b[^>]*>/i);
  if (unclosed >= 0) {
    text = text.slice(0, unclosed);
    leaked = true;
  }
  text = text.replace(/<\|(?:analysis|think|reasoning)\|>[\s\S]*?(?=<\|final\|>|$)/gi, () => {
    leaked = true;
    return '';
  }).replace(/<\|final\|>/gi, '').trim();

  if (INTERNAL_NARRATION.test(text) || ENGLISH_RECAP_ANALYSIS.test(text)
      || GROUP_CONTEXT_LEAK.test(text)
      || PROMPT_OR_DRAFT_LEAK.test(text)
      || /(?:^|\n)\s*(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/i.test(text)) {
    return { text: '', leaked: true, blocked: true };
  }
  return { text, leaked, blocked: !text };
}
/** Return compact, content-free diagnostics for correlating unsafe model output. */
export function replySafetyDiagnostics(rawValue, safeResult) {
  const raw = String(rawValue ?? '');
  const markersIn = (text) => {
    const markers = [];
    if (/\[\s*tob\s*:\s*\d+\s*\]/i.test(text)) markers.push('tob');
    if (/\[\s*at\s*:\s*\d+\s*\]/i.test(text)) markers.push('at');
    if (/<\|(?:analysis|think|reasoning)\|>|<(?:analysis|think|thinking|reasoning)\b/i.test(text)) {
      markers.push('reasoning-tag');
    }
    if (/(?:^|\n)\s*(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/i.test(text)) {
      markers.push('reasoning-label');
    }
    if (/\[(?:图片|动画表情|表情|语音|视频|文件|非文本消息)\]/.test(text)) markers.push('media-placeholder');
    if (/\[\s*(?:SILENT|SKIP)\s*\]/i.test(text)) markers.push('control-marker');
    if (/\[sticker\]\s*sent/i.test(text)) markers.push('sticker-status');
    if (hasStickerDirective(text)) markers.push('sticker-directive');
    return markers;
  };
  const markers = markersIn(raw);
  const remainingMarkers = markersIn(String(safeResult?.text ?? ''));
  return {
    rawChars: raw.length,
    safeChars: String(safeResult?.text ?? '').length,
    leaked: Boolean(safeResult?.leaked),
    blocked: Boolean(safeResult?.blocked),
    markers,
    remainingMarkers
  };
}

/** Catch obvious non-answers to a question without judging the answer's facts or tone. */
export function replyQualityIssue(input, reply) {
  const question = String(input ?? '').trim();
  if (!/[?？]|什么|怎么|为什么|如何|哪(?:个|里|些|种)|谁|几(?:点|个|岁)|多少|多久|吗[。!！]?$/u.test(question)) return '';
  const answer = stripStickerDirectives(reply);
  if (!answer) return 'missing-answer';
  const compact = (value) => value.replace(/[\s，。！？!?.,、~～]+/gu, '').toLocaleLowerCase();
  const compactQuestion = compact(question);
  const compactAnswer = compact(answer);
  if (compactAnswer === compactQuestion
      || (compactQuestion.length >= 6 && compactAnswer.startsWith(compactQuestion))) return 'echoed-question';
  if (/^(?:[哈呵嘿嗯哦啊]+|收到|你猜|[?？!！。,.，~～])+$/u.test(answer)) return 'generic-non-answer';
  return '';
}

/** Compare actual reply text, not just shared topic words. */
export function repeatsRecentReply(reply, recentReplies = []) {
  const normalize = (value) => stripStickerDirectives(value)
    .replace(/[\s，。！？!?.,、~～“”"'‘’（）()]+/gu, '')
    .toLocaleLowerCase();
  const current = normalize(reply);
  if (current.length < 6) return false;
  return recentReplies.some((previousReply) => {
    const previous = normalize(previousReply);
    if (previous.length < 6) return false;
    if (current === previous) return true;
    const [shorter, longer] = current.length < previous.length
      ? [current, previous] : [previous, current];
    return shorter.length >= 12 && shorter.length / longer.length >= 0.75 && longer.includes(shorter);
  });
}
