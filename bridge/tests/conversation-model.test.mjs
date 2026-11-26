import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionModelGuard, nativeConversationModel } from '../src/conversation-model.mjs';
import { modelProxyEntriesFor } from '../src/model-proxy-watch.mjs';
import { parseDshModelRoute } from '../src/model-management.mjs';

const source = (provider) => `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: ${provider}
    model: reflection/beam-free
- id: llm-pi-ai
  config:
    providers:
      dsh:
        baseURL: http://127.0.0.1:18903/v1
`;

test('原生提供方会话首次/换模型选择，复用不重复选择，旧提供方行为保留', async () => {
  let config = { provider: 'our-free-model', model: 'reflection/beam-free' };
  const selected = [];
  const guard = createSessionModelGuard({ readConfig: () => config, selectModel: async (request) => selected.push(request) });
  await guard('existing');
  await guard('existing');
  await guard('new');
  assert.deepEqual(selected, [
    { sessionId: 'existing', provider: 'our-free-model', model: 'reflection/beam-free' },
    { sessionId: 'new', provider: 'our-free-model', model: 'reflection/beam-free' }
  ]);
  config = { ...config, model: 'deepseek-v4.1-flash-free', reasoningEffort: 'light' };
  await guard('existing');
  assert.equal(selected.length, 3);
  assert.equal(selected[2].reasoningEffort, 'light');
  config = { provider: 'dsh', model: 'old-model' };
  await guard('legacy');
  assert.equal(selected.length, 3);
  assert.throws(() => nativeConversationModel({ provider: 'our-free-model' }), /未配置/);
});

test('选择模型失败不会缓存为成功，下次可以重试', async () => {
  let attempts = 0;
  const guard = createSessionModelGuard({ readConfig: () => ({ provider: 'our-free-model', model: 'beam-free' }),
    selectModel: async () => { if (++attempts === 1) throw new Error('temporarily unavailable'); } });
  await assert.rejects(guard('session'), /temporarily/);
  await guard('session');
  assert.equal(attempts, 2);
});

test('原生模型路线不会把旧 18903 判为主对话依赖，视觉端口保留', () => {
  assert.deepEqual(modelProxyEntriesFor({ provider: 'our-free-model' }).map((x) => x.port), [18901]);
  assert.deepEqual(modelProxyEntriesFor({ provider: 'dsh' }).map((x) => x.port), [18901, 18903]);
});

test('模型状态识别实际默认提供方，忽略未选用的旧代理 baseURL', () => {
  assert.deepEqual(parseDshModelRoute(source('our-free-model')), {
    provider: 'our-free-model', model: 'reflection/beam-free', baseURL: ''
  });
  assert.equal(parseDshModelRoute(source('dsh')).baseURL, 'http://127.0.0.1:18903/v1');
  assert.equal(parseDshModelRoute(source("'our-free-model'").replaceAll('\n', '\r\n')).provider, 'our-free-model');
});

test('旧代理自动晋升和保存策略不能覆盖 Our Free Model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-model-route-'));
  const patch = join(dir, 'cordis.patch.yml');
  const policy = join(dir, 'model-policy.json');
  const original = source('our-free-model');
  writeFileSync(patch, original);
  writeFileSync(policy, JSON.stringify({ version: 1, primary: 'old-model', fallbacks: [] }));
  const saved = { patch: process.env.DSH_PATCH_FILE, policy: process.env.MODEL_POLICY_FILE };
  process.env.DSH_PATCH_FILE = patch;
  process.env.MODEL_POLICY_FILE = policy;
  try {
    const module = await import(`../src/model-management.mjs?native-test=${Date.now()}`);
    const result = await module.syncPromotedModel('old-model');
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'native-provider-active');
    await assert.rejects(module.saveModelPolicy({ primary: 'old-model' }), (error) => error.status === 409);
    assert.equal(readFileSync(patch, 'utf8'), original);
    assert.equal(JSON.parse(readFileSync(policy, 'utf8')).version, 1);
  } finally {
    for (const [key, value] of [['DSH_PATCH_FILE', saved.patch], ['MODEL_POLICY_FILE', saved.policy]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
