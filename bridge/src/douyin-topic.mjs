// 主人指定浏览主题的共享校验。
//
// 主题来自爸的自然语言原话，经模型压缩后从 MCP 一路传到监听器。这里只做格式与
// 黑名单校验，不判断“这个主题好不好”。规则与 Python 侧 douyin_search.normalize_topic
// 保持一致：1–20 字、拒绝换行/CQ 码/方括号/链接，命中黑名单即拒绝。

import { readFileSync } from 'node:fs';

export const BROWSE_TOPIC_MAX_CHARS = 20;

const BOUNDARY_RE = /[\r\n\t]/;
const CQ_RE = /cq:/i;
const BRACKET_RE = /[\[\]［］【】]/;
const URL_RE = /https?:\/\/|www\.|douyin\.com|\/video\//i;

function topicLength(value) {
  // 用码点计数，避免 emoji 被算成两个字符。
  return [...value].length;
}

/**
 * @param {unknown} value 上游传来的 topic；省略/空串表示“没有指定主题”。
 * @param {{ blacklist?: string[] }} [options]
 * @returns {{ topic: string, error: string }} 出错时 topic 为空、error 为中文原因。
 */
export function normalizeBrowseTopic(value, { blacklist = [] } = {}) {
  if (value === undefined || value === null) return { topic: '', error: '' };
  if (typeof value !== 'string') return { topic: '', error: '主题需为文字' };
  if (BOUNDARY_RE.test(value)) return { topic: '', error: '主题不能包含换行或制表符' };
  const topic = value.replace(/\s+/g, ' ').trim();
  if (!topic) return { topic: '', error: '' };
  if (CQ_RE.test(topic)) return { topic: '', error: '主题不能包含 CQ 码' };
  if (BRACKET_RE.test(topic)) return { topic: '', error: '主题不能包含方括号' };
  if (URL_RE.test(topic)) return { topic: '', error: '主题不能是链接' };
  if (topicLength(topic) > BROWSE_TOPIC_MAX_CHARS) {
    return { topic: '', error: `主题最多 ${BROWSE_TOPIC_MAX_CHARS} 个字` };
  }
  const lowered = topic.toLowerCase();
  for (const entry of Array.isArray(blacklist) ? blacklist : []) {
    const word = String(entry ?? '').trim().toLowerCase();
    if (word && lowered.includes(word)) {
      return { topic: '', error: `主题包含黑名单词：${entry}` };
    }
  }
  return { topic, error: '' };
}

/** 读取 Python 侧 config.json 的 browse_topics.blacklist；文件损坏时按空表处理。 */
export function readBrowseTopicBlacklist(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const list = cfg?.browse_topics?.blacklist;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
