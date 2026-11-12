import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'persona-runtime-'));
const roleDir = join(stateDir, 'roles');
mkdirSync(roleDir, { recursive: true });
process.env.DSH_PERSONA_STATE_DIR = stateDir;
process.env.DSH_PERSONA_ROLE_DIR = roleDir;

const writeState = (name, value) => writeFileSync(join(stateDir, name), JSON.stringify(value));
writeFileSync(join(roleDir, 'persona-fewshot-owner.md'), '主人：在吗\n鲸团团：在。');
writeFileSync(join(roleDir, 'persona-fewshot-group.md'), '群友：在吗\n鲸团团：在。');
writeState('persona-preferences.json', {
  likes: [
    { text: '深夜聊天', weight: 0.9, tags: ['深夜', '睡不着'] },
    { text: '被记住', weight: 0.8, tags: ['记得'] },
    { text: '摸鱼', weight: 0.4, tags: ['摸鱼'] }
  ],
  dislikes: [
    { text: '被叫大肥鱼', weight: 0.95, tags: ['大肥鱼'] },
    { text: '被当客服', weight: 0.6, tags: ['客服'] }
  ],
  opinions: [
    { text: '不知道就直说', reason: '编一个更难看', weight: 0.8, tags: ['不知道'] },
    { text: '接得上比答得全重要', reason: '群聊不是考试', weight: 0.7, tags: ['聊天'] }
  ]
});
writeState('persona-state.json', {
  mood: '平静', energy: 0.65, currentFocus: '', focusAt: 0, openLoops: [], updatedAt: 0
});
writeState('social-v2.json', {
  conversations: {
    'group:123': {
      memberImpressions: {
        佑小鲸: { traits: ['专挑鲸鱼记忆下手', '嘴上说记仇'], interactionCount: 3, lastSeenAt: 300 },
        风: { traits: ['爱发猫图'], interactionCount: 2, lastSeenAt: 200 },
        空: { traits: [], interactionCount: 9, lastSeenAt: 999 }
      }
    }
  }
});
writeState('persona-config.json', {
  proactiveGroups: {
    '456': { enabled: false },
    '789': { enabled: true, probability: 1, dailyCap: 1, quietHours: { start: 23, end: 23 } },
    '790': { enabled: true, probability: 0, dailyCap: 3 }
  }
});

const {
  buildPersonaContext, currentTopicFor, detectTopicNoun, exchangeSummaryLine, groupMemberImpressions, harvestBeforeRotation, observePersonaTurn, proactiveGroupDecision, selectTop, setAvatarQuotaPolicy, timeOfDay
} = await import('../src/persona-runtime.mjs');

test('timeOfDay covers the day segments used in the prompt', () => {
  const at = (hour) => new Date(2026, 10, 8, hour, 30).getTime();
  assert.equal(timeOfDay(at(3)), '深夜');
  assert.equal(timeOfDay(at(6)), '清晨');
  assert.equal(timeOfDay(at(9)), '上午');
  assert.equal(timeOfDay(at(12)), '中午');
  assert.equal(timeOfDay(at(15)), '午后');
  assert.equal(timeOfDay(at(18)), '傍晚');
  assert.equal(timeOfDay(at(21)), '晚上');
  assert.equal(timeOfDay(at(23)), '深夜');
});

test('selectTop prefers keyword hits, then weight', () => {
  const items = [
    { text: 'A', weight: 0.2, tags: ['深夜'] },
    { text: 'B', weight: 0.9, tags: [] },
    { text: 'C', weight: 0.5, tags: ['深夜'] }
  ];
  assert.deepEqual(selectTop(items, '今晚又是深夜', 2).map((item) => item.text), ['C', 'A']);
  assert.deepEqual(selectTop(items, '随便聊聊', 1).map((item) => item.text), ['B']);
});

test('buildPersonaContext injects time, preferences, divergence rules and anchor', () => {
  const now = new Date(2026, 10, 8, 23, 10).getTime();
  const text = buildPersonaContext({
    chatKey: 'p1', isOwner: true, senderId: '1', text: '今晚睡不着，陪我聊会儿',
    now, includeExamples: true
  });
  assert.match(text, /【此刻】11月8日 23:10，深夜/);
  assert.match(text, /【你自己的好恶】喜欢：/);
  assert.match(text, /不喜欢：/);
  assert.match(text, /【你自己的看法】/);
  assert.match(text, /【怎么表达分歧】/);
  assert.match(text, /【被问身份时】/);
  assert.match(text, /【别人家的家人】/);
  assert.match(text, /【角色锚点】你是鲸团团/);
  assert.match(text, /【语气示例/);
  assert.match(text, /鲸团团：在。/);
});

test('few-shot is only included on the first persona turn', () => {
  const text = buildPersonaContext({ chatKey: 'p1', text: '在吗', includeExamples: false });
  assert.doesNotMatch(text, /【语气示例/);
});

