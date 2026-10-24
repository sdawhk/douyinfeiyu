import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupConversationContext } from '../src/group-conversation-context.mjs';

test('keeps earlier messages available when their turns do not trigger a reply', () => {
  const context = new GroupConversationContext({ windowMs: 5_000 });
  context.remember('group-a', {
    senderId: '3854165110', senderName: '风', text: '日本三不喷，音乐动画片'
  }, 1_000);

  const followupContext = context.format('group-a', 1_043);
  assert.match(followupContext, /日本三不喷，音乐动画片/);
  assert.match(followupContext, /风（QQ 3854165110）/);
  assert.equal(context.format('group-b', 1_043), '');
});

test('expires old context and limits each group to the newest messages', () => {
  const context = new GroupConversationContext({ windowMs: 100, maxEntries: 2 });
  context.remember('group-a', { senderId: '1', text: '第一条' }, 0);
  context.remember('group-a', { senderId: '2', text: '第二条' }, 20);
  context.remember('group-a', { senderId: '3', text: '第三条' }, 40);

  const recent = context.format('group-a', 60);
  assert.doesNotMatch(recent, /第一条/);
  assert.match(recent, /第二条/);
  assert.match(recent, /第三条/);
  assert.equal(context.format('group-a', 200), '');
});

test('preserves whether a previous group message addressed another member', () => {
  const context = new GroupConversationContext();
  context.remember('group-a', {
    senderId: '1', senderName: '甲', text: '这个人机骂我', directionHint: '@其他群友 2'
  }, 1_000);
  assert.match(context.format('group-a', 1_001), /@其他群友 2/);
});
