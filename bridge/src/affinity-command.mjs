/** Parse explicit natural-language and slash commands for affinity lookup. */
export function parseAffinityCommand(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  const slash = text.match(/^\/(?:好感度|affinity)(?:\s+([\s\S]*?))?[？?。！!]*$/i);
  if (slash) return { args: String(slash[1] ?? '').replace(/[？?。！!]+$/g, '').trim() };

  // Accept conversational ways of asking for the caller's score, including
  // "给我看一下，我和你的好感度". Authorization for explicit QQ targets is
  // still enforced by handleCommand.
  text = text
    .replace(/^(?:(?:请|麻烦)?\s*)?(?:你\s*)?(?:(?:帮我|给我)\s*)?(?:(?:我想|想)\s*)?(?:看看|看下|看一下|查看|查查|查一下|查询|查)(?:一下)?[\s，,]*/i, '')
    .replace(/^(?:我\s*和\s*(?:你|机器人|小鲸鱼|肥鱼)(?:之间)?|(?:小鲸鱼|肥鱼)\s*和\s*我)(?:的)?\s*/i, '')
    .replace(/^(?:(?:我|自己)(?:的)?|(?:小鲸鱼|肥鱼)(?:的)?)\s*/i, '');
  const match = text.match(/^好感度(?:\s*(?:是多少|多少|分数|情况|状态))?(?:\s+([\s\S]*?))?[？?。！!]*$/i);
  if (!match) return null;
  return { args: String(match[1] ?? '').replace(/[？?。！!]+$/g, '').trim() };
}
