import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runBackgroundDouyinTurn, watchedVideosFromRecords } from '../src/background-douyin-turn.mjs';

const video = { url: 'https://www.douyin.com/video/12345', title: '本轮真实视频' };
function watchRecords({ played = true, isError = false, name = 'mcp__snowluma__douyin_direct_browse' } = {}) {
  return [
    { event: { type: 'tool/call', data: { callId: 'watch-1', name, arguments: JSON.stringify({ action: 'watch' }) } } },
    { event: { type: 'tool/result', data: { message: { toolCallId: 'watch-1', isError,
      content: [{ type: 'text', text: JSON.stringify({ ok: true, played, video }) }] } } } }
  ];
}
function runner(raw, records = []) {
  const prompted = [];
  const cancelled = [];
  const options = { cwd: 'D:/deepseek/qqchat', persona: '你是鲸团团。', key: 'private:12345', token: 'private-token',
    prompt: '自行决定想不想看视频。',
    createSession: async ({ request }) => ({ sessionId: request.sessionId, agentPreset: request.agentPreset }),
    promptSession: async (request) => prompted.push(request), waitForReply: async () => raw,
    readRecords: async () => records, cancelSession: async (id) => cancelled.push(id) };
  return { options, prompted, cancelled };
}

test('后台选择静默只运行一次，不纠正、不发 QQ，也不使用主聊天会话', async () => {
  const r = runner('[SILENT]');
  assert.deepEqual(await runBackgroundDouyinTurn(r.options), { reply: '', watched: [] });
  assert.equal(r.prompted.length, 1);
  assert.match(r.prompted[0].request.sessionId, /^session-qq-browse-/);
  assert.deepEqual(r.cancelled, [r.prompted[0].request.sessionId]);
});

test('没有本轮播放证据时，旧视频总结不能成为本次日报', async () => {
  const r = runner('我刚刚看了两条旧视频。');
  assert.equal((await runBackgroundDouyinTurn(r.options)).reply, '');
  assert.deepEqual(watchedVideosFromRecords(watchRecords({ played: false })), []);
  assert.deepEqual(watchedVideosFromRecords(watchRecords({ isError: true })), []);
  assert.deepEqual(watchedVideosFromRecords(watchRecords({ name: 'other-tool' })), []);
});

test('日报只采用本任务成功的播放记录', async () => {
  const r = runner('这条视频很有趣。', watchRecords());
  assert.deepEqual(await runBackgroundDouyinTurn(r.options), { reply: '这条视频很有趣。', watched: [video] });
});

test('凭据泄露和任务失败都不会发布，并且清理独立会话', async () => {
  const r = runner('private-token', watchRecords());
  assert.equal((await runBackgroundDouyinTurn(r.options)).reply, '');
  r.options.waitForReply = async () => { throw new Error('timeout'); };
  await assert.rejects(runBackgroundDouyinTurn(r.options), /timeout/);
  assert.equal(r.cancelled.length, 2);
});

test('主消息与主动评估同会话串行；其它聊天可并行，失败不堵住后续消息', async () => {
  const source = readFileSync(new URL('../src/qq-bot.mjs', import.meta.url), 'utf8');
  const wrapper = source.slice(source.indexOf('async function ask('), source.indexOf('async function askInSession('));
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ask = vm.runInNewContext(`${wrapper}\nask`, { Map, Promise,
    askInSession: async (key, text) => {
      calls.push(text);
      if (text === 'first') { await gate; throw new Error('failed first turn'); }
      return text;
    } });
  const first = ask('p1', 'first').catch((error) => error.message);
  const next = ask('p1', 'next');
  assert.equal(await ask('p2', 'other'), 'other');
  assert.deepEqual(calls, ['first', 'other']);
  release();
  assert.equal(await first, 'failed first turn');
  assert.equal(await next, 'next');
  assert.deepEqual(calls, ['first', 'other', 'next']);
});

for (const preset of ['qq-chat', 'qq-chat-v2']) {
  test(`${preset}：同一条消息只由主桥接接收，仍可分条发送`, async () => {
    const plugin = await import(`../dsh/agent-presets/${preset}/qq-tool-restrict.mjs`);
    let guard;
    plugin.apply({ tools: { restrict() {}, guard(fn) { guard = fn; } } });
    const run = (sessionId, name) => guard({ name, agent: { session: { id: sessionId } } });
    for (const suffix of ['get_unread_messages', 'get_recent_messages', 'get_group_history',
      'wait_for_messages', 'mark_read', 'set_wake_config', 'get_prompt']) {
      assert.equal(typeof run('session-qq-managed-123', `mcp__snowluma__qq_${suffix}`), 'string');
      assert.equal(run('session-legacy-123', `mcp__snowluma__qq_${suffix}`), undefined);
    }
    assert.equal(run('session-qq-managed-123', 'mcp__snowluma__qq_send_message'), undefined);
    assert.equal(run('session-qq-managed-123', 'mcp__snowluma__qq_reply'), undefined);
    assert.equal(run('session-qq-browse-123', 'mcp__snowluma__douyin_direct_browse'), undefined);
    for (const name of ['mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_wait_for_messages',
      'mcp__snowluma__qq_get_unread_messages', 'mcp__cabin-world-safe__cabin_go', 'dev_mode_set']) {
      assert.equal(typeof run('session-qq-browse-123', name), 'string');
    }
  });
}
