import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAddressGuardReply, guardGroupAddressChange, parseGroupAddressChange } from '../src/group-address-guard.mjs';

test('recognizes explicit requests to change how a group member is addressed', () => {
  assert.deepEqual(parseGroupAddressChange('以后叫我爸爸'), { kind: 'user', requested: '爸爸' });
  assert.deepEqual(parseGroupAddressChange('@小鲸鱼 以后你就叫我阿哲'), { kind: 'user', requested: '阿哲' });
  assert.deepEqual(parseGroupAddressChange('小鲸鱼，以后称呼我为老板'), { kind: 'user', requested: '老板' });
  assert.deepEqual(parseGroupAddressChange('你以后可以叫我小可爱吗'), { kind: 'user', requested: '小可爱' });
});

test('recognizes bot renaming requests but ignores quoted discussion and ordinary instructions', () => {
  assert.deepEqual(parseGroupAddressChange('以后你叫自己小猫'), { kind: 'bot', requested: '小猫' });
  assert.deepEqual(parseGroupAddressChange('把机器人改名叫小猫'), { kind: 'bot', requested: '小猫' });
  assert.equal(parseGroupAddressChange('他说以后叫我爸爸'), null);
  assert.equal(parseGroupAddressChange('以后叫我去群里'), null);
});

test('keeps the owner title reserved and uses the QQ card name for group members', () => {
  assert.match(groupAddressGuardReply({ kind: 'user', requested: '主人' }, '群友甲'), /只指配置的主人 QQ/);
  assert.match(groupAddressGuardReply({ kind: 'user', requested: '老板' }, '群友甲'), /群名片“群友甲”/);
  assert.match(groupAddressGuardReply({ kind: 'bot', requested: '小猫' }), /还是叫小鲸鱼/);
});

test('only guards non-owner requests made in groups', () => {
  const request = '以后叫我爸爸';
  assert.deepEqual(guardGroupAddressChange({ isGroup: true, isOwner: false, text: request }), { kind: 'user', requested: '爸爸' });
  assert.equal(guardGroupAddressChange({ isGroup: true, isOwner: true, text: request }), null);
  assert.equal(guardGroupAddressChange({ isGroup: false, isOwner: false, text: request }), null);
});
