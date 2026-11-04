// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SENSITIVE_RE } from './sensitive.js';
import {
  AVATAR_AUDIT_PATH,
  AVATAR_STATE_PATH,
  AVATAR_WORK_DIR,
  avatarOptions,
  changeAvatar,
  isAvatarSessionAllowed,
  previewAvatar
} from './avatar-image.mjs';
import { resolveFfmpegPath } from './animated-image.mjs';

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

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
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

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.httpAccessToken || c.snowluma?.accessToken || ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 构造可选的“引用/回复”消息段：
// - 传了 replyToMessageId 时，在文本前追加 reply 段，让 QQ 显示“引用了某条消息”；
// - 使用结构化消息段而不是 CQ 码，避免注入；
// - replyToMessageId 必须是非零整数（字符串数字也接受；QQ 消息 id 可能为负数）。
function messageSegments(message, replyToMessageId) {
  const segments = [];
  const replyId = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
    ? String(replyToMessageId).trim()
    : null;
  if (replyId !== null) {
    if (!/^-?[1-9]\d*$/.test(replyId)) {
      throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    }
    segments.push({ type: 'reply', data: { id: replyId } });
  }
  segments.push({ type: 'text', data: { text: escapeCqText(String(message ?? '')) } });
  return segments;
}

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
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

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  return body;
}

