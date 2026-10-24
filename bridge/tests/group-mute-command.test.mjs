import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupMuteCommand } from '../src/group-mute-command.mjs';

test('recognizes a standalone mute command with a vocative and a Chinese duration', () => {
  assert.deepEqual(parseGroupMuteCommand('先闭嘴十分钟，鲸鱼'), { muted: true, durationMs: 10 * 60_000 });
  assert.deepEqual(parseGroupMuteCommand('小鲸鱼，闭嘴30秒'), { muted: true, durationMs: 30_000 });
  assert.deepEqual(parseGroupMuteCommand('闭嘴'), { muted: true, durationMs: null });
  assert.deepEqual(parseGroupMuteCommand('鲸鱼，解禁'), { muted: false, durationMs: null });
});

test('does not treat ordinary sentences or unsupported durations as mute commands', () => {
  assert.equal(parseGroupMuteCommand('我觉得机器人应该闭嘴'), null);
  assert.equal(parseGroupMuteCommand('闭嘴一百小时'), null);
  assert.equal(parseGroupMuteCommand('闭嘴十分钟后再说别的'), null);
});
