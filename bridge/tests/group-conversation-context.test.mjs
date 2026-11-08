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
  assert.match(followupContext, /风/);
  assert.doesNotMatch(followupContext, /3854165110/);
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
    senderId: '1', senderName: '甲', text: '这个人机骂我', directionHint: '@其他群友'
  }, 1_000);
  assert.match(context.format('group-a', 1_001), /@其他群友/);
});

test('keeps the latest eight messages plus an earlier message from the current speaker', () => {
  const context = new GroupConversationContext();
  for (let index = 1; index <= 12; index++) {
    context.remember('group-a', { senderId: index === 3 ? 'alice' : 'other', text: `消息${index}` }, index * 100);
  }
  const selected = context.format('group-a', 1_200, { senderId: 'alice' });
  assert.match(selected, /消息3/);
  assert.doesNotMatch(selected, /消息2/);
  assert.match(selected, /消息5/);
  assert.match(selected, /消息12/);
  assert.equal(context.version('group-a'), 12);
});

test('injects group member impressions before the recent messages', () => {
  const context = new GroupConversationContext();
  context.remember('group-a', { senderId: '1', senderName: '甲', text: '在聊什么' }, 1_000);
  const selected = context.format('group-a', 1_001, { extra: '【你记得的群友】佑小鲸：爱接梗。' });
  assert.match(selected, /【你记得的群友】/);
  assert.ok(selected.indexOf('【你记得的群友】') < selected.indexOf('【本群近期消息背景】'));
});

test('keeps the default context window at ten minutes', () => {
  const context = new GroupConversationContext();
  context.remember('group-a', { senderId: '1', text: '十分钟内' }, 0);
  assert.match(context.format('group-a', 9 * 60_000), /十分钟内/);
  assert.equal(context.format('group-a', 11 * 60_000), '');
});

test('describes media-only context without exposing raw placeholders', () => {
  const context = new GroupConversationContext();
  context.remember('group-a', { senderId: 'alice', text: '[图片] [图片]' }, 100);
  const selected = context.format('group-a', 200);
  assert.match(selected, /发送了媒体内容（内容未识别）/);
  assert.doesNotMatch(selected, /\[图片\]/);
});
