// Commands handled by the isolated AstrBot instance hosting the group report
// and pet plugins. Keep this list in sync with their registered commands.
const COMMANDS = new Set([
  '群分析', 'group_analysis', '群漫画', 'group_comic', 'daily_comic',
  '设置格式', 'set_format', '设置模板', 'set_template',
  '查看模板', 'view_templates', '查看漫画风格', 'view_comic_styles',
  '分析设置', 'analysis_settings', '增量状态', 'incremental_status',
  '领养宠物', '我的宠物', '宠物改名', '散步', '对决', '宠物进化',
  '宠物技能', '学习技能', '修复宠物技能', '宠物商店', '宠物背包',
  '购买', '使用', '装备', '宠物签到', '宠物排行', '丢弃宠物',
  '确认丢弃', '宠物菜单'
]);

export function isAstrbotSidecarCommand(text) {
  const match = /^\s*[!/](\S+)(?=\s|$)/u.exec(String(text ?? ''));
  return Boolean(match && COMMANDS.has(match[1]));
}
