import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMessageReferences, explicitGroupReplyDecision, groupTurnPrompt, shouldSkipUnaddressedGroupMedia } from '../src/qq-message-context.mjs';

const botSelf = '2427256325';
const keywords = ['小鲸鱼', '鲸鱼', 'deepseek'];

function decision(message, text, isOwner = false) {
  return explicitGroupReplyDecision({
    botSelf, text, isOwner, keywords,
    references: describeMessageReferences(message, botSelf)
  });
}

test('an @ of another 小鲸鱼 does not address the bot', () => {
  const otherAt = [{ type: 'at', data: { qq: '1581449421', text: '@小鲸鱼' } },
    { type: 'text', data: { text: ' 你怎么看' } }];
  assert.equal(decision(otherAt, '你怎么看'), false);
  assert.equal(decision(otherAt, '@小鲸鱼 你怎么看'), false);
  assert.equal(decision(otherAt, '@小鲸鱼 你怎么看', true), false);
  assert.equal(decision([{ type: 'text', data: { text: '@小鲸鱼 你怎么看' } }], '@小鲸鱼 你怎么看'), false);
  assert.equal(decision([{ type: 'at', data: { qq: '1581449421', text: '@黑糖' } },
    { type: 'text', data: { text: ' 来一首夜曲' } }], '来一首夜曲'), false);
});

test('the bot still answers its own QQ mention and a separate nickname call', () => {
  const selfAt = [{ type: 'at', data: { qq: botSelf, text: '@最爱吃白饭' } },
    { type: 'text', data: { text: ' 你怎么看' } }];
  assert.equal(decision(selfAt, '你怎么看'), true);
  assert.equal(decision([{ type: 'text', data: { text: '小鲸鱼你怎么看' } }], '小鲸鱼你怎么看'), true);
});

function followUp(text, { references = {}, at = 10_000 } = {}) {
  const now = Date.parse('2026-11-08T08:48:51Z');
  return explicitGroupReplyDecision({
    botSelf, text, keywords, now,
    references: describeMessageReferences(references, botSelf),
    recentReplyAt: now - at
  });
}

test('someone the bot just answered can continue with a short line', () => {
  assert.equal(followUp('你试试'), true);
  assert.equal(followUp('那你倒是说啊'), true);
  assert.equal(followUp('其他的呢'), true);
});

test('the follow-up rule stays narrow: window, length and third person', () => {
  assert.equal(followUp('你试试', { at: 100_000 }), null);
  assert.equal(followUp('一二三四五六七八九十一二三四五'), true);
  assert.equal(followUp('一二三四五六七八九十一二三四五六'), null);
  assert.equal(followUp('他说你试试'), null);
  assert.equal(followUp('那她呢'), null);
  assert.equal(explicitGroupReplyDecision({ botSelf, text: '你试试', keywords, references: {} }), null);
});

test('an @ of a third person still wins over the follow-up rule', () => {
  const otherAt = [{ type: 'at', data: { qq: '1581449421', text: '@黑糖' } },
    { type: 'text', data: { text: ' 你试试' } }];
  assert.equal(followUp('你试试', { references: otherAt }), false);
});

test('group turns identify each speaker and keep self-descriptions with that speaker', () => {
  const first = groupTurnPrompt({ groupId: '123', botSelf, senderId: '456',
    senderName: '群友甲', text: '真好，看的叔叔骨架都暖暖的' });
  const second = groupTurnPrompt({ groupId: '123', botSelf, senderId: '789',
    senderName: '群友乙', text: '你这叔叔有点危险啊' });
  assert.match(first, /发言人："群友甲"，群友/);
  assert.match(first, /自称、身份、亲属称谓属于本轮发言人/);
  assert.match(first, /【本轮发言人原话】"真好，看的叔叔骨架都暖暖的"/);
  assert.match(second, /发言人："群友乙"，群友/);
  assert.doesNotMatch(second, /群友甲/);
  assert.match(first, /对象、图片含义、指代或上下文不确定时/);
  assert.doesNotMatch(first, /2427256325|QQ 456/);
});

test('allowed group interjections may join relevant conversation but can still stay silent', () => {
  const prompt = groupTurnPrompt({ groupId: '123', botSelf, senderId: '456',
    senderName: '群友甲', text: '这家店真不错', canInterject: true });
  assert.match(prompt, /只代表可以评估，不代表必须回复/);
  assert.match(prompt, /正在聊的话题/);
  assert.match(prompt, /只输出 \[SILENT\]/);
  assert.match(prompt, /认同并说出具体理由/);
  assert.match(prompt, /部分认同、补充边界/);
  assert.match(prompt, /不认同并给出理由/);
  assert.match(prompt, /先核实\/追问/);
  assert.match(prompt, /没有有用补充时就沉默/);
  assert.match(prompt, /不要为了显得独立而唱反调/);
  assert.match(prompt, /不要编经历当论据/);
});

test('unaddressed group images stay silent while direct mentions and replies to the bot are processed', () => {
  assert.equal(shouldSkipUnaddressedGroupMedia({ isGroup: true, text: '', mediaCount: 1, references: {}, botSelf }), true);
  assert.equal(shouldSkipUnaddressedGroupMedia({ isGroup: true, text: '', mediaCount: 1,
    references: { hasBotMention: true }, botSelf }), false);
  assert.equal(shouldSkipUnaddressedGroupMedia({ isGroup: true, text: '', mediaCount: 1,
    references: { replyId: '1', quotedUserId: botSelf }, botSelf }), false);
  assert.equal(shouldSkipUnaddressedGroupMedia({ isGroup: true, text: '这是什么图', mediaCount: 1,
    references: {}, botSelf }), false);
  assert.equal(shouldSkipUnaddressedGroupMedia({ isGroup: false, text: '', mediaCount: 1,
    references: {}, botSelf }), false);
});
