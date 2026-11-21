import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBanterPrompt, GROUP_BANTER_GUIDANCE } from '../src/group-banter.mjs';
import { groupTurnPrompt } from '../src/qq-message-context.mjs';
import { loadRolePersona } from '../src/role-card.mjs';

test('direct provocation allows an improvised retort instead of forced concession', () => {
  const prompt = groupBanterPrompt({ text: '你这废物只会吃白饭', directed: true });
  assert.match(prompt, /本轮可以回嘴/);
  assert.match(prompt, /不必逢怼就认输/);
  assert.match(prompt, /口语粗话/);
});

test('quoted abuse and other peoples conversations never trigger a retort instruction', () => {
  assert.equal(groupBanterPrompt({ text: '那个人是傻逼', directed: false }), '');
  assert.equal(groupBanterPrompt({ text: '引用一下，他说骂我两句', directed: true }), '');
});

test('an invitation to roast oneself is local to the current exchange, even for the owner', () => {
  const prompt = groupBanterPrompt({ text: '骂我两句，来互怼', directed: true, isOwner: true });
  assert.match(prompt, /本轮自愿互怼/);
  assert.match(prompt, /不套固定骂人模板/);
  assert.match(prompt, /不把邀请理解成以后持续攻击的许可/);
});

test('stop requests take precedence over matching the words 骂我', () => {
  for (const text of ['别骂我了', '不想再听你骂我', '不要再骂我', '好了别怼了，不想吵了']) {
    assert.match(groupBanterPrompt({ text, directed: true }), /本轮收住/);
    assert.doesNotMatch(groupBanterPrompt({ text, directed: true }), /本轮自愿互怼/);
  }
});

test('serious correction and actual help requests take priority over swearing', () => {
  for (const text of ['你个傻逼，这段代码怎么修复', '你算错了，废物', '认真回答这个问题']) {
    assert.match(groupBanterPrompt({ text, directed: true }), /本轮先办事/);
  }
});

test('live group prompt and role loader both carry the same banter policy without affecting owner private persona', () => {
  const prompt = groupTurnPrompt({ groupId: '999999', senderId: '123456', senderName: '甲',
    botSelf: '888888', text: '你这复读机', directed: true });
  assert.match(prompt, /本轮可以回嘴/);
  assert.ok(loadRolePersona('小鲸鱼').includes(GROUP_BANTER_GUIDANCE));
  assert.ok(!loadRolePersona('鲸团团-主人私聊').includes(GROUP_BANTER_GUIDANCE));
});
