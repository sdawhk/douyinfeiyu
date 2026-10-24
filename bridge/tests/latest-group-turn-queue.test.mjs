import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestGroupTurnQueue } from '../src/latest-group-turn-queue.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('keeps only the newest pending group turn and suppresses an outdated active reply', async () => {
  const queue = createLatestGroupTurnQueue();
  const gate = deferred();
  const calls = [];

  const active = queue('g1', async (isLatest) => {
    calls.push('active-start');
    await gate.promise;
    calls.push(`active-latest:${isLatest()}`);
  });
  const replaced = queue('g1', async () => calls.push('replaced'));
  const newest = queue('g1', async () => calls.push('newest'));

  gate.resolve();
  await Promise.all([active, replaced, newest]);
  assert.deepEqual(calls, ['active-start', 'active-latest:false', 'newest']);
});

test('does not replace a pending bot-directed group turn with ordinary chatter', async () => {
  const queue = createLatestGroupTurnQueue();
  const gate = deferred();
  const calls = [];

  const active = queue('g2', async () => {
    calls.push('active-start');
    await gate.promise;
  });
  const directed = queue('g2', async () => calls.push('directed'), true);
  const chatter = queue('g2', async () => calls.push('chatter'), false);

  gate.resolve();
  await Promise.all([active, directed, chatter]);
  assert.deepEqual(calls, ['active-start', 'directed']);
});
