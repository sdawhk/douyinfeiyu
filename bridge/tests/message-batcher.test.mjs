import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageBatcher } from '../src/message-batcher.mjs';

test('merges messages after idle time and enforces maximum wait', async () => {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const clock = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const delivered = [];
  const batcher = createMessageBatcher((key, messages) => delivered.push([key, messages]), () => {}, clock, () => time);
  async function advance(ms) {
    time += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    await Promise.resolve();
  }
  batcher.add('p1', 'a', 5000, 15000);
  await advance(4000);
  batcher.add('p1', 'b', 5000, 15000);
  await advance(4999);
  assert.equal(delivered.length, 0);
  await advance(1);
  assert.deepEqual(delivered, [['p1', ['a', 'b']]]);
  batcher.add('p1', 'c', 5000, 15000);
  await advance(4000);
  batcher.add('p1', 'd', 5000, 15000);
  await advance(4000);
  batcher.add('p1', 'e', 5000, 15000);
  await advance(7000);
  assert.deepEqual(delivered[1], ['p1', ['c', 'd', 'e']]);
});

test('keeps conversations separate and drops pending text for a command', async () => {
  const delivered = [];
  const batcher = createMessageBatcher((key, messages) => delivered.push([key, messages]));
  batcher.add('g1:u1', 'first', 5000, 15000);
  batcher.add('g1:u2', 'other', 5000, 15000);
  assert.equal(batcher.drop('g1:u1'), 1);
  batcher.flush('g1:u2');
  await Promise.resolve();
  assert.deepEqual(delivered, [['g1:u2', ['other']]]);
});
