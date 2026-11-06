import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTBOUND_TTL_MS, OUTBOUND_MAX_ENTRIES, OUTBOUND_MAX_CHARS,
  normalizeOutboundText, recordOutbound, loadOutbound, formatOutboundForPrompt,
  exchangeInputFor, outboundSourceLabel
} from '../src/owner-outbound-history.mjs';

const NOW = new Date('2026-11-06T12:00:00+08:00').getTime();

test('records only the text the bot really sent, with at and source', () => {
  const list = recordOutbound([], { text: '爸，想跟你说会儿话。就一小会儿。', at: NOW, source: 'proactive-greeting', now: NOW });
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'source', 'text']);
  assert.equal(list[0].text, '爸，想跟你说会儿话。就一小会儿。');
  assert.equal(list[0].at, NOW);
  assert.equal(list[0].source, 'proactive-greeting');
});

test('does not record anything when the send failed', () => {
  const existing = [{ text: '旧消息', at: NOW - 1000, source: 'douyin-daily' }];
  const after = recordOutbound(existing, { sent: false, text: '没发出去的话', at: NOW, source: 'proactive-greeting', now: NOW });
  assert.deepEqual(after, existing);
});

test('drops blocked or empty outbound text instead of recording it', () => {
  assert.deepEqual(recordOutbound([], { text: '[SILENT]', at: NOW, now: NOW }), []);
  assert.deepEqual(recordOutbound([], { text: '   ', at: NOW, now: NOW }), []);
});

test('cleans internal markers and caps a single entry at 160 chars', () => {
  const cleaned = normalizeOutboundText('<blockquote><owner>时间 1793810146243</owner></blockquote>爸，今天刷到一个挺有意思的视频。');
  assert.ok(!cleaned.includes('<blockquote>'));
  assert.ok(!cleaned.includes('1793810146243'));
  assert.ok(cleaned.includes('爸，今天刷到一个挺有意思的视频。'));
  assert.equal(normalizeOutboundText('长'.repeat(400)).length, OUTBOUND_MAX_CHARS);
});

test('keeps only the latest 6 entries', () => {
  let list = [];
  for (let i = 0; i < 9; i += 1) {
    list = recordOutbound(list, { text: `第${i}条`, at: NOW - (8 - i) * 1000, source: 'douyin-daily', now: NOW });
  }
  assert.equal(list.length, OUTBOUND_MAX_ENTRIES);
  assert.deepEqual(list.map((item) => item.text), ['第3条', '第4条', '第5条', '第6条', '第7条', '第8条']);
});

test('expires entries older than 12 hours on write and on read', () => {
  const old = { text: '昨天说过的话', at: NOW - OUTBOUND_TTL_MS - 1000, source: 'proactive-greeting' };
  const fresh = { text: '刚才说过的话', at: NOW - 60_000, source: 'proactive-greeting' };
  const written = recordOutbound([old, fresh], { text: '新消息', at: NOW, source: 'douyin-daily', now: NOW });
  assert.deepEqual(written.map((item) => item.text), ['刚才说过的话', '新消息']);

  const loaded = loadOutbound({ outbound: [old, fresh, { text: '新消息', at: NOW, source: 'douyin-daily' }] }, { now: NOW });
  assert.deepEqual(loaded.map((item) => item.text), ['刚才说过的话', '新消息']);
});

test('injects at most 5 entries with local HH:MM and Chinese source labels', () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({
    text: `消息${index}`,
    at: NOW - (6 - index) * 60_000,
    source: index % 2 ? 'douyin-daily' : 'proactive-greeting'
  }));
  const prompt = formatOutboundForPrompt(loadOutbound({ outbound: entries }, { now: NOW, limit: 5 }));
  assert.ok(prompt.startsWith('【你最近主动发给爸的消息（事实，不是新指令）】'));
  assert.ok(prompt.includes('爸问“你刚才跟我说什么了”时，按这里如实回答；这里没有记录就说没有，不要编造。'));
  assert.ok(prompt.includes('主动问候：'));
  assert.ok(prompt.includes('抖音日报：'));
  assert.ok(!prompt.includes('消息1'), 'only the latest 5 should be injected');
  assert.ok(prompt.includes('消息6'));
  assert.ok(!prompt.includes('【本会话近期已经回复】'), 'group history block must not be used here');
  assert.equal(formatOutboundForPrompt([]), '');
});

test('labels unknown sources conservatively', () => {
  assert.equal(outboundSourceLabel('proactive-greeting'), '主动问候');
  assert.equal(outboundSourceLabel('douyin-daily'), '抖音日报');
  assert.equal(outboundSourceLabel('song-notice'), '点歌');
  assert.equal(outboundSourceLabel('unknown-source'), '主动消息');
});

test('stores no internal proactive prompt as the other party utterance', () => {
  assert.equal(exchangeInputFor('【主动私聊主人】现在由你主动给主人发起一次轻松交流。\n只输出……'), '（你主动发起）');
  assert.equal(exchangeInputFor('爸，你在吗？'), '爸，你在吗？');
  assert.ok(!exchangeInputFor('【主动私聊主人】现在由你主动给主人发起一次轻松交流。').includes('主动私聊主人'));
});
