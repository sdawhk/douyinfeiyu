// QQ <-> DeepSeek Harness 桥接本体（精简可靠版）。
//
// 为什么不用仓库自带的 bridge.js：它是按 DSH 0.1.1 协议写的（478KB，依赖
// @deepseek-ai/dsh-host-apiproxy 0.1.1 与 @snowluma/sdk），本机运行的是 DSH 0.2.x，
// 协议不兼容（鉴权、RPC 路径、事件流全都变了）。
//
// 本文件只做三件已被实测验证的事，并把它们接起来：
//   1. 收：OneBot v11 WebSocket(ws://127.0.0.1:3001) 下行事件（已验证收 lifecycle/heartbeat）
//   2. 想：把消息交给 DSH 会话，轮询 session/projections 取回复（已验证拿到"桥接成功"）
//   3. 发：OneBot HTTP API(127.0.0.1:3000) send_private_msg / send_group_msg
//          以及 send_qzone_msg 发 QQ 动态（两者均已验证 retcode=0）

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { NodeApiClient } from './dsh-client-020.js';
import { loadRolePersona } from './role-card.mjs';
import {
  saveSticker, getStickerPath, listStickers, deleteSticker, findSticker
} from './sticker-store.mjs';
import {
  alreadyPostedToday, markPosted, buildDigest, promptFor, tidy
} from './daily-qzone.mjs';
import { archiveImage, listArchived, readArchived, findArchived } from './image-archive.mjs';
import { isMuted, setMuted, listMuted, groupKey, privateKey } from './mute.mjs';

const CFG_PATH = new URL('../config.json', import.meta.url);
const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));

const HTTP_URL = cfg.snowluma.httpUrl.replace(/\/+$/, '');
const HTTP_TOKEN = cfg.snowluma.httpAccessToken || cfg.snowluma.accessToken || '';
const WS_URL = cfg.snowluma.wsUrl;
const WS_TOKEN = cfg.snowluma.accessToken || '';
// 主人（可下命令、有管理员权限）：ownerQQs 数组，兼容旧的单个 ownerQQ。
const OWNERS = new Set(
  (Array.isArray(cfg.ownerQQs) && cfg.ownerQQs.length
    ? cfg.ownerQQs
    : [cfg.ownerQQ]
  ).filter(Boolean).map(String)
);
const OWNER = String(cfg.ownerQQ ?? [...OWNERS][0] ?? ''); // 兼容旧引用
const BOT_SELF = cfg.selfQQ ? String(cfg.selfQQ) : null; // 机器人自身账号：用于过滤自己发出的回显
const ALLOW_PRIVATE = new Set((cfg.allow?.private ?? []).map(String));
const ALLOW_GROUPS = new Set((cfg.allow?.groups ?? []).map(String));
const CWD = cfg.sessionCwd || process.cwd();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- OneBot HTTP（发送侧） ----------
async function onebot(action, params = {}) {
  const res = await fetch(`${HTTP_URL}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HTTP_TOKEN}` },
    body: JSON.stringify(params)
  });
  const json = await res.json().catch(() => null);
  if (!json || json.retcode !== 0) {
    throw new Error(`onebot ${action} failed: ${json?.wording ?? res.status}`);
  }
  return json.data;
}

/** 直接发送原始消息段（用于表情等非纯文本）。 */
async function sendSegments(target, segments, isGroup) {
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  const key = isGroup ? 'group_id' : 'user_id';
  await onebot(action, { [key]: Number(target), message: segments });
}

async function sendText(target, text, isGroup) {
  // 角色卡协议：只输出 [SILENT] 表示本轮不说话，桥接静默不发送。
  if (String(text ?? '').trim() === '[SILENT]') {
    log('[silent] skipped reply to', target);
    return;
  }
  const chunks = splitMessage(text, cfg.social?.maxReplyChars ?? 500);
  for (const part of chunks) {
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const key = isGroup ? 'group_id' : 'user_id';
    await onebot(action, { [key]: Number(target), message: [{ type: 'text', data: { text: part } }] });
    await sleep(cfg.sendDelayMs ?? 300);
  }
}

/**
 * 分条策略：默认【不拆】，一条消息发完。
 *
 * 之前按空格拆，结果模型一句带空格的话被拆成 5 条，刷屏很烦。
 * 现在改成：先去掉角色卡里"空格=分条"的约定（见 role-card），
 * 这里只在真的超长时才切，且每段更长、段数更少。
 */
