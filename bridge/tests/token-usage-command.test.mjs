import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTokenUsage, parseTokenUsageRequest } from '../src/token-usage-command.mjs';

test('token usage queries recognize today, yesterday, and a specific date', () => {
  const now = Date.parse('2026-10-22T16:30:00Z'); // 2026-10-23 in Singapore
  assert.equal(parseTokenUsageRequest('今天用了多少 token', now), '2026-10-23');
  assert.equal(parseTokenUsageRequest('昨天的 token 消耗', now), '2026-10-22');
  assert.equal(parseTokenUsageRequest('查询 2026-10-20 token 用量', now), '2026-10-20');
  assert.equal(parseTokenUsageRequest('今天晚上吃什么', now), null);
});

test('token usage summary distinguishes upstream usage from estimates', () => {
  const text = formatTokenUsage({
    date: '2026-10-23', requests: 3, exactRequests: 2, estimatedRequests: 1,
    inputTokens: 120, outputTokens: 40, totalTokens: 160,
    estimatedInputTokens: 20, estimatedOutputTokens: 10, estimatedTotalTokens: 30,
    models: { 'test/model': { totalTokens: 160, estimatedTotalTokens: 30 } },
  });
  assert.match(text, /上游报告用量/);
  assert.match(text, /估算值不等于账单用量/);
  assert.match(text, /test\/model/);
});
