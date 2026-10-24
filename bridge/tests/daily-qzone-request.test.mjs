import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQzoneRequest, isQzoneFollowupRequest } from '../src/daily-qzone.mjs';

test('parses contextual owner requests to publish a QQ dynamic', () => {
  assert.equal(parseQzoneRequest('今天主人帮你更新了好感度系统你去以这个内容发一篇动态'), '主人帮你更新了好感度系统');
  assert.equal(parseQzoneRequest('你去把这件事发一条动态'), '这件事');
  assert.equal(parseQzoneRequest('你去以这个内容发一篇动态'), '根据主人最近给出的聊天内容');
  assert.equal(parseQzoneRequest('发一条动态'), '根据主人最近给出的聊天内容');
  assert.equal(parseQzoneRequest('帮我发一条关于今天晚饭的动态'), '今天晚饭');
  assert.equal(parseQzoneRequest('我觉得这件事值得发动态'), null);
});

test('recognizes short follow-ups for history-based context resolution', () => {
  assert.equal(isQzoneFollowupRequest('给你加了呀，你去发吧'), true);
  assert.equal(isQzoneFollowupRequest('好，你去发吧'), true);
  assert.equal(isQzoneFollowupRequest('这图发吧'), false);
});