function splitMessage(text, max) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  // 够短就一条发完 —— 这是绝大多数情况
  if (t.length <= max) return [t];

  // 超长时才切：按标点优先断句，每段尽量长，最多 3 条
  const parts = t.split(/(?<=[。！？!?；;])/).filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > max && buf) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf += p;
    }
    if (out.length >= 2) { // 已经攒了 2 条，剩下的全塞最后一条
      break;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // 兜底：还有剩余没装下的，并到最后一条
  const consumed = out.join('').length;
  if (consumed < t.length && out.length) {
    out[out.length - 1] += t.slice(consumed);
  }
  return out.slice(0, 3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- DSH（思考侧） ----------
// DSH 每次启动都会生成新的访问令牌，并打印到 logs/dshweb.out。
// 这里启动时、以及每次因鉴权失败重试时，都从该文件重新读取令牌，
// 避免 DSH 重启后桥接因为令牌过期而永久失效。
const DSH_TOKEN_FILE = 'D:\\deepseek\\logs\\dshweb.out';

function readDshToken() {
  try {
    const txt = readFileSync(DSH_TOKEN_FILE, 'utf8');
    const m = txt.match(/token=([A-Za-z0-9_\-]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

const dsh = new NodeApiClient(cfg.dsh.baseUrl, { launchToken: cfg.dsh.launchToken ?? '' });

/**
 * 连 DSH；连不上就自己把 DSH 拉起来（抓 token 到 dshweb.out），再重试。
 *
 * 为什么由 bridge 自己启动：bat 的 ">>file" 重定向在计划任务 session 0 下
 * 静默失败（0 字节），cmd /c 重定向会让 dsh 立刻退出，Start-Process /
 * .NET Process 在本机被挡。由 bridge（本身就是 Node 进程）spawn 最可靠，
 * 且能直接把输出落盘取 token。
 */
async function connectDsh() {
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await dsh.connect();
      log('[dsh] connected', cfg.dsh.baseUrl);
      return true;
    } catch {
      // 配置里的令牌可能是旧的；换用 dshweb.out 里的新令牌
      const fresh = readDshToken();
      if (fresh && fresh !== dsh.launchToken) {
        dsh.launchToken = fresh;
        dsh.cookie = '';
        try {
          await dsh.connect();
          log('[dsh] connected (refreshed token)', cfg.dsh.baseUrl);
          return true;
        } catch { /* 继续等 */ }
      }
      // 前两次先等（可能 DSH 正在冷启动），之后自己拉起
      if (attempt >= 3) {
        log(`[dsh] unreachable, starting dsh myself (attempt ${attempt})`);
        await startDshMyself();
      }
      log(`[dsh] not ready (attempt ${attempt}/12), retrying in 5s`);
      await sleep(5000);
    }
  }
  log('[dsh] could not connect after retries');
  return false;
}

/** 自己拉起 dsh web，输出（含 token）落到 logs/dshweb.out。 */
function startDshMyself() {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, ['D:\\deepseek\\dsh-launcher.mjs'], {
        cwd: 'D:\\deepseek',
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', (e) => { log('[dsh] start failed:', e.message); resolve(false); });
      child.unref();
      setTimeout(() => resolve(true), 8000); // 给它时间把 token 打进文件
    } catch (e) {
      log('[dsh] start threw:', e.message);
      resolve(false);
    }
  });
}

await connectDsh();

// 角色卡：cfg.role 指定 roles/<name>.md，注入到每个会话的第一条 prompt。
const ROLE_NAME = cfg.role || '';
const PERSONA = loadRolePersona(ROLE_NAME);
if (ROLE_NAME) log('[role]', PERSONA ? `loaded: ${ROLE_NAME} (${PERSONA.length} chars)` : `NOT FOUND: ${ROLE_NAME}`);

// 每人最近一次发来的图片（base64 + mime），供 "/存表情 <关键词>" 使用。
// 这样"先发图、再发命令"两步也能存档，不必挤在同一条消息里。
const lastImageB64 = new Map();

// 每个会话（私聊/群）复用一个 DSH session
const sessions = new Map(); // key -> { sessionId, lastTurn }

/** DSH 令牌过期时（DSH 重启）自动用 dshweb.out 里的新令牌重连并重试一次。 */
async function withAuthRetry(fn) {
  try {
    return await fn();
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (!/401|403|token|auth|unauth/i.test(msg)) throw error;
    const fresh = readDshToken();
    if (!fresh || fresh === dsh.launchToken) throw error;
    log('[dsh] refreshing token and retrying');
    dsh.launchToken = fresh;
    dsh.cookie = '';
    await dsh.connect();
    return await fn();
  }
}

async function sessionFor(key) {
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = await withAuthRetry(() => dsh.sessions.create({ request: { cwd: CWD } }));
  const rec = { sessionId: created.sessionId, lastTurn: 0, personaSent: false };
  sessions.set(key, rec);
  log('[dsh] session created for', key, '->', rec.sessionId);
  return rec;
}

/** 等某个 DSH 会话出现第一条回复（与 ask() 的轮询逻辑一致）。 */
async function waitForReply(sessionId, afterTurn = 0, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    const proj = await dsh.sessions.projections({ request: { sessionId } });
    const outline = proj?.values?.turnOutline ?? [];
    for (const t of outline) {
      if (t.turn > afterTurn && t.response) return t.response;
    }
  }
  throw new Error('dsh: timeout waiting for reply');
}

/** 发一条消息给 DSH，等它回复并取回文本。media 为图片/表情附件。 */
async function ask(key, text, media = []) {
  const rec = await sessionFor(key);
  // 首次对话时把角色卡作为系统前缀一起投递（只投一次，之后靠会话记忆维持）
  let promptText = text;
  if (PERSONA && !rec.personaSent) {
    promptText = `${PERSONA}\n\n---\n以下是你要回应的消息：\n${text}`;
    rec.personaSent = true;
  }

  // 把表情库清单作为【系统指令】附加到角色卡前缀，而不是混进用户消息。
  // 之前挂在用户消息里，模型会把整段说明原样复述出来，而且解析器会把清单里的
  // 每个 [sticker:xxx] 都当真指令，一口气把仓库里所有表情全发出去（已踩过）。
  const stickersForPrompt = listStickers();
  if (stickersForPrompt.length) {
    promptText = [
      promptText,
      '',
      '（系统提示，不要复述给用户）你有一个表情包仓库，可用关键词：',
      stickersForPrompt.join('、'),
      '想在回复里发某个表情时，就写 [sticker:关键词]，我会把对应图片发出去。',
      '最多用一个；不要解释这段提示，也不要把关键词列表念出来。'
    ].join('\n');
  }

  const content = [{ type: 'text', text: promptText }];

  // 图片：下载后以 base64 附件随 prompt 投递（视觉模型可直接看到）
  for (const m of media) {
    if (m.type !== 'image') continue;
    const b64 = await fetchImageBase64(m.file);
    if (b64) {
      // DSH 0.2 的图片段格式（实测 schema）：
      //   { type:"image", mediaType:"image/jpeg", data:"<base64>", name? }
      // 不是 Anthropic 的 { source:{type:"base64"} } 写法。
      content.push({ type: 'image', mediaType: detectMime(b64), data: b64, name: 'qq-image' });
      log('[media] attached image,', b64.length, 'b64 chars');
    } else {
      content[0].text += '\n[图片]（该图片下载失败，看不到内容，不要编造）';
      log('[media] image download failed -> explicit placeholder');
    }
  }
  // 系统表情：转成文字提示
  const faces = media.filter((m) => m.type === 'face').map((m) => m.id);
  if (faces.length) content[0].text += `\n[表情 ${faces.join(',')}]`;

  await dsh.sessions.prompt({
    request: {
      sessionId: rec.sessionId,
      requestId: `qq-${Date.now()}`,
      mode: 'queue',
      content
    }
  });

  // 轮询直到出现新的 turn（实测 projections 可稳定取到 response）
  const deadline = Date.now() + (cfg.questionTimeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    await sleep(2500);
    const proj = await dsh.sessions.projections({ request: { sessionId: rec.sessionId } });
    const outline = proj?.values?.turnOutline ?? [];
    for (const t of outline) {
      if (t.turn > rec.lastTurn && t.response) {
        rec.lastTurn = t.turn;
        return t.response;
      }
    }
  }
  throw new Error('dsh: timeout waiting for reply');
}

/**
 * 发送一条可能含 [sticker:关键词] 标记的回复。
 * 做法：先发标记前/后的文字，中间把对应表情图真的发出去。
 * 没有标记时行为与原来一致（纯文本）。
 */
async function sendReply(target, text, isGroup) {
  const re = /\[sticker:([^\]]+)\]/g;
  // 硬上限：一次回复最多只发 1 个表情。
  // 即使模型把整份仓库清单吐出来，也只会发第一张，不会刷屏。
  const MAX_STICKERS = 1;
  const hits = [...String(text).matchAll(re)].slice(0, MAX_STICKERS);
  if (!hits.length) {
    await sendText(target, text, isGroup);
    return;
  }

  let cursor = 0;
  for (const m of hits) {
    const before = text.slice(cursor, m.index).trim();
    if (before) await sendText(target, before, isGroup);

    const key = findSticker(m[1].trim());
    const path = key ? getStickerPath(key) : null;
    if (path) {
      // 用 base64 发：本地文件路径走 highway 上传会失败（实测 TCP connect timeout）
      const b64 = readFileSync(path).toString('base64');
      await sendSegments(target, [{ type: 'image', data: { file: `base64://${b64}` } }], isGroup);
      log('[sticker] sent', key);
    } else {
      log('[sticker] not found, skip:', m[1]);
    }
    cursor = m.index + m[0].length;
  }
  // 尾部文字里可能还有多余的 [sticker:xxx]（我们只处理了前 MAX_STICKERS 个），
  // 必须清掉，否则会当成正文原样发出去，看起来像胡言乱语。
  const after = text.slice(cursor).replace(/\[sticker:[^\]]*\]/g, '').trim();
  if (after) await sendText(target, after, isGroup);
}

