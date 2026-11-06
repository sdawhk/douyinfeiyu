import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BROWSE_TOPIC_MAX_CHARS, normalizeBrowseTopic, readBrowseTopicBlacklist } from '../src/douyin-topic.mjs';

test('a short owner topic is accepted and trimmed', () => {
  assert.deepEqual(normalizeBrowseTopic('  游戏  '), { topic: '游戏', error: '' });
  assert.deepEqual(normalizeBrowseTopic('猫猫视频'), { topic: '猫猫视频', error: '' });
});

test('missing topic means the normal recommendation feed, not an error', () => {
  assert.deepEqual(normalizeBrowseTopic(undefined), { topic: '', error: '' });
  assert.deepEqual(normalizeBrowseTopic(null), { topic: '', error: '' });
  assert.deepEqual(normalizeBrowseTopic('   '), { topic: '', error: '' });
});

test('non-string topics are rejected', () => {
  assert.deepEqual(normalizeBrowseTopic(42), { topic: '', error: '主题需为文字' });
  assert.deepEqual(normalizeBrowseTopic(['游戏']), { topic: '', error: '主题需为文字' });
});

test('topics longer than the limit are rejected by code point', () => {
  const limitTopic = '字'.repeat(BROWSE_TOPIC_MAX_CHARS);
  assert.equal(normalizeBrowseTopic(limitTopic).topic, limitTopic);
  const tooLong = '字'.repeat(BROWSE_TOPIC_MAX_CHARS + 1);
  assert.equal(normalizeBrowseTopic(tooLong).error, `主题最多 ${BROWSE_TOPIC_MAX_CHARS} 个字`);
});

test('newlines, CQ codes, brackets and URLs are rejected', () => {
  assert.match(normalizeBrowseTopic('游戏\n视频').error, /换行/);
  assert.match(normalizeBrowseTopic('游戏\t视频').error, /换行/);
  assert.match(normalizeBrowseTopic('CQ:at,qq=123').error, /CQ 码/);
  assert.match(normalizeBrowseTopic('[游戏]').error, /方括号/);
  assert.match(normalizeBrowseTopic('游戏【推荐】').error, /方括号/);
  assert.match(normalizeBrowseTopic('https://www.douyin.com/video/1').error, /链接/);
  assert.match(normalizeBrowseTopic('www.douyin.com').error, /链接/);
});

test('blacklisted words are rejected even inside a longer topic', () => {
  const { topic, error } = normalizeBrowseTopic('游戏 赌博', { blacklist: ['赌博'] });
  assert.equal(topic, '');
  assert.match(error, /黑名单/);
  assert.equal(normalizeBrowseTopic('游戏', { blacklist: ['赌博'] }).topic, '游戏');
});

test('blacklist config is read from browse_topics and corrupt files fail open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-topic-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ browse_topics: { blacklist: ['赌博', ''] } }));
    assert.deepEqual(readBrowseTopicBlacklist(path), ['赌博', '']);
    writeFileSync(path, 'not json');
    assert.deepEqual(readBrowseTopicBlacklist(path), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
