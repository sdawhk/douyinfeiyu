import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAffinityMessage } from '../src/affinity-rules.mjs';

test('explicit insults are recognized, while ordinary disagreement is not', () => {
  assert.equal(classifyAffinityMessage('你这个垃圾机器人').insult, true);
  assert.equal(classifyAffinityMessage('我觉得你说得不对').insult, false);
});


