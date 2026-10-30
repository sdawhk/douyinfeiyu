import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAffinityCommand } from '../src/affinity-command.mjs';

test('natural affinity lookups are parsed as deterministic commands', () => {
  for (const phrase of [
    '好感度',
    '看看好感度',
    '查一下好感度',
    '帮我看看好感度',
    '查看我的好感度是多少',
    '给我看一下，我和你的好感度',
    '帮我看看我和小鲸鱼的好感度',
    '看看我和肥鱼之间的好感度是多少'
  ]) {
    assert.deepEqual(parseAffinityCommand(phrase), { args: '' }, phrase);
  }
});

test('owner lookup and mutation arguments stay attached to the command', () => {
  assert.deepEqual(parseAffinityCommand('/好感度 1668389572'), { args: '1668389572' });
  assert.deepEqual(parseAffinityCommand('好感度 调整 1668389572 +2 主人表扬'), { args: '调整 1668389572 +2 主人表扬' });
  assert.equal(parseAffinityCommand('最近群里发生了什么'), null);
});

test('affinity guidance questions are handled with system facts', () => {
  for (const phrase of ['好感度怎么加', '好感度如何提升', '怎么增加好感度', '帮我说说好感度怎么加', '/好感度 怎么加']) {
    assert.deepEqual(parseAffinityCommand(phrase), { args: '', help: true }, phrase);
  }
});