// ---------- 命令 ----------
async function handleCommand(text, sender, isGroup, target) {
  const t = text.trim();
  // 认定为命令的三种情形：
  //   1) 以 / 开头（/表情 /存表情 ...）
  //   2) 无斜杠的中文短命令（发动态、表情、状态 ...）
  //   3) 中文命令 + 参数（发动态 xxx、/表情 xxx）
  const bareCmd = /^(?:发动态|发说说|说说|发表情|表情|状态|群列表|帮助|存表情|表情包列表|删表情|图库)(?:\s+(\S+))?$/;
  if (!t.startsWith('/') && !bareCmd.test(t)) {
    return null; // 不是命令
  }
  // 命令只认主人（Komorebi 大号 + 机器人号），其他人发 /qzone 之类不会执行
  if (!isOwner(sender)) {
    return '这个命令只有主人能用。';
  }

  // 发动态： /qzone <内容>  或  "发动态 <内容>"
  const qz = t.match(/^(?:\/qzone|发动态|发说说|说说)\s*([\s\S]+)$/i);
  if (qz) {
    const data = await onebot('send_qzone_msg', { content: qz[1].trim(), ugc_right: 1 });
    return `已发布 QQ 动态：tid=${data.tid}`;
  }

  if (/^(?:\/status|状态)$/i.test(t)) {
    const li = await onebot('get_login_info');
    const st = await onebot('get_status');
    return `QQ ${li.nickname}(${li.user_id}) 在线=${st.online}`;
  }

  // 发表情： /face <关键词>  搜系统表情并发送
  const fc = t.match(/^(?:\/face|发表情|表情)\s*(\S+)?$/i);
  if (fc) {
    const q = fc[1] || '微笑';
    const res = await onebot('search_sys_faces', { query: q });
    const faces = res?.faces ?? [];
    if (!faces.length) return `没找到"${q}"相关的表情`;
    const f = faces[0];
    await sendSegments(target, [{ type: 'face', data: { id: String(f.em_code ?? f.q_sid) } }], isGroup);
    return `已发表情：${f.q_des ?? q}`;
  }

  // ---- 本地表情包仓库 ----
  // QQ 收藏接口只有读、没有写，所以用本地目录当仓库：存起来以后自己发。

  // 存表情： /存表情 <关键词>   （把紧接着发来的 / 同一条消息里的图片存档）
  const saveM = t.match(/^(?:\/存表情|\/sticker-save|存表情)\s*(\S+)\s*$/i);
  if (saveM) {
    const key = saveM[1];
    const b64 = lastImageB64.get(sender);
    if (!b64) return `没拿到图片。先发一张图，再发“/存表情 ${key}”（同一条消息带图也行）。`;
    saveSticker(key, b64.data, b64.mime);
    lastImageB64.delete(sender);
    return `存好了：${key}`;
  }

  // 发表情： /表情 <关键词>
  const useM = t.match(/^(?:\/表情|\/sticker|表情)\s*(\S+)\s*$/i);
  if (useM) {
    const key = findSticker(useM[1]);
    if (!key) {
      const all = listStickers();
      return all.length
        ? `没有"${useM[1]}"。已存的：${all.join('、')}`
        : '仓库还是空的。先发图再 /存表情 <关键词>';
    }
    const path = getStickerPath(key);
    if (!path) return `记录里说有"${key}"，但文件不见了，重新存一次吧。`;
    // 注意：不能用本地文件路径发图。实测 OneBot 走 highway 上传本地文件会失败
    // ("highway upload transport failed ... TCP connect timeout")。
    // 直接把 base64 交给 OneBot 才可靠。
    const b64 = readFileSync(path).toString('base64');
    const ext = extname(path).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';
    await sendSegments(target, [{
      type: 'image',
      data: { file: `base64://${b64}`, ...(mime === 'image/jpeg' ? {} : {}) }
    }], isGroup);
    return null; // 图片已经发出，不再回文字
  }

  // 列表： /表情包列表
  if (/^(?:\/表情包列表|\/stickers|表情包列表)$/i.test(t)) {
    const all = listStickers();
    return all.length ? `已存 ${all.length} 个：\n${all.join('\n')}` : '仓库空的。发张图再 /存表情 <关键词>';
  }

  // 删除： /删表情 <关键词>
  const delM = t.match(/^(?:\/删表情|\/sticker-del|删表情)\s*(\S+)\s*$/i);
  if (delM) {
    const key = findSticker(delM[1]);
    if (!key) return `没有"${delM[1]}"`;
    deleteSticker(key);
    return `删了：${key}`;
  }

  // ---- 禁言 ----
  // /闭嘴  在当前群/私聊里让我闭嘴
  if (/^(?:\/闭嘴|\/mute)$/i.test(t)) {
    setMuted(isGroup ? groupKey(target) : privateKey(sender), true);
    return '哦。';
  }
  // /解禁  恢复说话
  if (/^(?:\/解禁|\/unmute|\/开口)$/i.test(t)) {
    setMuted(isGroup ? groupKey(target) : privateKey(sender), false);
    return '行吧，那我说了。';
  }
  // /静音状态
  if (/^(?:\/静音状态|\/mutestatus)$/i.test(t)) {
    const all = listMuted();
    return all.length ? `当前被禁言的会话：\n${all.join('\n')}` : '没有被禁言的会话。';
  }

  // ---- 自动图库（收到过的图自动存原图，防止链接过期取不回）----
  // /图库  查看最近缓存了哪些原图
  if (/^(?:\/图库|\/images|图库)$/i.test(t)) {
    const all = listArchived(3);
    if (!all.length) return '图库还是空的。发张图我就自动存下原图。';
    const lines = all.slice(-12).map((x, i) => `${i + 1}. ${x.day} ${Math.round(x.bytes / 1024)}KB ${x.file}`);
    return `最近缓存 ${all.length} 张（显示最后 12 张）：\n${lines.join('\n')}\n\n用 /存图 <序号> <关键词> 存成表情`;
  }

  // /存图 <序号|hash前缀> <关键词>  把已缓存的原图存成表情
  const arcM = t.match(/^(?:\/存图|\/archive)\s+(\S+)\s+(\S+)\s*$/i);
  if (arcM) {
    const all = listArchived(30);
    let rec = null;
    const idx = Number(arcM[1]);
    if (Number.isInteger(idx) && idx >= 1 && idx <= all.length) {
      rec = all
        .slice()
        .sort((a, b) => (a.day === b.day ? a.file.localeCompare(b.file) : a.day.localeCompare(b.day)))[idx - 1];
    } else {
      rec = findArchived(arcM[1]);
    }
    if (!rec) return `没找到 ${arcM[1]}。用 /图库 看看有哪些。`;
    const b64 = readArchived(rec.path);
    if (!b64) return '读不出来，文件可能坏了。';
    const ext = rec.path.toLowerCase();
    const mime = ext.endsWith('.png') ? 'image/png'
      : ext.endsWith('.gif') ? 'image/gif'
      : ext.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg';
    saveSticker(arcM[2], b64, mime);
    return `存好了：${arcM[2]}（${Math.round(rec.bytes / 1024)}KB 原图）`;
  }

  // 查看群列表： /groups
  if (/^(?:\/groups|群列表)$/i.test(t)) {
    const gl = await onebot('get_group_list');
    if (!gl?.length) return '当前账号没有加入任何群。（QQ 不支持第三方建群，需要手动把机器人拉进群）';
    return '已加入的群：\n' + gl.map((g) => `${g.group_id} ${g.group_name}`).join('\n');
  }

  if (/^(?:\/help|帮助)$/i.test(t)) {
    return [
      '可用命令：',
      '  /qzone <内容>  —— 发 QQ 动态（说说）',
      '  /face <关键词> —— 发一个系统表情（如 /face 笑）',
      '  /groups        —— 查看已加入的群',
      '  /status        —— 查看 QQ 在线状态',
      '',
      '  表情包（存本地仓库，注意 QQ 收藏接口没有写入能力）：',
      '  /存表情 <关键词> —— 把刚发的那张图存起来',
      '  /表情 <关键词>   —— 把存过的表情发出来',
      '  /表情包列表      —— 看存了哪些',
      '  /删表情 <关键词> —— 删掉一个',
      '',
      '  自动图库（收到的图会自动存原图，防止 QQ 链接过期）：',
      '  /图库            —— 看最近缓存了哪些原图',
      '  /存图 <序号> <关键词> —— 把缓存的原图存成表情',
      '',
      '  禁言（群里 @ 我说"闭嘴"即可，主人专属）：',
      '  /闭嘴 或 "闭嘴"   —— 在这个群/私聊里闭嘴',
      '  /解禁 或 "可以讲话" —— 恢复说话',
      '  /静音状态          —— 看哪些会话被禁言了',
      '',
      '  /help          —— 本帮助',
      '',
      '其他消息会交给 DeepSeek Harness 处理并回复。',
      '你也可以直接发图片，我能看到。'
    ].join('\n');
  }

  return null; // 不是命令，交给 DSH
}

