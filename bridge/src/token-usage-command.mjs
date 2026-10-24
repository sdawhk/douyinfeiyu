function singaporeDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now));
}

function offsetDate(date, days) {
  const value = new Date(`${date}T12:00:00+08:00`);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function parseTokenUsageRequest(text, now = Date.now()) {
  const value = String(text ?? '').trim();
  if (!/(?:token|tokens|令牌)/i.test(value) || !/(?:用量|消耗|使用量|用了|使用了|多少|统计)/i.test(value)) return null;
  const explicit = value.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if (explicit) return explicit;
  const today = singaporeDate(now);
  return /昨天|昨日/.test(value) ? offsetDate(today, -1) : today;
}

export function formatTokenUsage(data) {
  if (!data || !Number.isFinite(data.requests)) return '用量统计服务暂时不可用，请稍后再查。';
  if (data.requests === 0) return `${data.date} 还没有记录到经过模型代理的成功请求。`;
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const lines = [`${data.date} 共成功请求 ${fmt(data.requests)} 次。`];
  if (data.exactRequests) {
    lines.push(`上游报告用量：输入 ${fmt(data.inputTokens)}、输出 ${fmt(data.outputTokens)}、总计 ${fmt(data.totalTokens)} tokens（${fmt(data.exactRequests)} 次）。`);
  }
  if (data.estimatedRequests) {
    lines.push(`另有 ${fmt(data.estimatedRequests)} 次上游未返回 usage，按文本估算约 ${fmt(data.estimatedInputTokens)} 输入 + ${fmt(data.estimatedOutputTokens)} 输出 = ${fmt(data.estimatedTotalTokens)} tokens；估算值不等于账单用量。`);
  }
  const models = Object.entries(data.models ?? {}).sort((a, b) =>
    ((b[1].totalTokens ?? 0) + (b[1].estimatedTotalTokens ?? 0)) - ((a[1].totalTokens ?? 0) + (a[1].estimatedTotalTokens ?? 0))).slice(0, 5);
  if (models.length) lines.push(`模型：${models.map(([name, item]) => `${name} ${fmt((item.totalTokens ?? 0) + (item.estimatedTotalTokens ?? 0))} tokens`).join('；')}`);
  return lines.join('\n');
}
