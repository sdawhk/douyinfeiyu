import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPrivateChatQQ, runPersonaMaintenance } from '../src/persona-maintenance.mjs';
import { groupMemberImpressions } from '../src/persona-runtime.mjs';

const DAY = 24 * 60 * 60_000;

function freshState() {
  const dir = mkdtempSync(join(tmpdir(), 'persona-maint-'));
  process.env.DSH_PERSONA_STATE_DIR = dir;
  mkdirSync(join(dir, 'persona-relations'), { recursive: true });
  return dir;
}

function writeJson(dir, name, value) {
  writeFileSync(join(dir, name), JSON.stringify(value));
}

function writeRelation(dir, name, value) {
  writeFileSync(join(dir, 'persona-relations', name), JSON.stringify(value, null, 2));
}

const logs = () => {
  const lines = [];
  const logger = (...args) => lines.push(args.join(' '));
  return { lines, logger };
};

test('isPrivateChatQQ: 关系文件或 private 会话任一成立即算私聊过', () => {
  const dir = freshState();
  writeRelation(dir, 'p111.json', { traits: [], recent: [] });
  const social = { conversations: { 'private:222': { recentMessages: [] } } };
  assert.equal(isPrivateChatQQ('111'), true);
  assert.equal(isPrivateChatQQ('222', social), true);
  assert.equal(isPrivateChatQQ('333', social), false);
  assert.equal(isPrivateChatQQ('', social), false);
});

test('weekly: 只清整组过期的桶，_unclaimed 与私聊桶永不清理', () => {
  const dir = freshState();
  const now = Date.now();
  writeJson(dir, 'persona-state.json', {
    openLoops: {
      'g700-111': [{ text: '群里早忘了的事', at: now - 10 * DAY }],
      '_unclaimed': [{ text: '人工待定', at: now - 30 * DAY }],
      'p222': [{ text: '私聊过的人', at: now - 10 * DAY }],
      'p333': [{ text: '还新鲜', at: now - 1000 }]
    },
    selfNotes: {},
    currentFocus: { 'g700-111': { text: '过期焦点', at: now - 10 * DAY } }
  });
  writeRelation(dir, 'p222.json', { traits: [], recent: [] });
  const { lines, logger } = logs();

  const report = runPersonaMaintenance({ apply: true, now, ownerQQs: [], currentGroupIds: null, bridgeRunning: true, forceWeekly: true, logger });
  assert.equal(report.weekly.due, true);
  assert.deepEqual(report.weekly.removed.map((item) => item.scope).sort(), ['g700-111', 'g700-111']);

  const state = JSON.parse(readFileSync(join(dir, 'persona-state.json'), 'utf8'));
  assert.equal(state.openLoops['g700-111'], undefined);
  assert.equal(state.openLoops['_unclaimed'].length, 1);
  assert.equal(state.openLoops['p222'].length, 1, '私聊桶豁免');
  assert.equal(state.openLoops['p333'].length, 1, '未过期桶保留');
  assert.equal(state.currentFocus['g700-111'], undefined);
  assert.ok(lines.some((line) => line.includes('skip(exempt-private)') && line.includes('p222')));
});

test('weekly: 文件未超过 512KB 时不触发', () => {
  const dir = freshState();
  const now = Date.now();
  writeJson(dir, 'persona-state.json', {
    openLoops: { 'g700-111': [{ text: '过期', at: now - 10 * DAY }] },
    selfNotes: {}, currentFocus: {}
  });
  const report = runPersonaMaintenance({ apply: true, now, ownerQQs: [], currentGroupIds: null, bridgeRunning: true });
  assert.equal(report.weekly.due, false);
  assert.equal(report.weekly.reason, 'below-size-threshold');
  const state = JSON.parse(readFileSync(join(dir, 'persona-state.json'), 'utf8'));
  assert.equal(state.openLoops['g700-111'].length, 1);
});

test('monthly: 过期关系文件删除，私聊过的豁免，旧群级文件归档而不是删除', () => {
  const dir = freshState();
  const now = Date.now();
  const staleRecent = [{ at: now - 120 * DAY, text: '很久以前' }];
  writeRelation(dir, 'g700-111.json', { traits: [], recent: staleRecent });
  writeRelation(dir, 'g700-222.json', { traits: [], recent: staleRecent });
  writeRelation(dir, 'p222.json', { traits: [], recent: staleRecent });
  writeRelation(dir, 'g700.json', { traits: [], recent: staleRecent });
  writeFileSync(join(dir, 'persona-relations', 'g700.json.bak-20261111'), '{}');
  writeJson(dir, 'social-v2.json', { conversations: { 'private:222': { recentMessages: [] } } });
  const { lines, logger } = logs();

  const report = runPersonaMaintenance({
    apply: true, now, ownerQQs: [], currentGroupIds: ['700'], bridgeRunning: false, forceMonthly: true, logger
  });
  assert.deepEqual(report.relations.deletions.map((item) => item.name), ['g700-111.json']);
  assert.equal(report.relations.legacyArchive.length, 1);
  assert.ok(report.relations.exempt.some((item) => item.name === 'g700-222.json'));
  assert.ok(lines.some((line) => line.includes('skip(exempt-private)') && line.includes('g700-222.json')));

  const dirFiles = readdirSync(join(dir, 'persona-relations'));
  assert.ok(!dirFiles.includes('g700-111.json'), '过期且非豁免 → 删除');
  assert.ok(dirFiles.includes('g700-222.json'), '私聊过 → 保留');
  assert.ok(dirFiles.includes('p222.json'), '私聊文件 → 保留');
  assert.ok(!dirFiles.includes('g700.json'), '旧群级文件 → 移出');
  assert.ok(!dirFiles.includes('g700.json.bak-20261111'), '旧备份一起移出');
  const archived = readdirSync(join(dir, 'persona-archive', report.stamp, 'legacy-group-relations'));
  assert.ok(archived.includes('g700.json') && archived.includes('g700.json.bak-20261111'));
});

