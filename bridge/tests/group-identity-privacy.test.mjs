import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGroupIdentityPrivate, groupIdentityLeak, protectedOwnerQQs, redactProtectedGroupIds } from '../src/group-identity-privacy.mjs';

const owner = '1234567890';

test('protects human owner IDs and excludes the bot account', () => {
  assert.deepEqual(protectedOwnerQQs({ ownerQQs: ['9000099999', owner], selfQQ: '9000099999' }), [owner]);
  assert.deepEqual(protectedOwnerQQs({ ownerQQ: owner, selfQQ: '9000099999' }), [owner]);
});

test('blocks owner QQ in plain, separated, fullwidth and Chinese digit forms', () => {
  for (const message of [owner, '找主人：123 456 7890', '主人 １２３４５６７８９０',
    '一二三四五六七八九零', '123-456-7890']) {
    assert.equal(groupIdentityLeak(message, [owner]), true, message);
    assert.throws(() => assertGroupIdentityPrivate(message, [owner]), /阻止发送/);
  }
  assert.equal(groupIdentityLeak('订单号 1234567891，今天 10:30 到', [owner]), false);
});

test('checks each group message segment including mentions, without scanning image data', () => {
  assert.equal(groupIdentityLeak([{ type: 'text', data: { text: `QQ ${owner}` } }], [owner]), true);
  assert.equal(groupIdentityLeak([{ type: 'at', data: { qq: owner } }], [owner]), true);
  assert.equal(groupIdentityLeak([{ type: 'image', data: { file: `base64://${owner}` } }], [owner]), false);
  assert.equal(groupIdentityLeak([{ type: 'text', data: { text: '你好' } }], [owner]), false);
});

test('redacts protected IDs from group prompts without changing ordinary Chinese numerals', () => {
  assert.equal(redactProtectedGroupIds(`一条消息，主人QQ ${owner}`, [owner]), '一条消息，主人QQ [已隐藏账号]');
  assert.equal(redactProtectedGroupIds('第一条消息', [owner]), '第一条消息');
});
