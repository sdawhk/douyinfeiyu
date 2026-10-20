import assert from 'node:assert/strict';
import { describeMessageReferences, explicitGroupReplyDecision } from '../src/qq-message-context.mjs';

const eventMessage = [
  { type: 'at', data: { qq: '2427256325' } },
  { type: 'text', data: { text: ' 你看这条：' } },
  { type: 'reply', data: { id: '-865208405' } },
];
const refs = describeMessageReferences(eventMessage, '2427256325', {
  user_id: 1668389572,
  sender: { nickname: 'Komorebi' },
  message: [
    { type: 'text', data: { text: '鱼鱼在吗' } },
    { type: 'image', data: { file: 'image-file' } },
  ],
});

assert.equal(refs.hasBotMention, true);
assert.equal(refs.replyId, '-865208405');
assert.equal(refs.quotedUserId, '1668389572');
assert.match(refs.context, /@机器人（QQ 2427256325）/);
assert.match(refs.context, /引用消息（QQ 1668389572，Komorebi）：鱼鱼在吗\[图片\]/);
assert.equal(explicitGroupReplyDecision({ botSelf: '2427256325', text: '你看这条', references: refs }), true);

const atOther = describeMessageReferences([{ type: 'at', data: { qq: '12345' } }], '2427256325');
assert.equal(explicitGroupReplyDecision({ botSelf: '2427256325', text: '你好', references: atOther }), false);
assert.equal(explicitGroupReplyDecision({ botSelf: '2427256325', text: '鲸鱼你怎么看', references: atOther, keywords: ['鲸鱼'] }), true);
assert.equal(explicitGroupReplyDecision({
  botSelf: '2427256325',
  text: '是什么意思',
  references: { replyId: '1', quotedUserId: '12345', mentions: [] },
}), false);
assert.equal(explicitGroupReplyDecision({
  botSelf: '2427256325',
  text: '是什么意思',
  references: { replyId: '1', quotedUserId: '2427256325', mentions: [] },
}), true);
assert.equal(explicitGroupReplyDecision({ botSelf: '2427256325', text: '来看看', isOwner: true }), true);

const lookupFailed = describeMessageReferences(
  [{ type: 'reply', data: { id: '123' } }],
  '2427256325',
  null,
  true
);
assert.match(lookupFailed.context, /原消息读取失败/);

const cqString = describeMessageReferences(
  '[CQ:at,qq=2427256325] 鱼鱼你在吗 [CQ:reply,id=-55]',
  '2427256325'
);
assert.equal(cqString.hasBotMention, true);
assert.equal(cqString.replyId, '-55');

console.log('QQ mention and reply context tests passed');
