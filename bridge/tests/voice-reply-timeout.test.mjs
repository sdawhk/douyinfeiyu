import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedVoiceReply } from '../src/voice-reply-timeout.mjs';

test('a timed out synthesis cannot commit a late send', async () => {
  let sent = false;
  let aborted = false;
  await assert.rejects(runBoundedVoiceReply(async (ensureActive, _commit, signal) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    ensureActive();
    sent = true;
  }, 5), /超过等待时限/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent, false);
  assert.equal(aborted, true);
});

test('a send committed before the deadline can finish after it without text fallback', async () => {
  let settled = false;
  const result = runBoundedVoiceReply(async (_ensureActive, commitSend) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    commitSend();
    await new Promise((resolve) => setTimeout(resolve, 30));
    settled = true;
    return 'voice sent';
  }, 10);
  assert.equal(await result, 'voice sent');
  assert.equal(settled, true);
});

test('voice task errors pass through before the deadline', async () => {
  await assert.rejects(runBoundedVoiceReply(async () => {
    throw new Error('synthesis failed');
  }, 100), /synthesis failed/);
});
