import test from 'node:test';
import assert from 'node:assert/strict';
import { commitmentClaimIssue } from '../src/reply-output-safety.mjs';

const blocked = [
  '这个思路好，专挑同款电饭煲焖老婆的抽象视频刷。我这边已经开始刷了，任务是真启动了。',
  '我又开了一轮浏览，任务在跑。',
  '等能查到记录我马上挑几条一样的 AI 整活视频给爸看。',
  '稍等我去查一下结果，马上给你。',
  '我这就去刷，刷完给你挑。',
  '任务已经启动了，等会儿报给你。',
];

const allowed = [
  '我这就去听，爸你放。',
  '马上给你唱一小段，别嫌难听。',
  '等我一下，我去看看你发的啥。',
  '我这就去睡，明天再聊。',
  '这条我还没真拿到结果，先不糊弄你。',
  '查结果的工具这会儿接不通，我这边没拿到记录。',
  '好呀，我给你挑两条视频看。',
];

test('commitment gate blocks running/progress claims made without a completed result', () => {
  for (const text of blocked) assert.equal(commitmentClaimIssue(text), 'task-commitment', text);
});

test('commitment gate allows ordinary conversational promises and honest no-result lines', () => {
  for (const text of allowed) assert.equal(commitmentClaimIssue(text), '', text);
});

test('commitment gate is bypassed only when a completed result is supplied', () => {
  assert.equal(commitmentClaimIssue('任务在跑，等会儿给你。', { completed: true }), '');
});

test('commitment gate strips sticker directives before judging', () => {
  assert.equal(commitmentClaimIssue('[sticker:DeepSeek娘019] 任务在跑'), 'task-commitment');
});
