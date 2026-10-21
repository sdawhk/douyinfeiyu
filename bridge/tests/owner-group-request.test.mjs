import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerImageReplyRequest, resolveGroupMention, latestOwnerImage, recentGroupSummary } from '../src/owner-group-request.mjs';
import { loadRolePersona } from '../src/role-card.mjs';

test('owner image request resolves a named QQ group and recent owner image', () => {
  assert.equal(isOwnerImageReplyRequest('你去群里回复一下我发的图片'), true);
  const groups = [
    { group_id: 1090249298, group_name: '肥鱼快乐群' },
    { group_id: 839367702, group_name: 'AI之家_md3music' }
  ];
  assert.equal(resolveGroupMention('ai之家的群你看看聊天记录', groups)?.group_id, 839367702);
  assert.equal(resolveGroupMention('839367702', groups)?.group_id, 839367702);
  const now = 1_792_488_960;
  const messages = [
    { user_id: 1668389572, time: now - 100, message_id: 1,
      message: [{ type: 'image', data: { file: 'recent-image' } }] },
    { user_id: 1581449421, time: now - 10, message_id: 2,
      message: [{ type: 'image', data: { file: 'other-image' } }] },
    { user_id: 1668389572, time: now - 3 * 60 * 60, message_id: 3,
      message: [{ type: 'image', data: { file: 'stale-image' } }] }
  ];
  assert.equal(latestOwnerImage(messages, 1668389572, now)?.image.data.file, 'recent-image');
  assert.match(recentGroupSummary(messages), /\[图片\]/);
});

test('persona distinguishes model tool limits from QQ bridge capability', () => {
  const persona = loadRolePersona('小鲸鱼');
  assert.match(persona, /QQ 桥接负责收发消息/);
  assert.doesNotMatch(persona, /本环境没有工具，也没有联网能力/);
});
