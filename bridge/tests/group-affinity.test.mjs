import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAffinityTransition } from '../src/group-affinity.mjs';
import { namesBotForGroupAffinity } from '../src/group-affinity-rules.mjs';

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const start = Date.parse('2026-10-30T02:00:00Z');

function update(record, text, now, senderId = '123456789', directed = true) {
  return groupAffinityTransition(record, { groupId: '987654321', senderId, text, directed, now });
}

test('directed thanks raise only the current group and respect per-sender cooldown and daily limit', () => {
  let state = {};
  assert.equal(update(state, '谢谢你', start, '123456789', false).record, state);
  assert.equal(update(state, '今天的天气真好', start).record, state);
  for (const minutes of [0, 20, 40]) {
    const result = update(state, '谢谢你，帮大忙了', start + minutes * MINUTE);
    assert.equal(result.delta, 1);
    state = result.record;
  }
  assert.equal(state['987654321'].score, 53);
  assert.equal(update(state, '太棒了', start + 50 * MINUTE).record, state, 'cooldown blocks repeated praise');
  assert.equal(update(state, '太棒了', start + 60 * MINUTE).record, state, 'daily cap blocks a fourth praise');
  state = update(state, '辛苦了', start + 60 * MINUTE, '222222222').record;
  assert.equal(state['987654321'].score, 54, 'a different group member has a separate allowance');
  state = update(state, '谢谢你', start + 24 * HOUR).record;
  assert.equal(state['987654321'].score, 55, 'a new Singapore day resets the sender allowance');
  assert.equal(state['111111111'], undefined, 'other groups do not change');
});

test('insults keep priority and a recovered warning can warn again', () => {
  const base = { '987654321': { score: 25, warnedAt: start - HOUR, warnedScore: 25, penalties: {} } };
  const praise = update(base, '谢谢你', start);
  assert.equal(praise.record['987654321'].score, 26);
  assert.equal(praise.record['987654321'].warnedAt, null);
  assert.equal(praise.action, null);
  const insult = update(praise.record, '你这个傻逼，谢谢', start + MINUTE);
  assert.equal(insult.record['987654321'].score, 25);
  assert.deepEqual(insult.action, { type: 'warn', score: 25 });
  assert.equal(update(insult.record, '你这个傻逼', start + 2 * MINUTE).record, insult.record,
    'existing insult cooldown still applies');
});

test('the owner can praise a group without gaining the power to penalize it', () => {
  const input = { groupId: '987654321', senderId: '999999999', directed: true,
    allowPenalty: false, now: start };
  const praise = groupAffinityTransition({}, { ...input, text: '谢谢你' });
  assert.equal(praise.record['987654321'].score, 51);
  const insult = groupAffinityTransition(praise.record, { ...input, text: '你这个傻逼' });
  assert.equal(insult.record, praise.record);
});

test('direct praise can address the bot by name without an at mention', () => {
  assert.equal(namesBotForGroupAffinity('大肥鱼真聪明'), true);
  assert.equal(namesBotForGroupAffinity('谢谢大肥鱼'), true);
  assert.equal(namesBotForGroupAffinity('鲸小囧做得好', '鲸小囧'), true);
  assert.equal(namesBotForGroupAffinity('谢谢其他群友'), false);
});

test('daily praise allowance resets at Singapore midnight after the cooldown', () => {
  const beforeMidnight = Date.parse('2026-10-30T15:10:00Z');
  let state = {};
  for (const minutes of [0, 20, 40]) state = update(state, '做得好', beforeMidnight + minutes * MINUTE).record;
  assert.equal(state['987654321'].score, 53);
  const nextDay = update(state, '谢谢你', beforeMidnight + 60 * MINUTE);
  assert.equal(nextDay.delta, 1);
  assert.equal(nextDay.record['987654321'].score, 54);
  assert.equal(nextDay.record['987654321'].praises['123456789'].count, 1);
});