// ---------- 事件处理 ----------
// 群白名单为空时放行所有群（方便第一次把机器人拉进群即可用）；
// 一旦配置了 allow.groups，就只放行名单内的群。
// ---- 群聊回复频率控制 ----
// 目标：少刷屏。被点名必回，没点名时按概率 + 冷却，避免每条都接。
const lastGroupReply = new Map(); // groupId -> timestamp

const MUST_REPLY_WORDS = [
  '小鲸鱼', '大肥鱼', '鲸鱼', 'deepseek', 'd指导', 'd老师', 'ds', '深度求索'
];

function shouldReplyInGroup(ev, text, groupId) {
  // 1) 被 @ 了必回
  const atMe = Array.isArray(ev.message) && ev.message.some(
    (s) => s?.type === 'at' && String(s?.data?.qq) === String(BOT_SELF ?? ev.self_id)
  );
  if (atMe) return true;

  // 2) 提到它的名字/关键词必回
  const t = String(text ?? '').toLowerCase();
  if (MUST_REPLY_WORDS.some((w) => t.includes(w.toLowerCase()))) return true;

  // 3) 主人说话必回
  if (isOwner(String(ev.user_id ?? ev.sender?.user_id ?? ''))) return true;

  // 4) 其他情况：按概率（可配置，默认 0.45）
  const p = Number(cfg.groupReplyProbability ?? 0.45);
  if (Math.random() > p) return false;

  // 5) 同一群冷却时间（默认 20 秒），避免连续刷
  const cooldown = Number(cfg.groupReplyCooldownMs ?? 20_000);
  const last = lastGroupReply.get(groupId) ?? 0;
  if (Date.now() - last < cooldown) return false;

  lastGroupReply.set(groupId, Date.now());
  return true;
}

