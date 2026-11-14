import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('cabin MCP enforces owner authorization and returns completed, running, and recent results', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-mcp-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const logFile = path.join(temp, 'world', 'cabin-log.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, Array.from({ length: 12 }, (_, i) => JSON.stringify({
    ts: i + 1, name: '小鲸鱼', kind: 'use', label: `记录${i + 1}`, text: 'x'.repeat(260),
  })).join('\n'));

  const cabinCalls = [];
  let taskPolls = 0;
  const game = createServer(async (req, res) => {
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/v1/tool') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      cabinCalls.push(body);
      if (body.name === 'cabin_go') return send({ taskId: 'go1', status: 'done', result: { ok: true, happened: ['走到了公园'] } });
      if (body.name === 'cabin_use') return send({ taskId: 'use1', status: 'running', label: '钓鱼' });
      return send({ status: 'done', result: { ok: true } });
    }
    if (req.method === 'GET' && req.url === '/v1/tasks/use1') {
      taskPolls++;
      return send(taskPolls === 1
        ? { taskId: 'use1', status: 'running', label: '钓鱼' }
        : { taskId: 'use1', status: 'done', result: { ok: true, happened: ['钓到一条鱼'] } });
    }
    res.writeHead(404).end();
  });
  const gamePort = await listen(game);
  t.after(() => game.close());

  const authCalls = [];
  const auth = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    authCalls.push({ url: req.url, body });
    const accepted = req.url === '/api/authorize/cabin'
      ? body.key === 'private:123' && body.token === 'owner-session-token'
      : body.token === 'owner-session-token' || body.token === 'other-session-token';
    res.writeHead(accepted ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(accepted ? { ok: true } : { ok: false, error: '令牌无效' }));
  });
  const authPort = await listen(auth);
  t.after(() => auth.close());

  const bridgeJson = path.join(temp, 'bridge.json');
  fs.writeFileSync(bridgeJson, JSON.stringify({ url: `http://127.0.0.1:${gamePort}`, token: 'one-time-game-token' }));
  const configFile = path.join(temp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ownerQQ: '123', consolePort: authPort }));

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-cabin-world-safe.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CABIN_BRIDGE_JSON: bridgeJson,
      CABIN_LOG_JSONL: logFile,
      CABIN_BRIDGE_CONFIG: configFile,
      CABIN_CONSOLE_TOKEN_FILE: path.join(temp, 'missing-console-token'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill(); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null) pending.get(message.id)?.(message);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 5000);
    pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(initialized.error, undefined);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await rpc('tools/list');
  const toolNames = tools.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('cabin_recent'));

  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    const content = response.result.content.find((item) => item.type === 'text').text;
    let value = null;
    try { value = JSON.parse(content); } catch {}
    return { response, text: content, value };
  };
  const owner = { key: 'private:123', token: 'owner-session-token' };
  const nonOwnerResult = await call('cabin_go', { ...owner, key: 'private:456', token: 'other-session-token', place: 'park' });
  assert.equal(nonOwnerResult.response.result.isError, true);
  assert.match(nonOwnerResult.text, /只允许主人私聊/);
  assert.equal(cabinCalls.length, 0, 'non-owner must be blocked before reaching the game');
  const borrowedOwnerToken = await call('cabin_go', { key: 'private:123', token: 'other-session-token', place: 'park' });
  assert.equal(borrowedOwnerToken.response.result.isError, true);
  assert.match(borrowedOwnerToken.text, /令牌无效/);
  assert.equal(cabinCalls.length, 0, 'a different session token must be rejected by the strict cabin authorization endpoint');

  const done = await call('cabin_go', { ...owner, place: 'park' });
  assert.equal(done.value.status, 'done');
  assert.equal(done.value.result.happened[0], '走到了公园');
  assert.equal(cabinCalls.at(-1).arguments.waitMs, 0);

  const polled = await call('cabin_use', { ...owner, object: 'pier', use: 'fish' });
  assert.equal(polled.value.status, 'done');
  assert.equal(polled.value.result.happened[0], '钓到一条鱼');
  assert.equal(taskPolls, 2);

  const recent = await call('cabin_recent', owner);
  assert.equal(recent.value.records.length, 10);
  assert.equal(recent.value.records[0].label, '记录3');
  assert.equal(recent.value.records[0].text.length, 200);
  assert.ok(authCalls.some((item) => item.url === '/api/authorize/cabin'));
  assert.ok(authCalls.some((item) => item.url === '/api/authorize/read'));
  fs.rmSync(logFile);
  const noHistory = await call('cabin_recent', owner);
  assert.deepEqual(noHistory.value.records, []);

  child.stdin.end();
  lines.close();
});
