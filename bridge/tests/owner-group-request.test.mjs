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

test('persona permits scoped QQ tools without duplicating automatic replies', () => {
  const persona = loadRolePersona('小鲸鱼');
  assert.match(persona, /本环境已接入 QQ、表情、记忆和安全联网 MCP 工具/);
  assert.match(persona, /工具发送成功后只输出 \[SILENT\]/);
  assert.doesNotMatch(persona, /本环境没有工具，也没有联网能力/);
});

test('owner role card can be reused in Douyin with channel-correct capability limits', () => {
  const persona = loadRolePersona('鲸团团-主人私聊', { channel: 'douyin' });
  assert.match(persona, /在 QQ 按 QQ 号核验，在抖音按已配置的抖音号核验；两边是同一个人/);
  assert.match(persona, /当前是抖音主人私聊/);
  assert.match(persona, /QQ 专属工具、账号操作和权限说明只适用于 QQ/);
  assert.doesNotMatch(persona, /本环境已接入 QQ、表情、记忆和安全联网 MCP 工具/);
  assert.doesNotMatch(persona, /本地表情库/);
});