/** 是否主人（有命令/管理权限） */
function isOwner(sender) {
  return OWNERS.has(String(sender));
}

function allowed(isGroup, id, sender) {
  if (isOwner(sender)) return true;
  const set = isGroup ? ALLOW_GROUPS : ALLOW_PRIVATE;
  if (set.size === 0 && isGroup) return true;
  return set.has(String(id));
}

async function onMessage(ev) {
  const isGroup = ev.message_type === 'group';
  const target = isGroup ? ev.group_id : ev.user_id;
  const sender = String(ev.user_id ?? ev.sender?.user_id ?? '');

  if (!allowed(isGroup, target, sender)) {
    log('[skip] not allowed:', sender, isGroup ? `group ${target}` : 'private');
    return;
  }
  // 只过滤机器人自己发出的回显，否则会把自己的回复又当成新消息 -> 无限自激。
  if (ev.post_type === 'message_sent') return;
  if (BOT_SELF && sender === BOT_SELF && ev.self_id === Number(BOT_SELF)) return;

  // 提取文本 + 图片/表情（图片会下载后作为附件随 prompt 一起给 DSH）
  const text = extractText(ev.message);
  const media = collectMedia(ev.message);
  if (!text && media.length === 0) return;

  log(`[msg] ${isGroup ? 'group' : 'private'} ${target} from ${sender}: ${(text || '[media]').slice(0, 60)}`);

  // ---- 禁言：主人 @ 我说"闭嘴"就闭嘴，直到说"可以讲话"才恢复 ----
  const chatKey = isGroup ? groupKey(target) : privateKey(sender);
  // 是否被 @：群消息里检查 at 段或文本里 @机器人的 QQ 号
  const atMe = isGroup
    ? (Array.isArray(ev.message) && ev.message.some(
        (s) => s?.type === 'at' && String(s?.data?.qq) === String(BOT_SELF ?? ev.self_id)
      ))
    : false; // 私聊天然就是对我说的

  // 只有主人能开关，且群里必须 @ 我（避免别人刷屏误触发）
  if (isOwner(sender) && (atMe || !isGroup)) {
    const t0 = String(text ?? '').trim();
    // 闭嘴：各种说法都认
    if (/闭嘴|别说话|禁言|不许说话|不要说话|shut\s*up/i.test(t0) && t0.length <= 20) {
      setMuted(chatKey, true);
      log('[mute] muted', chatKey);
      await sendText(target, '哦。', isGroup).catch(() => {});
      return;
    }
    // 恢复：必须明确说可以讲话
    if (/可以讲话|可以说话|能说话|解除禁言|你可以说了|开口|解禁/i.test(t0) && t0.length <= 20) {
      setMuted(chatKey, false);
      log('[mute] unmuted', chatKey);
      await sendText(target, '行吧，那我说了。', isGroup).catch(() => {});
      return;
    }
  }

  // ---- 回复频率控制（多量少次：降低刷屏，但一次说完整）----
  // 之前是每条消息都回，很吵。现在：
  //   1) 被 @ / 点名 / 含关键词（小鲸鱼、大肥鱼、DeepSeek...）必回
  //   2) 私聊必回
  //   3) 群里没叫它时，按概率回（默认 45%），且同一群有冷却时间
  if (isGroup && !shouldReplyInGroup(ev, text, target)) {
    log('[skip] not replying (frequency control)', target);
    return;
  }

  // 已被禁言：完全不回应（连自动存图也不做，安静到底）
  if (isMuted(chatKey)) {
    log('[mute] skipped (muted)', chatKey);
    return;
  }

  // 收到图片时：先判断是不是表情包，是才存。
  // 普通照片/截图/聊天截图不进图库，避免占空间（用户明确要求）。
  const firstImage = media.find((m) => m.type === 'image');
  if (firstImage && !isMuted(chatKey)) {
    try {
      const thumb = await fetchImageBase64(firstImage.file); // 缩略图够判断用
      if (thumb) {
        const isSticker = await looksLikeSticker(thumb, detectMime(thumb));
        if (isSticker) {
          const full = await fetchImageFull(firstImage.file);
          if (full) {
            const r = archiveImage(full.data, full.mime);
            if (r?.fresh) log('[archive] saved sticker', r.bytes, 'bytes ->', r.path);
            if (r && cfg.autoSticker !== false) {
              autoNameAndSave(full.data, full.mime, sender).catch(() => {});
            }
          }
        } else {
          log('[archive] skipped: not a sticker (photo/screenshot)');
        }
      }
    } catch { /* 存不下就算了，不影响回复 */ }
  }

  // 记下这次的图片（供随后 "/存表情 <关键词>" 使用）
  // 只对主人做，避免把陌生人的图也缓存下来。
  if (firstImage && isOwner(sender)) {
    try {
      const b64 = await fetchImageBase64(firstImage.file);
      if (b64) lastImageB64.set(sender, { data: b64, mime: detectMime(b64) });
    } catch { /* 拿不到就算了，不影响主流程 */ }
  }

  try {
    const cmdReply = await handleCommand(text, sender, isGroup, target);
    if (cmdReply) {
      await sendText(target, cmdReply, isGroup);
      return;
    }
    const reply = await ask(`${isGroup ? 'g' : 'p'}${target}`, text || '[图片]', media);
    await sendReply(target, reply, isGroup);
    log(`[reply] -> ${target}: ${reply.slice(0, 60)}`);
  } catch (error) {
    // 错误只记日志，绝不发到群里。
    // 之前这里会把 "处理失败：dsh: timeout waiting for reply" 这类内部错误
    // 原文发到群里 —— 群友看不懂，还显得机器人坏了、在胡言乱语。
    log('[error]', error.message);
    // 只对主人提示一次，且用人话；群里保持安静。
    if (!isGroup && isOwner(sender)) {
      await sendText(target, '刚才卡了一下，再说一遍？', false).catch(() => {});
    }
  }
}