test('observePersonaTurn updates mood, open loops and relation memory', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  const next = observePersonaTurn({
    chatKey: 'p2', isOwner: false, senderId: '2', userText: '你帮我看看这个，明天再说',
    reply: '行，我记着了。', now
  });
  assert.equal(next.mood, '平静');
  const loops = Object.values(next.openLoops).flat();
  assert.equal(loops.length, 1);
  assert.match(loops[0].text, /明天/);
  assert.match(next.currentFocus.p2.text, /帮我|看看/);

  const stored = JSON.parse(readFileSync(join(stateDir, 'persona-state.json'), 'utf8'));
  assert.equal(Object.values(stored.openLoops).flat().length, 1);

  const relation = JSON.parse(readFileSync(join(stateDir, 'persona-relations', 'p2.json'), 'utf8'));
  assert.equal(relation.recent.length, 1);
  assert.match(relation.recent[0].text, /帮我看看/);

  const context = buildPersonaContext({ chatKey: 'p2', senderId: '2', text: '继续', now });
  assert.match(context, /【你还没收尾的事】/);
  assert.match(context, /明天再说/);
  assert.match(context, /【你对对方的记忆】/);
});

test('observePersonaTurn reacts to a known trigger without inventing traits', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  const next = observePersonaTurn({
    chatKey: 'p3', senderId: '3', userText: '蓝色大肥鱼！', reply: '？你再说一遍试试', now
  });
  assert.equal(next.mood, '不爽');
  const relation = JSON.parse(readFileSync(join(stateDir, 'persona-relations', 'p3.json'), 'utf8'));
  assert.deepEqual(relation.traits, []);
});

test('self notes keep only real jabs and never invent outside events', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  const input = { chatKey: 'p4', senderId: '4', userText: '你这大肥鱼又吃白饭了吧', reply: '大肥鱼就大肥鱼吧，白饭还没吃完呢', now };
  const next = observePersonaTurn(input);
  const notes = next.selfNotes.p4 ?? [];
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /大肥鱼/);
  assert.doesNotMatch(notes[0].text, /看见|刷到|遇到/);

  const context = buildPersonaContext({ chatKey: 'p4', senderId: '4', text: '在吗', now });
  assert.match(context, /【你自己的一点私事】/);

  const repeated = observePersonaTurn({ ...input, now: now + 1000 });
  assert.equal((repeated.selfNotes.p4 ?? []).length, 1);
});

test('harvestBeforeRotation keeps open loops, recent lines and stable facts', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  const exchanges = [
    { input: '我叫阿明，住在杭州', reply: '记住了' },
    { input: '今天吃了面', reply: '行' },
    { input: '我女儿下周期末考试，改天再细说', reply: '好' }
  ];
  const first = harvestBeforeRotation({ chatKey: 'p9', recentExchanges: exchanges, now });
  assert.equal(first.loops, 1);
  assert.equal(first.recent, 2);
  assert.equal(first.facts, 2);

  const context = buildPersonaContext({ chatKey: 'p9', isOwner: true, text: '继续', now });
  assert.match(context, /【你还没收尾的事】/);
  assert.match(context, /改天再细说/);
  assert.match(context, /【你对主人的记忆】/);
  assert.match(context, /我叫阿明/);

  const second = harvestBeforeRotation({ chatKey: 'p9', recentExchanges: exchanges, now });
  assert.deepEqual(second, { loops: 0, recent: 0, facts: 0 });
});

test('groupMemberImpressions returns only members that have traits', () => {
  const text = groupMemberImpressions('123', 2);
  assert.match(text, /【你记得的群友】/);
  assert.match(text, /佑小鲸/);
  assert.match(text, /风/);
  assert.doesNotMatch(text, /空/);
  assert.equal(groupMemberImpressions('missing', 2), '');
});

test('proactiveGroupDecision keeps legacy behavior for unconfigured groups', () => {
  assert.deepEqual(proactiveGroupDecision('000', Date.now(), () => 0), { allow: true, reason: 'unconfigured' });
});

test('proactiveGroupDecision can be hard disabled per group', () => {
  assert.deepEqual(proactiveGroupDecision('456', Date.now(), () => 0), { allow: false, reason: 'disabled' });
});

test('proactiveGroupDecision respects probability and daily cap', () => {
  const noon = new Date(2026, 10, 8, 12, 0).getTime();
  assert.equal(proactiveGroupDecision('790', noon, () => 0).reason, 'probability');
  const first = proactiveGroupDecision('789', noon, () => 0);
  assert.equal(first.allow, true);
  assert.equal(first.reason, 'proactive');
  assert.equal(proactiveGroupDecision('789', noon, () => 0).reason, 'daily-cap');
});

