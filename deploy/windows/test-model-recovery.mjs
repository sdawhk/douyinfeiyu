import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'model-recovery-'));
let upstreamCalls = 0;
const upstream = http.createServer((req, res) => {
  upstreamCalls++;
  if (upstreamCalls <= 3) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"temporary gateway failure"}}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
let child;
try {
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const keysFile = join(dir, 'keys.json');
  const policyFile = join(dir, 'policy.json');
  writeFileSync(keysFile, JSON.stringify({ upstream: `http://127.0.0.1:${upstreamPort}`, keys: [{ name: 'test', key: 'fake' }] }));
  writeFileSync(policyFile, JSON.stringify({ primary: 'test-primary', fallbacks: ['test-backup'], firstTokenTimeoutMs: 3000, fallbackBudgetMs: 10000 }));

  const portServer = http.createServer();
  await listen(portServer);
  const port = portServer.address().port;
  await close(portServer);
  child = spawn(process.execPath, [fileURLToPath(new URL('./model-pool-proxy.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), KEYS_FILE: keysFile,
      KEYS_STATE_FILE: join(dir, 'key-state.json'), MODEL_STATE_FILE: join(dir, 'model-state.json'),
      MODEL_POLICY_FILE: policyFile, MODEL_ACTIVITY_FILE: join(dir, 'activity.json'),
      MODEL_COOLDOWN_MS: '10000', MODEL_RECOVERY_PROBE_INTERVAL_MS: '150' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 100 && !output.includes('model-pool proxy:'); i++) {
    if (child.exitCode != null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(output, /model-pool proxy:/);
  const chat = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-primary', messages: [{ role: 'user', content: 'ping' }], stream: true }),
    });
    return { status: response.status, text: await response.text() };
  };
  assert.equal((await chat()).status, 502);
  assert.equal(upstreamCalls, 2);
  assert.equal((await chat()).status, 502); // one recovery probe
  assert.equal(upstreamCalls, 3);
  const cooling = await chat();
  assert.equal(cooling.status, 503);
  assert.match(cooling.text, /all model routes are cooling down/);
  assert.equal(upstreamCalls, 3); // probe rate limit
  await new Promise((resolve) => setTimeout(resolve, 170));
  const recovered = await chat();
  assert.equal(recovered.status, 200);
  assert.match(recovered.text, /"content":"OK"/);
  assert.equal(upstreamCalls, 4);
  console.log('model recovery probe: passed');
} finally {
  child?.kill();
  await close(upstream);
  rmSync(dir, { recursive: true, force: true });
}