/** 收集消息里的图片/表情段，返回 [{type:'image',file,url}]。 */
function collectMedia(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const seg of message) {
    if (!seg) continue;
    if (seg.type === 'image' && seg.data?.file) {
      out.push({ type: 'image', file: seg.data.file, url: seg.data.url ?? '' });
    }
    if (seg.type === 'face' && seg.data?.id) {
      out.push({ type: 'face', id: String(seg.data.id) });
    }
  }
  return out;
}

/**
 * 按 base64 魔数判断真实图片类型。
 * 必须准确：DSH 的 schema 只接受 image/png|jpeg|webp|gif，且与 data 实际格式不符会被拒。
 */
function detectMime(b64) {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('/9j/') || b64.startsWith('/9j4')) return 'image/jpeg';
  if (b64.startsWith('UklGRg')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/jpeg';
}

/**
 * 下载【原图】（spec=0），用于本地归档。
 * 与 fetchImageBase64 的区别：那个优先要缩略图（为了快速给模型看、省带宽），
 * 这个必须拿原图 —— 归档是为了长期保存，缩略图会永久丢掉细节。
 */
async function fetchImageFull(file) {
  try {
    const res = await onebot('get_image', { file });
    if (typeof res?.base64 === 'string' && res.base64.length > 0) {
      return { data: res.base64, mime: detectMime(res.base64) };
    }
    const url = res?.url || res?.file;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
    // 强制 spec=0：拿原图
    const orig = url.replace(/([?&])spec=\d+/, '$1spec=0');
    const r = await fetch(orig, { signal: AbortSignal.timeout(25_000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // 拒绝占位图：QQ 链接过期后会返回 1x1 像素（<1KB），存它没有意义
    if (buf.length < 1024) return null;
    if (buf.length > 20 * 1024 * 1024) return null;
    return { data: buf.toString('base64'), mime: detectMime(buf.toString('base64')) };
  } catch {
    return null;
  }
}

/**
 * 取图片二进制的 base64。
 *
 * 两个实测结论：
 *  1. SnowLuma 的 get_image 返回的是 { file, url, file_size, file_name } —— 一个带 rkey
 *     的下载 URL，而不是 base64。必须下载再转 base64，否则模型只看到 [图片] 占位符。
 *  2. 默认 spec=0 是原图（实测一张 4.8MB -> base64 6.4M 字符，接近 DSH 附件上限且很慢）。
 *     QQ 的 URL 支持 spec 参数，spec=198 返回约 169KB 的缩略图，肉眼可辨、体积降 28 倍。
 *     因此优先请求 spec=198，失败再回退原图。
 */
async function fetchImageBase64(file) {
  try {
    const res = await onebot('get_image', { file });
    // 少数实现会直接给 base64
    if (typeof res?.base64 === 'string' && res.base64.length > 0) return res.base64;

    const url = res?.url || res?.file;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;

    // 先试缩略图
    const thumb = url.replace(/([?&])spec=\d+/, '$1spec=198');
    if (thumb !== url) {
      try {
        const r = await fetch(thumb, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 0) {
            log('[media] image thumbnail', buf.length, 'bytes');
            return buf.toString('base64');
          }
        }
      } catch { /* 缩略图失败就回退原图 */ }
    }

    // 回退：原图
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 20 * 1024 * 1024) return null;
    log('[media] image full', buf.length, 'bytes');
    return buf.toString('base64');
  } catch { /* 拿不到就忽略 */ }
  return null;
}

function extractText(message) {
  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';
  return message
    .filter((seg) => seg?.type === 'text')
    .map((seg) => seg?.data?.text ?? '')
    .join('')
    .trim();
}

/**
 * 判断一张图是不是表情包（值得存）。
 * 普通照片、截图、界面截图、文档图都不存 —— 用户明确要求只存表情包。
 * 只看缩略图就够了，省带宽。
 */
async function looksLikeSticker(b64, mime) {
  try {
    const rec = await dsh.sessions.create({ request: { cwd: CWD } });
    await dsh.sessions.prompt({
      request: {
        sessionId: rec.sessionId,
        requestId: `issticker-${Date.now()}`,
        mode: 'queue',
        content: [{
          type: 'text',
          text: '判断这张图是不是表情包/梗图（可用来聊天斗图的那种）。'
            + '真人照片、风景照、界面截图、聊天记录截图、文档、商品图、二维码 —— 都算不是。'
            + '只回答一个字：是 或 否。不要解释。'
        }, { type: 'image', mediaType: mime, data: b64, name: 'q' }]
      }
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const p = await dsh.sessions.projections({ request: { sessionId: rec.sessionId } });
      const o = p?.values?.turnOutline ?? [];
      if (o.length && o[o.length - 1].response) {
        const ans = String(o[o.length - 1].response).trim();
        // 出现"不是/否/no"都算否定；否则出现"是/yes"算肯定
        if (/不是|否|no/i.test(ans)) return false;
        return /是|yes|true/i.test(ans);
      }
    }
  } catch { /* 判断失败就当不是，不存 */ }
  return false;
}

/**
 * 自动给一张新图起关键词并存入表情库。
 * 后台异步跑，不阻塞回复；失败也不影响主流程。
 */
async function autoNameAndSave(b64, mime, senderTag) {
  try {
    const rec = await dsh.sessions.create({ request: { cwd: CWD } });
    await dsh.sessions.prompt({
      request: {
        sessionId: rec.sessionId,
        requestId: `autoname-${Date.now()}`,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: '给这个表情包起一个 2 到 4 个字的中文关键词，用于以后搜索调用。'
              + '只看主体动作或情绪，不要描述背景，不要解释，不要标点，不要加引号。'
              + '只输出关键词本身。'
          },
          { type: 'image', mediaType: mime, data: b64, name: 's' }
        ]
      }
    });
    // 等命名结果
    let name = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const p = await dsh.sessions.projections({ request: { sessionId: rec.sessionId } });
      const o = p?.values?.turnOutline ?? [];
      if (o.length && o[o.length - 1].response) {
        name = String(o[o.length - 1].response).trim();
        break;
      }
    }
    if (!name) { log('[autosticker] no name returned, skip'); return; }
    // 清洗：去掉标点引号和多余说明
    name = name.replace(/[`"'"「」『』。.!！,，\s]/g, '').slice(0, 8);
    if (!name) return;
    // 同名加序号，避免覆盖已有表情
    let final = name;
    let n = 2;
    while (listStickers().includes(final)) final = `${name}${n++}`;
    saveSticker(final, b64, mime);
    log('[autosticker] saved', JSON.stringify(final), `(${Math.round(b64.length * 0.75 / 1024)}KB)`);
    // 起完名就告诉主人，省得他猜存没存
    if (isOwner(senderTag)) {
      await sendText(Number(senderTag), `存好了："${final}"`, false).catch(() => {});
    }
  } catch (e) {
    log('[autosticker] failed:', e.message);
  }
}

// ---------- WebSocket（接收侧） ----------
function connect() {
  const ws = new WebSocket(WS_URL, { headers: WS_TOKEN ? { authorization: `Bearer ${WS_TOKEN}` } : {} });
  ws.addEventListener('open', () => log('[ws] connected', WS_URL));
  ws.addEventListener('message', (event) => {
    let ev;
    try { ev = JSON.parse(String(event.data)); } catch { return; }
    if (ev.post_type === 'message' && ev.message_type !== 'sent') {
      onMessage(ev).catch((e) => log('[error] handler', e.message));
    }
  });
  ws.addEventListener('error', (e) => log('[ws] error', e.message ?? '(none)'));
  ws.addEventListener('close', () => { log('[ws] closed, reconnect in 5s'); setTimeout(connect, 5000); });
  return ws;
}

/** 等 OneBot HTTP 就绪；DSH 允许稍后再连（令牌单独处理），避免冷启动即崩溃。 */
async function waitForOnebot(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await onebot('get_login_info');
      log('[onebot] login ok:', `${info.nickname}(${info.user_id})`);
      return true;
    } catch {
      await sleep(2000);
    }
  }
  log('[onebot] not ready within timeout');
  return false;
}

const onebotReady = await waitForOnebot();
if (!onebotReady) log('[warn] starting anyway; onebot may come up later');
connect();
log('[bridge] running. owners =', [...OWNERS].join(', '), '| self =', BOT_SELF ?? '(unknown)');

// ---------- 每日 QQ 动态（说说）----------
// 用户设定：从当天真实聊天提炼 + 全自动直接发 + 公开可见。
// 因此这里做了两道保险：每天只发一条（状态文件按日期记录），以及内容过滤。

async function postDailyQzone() {
  try {
    if (alreadyPostedToday()) {
      log('[qzone] already posted today, skip');
      return;
    }
    // 素材来源：和主人（Komorebi 大号）的当天聊天
    const ownerUin = Number(OWNER);
    const h = await onebot('get_friend_msg_history', { user_id: ownerUin, count: 60 }).catch(() => null);
    const msgs = h?.data?.messages ?? [];
    const lines = buildDigest(msgs);
    if (lines.length < 2) {
      log('[qzone] not enough material today, skip');
      return;
    }

    // 用独立的 DSH 会话改写，避免污染聊天会话的人设上下文
    const rec = await dsh.sessions.create({ request: { cwd: CWD } });
    await dsh.sessions.prompt({
      request: {
        sessionId: rec.sessionId,
        requestId: `qzone-${Date.now()}`,
        mode: 'queue',
        content: [{ type: 'text', text: promptFor(lines) }]
      }
    });
    const raw = await waitForReply(rec.sessionId, 0);
    const text = tidy(raw);
    if (!text || text.length < 4) {
      log('[qzone] generation empty, skip');
      return;
    }

    const data = await onebot('send_qzone_msg', { content: text, ugc_right: 1 });
    markPosted(data?.tid, text);
    log('[qzone] posted:', text, '| tid=', data?.tid);
  } catch (e) {
    log('[qzone] failed:', e.message);
  }
}

/** 每天在设定的时间触发一次；错过时间（如机器没开）则在启动后补发。 */
function scheduleDailyQzone() {
  const hour = Number(cfg.dailyQzone?.hour ?? 22);
  const minute = Number(cfg.dailyQzone?.minute ?? 0);
  let fired = false;
  const tick = () => {
    const now = new Date();
    const hit = now.getHours() === hour && now.getMinutes() === minute;
    if (hit && !fired && !alreadyPostedToday()) {
      fired = true;
      postDailyQzone();
    }
    // 跨过这一分钟后重置，允许第二天再次触发
    if (now.getMinutes() !== minute) fired = false;
  };
  setInterval(tick, 30_000);
  // 启动时先检查一次：如果今天还没发且已经过了设定时间，就补发
  setTimeout(() => {
    const now = new Date();
    const passed = now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
    if (passed && !alreadyPostedToday()) postDailyQzone();
  }, 20_000);
  log(`[qzone] daily schedule armed at ${hour}:${String(minute).padStart(2, '0')}`);
}

if (cfg.dailyQzone?.enabled) {
  scheduleDailyQzone();
} else {
  log('[qzone] daily auto-post disabled (config.dailyQzone.enabled is not true)');
}
