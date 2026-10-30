import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerPrivateReplyRequest, findUnansweredPrivateMessages, decideMissedPrivateReply } from '../src/owner-private-reply.mjs';

test('recognizes an explicit missed private message request and target name', () => {
  assert.deepEqual(parseOwnerPrivateReplyRequest('你前几天 M星辰 给你发消息你都没回，你去回复一下'), { targetHint: 'M星辰' });
  assert.deepEqual(parseOwnerPrivateReplyRequest('回复 M星辰 之前私聊漏回的信息'), { targetHint: 'M星辰' });
  assert.deepEqual(parseOwnerPrivateReplyRequest('把 1668389572 之前漏回的私聊回复一下'), { targetHint: '1668389572' });
  assert.deepEqual(parseOwnerPrivateReplyRequest('去回复之前私聊漏掉的信息'), { targetHint: null });
  assert.equal(parseOwnerPrivateReplyRequest('帮我看看私聊记录'), null);
});

test('selects only messages after the most recent bot reply', () => {
  const messages = [
    { user_id: 42, time: 100, message: 'old request' },
    { user_id: 7, time: 110, message: 'already answered' },
    { user_id: 42, time: 120, message: 'new request' },
    { user_id: 42, time: 130, message: 'follow-up' }
  ];
  assert.deepEqual(findUnansweredPrivateMessages(messages, 7, { now: 130_000 }).messages.map((item) => item.message), ['new request', 'follow-up']);
  assert.equal(findUnansweredPrivateMessages(messages.slice(0, 2), 7).reason, 'none');
});

test('rejects stale unanswered messages rather than replying to old history', () => {
  const result = findUnansweredPrivateMessages([{ user_id: 42, time: 1, message: 'old' }], 7, { now: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(result.reason, 'stale');
  assert.deepEqual(result.messages, []);
});

test('allows the model to decide that an unanswered chat needs no follow-up', () => {
  assert.deepEqual(decideMissedPrivateReply('[SILENT]', { text: '', blocked: true }), { action: 'skip' });
  assert.deepEqual(decideMissedPrivateReply('嗨，刚看到你的消息。', { text: '嗨，刚看到你的消息。', blocked: false }), {
    action: 'reply', text: '嗨，刚看到你的消息。'
  });
  assert.deepEqual(decideMissedPrivateReply('<think>分析</think>', { text: '', blocked: true }), { action: 'invalid' });
});
