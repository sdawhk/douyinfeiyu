import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOUYIN_OWNER_RULES, QQ_OWNER_DOUYIN_TOOL_RULES, douyinOwnerTurnPrompt, qqOwnerDouyinToolPrompt } from '../src/douyin-owner-prompt.mjs';

const qqBotSource = readFileSync(fileURLToPath(new URL('../src/qq-bot.mjs', import.meta.url)), 'utf8');

test('douyin owner turns receive the no-tool anti-commitment rules', () => {
  const prompt = douyinOwnerTurnPrompt({ channel: 'douyin', isDouyinOwnerTurn: true });
  assert.equal(prompt, DOUYIN_OWNER_RULES);
  for (const phrase of ['没有刷抖音', '不能说自己', '任务已启动', '正在做']) {
    assert.ok(prompt.includes(phrase), `missing ${phrase}`);
  }
  // 抖音不注入 QQ 专属工具规则，避免模型去找它根本没有的 key/token。
  assert.ok(!prompt.includes('传当前 key/token'));
  assert.ok(!prompt.includes('douyin_browse_recommendations'));
});

test('QQ and non-owner douyin turns keep the previous prompt (empty append)', () => {
  assert.equal(douyinOwnerTurnPrompt({ channel: 'qq', isDouyinOwnerTurn: true }), '');
  assert.equal(douyinOwnerTurnPrompt({ channel: 'douyin', isDouyinOwnerTurn: false }), '');
});

test('QQ owner private turn keeps the original four Douyin tool rules verbatim', () => {
  const prompt = qqOwnerDouyinToolPrompt({ ownerPrivateTurn: true, hasToolSession: true });
  assert.equal(prompt, QQ_OWNER_DOUYIN_TOOL_RULES);
  for (const marker of ['【主人抖音浏览】', '【抖音互动建议】', '【抖音点赞与评论】', '【抖音视频分享】']) {
    assert.ok(prompt.includes(marker), `missing ${marker}`);
  }
  assert.ok(prompt.includes('douyin_browse_recommendations'));
  assert.equal(qqOwnerDouyinToolPrompt({ ownerPrivateTurn: true, hasToolSession: false }), '');
  assert.equal(qqOwnerDouyinToolPrompt({ ownerPrivateTurn: false, hasToolSession: true }), '');
});

test('qq-bot wiring injects the douyin rule outside the QQ tools gate and keeps the QQ call unchanged', () => {
  assert.ok(qqBotSource.includes('if (douyinOwnerTurn) {'), 'douyin rule must be injected outside if (toolsBefore)');
  assert.ok(qqBotSource.includes('douyinOwnerTurnPrompt({ channel, isDouyinOwnerTurn: douyinOwnerTurn })'));
  assert.ok(qqBotSource.includes('qqOwnerDouyinToolPrompt({ ownerPrivateTurn, hasToolSession: true })'));
  // 反承诺规则必须能覆盖抖音轮：抖音 key 不匹配 /^([gp])(\\d+)$/，toolsBefore 必为 null。
  assert.match(qqBotSource, /const match = \/\^\(\[gp\]\)\(\\d\+\)\$\/\.exec\(chatKey\)/);
  assert.match(qqBotSource, /const key = `d\$\{ownerId\}`/);
});
