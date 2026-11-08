import { hasStickerDirective, stripStickerDirectives } from './reply-sticker-token.mjs';

const FINAL_MARKER = /<\|final\|>|<final>|(?:最终(?:回复|回答)|给用户的回复)\s*[:：]/i;
const REASONING_MARKER = /<\|(?:analysis|think|reasoning)\|>|<(?:analysis|think|thinking|reasoning)\b|(?:^|\n)\s*(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/i;
const INTERNAL_NARRATION = /(?:当前(?:这)?轮(?:消息|内容|对话)?\s*[，,:：]|本轮(?:消息|内容|对话|说)\s*[，,:：]?|等等[，,]\s*我(?:需要|要|得)|让我(?:先)?(?:分析|想|仔细想)|我(?:需要|要|得)(?:先)?(?:仔细)?(?:分析|判断|思考|推理|想想)|用户(?:说|提到|想要|可能|的意思是|是在)|我(?:应该|需要|要|得)(?:如何|怎么|直接)?(?:回复|回答)|先(?:分析|推理)一下|(?:the user (?:said|means|wants|is asking)|user message|current turn|we need to|I should (?:answer|reply|respond)|let me think|let's think|let's analyze|need to understand)\b)/i;
const ENGLISH_RECAP_ANALYSIS = /(?:^[^.!?\n]{1,100}\bsaid\s+["“][\s\S]{0,260}?\b(?:and then|then)\b[\s\S]{0,220}\b(?:hmm|the previous message|previous message)\b|\b(?:hmm|let me think)\b[\s\S]{0,160}\b(?:the )?(?:previous|preceding|earlier) message\b[\s\S]{0,120}\b(?:my|our)\s+(?:雷点|trigger|weak spot|sore spot)\b)/i;
const MEDIA_PLACEHOLDER = /\[(?:图片|动画表情|表情|语音|视频|文件|非文本消息)\]/g;
const GIF_PLACEHOLDER = /\[\s*gif\s*\]/gi;
const GROUP_CONTEXT_LEAK = /\[(?:Image|图片)\s*:\s*\d{1,2}:\d{2}\b[^\]\n]{0,200}\]|(?:QQ\s*)?\d{5,20}[）)]\s*刚刚发了一条消息\s*[:：]|看不到原文图片里的内容[\s\S]{0,100}从语境来看/i;
const CONTROL_MARKER = /\[\s*(?:SILENT|SKIP)\s*\]/i;
const INTERNAL_STATUS_MARKER = /\[\s*sl\s*:\s*\d{1,3}\s*%\s*\]/gi;
const PROMPT_OR_DRAFT_LEAK = /DeepSeek\s*主题表情及动作\s*[\/／]\s*情[绪緒]|(?:过|過)长的提示[词詞]内容已忽略|聚焦[于於]核心回[应應]|回复听话的内容|\*{1,2}\s*(?:回复|最终回复)\s*[:：]\s*\*{1,2}|【(?:回复格式|QQ 工具会话|本会话近期已经回复)】|系统提示[，,]不要复述给用户|表情包仓库[，,]可用关键词/i;
const INTERNAL_CHAT_TAG = /<\/?(?:blockquote|owner|time)\b[^>]*>/i;
const LABELED_EPOCH = /(?:时间|time)\s*[:：]?\s*1[6-9]\d{11}\b/i;
const STANDALONE_EPOCH = /\b1[6-9]\d{11}\b/g;

/**
 * 去掉模型复述历史时带出的内部序列化标记，只保留可读正文。
 * 只处理明确的内部标签与毫秒级时间戳，不碰正常的尖括号、时间、手机号和订单号。
 */
export function stripInternalChatMarkers(value) {
  let text = String(value ?? '');
  const hadTags = INTERNAL_CHAT_TAG.test(text);
  if (!hadTags && !LABELED_EPOCH.test(text)) return text;
  // 闭合标签代表一个字段/一段记录的结束，换成换行避免正文粘连。
  text = text.replace(/<\/?(?:blockquote|owner|time)\b[^>]*>/gi, (tag) => (/^<\//.test(tag) ? '\n' : ''))
    .replace(/(?:时间|time)\s*[:：]?\s*1[6-9]\d{11}\b/gi, '');
  // 只有在确认出现过内部标签时，才清理裸的 13 位毫秒时间戳，降低误伤正常数字的概率。
  if (hadTags) text = text.replace(STANDALONE_EPOCH, '');
  return text.split(/\r?\n/)
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n').trim();
}

/**
 * 群历史回声检测的实测参数：
 * - 8 字以上才做“近原文”强命中，避免“赢了/好奇怪/打游戏”这类常见词误伤；
 * - 4~7 字短句只做精确命中，并且只作为“连续 transcript”的证据；
 * - 至少 2 条强命中，或 2 条以上命中里至少有 1 条强命中且总命中数 >= 3，才判定为整段复述；
 * - 命中间隔不超过 1 行，且间隔行必须是短行/纯标点，避免把中间的评论一起吞掉；
 * - 丢掉回声后正文不足 6 个有效字符，视为只剩 transcript，直接 blocked。
 */
const ECHO_STRONG_MIN_CHARS = 8;
const ECHO_WEAK_MIN_CHARS = 4;
const ECHO_SIMILARITY = 0.8;
const ECHO_MAX_HIT_GAP = 2;
const ECHO_MIN_STRONG_HITS = 2;
const ECHO_MIN_TOTAL_HITS = 3;
const ECHO_MIN_REMAINING_CHARS = 6;

function normalizeEchoLine(value) {
  return String(value ?? '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .toLocaleLowerCase();
}

function echoHistoryEntries(historyLines) {
  return (Array.isArray(historyLines) ? historyLines : [])
    .map((item) => typeof item === 'string'
      ? { senderName: '', text: item }
      : { senderName: String(item?.senderName ?? ''), text: String(item?.text ?? '') });
}

function bigramDice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (value) => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * 丢弃模型逐句复述群历史的部分，只保留下它自己的评论。
 * 返回 dropped 行数、总行数和最终 blocked 状态，便于调用方决定是否整条丢弃。
 */
export function stripHistoryEcho(value, historyLines) {
  const text = String(value ?? '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || !Array.isArray(historyLines) || !historyLines.length) {
    return { text, dropped: 0, totalLines: lines.length, blocked: false };
  }
  const entries = echoHistoryEntries(historyLines);
  const historyText = new Set();
  const historySpeakers = new Set();
  for (const entry of entries) {
    const normalizedText = normalizeEchoLine(entry.text);
    if (normalizedText) historyText.add(normalizedText);
    const normalizedSpeaker = normalizeEchoLine(entry.senderName);
    if (normalizedSpeaker.length >= 2) historySpeakers.add(normalizedSpeaker);
  }
  const longHistory = [...historyText].filter((item) => item.length >= ECHO_STRONG_MIN_CHARS);
  const normalizedLines = lines.map(normalizeEchoLine);
  const types = normalizedLines.map((line) => {
    if (!line) return 'punct';
    if (line.length >= ECHO_STRONG_MIN_CHARS) {
      if (historyText.has(line)) return 'strong';
      const tolerance = Math.max(4, Math.ceil(line.length * 0.25));
      for (const candidate of longHistory) {
        if (Math.abs(candidate.length - line.length) <= tolerance
            && bigramDice(line, candidate) >= ECHO_SIMILARITY) return 'strong';
      }
      return 'none';
    }
    if (line.length >= ECHO_WEAK_MIN_CHARS && historyText.has(line)) return 'weak';
    if (line.length >= 2 && (historyText.has(line) || historySpeakers.has(line))) return 'short';
    return 'none';
  });
  const isHit = (index) => types[index] !== 'none' && types[index] !== 'punct';
  const canBridge = (from, to) => {
    for (let i = from + 1; i < to; i += 1) {
      if (normalizedLines[i].length > 6 && types[i] !== 'none' && types[i] !== 'punct') return false;
      if (normalizedLines[i].length > 6) return false;
    }
    return true;
  };
  const dropped = new Set();
  const finalizeGroup = (group) => {
    if (!group.length) return;
    const strongHits = group.filter((index) => types[index] === 'strong').length;
    const qualifies = strongHits >= ECHO_MIN_STRONG_HITS
      || (group.length >= ECHO_MIN_TOTAL_HITS && strongHits >= 1);
    if (qualifies) {
      for (let i = group[0]; i <= group[group.length - 1]; i += 1) dropped.add(i);
      return;
    }
    for (const index of group) if (types[index] === 'strong') dropped.add(index);
  };
  let group = [];
  for (let index = 0; index < types.length; index += 1) {
    if (!isHit(index)) continue;
    if (group.length && index - group[group.length - 1] > ECHO_MAX_HIT_GAP) {
      finalizeGroup(group);
      group = [];
    } else if (group.length && !canBridge(group[group.length - 1], index)) {
      finalizeGroup(group);
      group = [];
    }
    group.push(index);
  }
  finalizeGroup(group);

  if (!dropped.size) return { text, dropped: 0, totalLines: lines.length, blocked: false };
  const remainingLines = lines.filter((line, index) => !dropped.has(index) && normalizeEchoLine(line));
  const remaining = remainingLines.join('\n').trim();
  const remainingChars = normalizeEchoLine(remaining).length;
  if (remainingChars < ECHO_MIN_REMAINING_CHARS) {
    return { text: '', dropped: dropped.size, totalLines: lines.length, blocked: true };
  }
  return { text: remaining, dropped: dropped.size, totalLines: lines.length, blocked: false };
}

/**
 * 一条历史回复是否以复述群历史为主，用于避免把旧 transcript 继续注入 prompt。
 * 实时历史不足时（例如 bridge 刚重启），退化为结构判断：5 行以上、每行不超过 30 字、
 * 且没有任何句末标点，视为逐条 transcript。宁愿少注入一条旧回复，也不要继续自我强化。
 */
export function isLikelyHistoryTranscript(value) {
  const lines = String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 5) return false;
  const normalized = lines.map(normalizeEchoLine).filter(Boolean);
  if (normalized.length < 5) return false;
  if (lines.some((line) => /[。！？!?]\s*$/.test(line))) return false;
  if (normalized.filter((line) => line.length >= 8).length < 2) return false;
  return normalized.every((line) => line.length <= 30);
}

export function isHistoryEchoReply(value, historyLines, minRatio = 0.5) {
  const echo = stripHistoryEcho(value, historyLines);
  if (echo.dropped) {
    if (echo.blocked) return true;
    if (echo.dropped / Math.max(1, echo.totalLines) >= minRatio) return true;
  }
  return isLikelyHistoryTranscript(value);
}

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

  const beforeRoleLabelCleanup = text;
  text = text.replace(/^\s*(?:\[admin\]|【管理员】)\s*/i, '').trim();
  const roleLabelLeaked = text !== beforeRoleLabelCleanup;
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

  const beforeGifCleanup = text;
  text = text.replace(GIF_PLACEHOLDER, '').replace(/[ \t]{2,}/g, ' ').trim();
  const gifPlaceholderLeaked = text !== beforeGifCleanup;
  if (!text) return { text: '', leaked: true, blocked: true };

  // 模型复述聊天记录时可能吐出内部序列化标签和原始毫秒时间戳，只清理标记、保留正文。
  const beforeInternalChatCleanup = text;
  text = stripInternalChatMarkers(text);
  const internalChatMarkerLeaked = text !== beforeInternalChatCleanup;
  if (!text) return { text: '', leaked: true, blocked: true };

  // Control markers are never part of a QQ reply, even with spaces or other
  // text around them. Reject the whole output so the retry can start cleanly.
  if (CONTROL_MARKER.test(text)) {
    return { text: '', leaked: true, blocked: true };
  }

  const reasoning = text.search(REASONING_MARKER);
  const final = text.match(FINAL_MARKER);
  let leaked = stickerStatusLeaked || roleLabelLeaked || mediaPlaceholderLeaked || gifPlaceholderLeaked || statusMarkerLeaked || internalChatMarkerLeaked;
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
    if (/\[\s*gif\s*\]/i.test(text)) markers.push('gif-placeholder');
    if (/\[\s*(?:SILENT|SKIP)\s*\]/i.test(text)) markers.push('control-marker');
    if (/\[sticker\]\s*sent/i.test(text)) markers.push('sticker-status');
    if (/<\/?(?:blockquote|owner|time)\b[^>]*>/i.test(text)) markers.push('internal-chat-tag');
    if (/(?:时间|time)\s*[:：]?\s*1[6-9]\d{11}\b|\b1[6-9]\d{11}\b/.test(text)) markers.push('epoch-timestamp');
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

// 无结果时最常见的“进度播报”句式。分成三类，避免把日常口语误判：
//   1) 明确声称任务在跑/已启动；
//   2) “马上/等会儿 + 给你/告诉你”并伴随外部任务词；
//   3) “结果/记录 … 马上 … 挑/给/发”这类以结果为前提的承诺。
const COMMITMENT_PROGRESS = /(?:已在跑|在跑|正在跑|跑起来了|已启动|已经启动|启动好了|任务.{0,6}(?:启动|在跑|进行中|处理中)|已经?开始(?:刷|跑|查|执行|处理)|又?开(?:了|起)?(?:新一轮|一轮)?(?:浏览|任务))/;
const COMMITMENT_DELIVERY = /(?:马上|立刻|这就|稍后|等会(?:儿)?|一会(?:儿)?|待会(?:儿)?|稍等|等我|等一下).{0,14}(?:给你|发给你|告诉你|报给你|交给你|反馈给你)/;
const COMMITMENT_ACTION = /(?:这就|马上|立刻|现在)(?:去|来)?(?:查|刷|跑|搜)/;
const COMMITMENT_EXTERNAL = /(?:任务|后台|浏览|刷(?:视频|抖音|同款|推荐)?|查询|查(?:一下|结果|记录)?|结果|记录|进度|接口|工具|进程|提交|采集|搜索)/;
const COMMITMENT_RESULT_PROMISE = /(?:结果|记录|进度|状态).{0,16}(?:马上|立刻|这就|再|就).{0,12}(?:挑|给|发|告诉|报|找|整理|汇总|列)/;

/**
 * 判断一条回复是否在“没有实际结果”时声称任务已在跑或马上交付。
 * completed 为 true 时放行（确实拿到了 completed 结果）。
 */
export function commitmentClaimIssue(reply, { completed = false } = {}) {
  const text = stripStickerDirectives(String(reply ?? '')).trim();
  if (!text || completed) return '';
  const sentences = text.split(/[。！？!?\n]+/u).map((item) => item.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (COMMITMENT_PROGRESS.test(sentence)) return 'task-commitment';
    if (COMMITMENT_DELIVERY.test(sentence) && COMMITMENT_EXTERNAL.test(sentence)) return 'task-commitment';
    if (COMMITMENT_ACTION.test(sentence)) return 'task-commitment';
    if (COMMITMENT_RESULT_PROMISE.test(sentence)) return 'task-commitment';
  }
  return '';
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

/** Catch an English paragraph in response to a Chinese message, while allowing terms and requested translation. */
export function replyLanguageIssue(input, reply) {
  const question = String(input ?? '');
  if (!/\p{Script=Han}/u.test(question)
      || /(?:用|说|回复|回答|改成|翻译成|写成)\s*(?:英文|英语|English)|(?:英文|英语)\s*(?:回复|回答|说|写)/iu.test(question)) return '';
  const answer = stripStickerDirectives(reply).replace(/https?:\/\/\S+/gi, '');
  const latinWords = answer.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
  const latinLetters = (answer.match(/[A-Za-z]/g) ?? []).length;
  const hanChars = (answer.match(/\p{Script=Han}/gu) ?? []).length;
  return (hanChars === 0 && latinWords.length >= 3 && latinLetters >= 12)
    || (latinWords.length >= 5 && latinLetters >= 25 && latinLetters > hanChars * 3)
    ? 'wrong-language' : '';
}

/** Catch replies that take over the other person's family role (e.g. “我帮你照顾”). */
const RELATION_SELF_FAMILY = /我(?:的)?(?:女儿|儿子|孩子|爸|老爸|妈|老妈|老婆|老公|对象|媳妇|丈夫|妻子)/u;
const RELATION_TAKEOVER = /(?:我(?:来|帮你|替你|给你|负责)?(?:照顾|照看|管|带|养|接送|辅导)|交给我|包在我身上|放心交给我)/u;

export function relationshipMisclaimIssue(input, reply) {
  if (!RELATION_SELF_FAMILY.test(String(input ?? ''))) return '';
  return RELATION_TAKEOVER.test(stripStickerDirectives(String(reply ?? '')))
    ? 'relationship-misclaim' : '';
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