test('退群：机器人不在的群，群作用域记忆直接删，私聊不动，并留下归档日志', () => {
  const dir = freshState();
  const now = Date.now();
  writeRelation(dir, 'g700-111.json', { traits: [], recent: [{ at: now, text: 'hi' }] });
  writeRelation(dir, 'g700.json', { traits: [], recent: [{ at: now, text: 'hi' }] });
  writeRelation(dir, 'p111.json', { traits: [], recent: [{ at: now, text: '私聊' }] });
  writeJson(dir, 'persona-state.json', {
    openLoops: { 'g700-111': [{ text: '群里的未收尾', at: now }], 'p111': [{ text: '私聊的未收尾', at: now }] },
    selfNotes: { 'g700-111': [{ text: '群笔记', at: now }] },
    currentFocus: { 'g700-111': { text: '群焦点', at: now } }
  });
  writeJson(dir, 'social-v2.json', {
    conversations: {
      'group:700': { recentMessages: [{ time: now, sender: '甲', userId: '111', text: 'hi' }], memberImpressions: { 111: { traits: ['x'], lastSeenAt: now } } },
      'private:111': { recentMessages: [{ time: now, text: '私聊' }] }
    }
  });
  const { lines, logger } = logs();

  const report = runPersonaMaintenance({
    apply: true, now, ownerQQs: [], currentGroupIds: ['700'], bridgeRunning: false, logger
  });
  // 700 还在列表里，不应删除；先换成真实退群场景再跑一次。
  assert.equal(report.groups.missing.length, 0);

  const report2 = runPersonaMaintenance({
    apply: true, now: now + 1000, ownerQQs: [], currentGroupIds: ['800'], bridgeRunning: false, forceMonthly: true, logger
  });
  assert.deepEqual(report2.groups.missing.map((item) => item.groupId), ['700']);

  const dirFiles = readdirSync(join(dir, 'persona-relations'));
  assert.ok(!dirFiles.includes('g700-111.json'));
  assert.ok(!dirFiles.includes('g700.json'));
  assert.ok(dirFiles.includes('p111.json'), '私聊文件不受退群影响');

  const state = JSON.parse(readFileSync(join(dir, 'persona-state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.openLoops), ['p111']);
  assert.equal(state.selfNotes['g700-111'], undefined);
  assert.equal(state.currentFocus['g700-111'], undefined);

  const social = JSON.parse(readFileSync(join(dir, 'social-v2.json'), 'utf8'));
  assert.equal(social.conversations['group:700'], undefined);
  assert.ok(social.conversations['private:111']);

  const logFile = join(dir, 'persona-archive', 'group-deletions.ndjson');
  assert.ok(existsSync(logFile), '删除前必须写归档日志');
  const record = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0]);
  assert.equal(record.groupId, '700');
  assert.equal(record.relations.length, 1, '第一次运行已把旧群级文件移入归档，这里只剩个人关系文件');
  assert.ok(record.relations[0].name.startsWith('g700-111'));
  assert.ok(record.conversation);
  assert.ok(lines.some((line) => line.includes('delete-group') && line.includes('700')));
});

test('退群：bridge 在跑时 social 会话延后删除，不被内存副本复活', () => {
  const dir = freshState();
  const now = Date.now();
  writeJson(dir, 'social-v2.json', {
    conversations: { 'group:700': { recentMessages: [{ time: now, text: 'hi' }] } }
  });
  const report = runPersonaMaintenance({ apply: true, now, ownerQQs: [], currentGroupIds: ['800'], bridgeRunning: true });
  assert.deepEqual(report.groups.missing.map((item) => item.groupId), ['700']);
  assert.equal(report.groups.missing[0].conversationDeferred, true);
  const social = JSON.parse(readFileSync(join(dir, 'social-v2.json'), 'utf8'));
  assert.ok(social.conversations['group:700'], '延后而不是假装删掉');
  assert.ok(report.pendingSocial.includes('700'));
});

test('monthly social: 60 天无活动的群会话归档，群印象 90 天淘汰（豁免优先）', () => {
  const dir = freshState();
  const now = Date.now();
  writeRelation(dir, 'p333.json', { traits: [], recent: [] });
  writeJson(dir, 'social-v2.json', {
    conversations: {
      'group:800': {
        recentMessages: [{ time: now - 61 * DAY, sender: '甲', userId: '111', text: 'hi' }],
        memberImpressions: {
          111: { traits: ['90 天没见'], lastSeenAt: now - 100 * DAY },
          333: { traits: ['私聊过'], lastSeenAt: now - 100 * DAY },
          444: { traits: ['还常见'], lastSeenAt: now - 10 * DAY }
        }
      },
      'private:333': { recentMessages: [{ time: now - 61 * DAY, text: '私聊' }] }
    }
  });
  const report = runPersonaMaintenance({
    apply: true, now, ownerQQs: [], currentGroupIds: ['800', '900'], bridgeRunning: false, forceMonthly: true
  });
  assert.deepEqual(report.social.idle.map((item) => item.key), ['group:800']);
  assert.deepEqual(report.social.impressions.map((item) => item.qqKey), ['111']);

  const social = JSON.parse(readFileSync(join(dir, 'social-v2.json'), 'utf8'));
  assert.equal(social.conversations['group:800'], undefined);
  assert.ok(social.conversations['private:333'], '私聊会话不归档');
  const archived = JSON.parse(readFileSync(join(dir, 'persona-archive', report.stamp, 'social-conversations.json'), 'utf8'));
  assert.ok(archived.conversations['group:800']);
});

test('幂等：同一份数据连续跑两次，第二次没有新的删除动作', () => {
  const dir = freshState();
  const now = Date.now();
  writeRelation(dir, 'g700-111.json', { traits: [], recent: [{ at: now - 120 * DAY, text: 'old' }] });
  writeRelation(dir, 'g700.json', { traits: [], recent: [] });
  writeJson(dir, 'persona-state.json', { openLoops: {}, selfNotes: {}, currentFocus: {} });
  writeJson(dir, 'social-v2.json', { conversations: {} });

  const first = runPersonaMaintenance({ apply: true, now, ownerQQs: [], currentGroupIds: ['700'], bridgeRunning: false, forceMonthly: true, forceWeekly: true });
  const second = runPersonaMaintenance({ apply: true, now: now + 1000, ownerQQs: [], currentGroupIds: ['700'], bridgeRunning: false, forceMonthly: true, forceWeekly: true });
  assert.equal(first.relations.deletions.length, 1);
  assert.equal(first.relations.legacyArchive.length, 1);
  assert.equal(second.relations.deletions.length, 0);
  assert.equal(second.relations.legacyArchive.length, 0);
});

test('群印象注入优先用昵称，昵称为空才回落 QQ', () => {
  const dir = freshState();
  const now = Date.now();
  writeJson(dir, 'persona-member-names.json', { 'g777-888': { name: '老群友', at: now } });
  writeJson(dir, 'social-v2.json', {
    conversations: {
      'group:777': {
        recentMessages: [
          { time: now - 2000, sender: '旧名字', userId: '999', text: 'a' },
          { time: now - 1000, sender: '小鱼', userId: '999', text: 'b' }
        ],
        memberImpressions: {
          999: { traits: ['爱发猫图'], lastSeenAt: now },
          888: { traits: ['只在很久以前说过话'], lastSeenAt: now - 1000 },
          555: { traits: ['从来没有昵称'], lastSeenAt: now - 2000 }
        }
      }
    }
  });
  const text = groupMemberImpressions('777', 3);
  assert.ok(text.includes('小鱼：爱发猫图'), `应显示昵称，实际：${text}`);
  assert.ok(!text.includes('999：'), '不能把 QQ 号当名字');
  assert.ok(text.includes('老群友：只在很久以前说过话'), '最近消息里没有时用旁挂表里的昵称');
  assert.ok(text.includes('555：'), '哪里都没有昵称时才回落 QQ');
});

test('维护脚本把 QQ→昵称写进旁挂表（含从旧 .bak 印象键恢复）', () => {
  const dir = freshState();
  const now = Date.now();
  writeJson(dir, 'social-v2.json', {
    conversations: {
      'group:777': {
        recentMessages: [{ time: now, sender: '小鱼', userId: '999', text: 'hi' }],
        memberImpressions: { 888: { traits: ['爱发猫图'], lastSeenAt: now } }
      }
    }
  });
  writeFileSync(join(dir, 'social-v2.json.bak-20261111'), JSON.stringify({
    conversations: { 'group:777': { memberImpressions: { 老群友: { traits: ['爱发猫图'], lastSeenAt: now } } } }
  }));
  const report = runPersonaMaintenance({ apply: true, now, ownerQQs: [], currentGroupIds: ['777'], bridgeRunning: false });
  assert.equal(report.names.recovered, 1);
  const names = JSON.parse(readFileSync(join(dir, 'persona-member-names.json'), 'utf8'));
  assert.equal(names['g777-999'].name, '小鱼');
  assert.equal(names['g777-888'].name, '老群友');
});
