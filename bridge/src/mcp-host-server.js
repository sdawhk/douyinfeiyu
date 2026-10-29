// SnowLuma 进程管理 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行），
// 给 agent 提供 SnowLuma 网关的状态查询与启停工具。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（HTTP get_login_info）
//   start_snowluma    —— 未运行时启动 launcher.bat 并等待网关就绪（最长 90s）
//   stop_snowluma     —— 停止 SnowLuma（按安装目录匹配进程）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const launcher = c.snowluma?.launcherPath ?? '';
  return {
    httpUrl,
    httpPort: new URL(httpUrl).port || '80',
    token: c.snowluma?.httpAccessToken || c.snowluma?.accessToken || '',
    launcher,
    homeDir: c.snowluma?.homeDir ?? (launcher ? path.dirname(launcher) : ''),
    // 进程控制默认关闭：只有 config.json 显式设置 snowluma.allowProcessControl=true 才允许启停
    allowProcessControl: c.snowluma?.allowProcessControl === true
  };
}

function getConsolePort() {
  try {
    const c = getConfig();
    return Number(c.consolePort) || 3100;
  } catch {
    return 3100;
  }
}

function readConsoleToken() {
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function isOwnerPrivateSession(key) {
  const match = /^private:(\d+)$/.exec(String(key ?? '').trim());
  if (!match) return false;
  const c = getConfig();
  const owners = (Array.isArray(c.ownerQQs) && c.ownerQQs.length ? c.ownerQQs : [c.ownerQQ])
    .filter((id) => id != null && String(id).trim())
    .map(String);
  return owners.includes(match[1]);
}

// 桥接只为主人私聊会话签发此类令牌，群聊令牌不能查询状态或控制进程。
async function bridgeAllowsOwnerPrivateToken(token) {
  try {
    const consoleToken = readConsoleToken();
    const res = await fetch(`http://127.0.0.1:${getConsolePort()}/api/authorize/process-control`, {
      headers: { 'x-console-token': consoleToken, 'x-agent-token': String(token || '') },
      signal: AbortSignal.timeout(5000)
    });
    return res.ok && (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

// 进程控制（启停/查 PID）依赖 Windows 的 powershell / taskkill。
// 非 Windows 宿主（本机：Android/Linux 的 DSH）上没有这些命令，
// SnowLuma 也不会跑在本机（它是 Windows 客户端），因此这里统一失败关闭：
// 只保留 snowluma_status 的 HTTP 探活（可探本机或局域网内的 Windows 网关）。
const PROCESS_CONTROL_SUPPORTED = process.platform === 'win32';

function findSnowLumaPids() {
  if (!PROCESS_CONTROL_SUPPORTED) return [];
  // 先按 OneBot HTTP 端口找监听进程，再用安装目录过滤命令行，
  // 避免误杀恰好占用同一端口的其他进程。
  const { httpPort, homeDir } = getHostConfig();
  const portNum = Number(httpPort);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return [];
  const pids = new Set();
  try {
    const byPort = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${portNum} } | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', byPort], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    for (const s of out.split(/\s+/)) {
      const n = Number(s.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } catch {}
  const home = String(homeDir || '').toLowerCase().replace(/\\/g, '/');
  const result = [];
  for (const pid of pids) {
    try {
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
      const cmdLower = String(cmd || '').toLowerCase().replace(/\\/g, '/');
      if (home && cmdLower.includes(home)) result.push(pid);
    } catch {
      // 拿不到命令行时宁可不杀，避免误伤
    }
  }
  return result;
}

const server = new McpServer({ name: 'snowluma-host', version: '0.1.0' });

server.tool(
  'snowluma_status',
  '仅主人私聊可查询 SnowLuma OneBot 网关状态与账号信息；群聊和其他人无权查看。',
  { key: z.string().describe('当前主人私聊会话 key，格式 private:主人QQ号'), token: z.string().describe('当前会话令牌') },
  async ({ key, token }) => {
    if (!isOwnerPrivateSession(key) || !(await bridgeAllowsOwnerPrivateToken(token))) {
      return { content: [{ type: 'text', text: '拒绝：仅主人私聊可查询 SnowLuma 状态。' }], isError: true };
    }
    const info = await gatewayInfo();
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }]
    };
  }
);

if (getHostConfig().allowProcessControl && PROCESS_CONTROL_SUPPORTED) {
  server.tool(
    'start_snowluma',
    '启动 SnowLuma（launcher.bat，独立窗口）并等待 OneBot 网关就绪，最长 90 秒。已在运行时直接返回当前状态。',
    { token: z.string().describe('主人私聊会话令牌') },
    async ({ token }) => {
      const hc = getHostConfig();
      if (!hc.launcher) {
        return { content: [{ type: 'text', text: '拒绝：未配置 snowluma.launcherPath。' }], isError: true };
      }
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeAllowsOwnerPrivateToken(token))) {
        return { content: [{ type: 'text', text: '拒绝：仅主人私聊会话可控制进程。' }], isError: true };
      }
      const before = await gatewayInfo();
      if (before.reachable && before.online) {
        return { content: [{ type: 'text', text: JSON.stringify({ started: false, alreadyOnline: true, info: before }) }] };
      }
      let spawnError = null;
      const child = spawn('cmd.exe', ['/c', 'start', '', `"${hc.launcher}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => { spawnError = err; });
      child.unref();
      let info = null;
      for (let i = 0; i < 45; i += 1) {
        if (spawnError) {
          return { content: [{ type: 'text', text: `启动失败：${spawnError?.message ?? spawnError}` }], isError: true };
        }
        await sleep(2000);
        info = await gatewayInfo();
        if (info.reachable && info.online) {
          return { content: [{ type: 'text', text: JSON.stringify({ started: true, readyAfterMs: (i + 1) * 2000, info }) }] };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ started: false, timeout: true, lastInfo: info ?? before }) }] };
    }
  );

  server.tool(
    'stop_snowluma',
    '停止 SnowLuma 进程（按安装目录匹配 node 进程后 taskkill）。谨慎使用：会断开当前 QQ 连接。',
    { token: z.string().describe('主人私聊会话令牌') },
    async ({ token }) => {
      const hc = getHostConfig();
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeAllowsOwnerPrivateToken(token))) {
        return { content: [{ type: 'text', text: '拒绝：仅主人私聊会话可控制进程。' }], isError: true };
      }
      const pids = findSnowLumaPids();
      if (pids.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ stopped: false, reason: 'no process found' }) }] };
      }
      const killed = [];
      for (const pid of pids) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
          killed.push(pid);
        } catch (error) {
          // 进程可能已退出
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true, killed }) }] };
    }
  );
}

await server.connect(new StdioServerTransport());
