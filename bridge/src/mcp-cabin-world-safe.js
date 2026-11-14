// 安全版小屋世界 MCP server（stdio）。暴露七个游戏工具及只读近期记录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE_JSON = process.env.CABIN_BRIDGE_JSON
  || 'C:\\Users\\admin\\Desktop\\小屋世界-v0.1\\data\\bridge.json';
const CABIN_LOG_JSONL = process.env.CABIN_LOG_JSONL
  || path.join(path.dirname(BRIDGE_JSON), 'world', 'cabin-log.jsonl');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_CONFIG = process.env.CABIN_BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const TOOL_TIMEOUT_MS = 150_000;

function loadBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return {}; }
}

function readConsoleToken() {
  const config = loadBridgeConfig();
  if (config.consoleToken) return String(config.consoleToken);
  try { return fs.readFileSync(process.env.CABIN_CONSOLE_TOKEN_FILE || path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function authorizeSession(key, token, requireOwner) {
  const match = /^(private|group):(\d+)$/.exec(String(key ?? '').trim());
  if (!match || !String(token ?? '').trim()) throw new Error('必须提供有效的当前会话 key 和 token');
  if (requireOwner) {
    const config = loadBridgeConfig();
    const owners = (Array.isArray(config.ownerQQs) && config.ownerQQs.length ? config.ownerQQs : [config.ownerQQ])
      .filter((id) => id != null && String(id).trim()).map(String);
    if (match[1] !== 'private' || !owners.includes(match[2])) {
      throw new Error('小屋世界的操作类工具只允许主人私聊使用');
    }
  }
  const port = Number(loadBridgeConfig().consolePort) || 3100;
  const endpoint = requireOwner ? '/api/authorize/cabin' : '/api/authorize/read';
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': readConsoleToken(),
    },
    body: JSON.stringify({ key, token }),
    signal: AbortSignal.timeout(15_000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`会话授权检查返回无效响应（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(result?.error || `会话授权失败（HTTP ${response.status}）`);
}

function readBridgeInfo() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(BRIDGE_JSON, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    console.error(`[cabin-world] bridge.json unavailable: ${path.resolve(BRIDGE_JSON)} (${error?.message ?? error})`);
    throw new Error('小屋世界桥未启动或连接信息不可读');
  }
  if (!info || typeof info.url !== 'string' || typeof info.token !== 'string' || !info.token) {
    throw new Error('bridge.json 缺少有效的 url 或 token');
  }
  const url = new URL(info.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('小屋世界桥地址必须是本机 HTTP 地址');
  }
  return { url: url.origin, token: info.token };
}

async function request(method, endpoint, body) {
  // bridge.json 的 token 每次启动都会变化；每次请求前重新读取。
  const { url, token } = readBridgeInfo();
  const response = await fetch(new URL(endpoint, `${url}/`), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`小屋世界桥返回了无效 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(data?.error || `小屋世界桥请求失败（HTTP ${response.status}）`);
  return data;
}

async function callTool(name, args = {}) {
  const gameArgs = ['cabin_go', 'cabin_use', 'cabin_buy', 'cabin_eat', 'cabin_stop'].includes(name)
    ? { ...args, waitMs: 0 }
    : args;
  let result = await request('POST', '/v1/tool', { name, arguments: gameArgs });
  if (result?.status !== 'running' || !result.taskId) return result;

  const taskId = String(result.taskId);
  const deadline = Date.now() + TOOL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
    if (result?.status !== 'running') return result;
  }
  return {
    taskId,
    status: 'running',
    label: result?.label,
    hint: '动作仍在进行中，尚未完成；稍后可再次查询任务状态。',
  };
}

const server = new McpServer({ name: 'cabin-world-safe', version: '0.1.0' });
const session = {
  key: z.string().regex(/^(private|group):\d+$/).describe('当前会话 key，例如 private:123456'),
  token: z.string().min(1).describe('当前会话令牌'),
};
const noArgs = { ...session };

function register(name, description, schema, ownerOnly = false) {
  const inputSchema = { ...schema, ...session };
  server.tool(name, description, inputSchema, async (args) => {
    try {
      const { key, token, ...toolArgs } = args;
      await authorizeSession(key, token, ownerOnly);
      const result = await callTool(name, toolArgs);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `小屋世界调用失败：${error?.message ?? error}` }], isError: true };
    }
  });
}

register('cabin_status', '查看小屋角色的位置、零花钱、背包、状态和正在做的事。', noArgs);
register('cabin_look', '查看当前房间的家具、可用动作和出口。', noArgs);
register('cabin_go', '前往指定地点，可选指定房间位置。仅主人私聊可操作。', {
  place: z.string().trim().min(1).max(80),
  zone: z.string().trim().min(1).max(80).optional(),
}, true);
register('cabin_use', '使用家具或物品。仅主人私聊可操作。', {
  object: z.string().trim().min(1).max(80),
  use: z.string().trim().min(1).max(80),
  item: z.string().trim().min(1).max(80).optional(),
  feeling: z.string().trim().max(200).optional(),
}, true);
register('cabin_buy', '在小卖部购买商品。仅主人私聊可操作。', {
  product: z.string().trim().min(1).max(80),
  feeling: z.string().trim().max(200).optional(),
}, true);
register('cabin_eat', '食用、饮用或使用背包中的商品。仅主人私聊可操作。', {
  product: z.string().trim().min(1).max(80),
  feeling: z.string().trim().max(200).optional(),
}, true);
register('cabin_stop', '停止当前动作。仅主人私聊可操作。', noArgs, true);
server.tool('cabin_recent', '只读查看小屋最近 10 条已完成动作记录，用于回顾今天做过什么。', noArgs, async ({ key, token }) => {
  try {
    await authorizeSession(key, token, false);
    let rows = [];
    try { rows = fs.readFileSync(CABIN_LOG_JSONL, 'utf8').split(/\r?\n/).filter(Boolean); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const recent = rows.slice(-400).flatMap((line) => {
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
        return [{
          ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : null,
          name: String(row.name ?? '').slice(0, 40),
          kind: String(row.kind ?? '').slice(0, 40),
          label: String(row.label ?? '').slice(0, 120),
          text: String(row.text ?? '').slice(0, 200),
        }];
      } catch { return []; }
    }).slice(-10);
    return { content: [{ type: 'text', text: JSON.stringify({ records: recent }, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `读取小屋最近记录失败：${error?.message ?? error}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
