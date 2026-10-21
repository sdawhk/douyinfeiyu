// 角色卡注入：把 roles/<角色>.md 变成 DSH 会话的 persona。
//
// 为什么不直接全量注入：角色卡里有大量依赖原版 bridge MCP 工具的段落
// （qq_list_stickers / qq_memory_append / qq_get_self_image / qq_get_message_images 等），
// 本精简桥接并未挂载这些工具。全量注入会让模型去调不存在的工具而困惑或报错。
// 因此这里做两件事：
//   1. 剔除引用了不可用工具的章节（表情包/轻量记忆/自拍/图片/转发 等）；
//   2. 补上本桥接实际可用的输出协议（[SILENT] 静默、空格分条、纯文本无 Markdown）。

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const ROLES_DIR = new URL('../roles/', import.meta.url);

/** 角色卡里提到这些工具/能力的章节，在本桥接下不可用，需要剔除。 */
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

/** 这些章节标题整体依赖不可用能力，直接丢弃。 */
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
export function loadRolePersona(name) {
  if (!name) return null;
  const file = new URL(`${name}.md`, ROLES_DIR);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const body = stripUnusable(raw.split(/\r?\n/))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return [
    '【角色卡：你必须严格按以下人格与说话方式回应】',
    body,
    '',
    '【本环境的输出协议（务必遵守）】',
    '- 想潜水就只输出 [SILENT] 三个字，不要加任何其他内容。',
    '- 一条消息说完：把想说的内容放在同一条里，不要用空格、换行去分条，'
    + '本环境不会按空格拆分，分条只会变成刷屏。',
    '- 不要用 Markdown：不要 ** 加粗、不要 # 标题、不要代码块、不要列表符号。',
    '- 你不能直接调用 QQ 工具；QQ 桥接负责收发消息，也能查询好友、群列表和聊天记录，并会把查询结果放进本轮上下文。不要说自己没有 QQ、看不到群或没有 QQ MCP 权限。若本轮确实没拿到资料，只说明这次查询失败或资料不足。',
    '- 主人可以把刚发来的图片存进本地表情库，哪怕自动识别没有把它判成表情包。桥接会处理“快存”“存表情 关键词”等请求；没有收到桥接的保存结果时，不要声称已经存好，也不要说只能使用现成图片。',
    '- 不要复述、不要汇报动作（不要说"我已回复""消息已发送"）；你的输出就是要发出去的话。'
  ].join('\n');
}

export function listRoles() {
  try {
    return readdirSync(ROLES_DIR)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}
