import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// qq-bot.mjs 一加载就会起服务，不能直接 import；这里用源码契约守住日志原因不被合并回一条。
const source = readFileSync(new URL('../src/qq-bot.mjs', import.meta.url), 'utf8');

test('group skip reasons stay distinguishable in logs', () => {
  assert.match(source, /reason=\$\{groupGate\.reason\}/);
  assert.equal(source.includes('reason=group-frequency-control'), false);
  for (const reason of ['interjection-off', 'cooldown', 'proactive-denied', 'not-directed']) {
    assert.ok(source.includes(`'${reason}'`), reason);
  }
});

test('a directed reply also refreshes the group cooldown clock', () => {
  assert.match(source, /if \(directed\) lastGroupReply\.set\(groupId, Date\.now\(\)\);/);
});

test('sent group replies remember which sender was answered', () => {
  assert.match(source, /if \(sent && isGroup\) noteGroupReplyTo\(target, sender\);/);
  assert.match(source, /function noteGroupReplyTo\(groupId, senderId\)/);
});
