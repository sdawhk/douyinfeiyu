import test from 'node:test';
import assert from 'node:assert/strict';
import { canReply } from '../src/reply-control.mjs';

test('private and group replies can be controlled independently and per chat', () => {
  assert.equal(canReply(undefined, false, 123456789), true);
  assert.equal(canReply(undefined, true, 987654321), true);
  const settings = { privateEnabled: false, groupEnabled: true, disabledPrivate: [], disabledGroups: ['987654321'] };
  assert.equal(canReply(settings, false, 123456789), false);
  assert.equal(canReply(settings, true, 987654321), false);
  assert.equal(canReply(settings, true, 123456789), true);
  settings.privateEnabled = true;
  settings.disabledPrivate = ['123456789'];
  assert.equal(canReply(settings, false, 123456789), false);
  assert.equal(canReply(settings, false, 987654321), true);
});