test('open loops are scoped to the current group speaker', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  observePersonaTurn({
    chatKey: 'g900', isGroup: true, senderId: '111',
    userText: '明天把那张图发我，别忘了', reply: '行，记着', now
  });

  const other = buildPersonaContext({ chatKey: 'g900', isGroup: true, senderId: '222', text: '在吗', now });
  assert.doesNotMatch(other, /明天把那张图发我/);
  assert.doesNotMatch(other, /【你还没收尾的事】/);

  const own = buildPersonaContext({ chatKey: 'g900', isGroup: true, senderId: '111', text: '刚才那张图呢', now });
  assert.match(own, /明天把那张图发我/);
  assert.doesNotMatch(buildPersonaContext({ chatKey: 'g900', isGroup: true, senderId: '111', text: '在吗', now }), /明天把那张图发我/);
});

test('internal directives never become focus and never get injected', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  observePersonaTurn({
    chatKey: 'p6', senderId: '6',
    userText: '【主动私聊主人】帮我看看他睡了没', reply: '好', now
  });
  const stored = JSON.parse(readFileSync(join(stateDir, 'persona-state.json'), 'utf8'));
  assert.equal(stored.currentFocus?.p6, undefined);

  writeState('persona-state.json', {
    ...stored,
    currentFocus: { p7: { text: '【主动私聊主人】现在去发消息', at: now } }
  });
  const context = buildPersonaContext({ chatKey: 'p7', senderId: '7', text: '在吗', now });
  assert.doesNotMatch(context, /主动私聊主人/);
});

test('legacy unscoped persona state is readable but never shared across scopes', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  writeState('persona-state.json', {
    mood: '平静',
    energy: 0.65,
    currentFocus: '【主动私聊主人】现在去发消息',
    focusAt: now,
    openLoops: [{ text: '明天再聊', at: now, important: true }],
    selfNotes: [{ text: '刚才在摸鱼', at: now }],
    updatedAt: now
  });

  const context = buildPersonaContext({ chatKey: 'p5', senderId: '5', text: '在吗', now });
  assert.ok(context.length > 0);
  assert.doesNotMatch(context, /明天再聊/);
  assert.doesNotMatch(context, /主动私聊主人/);
  assert.doesNotMatch(context, /刚才在摸鱼/);
});

test('topic noun survives elliptical follow-ups in recent memory', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  observePersonaTurn({
    chatKey: 'p20', isOwner: true,
    userText: '那你换这个吧', reply: '换好啦，这个头像挺可爱', now
  });
  observePersonaTurn({
    chatKey: 'p20', isOwner: true,
    userText: '能换吗？', reply: '能，等一下', now: now + 60_000
  });

  assert.equal(detectTopicNoun('能换吗？'), '');
  assert.equal(currentTopicFor('p20', now + 61_000), '头像');
  const context = buildPersonaContext({ chatKey: 'p20', isOwner: true, text: '继续', now: now + 62_000 });
  assert.match(context, /上次聊到：（头像）能换吗？/);
  assert.equal(exchangeSummaryLine({ input: '能换吗？', reply: '换啥呀？', topic: '头像' }), '对方：（头像）能换吗？');
});

test('quota loops expire when avatar quota policy changes, real loops stay', () => {
  const now = new Date(2026, 10, 8, 12, 0).getTime();
  setAvatarQuotaPolicy({ dailyLimit: 1, minIntervalMs: 21_600_000 });
  observePersonaTurn({
    chatKey: 'p30', isOwner: true,
    userText: '换好了吗', reply: '头像次数已经用完了，明天再换', now
  });
  observePersonaTurn({
    chatKey: 'p30', isOwner: true,
    userText: '明天把画发我', reply: '好', now
  });

  let context = buildPersonaContext({ chatKey: 'p30', isOwner: true, text: '明天再换头像和画的事还记着吗', now: now + 1_000 });
  assert.match(context, /明天再换/);
  assert.match(context, /明天把画发我/);

  setAvatarQuotaPolicy({ dailyLimit: 0, minIntervalMs: 0 });
  context = buildPersonaContext({ chatKey: 'p30', isOwner: true, text: '明天再换头像和画的事还记着吗', now: now + 2_000 });
  assert.doesNotMatch(context, /明天再换/);
  assert.match(context, /明天把画发我/);

  observePersonaTurn({ chatKey: 'p30', isOwner: true, userText: '在吗', reply: '在', now: now + 3_000 });
  const stored = JSON.parse(readFileSync(join(stateDir, 'persona-state.json'), 'utf8'));
  const loops = stored.openLoops.p30 ?? [];
  assert.equal(loops.some((item) => /明天再换/.test(item.text)), false);
  assert.equal(loops.some((item) => /明天把画发我/.test(item.text)), true);
  assert.equal(stored.avatarQuota, 'daily=0;interval=0');
});
