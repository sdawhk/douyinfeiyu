import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NodeApiClient } from './dsh-client-020.js';

const POLICY_FILE = process.env.MODEL_POLICY_FILE || 'D:\\deepseek\\state\\model-policy.json';
const DSH_PATCH_FILE = process.env.DSH_PATCH_FILE || 'D:\\deepseek\\dshhome\\profiles\\web\\cordis.patch.yml';
const KEYS_FILE = process.env.KEYS_FILE || 'D:\\deepseek\\keys.json';
const BRIDGE_LOG = process.env.BRIDGE_LOG || 'D:\\deepseek\\logs\\bridge.log';
const DSH_LOG = process.env.DSH_LOG || 'D:\\deepseek\\logs\\dshweb.out';
const PROXY_URL = process.env.MODEL_PROXY_URL || 'http://127.0.0.1:18903';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,159}$/;

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function atomicWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, value, 'utf8');
  try { renameSync(temp, file); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}
function dshConfig() {
  const source = readFileSync(DSH_PATCH_FILE, 'utf8');
  const block = source.match(/- id: agent-default-model\r?\n[\s\S]*?(?=\r?\n- id: |$)/)?.[0] || '';
  const provider = source.match(/- id: llm-pi-ai\r?\n[\s\S]*?\bbaseURL:\s*(\S+)/)?.[1] || '';
  return { source, model: block.match(/^\s+model:\s*(\S+)/m)?.[1] || '', baseURL: provider };
}
function defaultPolicy() {
  return { version: 0, primary: dshConfig().model || 'reflection/beam-free', fallbacks: [],
    firstTokenTimeoutMs: 12000, fallbackBudgetMs: 45000 };
}
export function readPolicy() { return readJson(POLICY_FILE) || defaultPolicy(); }
function redact(value) {
  let text = String(value || '请求失败');
  for (const entry of keys()) text = text.replaceAll(entry.key, '[redacted]');
  return text.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 240);
}
function safeFailure(error) { return redact(error?.message || error); }

export async function modelStatus() {
  const saved = readPolicy();
  const dsh = dshConfig();
  let proxy = null;
  try {
    const result = await fetch(`${PROXY_URL}/_models`, { signal: AbortSignal.timeout(2500) });
    if (result.ok) proxy = await result.json();
  } catch {}
  const route = dsh.baseURL === `${PROXY_URL}/v1` ? 'proxy' : 'direct';
  return { saved, dsh: { defaultModel: dsh.model, baseURL: dsh.baseURL }, route,
    proxy: proxy && { online: true, policy: proxy.policy, lastActivity: proxy.lastActivity, lastSuccess: proxy.lastSuccess,
      cooling: proxy.cooling, keys: proxy.keys },
    effective: Boolean(proxy && route === 'proxy' && proxy.policy?.version === saved.version
      && proxy.policy?.primary === saved.primary && dsh.model === saved.primary) };
}

