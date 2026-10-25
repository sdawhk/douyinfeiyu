const FINAL_MARKER = /<\|final\|>|<final>|(?:最终(?:回复|回答)|给用户的回复)\s*[:：]/i;
const REASONING_MARKER = /<\|(?:analysis|think|reasoning)\|>|<(?:analysis|think|thinking|reasoning)\b|(?:^|\n)\s*(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/i;
const INTERNAL_NARRATION = /(?:当前(?:这)?轮(?:消息|内容|对话)?\s*[，,:：]|本轮(?:消息|内容|对话|说)\s*[，,:：]?|等等[，,]\s*我(?:需要|要|得)|让我(?:先)?(?:分析|想|仔细想)|我(?:需要|要|得)(?:先)?(?:仔细)?(?:分析|判断|思考|推理|想想)|用户(?:说|提到|想要|可能|的意思是|是在)|我(?:应该|需要|要|得)(?:如何|怎么|直接)?(?:回复|回答)|先(?:分析|推理)一下|(?:the user (?:said|means|wants|is asking)|user message|current turn|we need to|I should (?:answer|reply|respond)|let me think|let's think|let's analyze|need to understand)\b)/i;
const ENGLISH_RECAP_ANALYSIS = /(?:^[^.!?\n]{1,100}\bsaid\s+["“][\s\S]{0,260}?\b(?:and then|then)\b[\s\S]{0,220}\b(?:hmm|the previous message|previous message)\b|\b(?:hmm|let me think)\b[\s\S]{0,160}\b(?:the )?(?:previous|preceding|earlier) message\b[\s\S]{0,120}\b(?:my|our)\s+(?:雷点|trigger|weak spot|sore spot)\b)/i;

export function sanitizeModelReply(value) {
  let text = String(value ?? '').trim();
  if (!text) return { text: '', leaked: false, blocked: true };

  const reasoning = text.search(REASONING_MARKER);
  const final = text.match(FINAL_MARKER);
  if (reasoning >= 0 && final && final.index > reasoning) {
    text = text.slice(final.index + final[0].length).trim();
    return { text, leaked: true, blocked: !text };
  }

  let leaked = false;
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
      || /(?:^|\n)\s*(?:analysis|reasoning|思考过程|推理过程)\s*[:：]/i.test(text)) {
    return { text: '', leaked: true, blocked: true };
  }
  return { text, leaked, blocked: !text };
}
