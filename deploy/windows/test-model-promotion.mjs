import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'model-promotion-'));
const attemptedModels = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    attemptedModels.push(body.model);
    if (body.model === 'test-primary') {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"temporary gateway failure"}}');
      return;
    }
    if (body.model === 'test-incomplete') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  });
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
let child;
try {
  await listen(upstream);
  const keysFile = join(dir, 'keys.json');
  const policyFile = join(dir, 'policy.json');
  writeFileSync(keysFile, JSON.stringify({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    keys: [{ name: 'test', key: 'fake' }],
  }));
  writeFileSync(policyFile, JSON.stringify({
    primary: 'test-primary', fallbacks: ['test-backup'],
    firstTokenTimeoutMs: 3000, fallbackBudgetMs: 10000,
  }));

  const portServer = http.createServer();
  await listen(portServer);
  const port = portServer.address().port;
  await close(portServer);
  child = spawn(process.execPath, [fileURLToPath(new URL('./model-pool-proxy.mjs', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      KEYS_FILE: keysFile,
      KEYS_STATE_FILE: join(dir, 'key-state.json'),
      MODEL_STATE_FILE: join(dir, 'model-state.json'),
      MODEL_POLICY_FILE: policyFile,
      MODEL_ACTIVITY_FILE: join(dir, 'activity.json'),
      MODEL_COOLDOWN_MS: '10000',
    },
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
      body: JSON.stringify({
        model: 'test-primary', messages: [{ role: 'user', content: 'ping' }], stream: true,
      }),
    });
    return { status: response.status, text: await response.text() };
  };

  assert.equal((await chat()).status, 200);
  assert.deepEqual(attemptedModels.slice(0, 2), ['test-primary', 'test-backup']);
  let policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  assert.equal(policy.primary, 'test-backup');
  assert.equal(policy.fallbacks.at(-1), 'test-primary');
  assert.equal(policy.checks.at(-1).source, 'complete-live-response');

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await chat()).status, 200);
  assert.equal(attemptedModels[2], 'test-backup');

  writeFileSync(policyFile, JSON.stringify({
    version: 3, primary: 'test-primary', fallbacks: ['test-incomplete'],
    firstTokenTimeoutMs: 3000, fallbackBudgetMs: 10000,
  }));
  const healthy = await fetch(`http://127.0.0.1:${port}/_models/healthy`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-primary' }),
  });
  assert.equal(healthy.status, 200);
  attemptedModels.length = 0;
  assert.equal((await chat()).status, 200);
  policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  assert.equal(policy.primary, 'test-primary');
  assert.deepEqual(attemptedModels, ['test-primary', 'test-incomplete']);

  writeFileSync(policyFile, JSON.stringify({
    version: 4, primary: 'test-primary', fallbacks: ['test-backup'], autoPromote: false,
    firstTokenTimeoutMs: 3000, fallbackBudgetMs: 10000,
  }));
  await fetch(`http://127.0.0.1:${port}/_models/healthy`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-primary' }),
  });
  attemptedModels.length = 0;
  assert.equal((await chat()).status, 200);
  policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  assert.equal(policy.primary, 'test-primary');
  assert.equal(policy.autoPromote, false);
  assert.deepEqual(attemptedModels, ['test-primary', 'test-backup']);
  console.log('persistent fallback promotion, manual primary lock, and incomplete-stream rejection: passed');
} finally {
  child?.kill();
  await close(upstream);
  rmSync(dir, { recursive: true, force: true });
}