function keys() {
  const source = readJson(KEYS_FILE);
  return (Array.isArray(source) ? source : source?.keys || [])
    .filter((entry) => entry?.key && /^https?:\/\//.test(entry.upstream || source?.upstream || 'http://127.0.0.1:18900'))
    .map((entry) => ({ key: entry.key, upstream: (entry.upstream || source?.upstream || 'http://127.0.0.1:18900').replace(/\/+$/, '') }));
}
export async function modelCatalog() {
  const first = keys()[0];
  if (!first) throw new Error('没有可用的模型凭据');
  const result = await fetch(`${first.upstream}/v1/models`, {
    headers: { authorization: `Bearer ${first.key}` }, signal: AbortSignal.timeout(10000) });
  if (!result.ok) throw new Error(`模型目录请求失败：HTTP ${result.status}`);
  const body = await result.json();
  return { models: (body.data || []).filter((row) => typeof row.id === 'string').map((row) => ({
    id: row.id, name: row.name || row.id, owner: row.owned_by || null,
    cost: /(?:^|[/:_-])free(?:$|[/:_-])/.test(row.id) || row.owned_by === 'our-free-model' ? 'free' : 'unknown',
    capabilities: row.capabilities || null
  })).sort((a, b) => a.id.localeCompare(b.id)), credentialsAvailable: true };
}

function streamHasContent(frame) {
  return frame?.choices?.some((choice) => (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0)
    || (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0))
    || (typeof frame?.output_text === 'string' && frame.output_text.length > 0);
}
export async function testModel(model) {
  if (!MODEL_ID.test(model || '')) throw Object.assign(new Error('模型 ID 格式无效'), { status: 400 });
  const entries = keys();
  if (!entries.length) throw new Error('没有可用的模型凭据');
  const started = Date.now();
  let lastError = '请求失败';
  for (const entry of entries) {
    try {
      const response = await fetch(`${entry.upstream}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${entry.key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '请只回复“好”' }], max_tokens: 32, stream: true }),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) { lastError = redact(`HTTP ${response.status}: ${await response.text()}`); continue; }
      const data = await response.text();
      let content = false, completed = false, remoteError = '';
      for (const line of data.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim();
        if (value === '[DONE]') { completed = true; continue; }
        try {
          const frame = JSON.parse(value);
          if (frame.error) remoteError = redact(frame.error.message || JSON.stringify(frame.error));
          if (streamHasContent(frame)) content = true;
          if (frame.choices?.some((choice) => choice.finish_reason)) completed = true;
        } catch {}
      }
      if (content && completed && !remoteError) return { model, ok: true, elapsedMs: Date.now() - started };
      lastError = remoteError || (content ? '流式回复中断，未正常结束' : '模型返回空回复');
    } catch (error) { lastError = safeFailure(error); }
  }
  return { model, ok: false, elapsedMs: Date.now() - started, reason: lastError };
}

function validatePolicy(value, current) {
  if (!value || value.version !== current.version) throw Object.assign(new Error('设置版本已变化，请刷新后重试'), { status: 409 });
  const primary = String(value.primary || '').trim();
  const fallbacks = value.fallbacks;
  if (!MODEL_ID.test(primary) || !Array.isArray(fallbacks) || fallbacks.length > 12
      || fallbacks.some((item) => typeof item !== 'string' || !MODEL_ID.test(item))) {
    throw Object.assign(new Error('主模型或备用模型格式无效'), { status: 400 });
  }
  if (new Set([primary, ...fallbacks]).size !== fallbacks.length + 1) {
    throw Object.assign(new Error('模型不能重复'), { status: 400 });
  }
  const firstTokenTimeoutMs = Number(value.firstTokenTimeoutMs);
  const fallbackBudgetMs = Number(value.fallbackBudgetMs);
  if (!Number.isInteger(firstTokenTimeoutMs) || firstTokenTimeoutMs < 3000 || firstTokenTimeoutMs > 30000
      || !Number.isInteger(fallbackBudgetMs) || fallbackBudgetMs < firstTokenTimeoutMs || fallbackBudgetMs > 120000) {
    throw Object.assign(new Error('超时设置超出允许范围'), { status: 400 });
  }
  return { version: current.version + 1, primary, fallbacks, firstTokenTimeoutMs, fallbackBudgetMs };
}
function qqSessionIds() {
  let log = '';
  try { log = readFileSync(BRIDGE_LOG, 'utf8').slice(-3_000_000); } catch { return []; }
  const latest = new Map();
  for (const hit of log.matchAll(/\[dsh\] session created for ([gp]\d+) -> (session-[\da-f-]+)/g)) latest.set(hit[1], hit[2]);
  return [...latest.entries()].map(([conversation, sessionId]) => ({ conversation, sessionId }));
}
async function dshClient() {
  const log = readFileSync(DSH_LOG, 'utf8');
  const token = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
  if (!token) throw new Error('无法取得 DSH 运行令牌');
  return new NodeApiClient('http://127.0.0.1:3090', { launchToken: token }).connect();
}
async function waitForDshModel(dsh, model) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const catalog = await dsh.call('session/modelCatalog', {});
    if (catalog?.groups?.some((group) => group.id === 'dsh' && group.models?.some((entry) => entry.id === model))) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`DSH 尚未加载模型 ${model}`);
}
function updatedDshSource(source, model) {
  const block = /(- id: agent-default-model\r?\n[\s\S]*?\bmodel:\s*)\S+/;
  const changed = source.replace(block, `$1${model}`);
  if (changed === source && !source.includes(`model: ${model}`)) throw new Error('DSH 默认模型配置未找到');
  const routed = changed.replace(/(- id: llm-pi-ai\r?\n[\s\S]*?\bbaseURL:\s*)\S+/, `$1${PROXY_URL}/v1`);
  const providerBlock = routed.match(/(- id: llm-pi-ai\r?\n[\s\S]*?)(?=\r?\n# === qq-bridge MCP BEGIN ===|$)/)?.[1];
  if (!providerBlock) throw new Error('DSH 模型列表配置未找到');
  if (providerBlock.includes(`- id: ${model}\n`) || providerBlock.includes(`- id: ${model}\r\n`)) return routed;
  return routed.replace(/(        models:\r?\n)/, `$1          - id: ${model}\n            name: ${model}\n`);
}
export async function saveModelPolicy(input) {
  const current = readPolicy();
  const next = validatePolicy(input, current);
  const primaryTest = await testModel(next.primary);
  if (!primaryTest.ok) throw Object.assign(new Error(`${next.primary} 测试失败：${primaryTest.reason}`), { status: 422, tests: [primaryTest] });
  const backupTests = new Array(next.fallbacks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, next.fallbacks.length) }, async () => {
    while (cursor < next.fallbacks.length) {
      const index = cursor++;
      backupTests[index] = await testModel(next.fallbacks[index]);
    }
  }));
  const tests = [primaryTest, ...backupTests];
  next.checks = tests.map(({ model, ok, reason }) => ({ model, ok, ...(reason ? { reason } : {}), at: new Date().toISOString() }));
  const previousPolicy = existsSync(POLICY_FILE) ? readFileSync(POLICY_FILE, 'utf8') : null;
  const previousDsh = readFileSync(DSH_PATCH_FILE, 'utf8');
  const dsh = await dshClient();
  const knownIds = new Set((await dsh.sessions.list({}))?.items?.map((item) => item.sessionId) || []);
  const sessions = qqSessionIds().filter((item) => knownIds.has(item.sessionId));
  const applied = [];
  try {
    atomicWrite(POLICY_FILE, JSON.stringify(next, null, 2));
    atomicWrite(DSH_PATCH_FILE, updatedDshSource(previousDsh, next.primary));
    await waitForDshModel(dsh, next.primary);
    for (const session of sessions) {
      await dsh.sessions.selectModel({ sessionId: session.sessionId, provider: 'dsh', model: next.primary });
      applied.push(session);
    }
    const status = await modelStatus();
    if (!status.effective) throw new Error('模型代理或 DSH 配置未生效');
    return { saved: next, tests, sessions: { updated: applied.length, total: sessions.length }, status };
  } catch (error) {
    if (previousPolicy == null) { try { unlinkSync(POLICY_FILE); } catch {} }
    else atomicWrite(POLICY_FILE, previousPolicy);
    atomicWrite(DSH_PATCH_FILE, previousDsh);
    for (const session of applied) {
      try { await dsh.sessions.selectModel({ sessionId: session.sessionId, provider: 'dsh', model: current.primary }); } catch {}
    }
    throw Object.assign(new Error(`应用失败，已回滚：${safeFailure(error)}`), { status: 503, tests });
  }
}