async function douyinShareApi(init = {}) {
  const consoleToken = readConsoleToken();
  if (!consoleToken) throw new Error('本地控制台令牌不可用');
  const res = await fetch('http://127.0.0.1:3101/douyin/share-latest', {
    ...init,
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(200000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `抖音分享 API HTTP ${res.status}`);
  return body;
}

async function douyinBrowseApi(minutes) {
  const consoleToken = readConsoleToken();
  if (!consoleToken) throw new Error('本地控制台令牌不可用');
  let res;
  try {
    res = await fetch('http://127.0.0.1:3101/douyin/browse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ minutes }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    const code = error?.cause?.code ? ` (${error.cause.code})` : '';
    throw new Error(`本机抖音浏览接口未能接通${code}；浏览任务没有得到启动确认。请勿推断浏览器或视频状态。`);
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `抖音浏览 API HTTP ${res.status}`);
  return body;
}

async function douyinBrowseStatusApi(jobId) {
  const consoleToken = readConsoleToken();
  if (!consoleToken) throw new Error('本地控制台令牌不可用');
  let res;
  try {
    res = await fetch('http://127.0.0.1:3101/douyin/browse-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    const code = error?.cause?.code ? ` (${error.cause.code})` : '';
    throw new Error(`本机抖音浏览状态接口未能接通${code}；任务状态未知。`);
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `抖音浏览状态 API HTTP ${res.status}`);
  return body;
}

async function douyinInteractApi(payload) {
  const consoleToken = readConsoleToken();
  if (!consoleToken) throw new Error('本地控制台令牌不可用');
  const res = await fetch('http://127.0.0.1:3101/douyin/interact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(420_000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || `抖音互动 API HTTP ${res.status}`);
  return body;
}

async function authorizeRead(key, token) {
  await agentApi('/api/authorize/read', { method: 'POST', body: JSON.stringify({ key, token: token || undefined }) });
}

const OWNER_MEMORY_FILE = path.join(ROOT, 'state', 'owner-private-memory.json');
const OWNER_MEMORY_KEYS = { identity: 'identityFacts', fact: 'facts', event: 'events', correction: 'corrections' };

function readOwnerMemory() {
  if (!fs.existsSync(OWNER_MEMORY_FILE)) return { schemaVersion: 2 };
  const value = JSON.parse(fs.readFileSync(OWNER_MEMORY_FILE, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('主人私聊记忆格式无效，已拒绝覆盖');
  return value;
}

function writeOwnerMemory(memory) {
  fs.mkdirSync(path.dirname(OWNER_MEMORY_FILE), { recursive: true });
  const temp = `${OWNER_MEMORY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...memory, schemaVersion: 2 }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, OWNER_MEMORY_FILE);
}

function cleanOwnerMemoryText(value, label = '记忆内容') {
  const text = String(value ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim();
  if (!text || [...text].length > 400) throw new Error(`${label}需为 1 到 400 个字符`);
  return text;
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.1.0' });

server.tool(
  'douyin_browse_recommendations',
  '仅主人 QQ 私聊可用。启动一项后台抖音浏览任务：在普通“推荐”流只读浏览 1–5 分钟并记录实际播放的视频，不点赞、评论、关注或发送消息。此工具快速返回 jobId；必须接着用 douyin_browse_status 查询，status=running 时稍等后继续查询，直到 completed 或 failed。不要把任务已启动说成已浏览完成。',
  { key: z.string(), token: z.string(), minutes: z.number().int().min(1).max(5) },
  async ({ key, token, minutes }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('抖音浏览仅允许主人 QQ 私聊调用');
      await authorizeRead(key, token);
      const result = await douyinBrowseApi(minutes);
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, next: 'Use douyin_browse_status with this jobId until status is completed or failed.' }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `抖音浏览失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'douyin_browse_status',
  '仅主人 QQ 私聊可用。查询 douyin_browse_recommendations 返回的 jobId。status=running 时稍等后再次调用；只有 status=completed 且包含实际结果时才能说浏览完成。failed 时只转述 error，不推测浏览器、截图或视频状态。',
  { key: z.string(), token: z.string(), jobId: z.string().uuid() },
  async ({ key, token, jobId }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('抖音浏览状态仅允许主人 QQ 私聊查询');
      await authorizeRead(key, token);
      const result = await douyinBrowseStatusApi(jobId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `抖音浏览状态查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'douyin_interact_with_video',
  '仅主人 QQ 私聊可用。对一条明确指定的抖音标准视频页点赞或评论。目标可用 videoUrl，或用 videoTitle 从最近观看记录唯一定位；标题需足够具体，不能唯一匹配时工具会拒绝。主人明确要求/确认点赞时才能 action=like；评论必须逐字使用主人本轮明确给出的 commentText，不得自行编写。dryRun=true 只检查页面控件并验证输入框，不会点赞或提交评论；真正操作必须 dryRun=false。每次仅操作一条视频，不批量、不关注、不重试状态不明的操作。',
  {
    key: z.string(), token: z.string(), action: z.enum(['like', 'comment']),
    videoUrl: z.string().url().max(500).optional(), videoTitle: z.string().min(2).max(300).optional(),
    commentText: z.string().max(200).optional(),
    dryRun: z.boolean()
  },
  async ({ key, token, action, videoUrl, videoTitle, commentText, dryRun }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('抖音点赞/评论仅允许主人 QQ 私聊调用');
      await authorizeRead(key, token);
      if (Boolean(videoUrl) === Boolean(videoTitle)) throw new Error('videoUrl 和 videoTitle 必须且只能提供一个');
      if (action === 'comment' && !String(commentText ?? '').trim()) throw new Error('评论必须提供主人明确给出的原文');
      if (action === 'like' && commentText) throw new Error('点赞操作不能附带评论文案');
      const result = await douyinInteractApi({ action, videoUrl, videoTitle, commentText, dryRun });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `抖音互动失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'douyin_share_latest_watched_video',
  '仅主人 QQ 私聊可用。把大肥鱼实际刷到并记录的最新一条未分享视频，发到已核验的主人抖音会话。一次最多一条；受每日 5 条总上限和去重限制。主人明确说分享/发给我时调用；无观看记录或发送失败时如实说明，不要重试不确定的发送。',
  { key: z.string(), token: z.string() },
  async ({ key, token }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('抖音视频分享仅允许主人 QQ 私聊调用');
      await authorizeRead(key, token);
      const result = await douyinShareApi({ method: 'POST', body: JSON.stringify({}) });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分享最近刷到的抖音视频失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_owner_memory_query',
  '只读查询鲸团团与主人之间的私聊长期记忆，包含身份事实、事实、共同经历和纠错。仅主人私聊可用；不要把内容带入群聊。',
  { key: z.string(), token: z.string() },
  async ({ key, token }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('主人私聊记忆仅允许主人私聊查询');
      await authorizeRead(key, token);
      return { content: [{ type: 'text', text: JSON.stringify(readOwnerMemory(), null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `主人私聊记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_owner_memory_append',
  '仅当主人在当前私聊明确要求“记住/记一下”或明确纠正旧记忆时，写入主人私聊长期记忆。不得自动记录推测、群聊内容、密码、账号凭据、住址等敏感信息。纠错必须提供原记忆和更正后的事实。',
  {
    key: z.string(), token: z.string(),
    category: z.enum(['identity', 'fact', 'event', 'correction']),
    content: z.string().trim().min(1).max(400),
    replaces: z.string().trim().max(400).optional().describe('correction 时要替换的旧事实原文'),
    occurredAt: z.string().trim().max(32).optional().describe('只有主人明确提供事件发生时间时填写；不要推测')
  },
  async ({ key, token, category, content, replaces, occurredAt }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('主人私聊记忆仅允许主人私聊写入');
      await authorizeRead(key, token);
      const clean = cleanOwnerMemoryText(content);
      const previous = category === 'correction' ? cleanOwnerMemoryText(replaces, '待更正的旧记忆') : '';
      const keyName = OWNER_MEMORY_KEYS[category];
      const memory = readOwnerMemory();
      const entries = Array.isArray(memory[keyName]) ? [...memory[keyName]] : [];
      const matches = (item, value) => typeof item === 'string' ? item === value
        : item && typeof item === 'object' && [item.content, item.text, item.summary, item.fact, item.previous].some((candidate) => candidate === value);
      if (category === 'correction') {
        for (const oldKey of ['identityFacts', 'identity', 'facts', 'events', 'corrections']) {
          memory[oldKey] = (Array.isArray(memory[oldKey]) ? memory[oldKey] : []).filter((item) => !matches(item, previous));
        }
        const corrections = Array.isArray(memory.corrections) ? memory.corrections : [];
        const duplicate = corrections.some((item) => item && typeof item === 'object' && item.content === clean && item.previous === previous);
        memory.corrections = (duplicate ? corrections : [...corrections,
          { content: clean, previous, source: '主人明确纠正', confidence: 'confirmed', recordedAt: new Date().toISOString() }]).slice(-100);
      } else {
        const duplicate = entries.some((item) => matches(item, clean));
        if (!duplicate) entries.push({ content: clean, source: '主人明确要求记录', confidence: 'confirmed', recordedAt: new Date().toISOString(),
          ...(category === 'event' && occurredAt ? { occurredAt: cleanOwnerMemoryText(occurredAt, '事件时间') } : {}) });
        memory[keyName] = entries.slice(-100);
      }
      writeOwnerMemory(memory);
      return { content: [{ type: 'text', text: `主人私聊记忆已${category === 'correction' ? '更正' : '记录'}：${clean}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `主人私聊记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_owner_memory_remove',
  '仅主人明确要求忘记或删除某条私聊记忆时使用；精确删除匹配条目。仅主人私聊可用，不影响群聊记忆。',
  {
    key: z.string(), token: z.string(),
    category: z.enum(['identity', 'fact', 'event', 'correction']),
    content: z.string().trim().min(1).max(400)
  },
  async ({ key, token, category, content }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('主人私聊记忆仅允许主人私聊删除');
      await authorizeRead(key, token);
      const clean = cleanOwnerMemoryText(content);
      const memory = readOwnerMemory();
      const keyName = OWNER_MEMORY_KEYS[category];
      const entries = Array.isArray(memory[keyName]) ? memory[keyName] : [];
      const matches = (item) => typeof item === 'string' ? item === clean
        : item && typeof item === 'object' && [item.content, item.text, item.summary, item.fact, item.previous].some((candidate) => candidate === clean);
      const remaining = entries.filter((item) => !matches(item));
      const removed = remaining.length !== entries.length;
      memory[keyName] = remaining;
      writeOwnerMemory(memory);
      return { content: [{ type: 'text', text: removed ? `已从主人私聊记忆删除：${clean}` : '没有找到完全匹配的主人私聊记忆，未删除其他内容。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `主人私聊记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

async function qzoneTool(action, args) {
  try {
    const data = await agentApi('/api/qzone/tool', {
      method: 'POST', body: JSON.stringify({ action, ...args }), timeoutMs: ['post', 'replace'].includes(action) ? 80_000 : 25_000
    });
    return { content: [{ type: 'text', text: data.result }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `QQ 空间操作失败：${error?.message ?? error}` }], isError: true };
  }
}

server.tool('qq_post_qzone',
  '在自己的 QQ 空间发布一条完整说说。爸已授予持续权限，无需逐次批准；仅主人私聊会话可用。内容会经过公开文本检查、重复话题检查与发送后回读确认。不要把私聊、群聊原文或工具诊断直接公开；发送结果不确定时先查动态，不要立即重试。',
  { key: z.string().describe('当前主人私聊会话 key，格式 private:QQ号'), token: z.string().describe('当前会话令牌'), content: z.string().describe('要公开发布的完整说说正文') },
  (args) => qzoneTool('post', args));

server.tool('qq_list_my_qzone',
  '分页查看机器人自己最近发布的 QQ 空间说说。只返回摘要；先用此工具确定动态序号，再查看详情。仅主人私聊会话可用。',
  { key: z.string().describe('当前主人私聊会话 key'), token: z.string().describe('当前会话令牌'), page: z.number().int().min(1).max(11).optional().describe('页码，默认 1；每页 10 条') },
  (args) => qzoneTool('list', args));

server.tool('qq_qzone_detail',
  '查看机器人自己某条 QQ 空间说说的内容预览、评论及楼中楼。index 是 qq_list_my_qzone 给出的全局序号。仅主人私聊会话可用。',
  { key: z.string().describe('当前主人私聊会话 key'), token: z.string().describe('当前会话令牌'), index: z.number().int().min(1).max(110).describe('动态全局序号') },
  (args) => qzoneTool('detail', args));

server.tool('qq_comment_qzone',
  '回复机器人自己说说下的指定评论或楼中楼。先用 qq_qzone_detail 确认评论路径；路径如 1 或 1.1。仅主人私聊会话可用，回复内容最多 500 字。',
  { key: z.string().describe('当前主人私聊会话 key'), token: z.string().describe('当前会话令牌'), index: z.number().int().min(1).max(110).describe('动态全局序号'), path: z.string().regex(/^\d+(?:\.\d+)*$/).describe('评论路径，例如 1.1'), content: z.string().min(1).max(500).describe('回复正文') },
  (args) => qzoneTool('comment', args));

server.tool('qq_delete_my_qzone',
  '删除自己 QQ 空间的一条说说。爸已授予持续权限，无需逐次批准；仅主人私聊可用。必须先调用 qq_list_my_qzone/qq_qzone_detail 核实序号确属机器人自己的动态，再提供 index。删除不可撤销，不得删除他人动态。',
  { key: z.string().describe('当前主人私聊会话 key'), token: z.string().describe('当前会话令牌'), index: z.number().int().min(1).max(110).describe('从自己的动态列表确认的全局序号') },
  (args) => qzoneTool('delete', args));

server.tool('qq_replace_my_qzone',
  '修订自己 QQ 空间的一条旧说说。爸已授予持续权限，无需逐次批准；仅主人私聊可用。先按 index 读取并核实自己的旧动态，再发布新版本；只有新版本确认成功后才删除旧动态。平台没有原地改正文接口，所以这是先发新再删旧的替换。',
  { key: z.string().describe('当前主人私聊会话 key'), token: z.string().describe('当前会话令牌'), index: z.number().int().min(1).max(110).describe('从自己的动态列表确认的全局序号'), content: z.string().trim().min(1).describe('修订后的完整动态正文') },
  (args) => qzoneTool('replace', args));

server.tool(
  'qq_status',
  '仅主人私聊会话可查询 QQ 机器人登录状态与账号信息。群聊或非主人请求一律拒绝。',
  { key: z.string().describe('当前主人私聊会话 key，格式 private:主人QQ号'), token: z.string().describe('当前会话令牌') },
  async ({ key, token }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('QQ 状态仅允许主人私聊查询');
      await authorizeRead(key, token);
      const login = await onebot('get_login_info');
      let profile = {};
      try { profile = await onebot('get_stranger_info', { user_id: login.user_id, no_cache: true }); } catch {}
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: JSON.stringify({ ...login, nickname: profile.nickname || login.nickname, online: status.online, good: status.good }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_my_profile',
  '修改机器人当前登录 QQ 账号自己的昵称或个性签名。爸已授予持续权限，无需逐次批准；仅主人私聊可用。禁止修改爸或其他人的资料。',
  {
    key: z.string().describe('当前主人私聊会话 key，格式 private:主人QQ号'),
    token: z.string().describe('当前会话令牌'),
    nickname: z.string().trim().min(1).max(20).optional().describe('要设置的新昵称（1 至 20 字）'),
    personalNote: z.string().trim().min(1).max(30).optional().describe('要设置的新个性签名（1 至 30 字）')
  },
  async ({ key, token, nickname, personalNote }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('修改 QQ 资料仅允许主人私聊操作');
      if (!nickname && !personalNote) throw new Error('请至少提供昵称或个性签名其中一项');
      for (const [label, value, maxLength] of [['昵称', nickname, 20], ['签名', personalNote, 30]]) {
        if (value && ([...value].length > maxLength || /[\r\n\u0000-\u001f]/.test(value))) {
          throw new Error(`${label}长度需为 1 到 ${maxLength} 个字符，且不能包含换行或控制字符`);
        }
      }
      await authorizeRead(key, token);
      await onebot('set_qq_profile', {
        ...(nickname ? { nickname } : {}),
        ...(personalNote ? { personal_note: personalNote } : {})
      });
      return { content: [{ type: 'text', text: `资料修改已由 OneBot 确认成功：${nickname ? `昵称「${nickname}」` : ''}${nickname && personalNote ? '，' : ''}${personalNote ? `签名「${personalNote}」` : ''}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `修改 QQ 资料失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 个人头像（P0）：仅主人私聊；只接受本机图库/表情/内置形象/指定消息 ──────
// 不暴露 URL 来源；旧头像备份失败即中止；真正上传前必须经过预览或 confirm=true。
function avatarReadMessageFor(key, token) {
  return async (messageId) => {
    const q = new URLSearchParams({ key, messageId: String(messageId) });
    const data = await agentApi(`/api/images/message?${q.toString()}`, {
      headers: token ? { 'x-agent-token': token } : {},
      timeoutMs: 180000
    });
    const images = Array.isArray(data?.images) ? data.images : [];
    const image = images.find((item) => item?.data && item?.mimeType);
    if (!image) throw new Error(data?.note || '这条消息里没有可用的图片');
    return { data: image.data, mimeType: image.mimeType };
  };
}

async function fetchAvatarBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) throw new Error('下载到的旧头像为空或过小');
  return buffer;
}

function avatarQuotaText(quota) {
  if (!quota || typeof quota !== 'object') return '';
  if (!quota.ok) return `\n配额提示：${quota.reason}`;
  return quota.remaining == null ? '' : `\n今日剩余次数：${quota.remaining}`;
}

server.tool(
  'qq_set_my_avatar',
  '修改机器人当前登录 QQ 自己（鲸团团）的个人头像。仅主人 QQ 私聊可用，群聊与非主人私聊一律拒绝。图片来源只允许四类：archive=本机图库里的 imageId（如 2026-11-01/aa8faf3e18fbad42.gif）、sticker=收藏表情 id、self=内置形象 deepseek娘.png、message=当前会话中指定 messageId 的图片；不接受任何外部 URL，也不能拿群友或他人的图片。两段式：先不带 confirm（或 dryRun=true）只做预览，得到主人本轮明确确认后再带 confirm=true 才会真正更换。真正更换前会先把旧头像备份到 state/avatar-history/，备份失败即中止；只有工具返回成功后才可以声称头像已更换。',
  {
    key: z.string().describe('当前主人私聊会话 key，格式 private:主人QQ号'),
    token: z.string().describe('当前会话令牌'),
    sourceType: z.enum(['archive', 'sticker', 'self', 'message']).describe('图片来源类型'),
    imageId: z.string().optional().describe('archive 来源必填：图库里的“日期/文件名”'),
    stickerId: z.string().optional().describe('sticker 来源必填：收藏表情 id 或图库文件名'),
    messageId: z.union([z.number(), z.string()]).optional().describe('message 来源必填：当前会话里带图片的消息 id'),
    confirm: z.boolean().optional().default(false).describe('主人明确确认后才传 true；否则只预览'),
    dryRun: z.boolean().optional().default(false).describe('true 时只预览，绝不更换头像')
  },
  async ({ key, token, sourceType, imageId, stickerId, messageId, confirm, dryRun }) => {
    try {
      if (!isOwnerPrivateSession(key)) throw new Error('换头像仅允许主人私聊操作，群聊与非主人一律拒绝');
      const current = getConfig();
      if (!isAvatarSessionAllowed(key, current)) throw new Error('换头像仅允许主人私聊操作，群聊与非主人一律拒绝');
      const options = avatarOptions(current.imageAvatar);
      if (!options.enabled) throw new Error('换头像功能未启用');
      if (sourceType === 'archive' && !String(imageId ?? '').trim()) {
        throw new Error('sourceType=archive 时必须提供 imageId（形如 2026-11-01/aa8faf3e18fbad42.gif）');
      }
      if (sourceType === 'sticker' && !String(stickerId ?? '').trim()) {
        throw new Error('sourceType=sticker 时必须提供 stickerId');
      }
      if (sourceType === 'message' && String(messageId ?? '').trim() === '') {
        throw new Error('sourceType=message 时必须提供 messageId');
      }
      await authorizeRead(key, token);

      const deps = {
        uin: current.selfQQ || current.ownerQQ,
        readMessage: avatarReadMessageFor(key, token),
        fetchAvatar: fetchAvatarBytes,
        upload: async (b64) => { await onebot('set_qq_avatar', { file: `base64://${b64}` }); },
        ffmpegPath: resolveFfmpegPath(options.ffmpegPath),
        statePath: AVATAR_STATE_PATH,
        auditPath: AVATAR_AUDIT_PATH,
        workRoot: AVATAR_WORK_DIR,
        now: () => Date.now()
      };
      const input = { sourceType, imageId, stickerId, messageId };

      // 预览分支：dryRun 或未确认。只读配额，不备份、不上传、不写配额。
      if (dryRun || (options.requireConfirm && !confirm)) {
        const preview = await previewAvatar({ input, options, deps });
        if (!preview.ok) {
          return { content: [{ type: 'text', text: `换头像预览失败（阶段：${preview.stage}）：${preview.reason}。未更换头像。` }], isError: true };
        }
        const p = preview.preview;
        const quotaLine = preview.quota?.ok === false
          ? `当前配额：${preview.quota.reason}`
          : `当前配额：今日剩余 ${preview.quota?.remaining ?? options.dailyLimit} 次`;
        return {
          content: [{
            type: 'text',
            text: [
              '换头像预览（未执行，头像没有变化）：',
              `来源：${p.ref}`,
              `原图：${String(p.format).toUpperCase()}，${Math.round(p.inputBytes / 1024)} KB，${p.animated ? '动图，只取首帧' : '静态图'}`,
              `将上传：JPEG ${p.width}×${p.height}，${Math.round(p.outputBytes / 1024)} KB`,
              quotaLine,
              '得到主人本轮明确同意后，再以 confirm=true 调用本工具才会真正更换；dryRun=true 永远只预览。'
            ].join('\n')
          }]
        };
      }

      const result = await changeAvatar({ input, options, deps });
      if (!result.ok) {
        return {
          content: [{
            type: 'text',
            text: `换头像失败（阶段：${result.stage}）：${result.reason}。头像未确认更换，不要对外声称已换。${result.backupPath ? `\n旧头像备份：${result.backupPath}` : ''}`
          }],
          isError: true
        };
      }
      return {
        content: [{
          type: 'text',
          text: `头像已更换成功：来源 ${result.preview.ref}，JPEG ${result.preview.width}×${result.preview.height}，${Math.round(result.preview.outputBytes / 1024)} KB。${result.preview.animated ? '（原图为动图，只用了首帧）' : ''}\n旧头像已备份：${result.backupPath}${avatarQuotaText(result.quota)}`
        }]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `换头像失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  { key: z.string().optional().describe('当前会话 key（reserved2 模式必填）'), token: z.string().optional().describe('当前会话令牌（reserved2 模式必填）') },
  async ({ key, token }) => {
    let reserved2 = false;
    try {
      const status = await agentApi('/api/status');
      if (status?.mode === 'reserved2') {
        reserved2 = true;
        if (!key || !token) throw new Error('请提供当前会话 key 和 token');
        await authorizeRead(key, token);
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => (reserved2 && a.allowGroups.length === 0 && !a.denyGroups.map(String).includes(String(g.group_id))) || isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), token: z.string().optional().describe('当前会话令牌（reserved2 模式必填）') },
  async ({ groupId, token }) => {
    const g = String(groupId);
    const a = getAccess();
    if (a.allowGroups.length && !isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`, token); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）'), token: z.string().optional().describe('当前会话令牌（reserved2 模式必填）') },
  async ({ groupId, messageSeq, token }) => {
    const g = String(groupId);
    const a = getAccess();
    if (a.allowGroups.length && !isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`, token); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。只有主人为来源会话单独配置跨会话发送权限时，才可用当前来源会话令牌向其他白名单好友发送。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。若当前来源会话获准跨会话访问，响应还会列出可查看、可发送的私聊白名单会话。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看指定会话的未读消息（只读，不自动标记已读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'), limit: z.number().optional().describe('最多返回条数，默认 30，最大 100') },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。普通会话只能查看自己的记录；被主人单独授权跨会话查看时，可把 qq_get_prompt 返回的 crossSessionAccess.privateSessions 中的私聊 key 与当前来源会话 token 一起使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话的当前未读消息标记为已读（用于“看过但决定不回复”后避免重复未读）。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待群友消息：可指定“静默窗口”来判断对方是否说完了。收到新消息后如果还想要更多上下文，设置 quietMs（例如 10000~20000）继续等一小段没有新消息的时间；桥接会强制至少等后台“收到新消息后最小静默”（默认 10000ms=10 秒）再返回，防止抢话。返回 timeout=true 表示这段时间内没有等到新消息/没人说话，这不是错误；可以再用 qq_get_unread_messages / qq_get_recent_messages 查看是否有新消息，再决定继续等、发言或潜水。沉睡前观察：准备设置潜水/下一次唤醒前，必须用 timeoutMs=300000 发起一次完整观察（短等待不会满足沉睡前观察）。如果全程没人说话，返回 preSleepWaitSatisfied=true；如果等待期间等到新消息，会返回 preSleepWaitObserved=true 和 newMessages，表示你已完成一次沉睡前观察，查看后认为不需要你参与即可直接设置潜水。响应里还会给出 preSleepWaitRemainingMs，帮助你判断还差多久。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    timeoutMs: z.number().optional().describe('总等待毫秒数；普通等待默认 30000，沉睡前观察请传 300000（最大 600000）'),
    minNewMessages: z.number().optional().describe('至少等到多少条新消息才提前返回，默认 1'),
    quietMs: z.number().optional().describe('检测到新消息后继续等待的静默窗口（毫秒），用于判断对方是否说完了；建议 8000~12000，默认取 socialV2.wait.defaultQuietMs（当前 8000）')
  },
  async ({ key, token, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id 查看单条消息的完整内容、发送者、引用信息（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        if (refresh) q.set('refresh', '1');
        const data = await agentApi(`/api/socialV2/sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 本地表情包（表情包集目录下的分类 GIF） ──────────────────────────────────
if (cfg.socialV2?.stickerPack?.enabled !== false && cfg.socialV2?.tools?.listLocalStickers !== false) {
  server.tool(
    'qq_list_local_stickers',
    '列出你本地表情包集里的表情包（按分类组织的 GIF）。每个分类一个表情，带标签 label 与适用场景 hint。可通过 query 按标签/场景搜索；没有把握用哪个时，先 qq_get_local_sticker_image 看图确认再决定。这是本地表情包，与 QQ 收藏表情（qq_list_stickers）不同。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('按标签/场景搜索，例如“怼人”“撒娇”“熬夜”；留空列出全部'),
      count: z.number().optional().describe('最多返回条数，默认 48')
    },
    async ({ key, token, query, count }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        const data = await agentApi(`/api/socialV2/local-sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取本地表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.tools?.listArchiveImages !== false) {
  server.tool(
    'qq_list_archive_images',
    '搜索主人本地归档图片库并返回图片编号、描述和标签。仅主人私聊可用。主人要求发壁纸/图库图片时，先用本工具查找；如描述不足，再用 qq_get_archive_image 预览。imageId 格式为“日期/文件名”，后续发送时必须原样使用。',
    {
      key: z.string().describe('当前主人私聊会话 key，格式 private:QQ号'),
      token: z.string().describe('当前会话令牌'),
      query: z.string().optional().describe('按描述、标签或图片编号搜索，例如“壁纸”“风景”“蓝色”'),
      days: z.number().int().min(1).max(3650).optional().describe('搜索最近多少天，默认 90 天'),
      count: z.number().int().min(1).max(40).optional().describe('最多返回几张，默认 20 张')
    },
    async ({ key, token, query, days, count }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (days != null) q.set('days', String(days));
        if (count != null) q.set('count', String(count));
        const data = await agentApi(`/api/socialV2/archive-image-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取归档图库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.tools?.getArchiveImage !== false) {
  server.tool(
    'qq_get_archive_image',
    '读取主人本地归档图库中的一张图片并以图像内容返回，供视觉模型预览。仅主人私聊可用。imageId 必须来自 qq_list_archive_images；本工具只预览，不会发送到 QQ。',
    {
      key: z.string().describe('当前主人私聊会话 key，格式 private:QQ号'),
      token: z.string().describe('当前会话令牌'),
      imageId: z.string().describe('qq_list_archive_images 返回的编号，格式 日期/文件名')
    },
    async ({ key, token, imageId }) => {
      try {
        const q = new URLSearchParams({ key, imageId: String(imageId) });
        const data = await agentApi(`/api/socialV2/archive-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        if (!data?.image?.data || !data?.image?.mimeType) return { content: [{ type: 'text', text: `图库图片无法预览：${data?.error || '未知错误'}` }], isError: true };
        return { content: [
          { type: 'text', text: `图库图片预览 ${data.image.id}：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取图库图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.tools?.sendArchiveImage !== false) {
  server.tool(
    'qq_send_archive_image',
    '把主人本地归档图库中的一张图片作为真实 QQ 图片发送到当前主人私聊。仅主人私聊可用；imageId 必须来自 qq_list_archive_images。发送前应确认图片符合当前请求，不能把图库内容批量发送。',
    {
      key: z.string().describe('当前主人私聊会话 key，格式 private:QQ号'),
      token: z.string().describe('当前会话令牌'),
      imageId: z.string().describe('要发送的图片编号，格式 日期/文件名，来自 qq_list_archive_images')
    },
    async ({ key, token, imageId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-archive-image', {
          method: 'POST', body: JSON.stringify({ key, imageId: String(imageId) }),
          headers: { 'x-agent-token': token }, timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图库图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.stickerPack?.enabled !== false && cfg.socialV2?.tools?.getLocalStickerImage !== false) {
  server.tool(
    'qq_get_local_sticker_image',
    '获取指定本地表情包的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_local_stickers 返回的表情你拿不准实际长什么样、或想确认表情内容时才调用。stickerId 用 qq_list_local_stickers 返回的 id（形如 local:装可怜）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('本地表情标识：qq_list_local_stickers 返回的 id（如 local:装可怜）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/local-sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `本地表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `本地表情 ${data.sticker?.label || stickerId}${data.sticker?.hint ? '（适用：' + data.sticker.hint + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取本地表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.stickerPack?.enabled !== false && cfg.socialV2?.tools?.sendLocalSticker !== false) {
  server.tool(
    'qq_send_local_sticker',
    '在指定会话发送一个本地表情包（表情包集里的分类 GIF）。stickerId 用 qq_list_local_stickers 返回的 id（形如 local:装可怜）。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('本地表情标识：qq_list_local_stickers 返回的 id（如 local:装可怜）'),
      replyToMessageId: z.string().optional().describe('要引用的消息 id（可选；来自 qq_get_message_detail 的 messageId）'),
      atUserId: z.string().optional().describe('要 @ 的 QQ 号（可选，仅群聊）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-local-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送本地表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
