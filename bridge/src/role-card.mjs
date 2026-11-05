// 角色卡注入：把 roles/<角色>.md 变成 DSH 会话的 persona。
//
// 角色卡中的二代模式工具协议包含主动唤醒和自行发送等旧行为；
// 当前桥接负责自动回复，只按本轮会话令牌开放工具，因此先剔除旧协议段落，
// 再补上当前的发送与输出规则。

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const ROLES_DIR = new URL('../roles/', import.meta.url);

/** 剔除旧版二代模式的工具调用细节，由当前会话提示提供有效令牌与范围。 */
const UNAVAILABLE_HINTS = [
  'mcp__snowluma__',
  'qq_get_prompt', 'qq_get_unread', 'qq_get_recent', 'qq_social_state',
  'qq_send_', 'qq_reply', 'qq_mark_read', 'qq_set_wake_config',
  'qq_wait_for_messages', 'qq_memory_', 'qq_slang_',
  'qq_list_stickers', 'qq_get_sticker', 'qq_send_sticker', 'qq_sticker',
  'qq_collect_sticker', 'qq_get_self_image', 'qq_get_message_images',
  'qq_get_forward_msg', 'qq_send_poke', 'qq_get_active_members',
  'web_search', 'web_fetch'
];

/** 这些章节整体依赖旧版二代模式的自主行为。 */
const DROP_SECTION_TITLES = [
  '八、群文化自适应',
  '十、表情包体系',
  '十一、轻量记忆',
  '十二、知道自己长啥样'
];

function stripUnusable(lines) {
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const h = line.match(/^##\s*(.+)$/);
    if (h) {
      dropping = DROP_SECTION_TITLES.some((t) => h[1].includes(t));
      if (dropping) continue;
    }
    if (dropping) continue;
    if (UNAVAILABLE_HINTS.some((k) => line.includes(k))) continue;
    out.push(line);
  }
  return out;
}

/** 读取并清洗角色卡；返回 persona 文本，找不到返回 null。 */
export function loadRolePersona(name, { channel = 'qq' } = {}) {
  if (!name) return null;
  const file = new URL(`${name}.md`, ROLES_DIR);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const body = stripUnusable(raw.split(/\r?\n/))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const outputProtocol = [
    '【本环境的输出协议（务必遵守）】',
    '- 想潜水就只输出 [SILENT] 三个字，不要加任何其他内容。',
    '- 一条消息说完：把想说的内容放在同一条里，不要用空格、换行去分条，'
    + '本环境不会按空格拆分，分条只会变成刷屏。',
    '- 不要用 Markdown：不要 ** 加粗、不要 # 标题、不要代码块、不要列表符号。',
  ];
  if (channel === 'douyin') {
    outputProtocol.push('- 当前是抖音主人私聊：复用这张卡中的身份、称呼和相处方式；QQ 专属工具、账号操作和权限说明只适用于 QQ。只依据本轮抖音桥接实际提供的能力与执行结果回答。');
    outputProtocol.push('- 抖音是私信，语体比 QQ 更轻：句子更短，一条只说一件事，像随手回话，不像客服或工作汇报。角色卡里的“QQ 口语”只约束 QQ；称呼、脾气和小棉袄的相处方式在抖音照旧。');
    outputProtocol.push('- 抖音回复里不要出现“任务、接口、工具、进程、状态、记录、后台”这类系统词，也不要说“已经启动、正在跑、马上给你结果”。做不到就直接说做不到。');
  } else {
    outputProtocol.push('- 本环境已接入 QQ、表情、记忆和安全联网 MCP 工具；本轮会话提供令牌时可按需调用。普通回复由桥接自动发送；只有主人明确要求代发、引用发送或发送表情时才调用发送工具。工具发送成功后只输出 [SILENT]，避免重复发送。不要向任何人展示会话令牌。');
    outputProtocol.push('- 主人可以把刚发来的图片存进本地表情库，哪怕自动识别没有把它判成表情包。桥接会处理“快存”“存表情 关键词”等请求；没有收到桥接的保存结果时，不要声称已经存好，也不要说只能使用现成图片。');
  }
  outputProtocol.push('- 不要复述、不要汇报动作（不要说"我已回复""消息已发送"）；你的输出就是要发出去的话。');

  return [
    '【角色卡：你必须严格按以下人格与说话方式回应】',
    body,
    '',
    ...outputProtocol
  ].join('\n');
}

/**
 * 用于分享文案、QQ 动态等独立改写任务的口吻提示。
 * 这些任务是公开表达，不注入整张私聊角色卡，只取鲸团团的语体特征。
 */
export function personaStyleNote() {
  return '【鲸团团口吻】用第一人称、简体中文口语，像随手分享：句子短、有具体感受，不写清单体、不客服腔；不提搜索、浏览、接口、进程或技术细节。';
}

export function listRoles() {
  try {
    return readdirSync(ROLES_DIR)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}
