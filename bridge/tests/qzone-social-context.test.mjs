import test from 'node:test';
import assert from 'node:assert/strict';
import { qzoneSocialReplyContext } from '../src/qzone-social-context.mjs';

test('Qzone context explains configured affinity thresholds and why actions are not occurring', () => {
  const context = qzoneSocialReplyContext({
    enabled: true,
    previewOnly: true,
    allowedFriends: [],
    likeThreshold: 75,
    commentThreshold: 85,
  });

  assert.match(context, /点赞门槛 75 分/);
  assert.match(context, /评论门槛 85 分/);
  assert.match(context, /白名单为空/);
  assert.match(context, /预览模式开启/);
  assert.match(context, /确实有好友动态互动功能/);
  assert.doesNotMatch(context, /当前聊天对象的好感度为/);
});

test('Qzone context includes a known score without changing the feature status', () => {
  const context = qzoneSocialReplyContext({
    enabled: false,
    previewOnly: false,
    allowedFriends: ['123456789'],
    likeThreshold: 60,
    commentThreshold: 80,
  }, 72);

  assert.match(context, /互动未启用/);
  assert.match(context, /点赞门槛 60 分/);
  assert.match(context, /当前聊天对象的好感度为 72 分/);
});
