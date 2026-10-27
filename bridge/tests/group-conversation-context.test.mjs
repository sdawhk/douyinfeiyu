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

test('selects the immediate exchange and earlier turns from the current speaker', () => {
  const context = new GroupConversationContext();
  for (let index = 1; index <= 8; index++) {
    context.remember('group-a', { senderId: index === 2 ? 'alice' : 'other', text: `消息${index}` }, index * 100);
  }
  const selected = context.format('group-a', 900, { senderId: 'alice' });
  assert.match(selected, /消息2/);
  assert.doesNotMatch(selected, /消息3/);
  assert.match(selected, /消息5/);
  assert.match(selected, /消息8/);
});

test('describes media-only context without exposing raw placeholders', () => {
  const context = new GroupConversationContext();
  context.remember('group-a', { senderId: 'alice', text: '[图片] [图片]' }, 100);
  const selected = context.format('group-a', 200);
  assert.match(selected, /发送了媒体内容（内容未识别）/);
  assert.doesNotMatch(selected, /\[图片\]/);
});
