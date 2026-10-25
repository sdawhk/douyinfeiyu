import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsageRecord, createUsageDay, estimateRequestUsage, normalizeTokenUsage, usageFromSse, usageSourceFromRequest } from './token-usage.mjs';

test('usage parser reads OpenAI chat and Responses API usage fields', () => {
  assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }), {
    inputTokens: 12, outputTokens: 5, totalTokens: 17
  });
  const stream = 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n';
  assert.deepEqual(usageFromSse(stream), { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 8, output_tokens: 4, total_tokens: 12 }), {
    inputTokens: 8, outputTokens: 4, totalTokens: 12
  });
});

test('daily totals separate provider-reported usage from text estimates', () => {
  const day = createUsageDay('2026-10-23');
  addUsageRecord(day, 'a/model', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  addUsageRecord(day, 'c/model', { inputTokens: 4, outputTokens: 3, totalTokens: 7 }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  addUsageRecord(day, 'b/model', null, { inputTokens: 6, outputTokens: 3, totalTokens: 9 });
  assert.equal(day.requests, 3);
  assert.equal(day.exactRequests, 2);
  assert.equal(day.totalTokens, 21);
  assert.equal(day.estimatedTotalTokens, 9);
});

test('text estimates include prompt and generated text for providers without usage metadata', () => {
  const usage = estimateRequestUsage({ messages: [{ role: 'user', content: '今天查用量' }] },
    'data: {"choices":[{"delta":{"content":"用量统计完成"}}]}\n\ndata: [DONE]\n');
  assert.ok(usage.inputTokens > 0);
  assert.ok(usage.outputTokens > 0);
});

test('records exact usage by conversation source and recognizes image input', () => {
  const request = { messages: [{ role: 'user', content: '【用量场景:group】你好' }] };
  const source = usageSourceFromRequest(request);
  assert.equal(source, 'group');
  const day = createUsageDay('2026-10-24');
  addUsageRecord(day, 'test/model', { prompt_tokens: 20, completion_tokens: 3 },
    { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, source);
  assert.equal(day.sources.group.inputTokens, 20);
  assert.equal(usageSourceFromRequest({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }), 'vision');
  delete day.sources; // Existing saved days predate source accounting.
  addUsageRecord(day, 'test/model', { prompt_tokens: 2, completion_tokens: 1 },
    { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, 'private');
  assert.equal(day.sources.private.totalTokens, 3);
});
