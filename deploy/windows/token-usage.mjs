export function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = Number(value.prompt_tokens ?? value.input_tokens ?? value.inputTokens);
  const output = Number(value.completion_tokens ?? value.output_tokens ?? value.outputTokens);
  const total = Number(value.total_tokens ?? value.totalTokens);
  const inputTokens = Number.isFinite(input) && input >= 0 ? Math.trunc(input) : null;
  const outputTokens = Number.isFinite(output) && output >= 0 ? Math.trunc(output) : null;
  const totalTokens = Number.isFinite(total) && total >= 0
    ? Math.trunc(total)
    : inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return inputTokens === null && outputTokens === null && totalTokens === null
    ? null : { inputTokens, outputTokens, totalTokens };
}

export function usageFromSse(text) {
  let usage = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const frame = JSON.parse(data);
      usage = normalizeTokenUsage(frame.usage ?? frame.response?.usage) ?? usage;
    } catch { /* Ignore partial or non-JSON SSE frames. */ }
  }
  return usage;
}

function textParts(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const part of value) textParts(part, output);
  else if (value && typeof value === 'object') {
    for (const key of ['content', 'text', 'input_text', 'output_text', 'arguments']) {
      if (key in value) textParts(value[key], output);
    }
  }
  return output;
}

export function estimateTokenCount(text) {
  const value = String(text ?? '');
  const cjk = value.match(/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/g)?.length ?? 0;
  const remainder = value.replace(/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/g, ' ');
  const tokens = remainder.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g) ?? [];
  const nonCjk = tokens.reduce((sum, token) => sum + (/^[A-Za-z0-9]+$/.test(token) ? Math.max(1, Math.ceil(token.length / 4)) : 1), 0);
  return Math.ceil(cjk * 1.5 + nonCjk);
}

export function estimateRequestUsage(request, responseText = '') {
  let input = [];
  if (Array.isArray(request?.messages)) textParts(request.messages, input);
  else if (request?.input !== undefined) textParts(request.input, input);
  const inputTokens = estimateTokenCount(input.join('\n'));
  let output = [];
  try {
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed?.choices)) textParts(parsed.choices.map((choice) => choice.message ?? choice.delta ?? choice), output);
    else if (parsed?.output !== undefined) textParts(parsed.output, output);
    else if (parsed?.output_text) textParts(parsed.output_text, output);
  } catch {
    output = [String(responseText).split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith('data:')) return [];
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return [];
      try {
        const frame = JSON.parse(data);
        const values = [];
        for (const choice of frame.choices ?? []) textParts(choice.delta ?? choice, values);
        if (frame.output_text) values.push(frame.output_text);
        if (frame.response?.output) textParts(frame.response.output, values);
        return values;
      } catch { return []; }
    }).join('')];
  }
  const outputTokens = estimateTokenCount(output.join('\n'));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export function createUsageDay(date) {
  return { date, requests: 0, exactRequests: 0, estimatedRequests: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0, models: {}, sources: {} };
}

export function usageSourceFromRequest(request) {
  const input = request?.messages ?? request?.input ?? [];
  if (Array.isArray(input) && input.some((message) =>
    Array.isArray(message?.content) && message.content.some((part) =>
      ['image_url', 'input_image', 'image'].includes(part?.type)))) return 'vision';
  const items = Array.isArray(input) ? [...input].reverse() : [input];
  for (const item of items) {
    const text = typeof item === 'string' ? item : JSON.stringify(item ?? '');
    const markers = [...text.matchAll(/【用量场景:(group|private|task)】/g)];
    if (markers.length) return markers.at(-1)[1];
  }
  return 'other';
}

export function addUsageRecord(day, model, usage, estimate, source = 'other') {
  day.requests += 1;
  const exact = normalizeTokenUsage(usage);
  const value = exact ?? estimate;
  const prefix = exact ? '' : 'estimated';
  const inputKey = prefix ? 'estimatedInputTokens' : 'inputTokens';
  const outputKey = prefix ? 'estimatedOutputTokens' : 'outputTokens';
  const totalKey = prefix ? 'estimatedTotalTokens' : 'totalTokens';
  day[inputKey] += value.inputTokens ?? 0;
  day[outputKey] += value.outputTokens ?? 0;
  day[totalKey] += value.totalTokens ?? ((value.inputTokens ?? 0) + (value.outputTokens ?? 0));
  day[exact ? 'exactRequests' : 'estimatedRequests'] += 1;
  const item = day.models[model] ??= { requests: 0, exactRequests: 0, estimatedRequests: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0 };
  item.requests += 1;
  item[exact ? 'exactRequests' : 'estimatedRequests'] += 1;
  item[inputKey] += value.inputTokens ?? 0;
  item[outputKey] += value.outputTokens ?? 0;
  item[totalKey] += value.totalTokens ?? ((value.inputTokens ?? 0) + (value.outputTokens ?? 0));
  day.sources ??= {};
  const sourceItem = day.sources[source] ??= { requests: 0, exactRequests: 0, estimatedRequests: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedTotalTokens: 0 };
  sourceItem.requests += 1;
  sourceItem[exact ? 'exactRequests' : 'estimatedRequests'] += 1;
  sourceItem[inputKey] += value.inputTokens ?? 0;
  sourceItem[outputKey] += value.outputTokens ?? 0;
  sourceItem[totalKey] += value.totalTokens ?? ((value.inputTokens ?? 0) + (value.outputTokens ?? 0));
  return day;
}
