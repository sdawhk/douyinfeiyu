/** Build grounded reply context for questions about Qzone and affinity interactions. */
export function qzoneSocialReplyContext(options, affinityScore = null) {
  if (!options) return '';

  const allowedCount = Array.isArray(options.allowedFriends) ? options.allowedFriends.length : 0;
  const enabled = options.enabled === true;
  const previewOnly = options.previewOnly !== false;
  const likeThreshold = Number.isFinite(Number(options.likeThreshold)) ? Number(options.likeThreshold) : 75;
  const commentThreshold = Number.isFinite(Number(options.commentThreshold)) ? Number(options.commentThreshold) : 85;
  const lines = [
    '【QQ空间互动与好感度的实际配置】',
    '机器人确实有好友动态互动功能，也有 0～100 分的好感度系统。好友动态达到点赞门槛后才会点赞；达到评论门槛后才会评论。',
    '好感度等级中，75 分及以上属于“很亲近”；因此当前点赞门槛对应“很亲近”，不是加好友后马上就会点赞。',
    `当前配置：好友动态互动${enabled ? '已启用' : '未启用'}；点赞门槛 ${likeThreshold} 分；评论门槛 ${commentThreshold} 分；白名单 ${allowedCount ? `有 ${allowedCount} 位好友` : '为空'}；${previewOnly ? '预览模式开启，只记录候选动作，不会实际点赞或评论' : '预览模式关闭，满足条件后可以实际执行'}。`,
  ];
  if (allowedCount === 0) lines.push('白名单为空时不会扫描任何好友的新动态；机器人只会处理白名单内好友。');
  lines.push('这是定时扫描新动态的自动互动功能，不代表机器人能立刻对任意指定动态手动点赞；不要声称已经点赞。');
  if (affinityScore !== null && affinityScore !== undefined && affinityScore !== '' && Number.isFinite(Number(affinityScore))) {
    lines.push(`当前聊天对象的好感度为 ${Number(affinityScore)} 分；只在对方直接询问自己的分数或是否达到门槛时透露。`);
  }
  lines.push('回答相关问题时直接说明功能、具体分数门槛和当前阻止实际点赞的配置，不要说“没有接这个功能”“只有精神支持”，也不要转成安慰、反讽或无关表情包。不要自行承诺修改配置。');
  return lines.join('\n');
}
