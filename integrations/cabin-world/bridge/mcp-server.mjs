#!/usr/bin/env node
// 小屋世界 MCP 服务器 / Cabin World MCP server — zero dependencies (Node.js 18+).
//
// Lets any MCP client use the same tools as the HTTP bridge: DeepSeek Harness (DSH), Claude Desktop, Cursor, …
// It speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and forwards every tool call to the running bridge
// (POST {url}/v1/tool with the token from <data>/bridge.json). It never talks to the game directly and stores nothing.
//
// Start the bridge first (start.cmd). Then register this file in your MCP client, e.g. DSH:
//   integrations/dsh/cordis.patch.yml   (or run integrations/dsh/install-dsh.cmd)
//
// Usage: node mcp-server.mjs [--data <folder with bridge.json>]   default: ../data next to this file
// stdout carries protocol frames only; diagnostics go to stderr.
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dataDir = path.resolve(opt('--data') || path.join(HERE, '..', 'data'));
const toolsFile = path.join(HERE, 'openai-tools.json');
const SERVER = { name: 'cabin-world', version: '1.1.0' };
const log = (...a) => process.stderr.write('[cabin-world-mcp] ' + a.join(' ') + '\n');

// MCP tool list from the same file the HTTP bridge hands to function-calling models.
function tools() {
  const t = JSON.parse(fs.readFileSync(toolsFile, 'utf8'));
  return (t.tools || t).map(x => ({ name: x.function.name, description: x.function.description, inputSchema: x.function.parameters || { type: 'object', properties: {} } }));
}
function bridge() {
  const file = path.join(dataDir, 'bridge.json');
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d.url && d.token) return d; } catch { /* not running */ }
  return null;
}
async function callTool(name, args) {
  const b = bridge();
  if (!b) return { isError: true, content: [{ type: 'text', text: '小屋世界桥没有运行（找不到 ' + path.join(dataDir, 'bridge.json') + '）。请先双击 start.cmd 打开小屋世界，再试一次。' }] };
  let res, body;
  try {
    res = await fetch(b.url + '/v1/tool', { method: 'POST', headers: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args || {} }), signal: AbortSignal.timeout(660000) });
    body = await res.json();
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: '连不上小屋世界桥（' + String(e.message || e) + '）。桥可能刚关闭；请重新运行 start.cmd。' }] };
  }
  const failed = !res.ok || body?.ok === false;
  return { isError: failed, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
    instructions: '小屋世界：给 AI 一个能生活的像素小世界。安装或升级 1.1 时，先 cabin_update_plan，逐项讲清更新与保留原版的差别，让用户分别选择；不可把同意升级当成同意全部换外观。只提交明确选择给 cabin_update_apply，未选保持当前状态。平时先 cabin_status / cabin_look 了解环境，用 cabin_go / cabin_use 真实行动，running 不等于完成，用 cabin_task 查回执。详细说明见 docs/AI-MANUAL.md 和 INSTALL-AI.md。' });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') { try { return reply(id, { tools: tools() }); } catch (e) { return fail(id, -32603, '读不到工具列表：' + e.message); } }
  if (method === 'tools/call') {
    const name = params?.name; if (!tools().some(t => t.name === name)) return fail(id, -32602, '没有这个工具：' + name);
    return reply(id, await callTool(name, params?.arguments));
  }
  if (method?.startsWith('notifications/')) return; // initialized, cancelled: nothing to do
  if (id !== undefined) fail(id, -32601, 'Method not found: ' + method);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  Promise.resolve(handle(msg)).catch(e => { log(e.stack || e); if (msg.id !== undefined) fail(msg.id, -32603, String(e.message || e)); });
});
rl.on('close', () => process.exit(0));
log('ready; data folder', dataDir);
