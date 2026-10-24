import test from 'node:test';
import assert from 'node:assert/strict';
import { recentImageFollowupContext, falselyClaimsImageIsUnavailable, hasUsableImageDescription } from '../src/recent-image-context.mjs';

test('a private image remains available for an immediate follow-up question', () => {
  const image = { caption: '截图里 A 说要走，B 问原因。', at: 1_000_000 };
  assert.match(recentImageFollowupContext(image, '如果是你，你会怎么做', 1_010_000), /A 说要走/);
  assert.equal(recentImageFollowupContext(image, '明天吃什么', 1_010_000), '');
  assert.equal(recentImageFollowupContext(image, '你怎么看这张图', 1_400_000), '');
});

test('detects a false claim that an already-inspected picture is invisible', () => {
  assert.equal(falselyClaimsImageIsUnavailable('看不到你发的那张图'), true);
  assert.equal(falselyClaimsImageIsUnavailable('看不到图细节'), true);
  assert.equal(falselyClaimsImageIsUnavailable('图里两个人在聊天'), false);
});

test('only sends image turns to the model when the vision result contains usable content', () => {
  assert.equal(hasUsableImageDescription('一块写着“和朋友的一千天”的小蛋糕'), true);
  assert.equal(hasUsableImageDescription('图片内容无法识别'), false);
  assert.equal(hasUsableImageDescription('看不清画面中的文字'), false);
  assert.equal(hasUsableImageDescription('QQ 图片'), false);
  assert.equal(hasUsableImageDescription(''), false);
});
