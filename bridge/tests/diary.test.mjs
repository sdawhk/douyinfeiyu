import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIARY_ENTRY_MAX_CHARS, appendDiaryEntry, detectDiaryGap, diaryCommandDenial, diaryEntryIssue, diaryInjectionText,
  diaryTailDue, diaryToolDenial, diaryToolFilePath, formatDiaryReply, isDiaryDayKey, normalizeDiaryState,
  parseDiaryCommand, readDiaryEntries, readDiaryForTool, redactDiaryText, scoreDiaryMaterial,
  summarizeDiaryText, weekdayCn
} from '../src/diary.mjs';
import { collectDiaryFacts, collectSourcePhrases, factsToPromptText } from '../src/diary-facts.mjs';
import { buildDiaryEntryPrompt } from '../src/diary-prompt.mjs';
import { pushDiaryRepo } from '../src/diary-git.mjs';
import { outboundSourceLabel, recordOutbound } from '../src/owner-outbound-history.mjs';
import { localDayKey } from '../src/daily-task.mjs';

const ENTRY_A = '今天和爸聊了几句，还一起听了几首歌，心里挺踏实的。';
const ENTRY_B = '下午自己安静了一会儿，把想做的事慢慢理清楚了，感觉还不错。';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbridge-diary-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('日期键使用本地日期，星期中文正确', () => {
  assert.equal(localDayKey(new Date(2026, 10, 6, 23, 0)), '2026-11-06');
  assert.equal(weekdayCn('2026-11-06'), '星期五');
  assert.equal(isDiaryDayKey('2026-11-06'), true);
  assert.equal(isDiaryDayKey('2026-1-6'), false);
  assert.equal(isDiaryDayKey('../evil'), false);
});

test('追加第一条使用 ## HH:MM，UTF-8 无 BOM、LF', () => withTempDir((dir) => {
  const result = appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_A, now: new Date(2026, 10, 6, 14, 5) });
  assert.equal(result.written, true);
  const raw = readFileSync(join(dir, '2026-11-06.md'));
  assert.notEqual(raw[0], 0xEF, '不应有 UTF-8 BOM');
  assert.equal(raw.includes(Buffer.from('\r\n')), false, '不应有 CRLF');
  const text = raw.toString('utf8');
  assert.match(text, /^# 2026-11-06 星期五/m);
  assert.match(text, /^## 14:05$/m);
  assert.match(text, /今天和爸聊了几句/);
  assert.ok(text.endsWith('\n'));
}));

test('同分钟同内容跳过，同分钟不同内容并入同一小节', () => withTempDir((dir) => {
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_A });
  const again = appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_A });
  assert.equal(again.written, false);
  assert.equal(again.reason, 'duplicate');
  const merged = appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_B });
  assert.equal(merged.written, true);
  const { entries } = readDiaryEntries(dir, '2026-11-06');
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /今天和爸聊了几句/);
  assert.match(entries[0].text, /下午自己安静了一会儿/);
}));

test('条目按时间排序，条数达到上限后拒绝', () => withTempDir((dir) => {
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '18:00', text: ENTRY_A, maxEntries: 2 });
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '09:00', text: ENTRY_B, maxEntries: 2 });
  const { entries } = readDiaryEntries(dir, '2026-11-06');
  assert.deepEqual(entries.map((item) => item.time), ['09:00', '18:00']);
  const full = appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '20:00', text: '晚上又想到一点小事，顺手记下来留个念想。', maxEntries: 2 });
  assert.equal(full.written, false);
  assert.equal(full.reason, 'day-full');
}));

test('单日文件超过 12KB 时拒绝继续追加', () => withTempDir((dir) => {
  writeFileSync(join(dir, '2026-11-06.md'), `# 2026-11-06 星期五\n\n${'旧'.repeat(13000)}\n`, 'utf8');
  const result = appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '21:00', text: ENTRY_A });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'day-full');
}));

test('脱敏会去掉链接、@ 和长数字', () => {
  const redacted = redactDiaryText('看 https://example.com/a 和 @someone，电话 13800138000');
  assert.doesNotMatch(redacted, /https?:\/\//);
  assert.doesNotMatch(redacted, /@someone/);
  assert.doesNotMatch(redacted, /13800138000/);
  assert.match(redacted, /链接已略/);
});

test('条目的长度、天气、群聊、链接、数字、复述和重复校验', () => {
  const dayKey = '2026-11-06';
  assert.equal(diaryEntryIssue(ENTRY_A, { dayKey }), '');
  assert.equal(diaryEntryIssue('太短了', { dayKey }), 'too-short');
  assert.equal(diaryEntryIssue('长'.repeat(DIARY_ENTRY_MAX_CHARS + 1), { dayKey }), 'too-long');
  assert.equal(diaryEntryIssue(`${ENTRY_A}今天天气不错。`, { dayKey }), 'weather-mentioned');
  assert.equal(diaryEntryIssue(`${ENTRY_A}群里有人聊到这个。`, { dayKey }), 'group-mentioned');
  assert.equal(diaryEntryIssue(`${ENTRY_A}https://a.com/x`, { dayKey }), 'link-leaked');
  assert.equal(diaryEntryIssue(`${ENTRY_A}电话 13800138000`, { dayKey }), 'long-number-leaked');
  assert.equal(diaryEntryIssue(`${ENTRY_A}\n## 标题`, { dayKey }), 'has-heading');
  assert.equal(diaryEntryIssue(`${ENTRY_A}爸说想要一个能随身带着的日记本`, {
    dayKey, sourcePhrases: ['爸说想要一个能随身带着的日记本']
  }), 'quoted-chat');
  assert.equal(diaryEntryIssue(ENTRY_A, { dayKey, existingEntries: [ENTRY_A] }), 'duplicate');
});

test('命令解析覆盖日记、昨天、指定日期、列表、全文、最近 N 条和手动记', () => {
  assert.deepEqual(parseDiaryCommand('日记'), { kind: 'today' });
  assert.deepEqual(parseDiaryCommand('看日记'), { kind: 'today' });
  assert.deepEqual(parseDiaryCommand('昨天的日记'), { kind: 'day', dayKey: 'yesterday' });
  assert.deepEqual(parseDiaryCommand('日记 2026-11-05'), { kind: 'day', dayKey: '2026-11-05' });
  assert.deepEqual(parseDiaryCommand('日记列表'), { kind: 'list' });
  assert.deepEqual(parseDiaryCommand('日记 全文'), { kind: 'full' });
  assert.deepEqual(parseDiaryCommand('日记 全文 昨天'), { kind: 'full', dayKey: 'yesterday' });
  assert.deepEqual(parseDiaryCommand('日记 最近 5 条'), { kind: 'recent', count: 5 });
  assert.deepEqual(parseDiaryCommand('记一下'), { kind: 'write', note: '' });
  assert.deepEqual(parseDiaryCommand('记一笔 今天挺开心的'), { kind: 'write', note: '今天挺开心的' });
  assert.equal(parseDiaryCommand('今天吃什么'), null);
  assert.match(diaryCommandDenial({ isGroup: true, isOwner: true }), /私聊/);
  assert.match(diaryCommandDenial({ isGroup: false, isOwner: false }), /主人/);
  assert.equal(diaryCommandDenial({ isGroup: false, isOwner: true }), '');
});

test('读日记命令返回条目、最近 N 条、全文、列表和缺失提示', () => withTempDir((dir) => {
  const now = new Date(2026, 10, 6, 23, 30);
  assert.equal(formatDiaryReply({ kind: 'today' }, { dir, now }), '今天还没写日记，想到就记，不用等到晚上。');
  appendDiaryEntry({ dir, dayKey: '2026-11-05', time: '22:10', text: ENTRY_B });
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_A });
  const today = formatDiaryReply({ kind: 'today' }, { dir, now });
  assert.match(today, /## 14:05/);
  assert.match(today, /今天和爸聊了几句/);
  const full = formatDiaryReply({ kind: 'full' }, { dir, now });
  assert.match(full, /# 2026-11-06 星期五/);
  const recent = formatDiaryReply({ kind: 'recent', count: 2 }, { dir, now });
  assert.match(recent, /最近 2 条/);
  assert.ok(recent.indexOf('2026-11-06') < recent.indexOf('2026-11-05'), '最近的条目应排在前面');
  assert.match(formatDiaryReply({ kind: 'list' }, { dir, now }), /2026-11-06｜1 条/);
  assert.match(formatDiaryReply({ kind: 'day', dayKey: '2026-11-01' }, { dir, now }), /没有日记/);
}));

test('摘要提取标题、心情和正文', () => {
  const summary = summarizeDiaryText('# 2026-11-06 星期五\n\n心情：挺踏实\n\n今天做了点小事。', { excerptChars: 10 });
  assert.equal(summary.title, '2026-11-06 星期五');
  assert.equal(summary.mood, '挺踏实');
  assert.ok([...summary.excerpt].length <= 10);
});

test('日记注入块不超过 450 字，块首写明日期与条数，只带今天最近 2 条和昨天最后 1 条', () => withTempDir((dir) => {
  for (const [day, time] of [['2026-11-05', '21:00'], ['2026-11-06', '09:00'], ['2026-11-06', '14:05'], ['2026-11-06', '18:30']]) {
    appendDiaryEntry({ dir, dayKey: day, time, text: `${ENTRY_A}${'还想到一些零碎的小事。'.repeat(3)}` });
  }
  const block = diaryInjectionText({ dir, now: new Date(2026, 10, 6, 22, 0) });
  assert.ok([...block].length <= 450, `注入块过长：${[...block].length}`);
  assert.match(block, /【我的日记】/);
  assert.match(block, /今天是 2026-11-06 星期五，今天已经记过 3 条/);
  assert.match(block, /今天已经记过：/);
  assert.match(block, /昨天最后一笔/);
  assert.match(block, /不许说没写\/还没写\/等晚上再写/);
  assert.match(block, /不用为此调用 qq_diary_read/);
  assert.doesNotMatch(block, /## 18:30/, '不应注入 Markdown 小节');
}));

test('没有日记时注入块告知“还没记”，仍保留日期与硬规则但不许说没写', () => withTempDir((dir) => {
  const block = diaryInjectionText({ dir, now: new Date(2026, 10, 6, 12, 0) });
  assert.match(block, /今天是 2026-11-06 星期五/);
  assert.match(block, /今天还没记。/);
  assert.match(block, /上面有今天的内容时，不许说没写/);
  assert.doesNotMatch(block, /只有明确写“今天还没记”时才可以说没写/);
}));

test('断档：最后写过的那天文件没了就给提示，文件还在就不提', () => withTempDir((dir) => {
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_A });
  const file = join(dir, '2026-11-06.md');
  assert.equal(detectDiaryGap({ dir, dayKey: '2026-11-06', lastWrittenDayKey: '2026-11-06', lastFile: file }), null);

  rmSync(file);
  const gap = detectDiaryGap({ dir, dayKey: '2026-11-06', lastWrittenDayKey: '2026-11-06', lastFile: file });
  assert.deepEqual(gap, { kind: 'today-missing', dayKey: '2026-11-06' });

  const block = diaryInjectionText({ dir, now: new Date(2026, 10, 6, 22, 0), gap });
  assert.match(block, /【日记断档】2026-11-06/);
  assert.match(block, /问问爸是不是动过文件/);
  assert.doesNotMatch(diaryInjectionText({ dir, now: new Date(2026, 10, 6, 22, 0) }), /日记断档/);
}));

test('状态里保留最后写入日期，旧状态可从 lastFile 推出', () => {
  assert.equal(normalizeDiaryState({ lastWrittenDayKey: '2026-11-06' }).lastWrittenDayKey, '2026-11-06');
  assert.equal(normalizeDiaryState({ lastFile: 'D:\\deepseek\\diary\\2026-11-05.md' }).lastWrittenDayKey, '2026-11-05');
  assert.equal(normalizeDiaryState({}).lastWrittenDayKey, '');
  assert.equal(normalizeDiaryState({}).diaryGap, null);
});

test('摘录按句号边界截断并补“…”，不出现半句', () => withTempDir((dir) => {
  const text = `今天和爸聊了几句，还一起听了几首歌。${'后面还有很多零碎的细节'.repeat(10)}`;
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text });
  const block = diaryInjectionText({ dir, now: new Date(2026, 10, 6, 22, 0) });
  assert.match(block, /今天和爸聊了几句，还一起听了几首歌。…/);
  assert.doesNotMatch(block, /零碎/);
  const summary = summarizeDiaryText(text, { excerptChars: 18 });
  assert.equal(summary.excerpt, '今天和爸聊了几句，还一起听了几首歌。…');
}));

test('素材打分：点歌、抖音、连聊、亲密度、间隔和深夜加分', () => {
  const now = new Date(2026, 10, 6, 15, 0);
  assert.equal(scoreDiaryMaterial({ facts: { songSentCount: 1, hasFacts: true }, now }).qualified, true);
  assert.equal(scoreDiaryMaterial({ facts: { douyinCount: 3, hasFacts: true }, now, lastEntryAt: now.getTime() }).score, 3);
  assert.equal(scoreDiaryMaterial({ facts: { douyinCount: 1, hasFacts: true }, now, lastEntryAt: now.getTime() }).qualified, false);
  assert.equal(scoreDiaryMaterial({ facts: { hasFacts: true }, now, chatTurns: 6 }).qualified, true);
  const late = scoreDiaryMaterial({
    facts: { hasFacts: true }, now: new Date(2026, 10, 6, 22, 45), todayEntries: 0, lastEntryAt: 0
  });
  assert.equal(late.qualified, true);
  assert.deepEqual(late.reasons.sort(), ['gap', 'late']);
});

test('状态迁移为 v2，旧字段被忽略', () => {
  const state = normalizeDiaryState({
    lastSuccessDate: '2026-11-05', pendingDate: '2026-11-06', attempts: 2,
    dayKey: '2026-11-06', entries: [{ time: '14:05', chars: 26 }]
  }, new Date(2026, 10, 6, 23, 0));
  assert.equal(state.version, 2);
  assert.equal(state.dayKey, '2026-11-06');
  assert.deepEqual(state.entries, [{ time: '14:05', chars: 26 }]);
  assert.equal(state.autoCount, 0);
  assert.equal(state.chatTurns, 0);
  assert.deepEqual(state.used, { douyinAt: 0, songAt: 0, chatAt: 0 });
});

test('23:30 兜底只在当天 0 条时触发，且当天只做一次', () => {
  const now = new Date(2026, 10, 6, 23, 30);
  assert.equal(diaryTailDue({ tailTime: '23:30', now: new Date(2026, 10, 6, 23, 29), dayKey: '2026-11-06', entryCount: 0 }), false);
  assert.equal(diaryTailDue({ tailTime: '23:30', now, dayKey: '2026-11-06', entryCount: 0 }), true);
  assert.equal(diaryTailDue({ tailTime: '23:30', now, dayKey: '2026-11-06', entryCount: 1 }), false);
  assert.equal(diaryTailDue({ tailTime: '23:30', now, dayKey: '2026-11-06', entryCount: 0, tailDoneDate: '2026-11-06' }), false);
});

test('事实层按日期和 sinceAt 过滤，不读群聊，不输出链接和作者', () => withTempDir((dir) => {
  const recentRepliesPath = join(dir, 'recent-chat-replies.json');
  const douyinMemoryPath = join(dir, 'douyin-interest-memory.json');
  const songJournalPath = join(dir, 'song-delivery-journal.json');
  const at = (hour, minute = 0) => new Date(2026, 10, 6, hour, minute).getTime();
  writeFileSync(recentRepliesPath, JSON.stringify({
    p1668389572: {
      at: at(20),
      exchanges: [{ input: '你今天想写日记吗？', reply: '想呀，我想把今天记下来。' }],
      outbound: [{ at: at(22), text: '爸，早点睡。', source: 'proactive-greeting' }]
    },
    g749167100: { at: at(21), exchanges: [{ input: '群聊内容', reply: '不该出现' }] }
  }), 'utf8');
  writeFileSync(douyinMemoryPath, JSON.stringify({
    watchedVideos: [
      { title: '小猫的故事 #治愈 #感人 1周前', author: '不该出现的作者', observedAt: new Date(at(12, 6)).toISOString(), contentSummary: '一只小猫和主人的日常。' },
      { title: '早上的视频', observedAt: new Date(at(8)).toISOString(), contentSummary: '早上的内容。' },
      { title: '昨天的视频', observedAt: new Date(2026, 10, 5, 12, 0).toISOString() }
    ]
  }), 'utf8');
  writeFileSync(songJournalPath, JSON.stringify({
    p1668389572: [
      { title: '哈基咪之歌', status: 'sent', at: at(18) },
      { title: '没发成的歌', status: 'failed', at: at(19) },
      { title: '昨天的歌', status: 'sent', at: new Date(2026, 10, 5, 18, 0).getTime() }
    ]
  }), 'utf8');

  const whole = collectDiaryFacts({ dayKey: '2026-11-06', ownerId: '1668389572',
    recentRepliesPath, douyinMemoryPath, songJournalPath });
  assert.equal(whole.douyinCount, 2);
  assert.equal(whole.songCount, 2);
  assert.equal(whole.songSentCount, 1);
  assert.equal(whole.chat.count, 1);
  assert.equal(whole.douyin[0].title, '早上的视频');
  const prompt = factsToPromptText(whole);
  assert.doesNotMatch(prompt, /不该出现的作者|douyin\.com|#治愈/);
  assert.match(prompt, /主动问候/);
  assert.ok(collectSourcePhrases(whole).includes('你今天想写日记吗？'));

  const since = collectDiaryFacts({ dayKey: '2026-11-06', ownerId: '1668389572', sinceAt: at(17),
    recentRepliesPath, douyinMemoryPath, songJournalPath });
  assert.equal(since.douyinCount, 0, '早上的视频应在 sinceAt 之前');
  assert.equal(since.songCount, 2);
  assert.equal(since.chat.count, 1, '20 点的聊天仍在窗口内');
  assert.equal(since.douyinLastAt, 0);
}));

test('日记提示词是短记、要求去重，并给出“这次不记”出口', () => {
  const prompt = buildDiaryEntryPrompt({
    dayKey: '2026-11-06', at: '14:05',
    facts: { chat: { lines: [{ input: '在吗', reply: '在呢' }] }, douyin: [], songs: [], outbound: [] },
    existingEntries: [ENTRY_A]
  });
  assert.match(prompt, /2026-11-06 星期五 14:05/);
  assert.match(prompt, /50 到 150 字/);
  assert.match(prompt, /今天已经写过/);
  assert.match(prompt, /这次不记/);
  assert.match(prompt, /不写天气/);
  assert.match(prompt, /群聊/);
  assert.match(prompt, /不许补细节|不许补人物/);
});

test('只读工具：群聊、非主人、抖音通道一律拒绝且不泄漏内容', () => withTempDir((dir) => {
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: ENTRY_A });
  for (const options of [
    { isGroup: true, isOwner: true },
    { isGroup: false, isOwner: false },
    { isGroup: false, isOwner: true, channel: 'douyin' }
  ]) {
    const result = readDiaryForTool({ dir, dayKey: '2026-11-06', ...options });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /今天和爸聊了几句/);
  }
  assert.match(diaryToolDenial({ isGroup: true, isOwner: true }), /私聊/);
}));

test('只读工具：日期穿越和非法模式被拒绝', () => withTempDir((dir) => {
  for (const dayKey of ['../evil', '../../etc/passwd', '2026-11-06/../../x', '2026-1-6', '']) {
    const result = readDiaryForTool({ dir, dayKey, isOwner: true, auditPath: '' });
    if (dayKey === '') {
      assert.equal(result.ok, true, '空日期默认今天');
    } else {
      assert.equal(result.ok, false);
      assert.match(result.error, /日期/);
    }
  }
  assert.equal(diaryToolFilePath(dir, '../evil'), null);
  assert.equal(readDiaryForTool({ dir, mode: 'whole-month', isOwner: true, auditPath: '' }).ok, false);
}));

test('只读工具：超长内容截断到 800 字以内并注明', () => withTempDir((dir) => {
  writeFileSync(join(dir, '2026-10-01.md'), `# 2026-10-01 星期四\n\n${'长'.repeat(2000)}\n`, 'utf8');
  const result = readDiaryForTool({ dir, dayKey: '2026-10-01', mode: 'full', isOwner: true, auditPath: '' });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok([...result.text].length <= 800, `超长：${[...result.text].length}`);
  assert.match(result.text, /已截断/);
}));

test('手动补记放宽天气和长数字，但仍拒绝群聊、链接和 @', () => {
  const dayKey = '2026-11-06';
  const manual = { dayKey, sourcePhrases: [], minChars: 4, allowWeather: true, allowLongNumbers: true };
  const weatherAndPhone = '今天下雨了，气温只有 12 度，爸说他的电话是 13800138000。';
  assert.equal(diaryEntryIssue(weatherAndPhone, manual), '');
  assert.equal(diaryEntryIssue(weatherAndPhone, { dayKey, minChars: 4 }), 'weather-mentioned');
  assert.equal(diaryEntryIssue('群里有人聊到这个，大家都在笑。', manual), 'group-mentioned');
  assert.equal(diaryEntryIssue('今天看了 https://example.com 挺有意思。', manual), 'link-leaked');
  assert.equal(diaryEntryIssue('今天想 @小明 一起吃饭。', manual), 'at-leaked');
});

test('点歌成功写进出站账本，失败不记，来源标签为“点歌”', () => {
  const at = Date.now();
  const list = recordOutbound([], { sent: true, text: '给爸唱了《生僻字》', source: 'song-notice', at, now: at });
  assert.equal(list.length, 1);
  assert.equal(outboundSourceLabel(list[0].source), '点歌');
  const failed = recordOutbound(list, { sent: false, text: '给爸唱了《没发成的歌》', source: 'song-notice', at, now: at });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].text, '给爸唱了《生僻字》');
});

test('日记素材注入块能出现“点歌”来源标签', () => withTempDir((dir) => {
  const recentRepliesPath = join(dir, 'recent-chat-replies.json');
  const at = new Date(2026, 10, 6, 14, 0).getTime();
  writeFileSync(recentRepliesPath, JSON.stringify({
    p1668389572: {
      at,
      exchanges: [],
      outbound: [{ at, text: '给爸唱了《生僻字》', source: 'song-notice' }]
    }
  }), 'utf8');
  const facts = collectDiaryFacts({
    dayKey: '2026-11-06', ownerId: '1668389572', recentRepliesPath,
    douyinMemoryPath: join(dir, 'missing-douyin.json'), songJournalPath: join(dir, 'missing-songs.json')
  });
  assert.equal(facts.outbound[0].label, '点歌');
  assert.match(factsToPromptText(facts), /点歌：给爸唱了《生僻字》/);
  const prompt = buildDiaryEntryPrompt({ dayKey: '2026-11-06', at: '14:05', facts });
  assert.match(prompt, /点歌：给爸唱了《生僻字》/);
}));

test('只读工具：不存在的日期、最近 N 条顺序和审计', () => withTempDir((dir) => {
  const auditPath = join(dir, 'audit.jsonl');
  const missing = readDiaryForTool({ dir, dayKey: '2020-01-01', isOwner: true, auditPath, now: new Date(2026, 10, 6, 15, 0) });
  assert.equal(missing.ok, true);
  assert.match(missing.text, /没有日记/);
  assert.doesNotMatch(missing.text, /可用 mode=day/, '今天 0 条时不补提示');

  appendDiaryEntry({ dir, dayKey: '2026-11-05', time: '22:10', text: ENTRY_B });
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '09:00', text: ENTRY_A });
  appendDiaryEntry({ dir, dayKey: '2026-11-06', time: '14:05', text: '下午又想到一点小事，顺手记下来，留着以后看。' });
  const missingWithToday = readDiaryForTool({ dir, dayKey: '2020-01-01', isOwner: true, auditPath, now: new Date(2026, 10, 6, 15, 0) });
  assert.match(missingWithToday.text, /2020-01-01 那天没有日记。/);
  assert.match(missingWithToday.text, /今天（2026-11-06）有 2 条，可用 mode=day 查看/);
  const recent = readDiaryForTool({ dir, mode: 'recent', count: 2, isOwner: true, qq: '1668389572', auditPath });
  assert.equal(recent.ok, true);
  const lines = recent.text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /2026-11-06 14:05/);
  assert.match(lines[1], /2026-11-06 09:00/);

  const day = readDiaryForTool({ dir, dayKey: '2026-11-06', isOwner: true, qq: '1668389572', auditPath });
  assert.match(day.text, /2026-11-06 星期五（2 条）/);
  const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(audit.some((item) => item.qq === '1668389572' && item.dayKey === '2026-11-06' && item.mode === 'day'));
  assert.ok(audit.every((item) => !JSON.stringify(item).includes('今天和爸聊了几句')), '审计不记录正文');
}));

function fakeGit({ changes = false, ahead = 0, pushFails = 0 } = {}) {
  const calls = [];
  let pushes = 0;
  const run = async (dir, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return { ok: true, code: 0, stdout: 'true', stderr: '' };
    if (args[0] === 'add') return { ok: true, code: 0, stdout: '', stderr: '' };
    if (args[0] === 'diff') return { ok: !changes, code: changes ? 1 : 0, stdout: '', stderr: '' };
    if (args[0] === 'commit') return { ok: true, code: 0, stdout: '[main abc1234] diary', stderr: '' };
    if (args[0] === 'rev-list') return { ok: true, code: 0, stdout: String(ahead), stderr: '' };
    if (args.includes('push')) {
      if (pushes < pushFails) {
        pushes += 1;
        return { ok: false, code: 128, stdout: '', stderr: 'proxy refused' };
      }
      pushes += 1;
      return { ok: true, code: 0, stdout: '', stderr: 'To https://gitee.com/suyangkun/fishys-diary.git' };
    }
    return { ok: false, code: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
  };
  return { run, calls };
}

test('日记推送：没有变更就不提交也不推送', async () => {
  const { run, calls } = fakeGit({ changes: false, ahead: 0 });
  const result = await pushDiaryRepo({ dir: 'D:/deepseek/diary', dayKey: '2026-11-06', run });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(calls.some((line) => line.startsWith('commit')), false);
  assert.equal(calls.some((line) => line.startsWith('push')), false);
});

test('日记推送：有变更时提交当天日记并常规推送成功', async () => {
  const { run, calls } = fakeGit({ changes: true, pushFails: 0 });
  const result = await pushDiaryRepo({ dir: 'D:/deepseek/diary', dayKey: '2026-11-06', run });
  assert.equal(result.ok, true);
  assert.equal(result.viaBypass, false);
  assert.ok(calls.includes('add --all -- .'));
  assert.ok(calls.includes('commit -m diary: 2026-11-06'));
  assert.ok(calls.includes('push origin HEAD'));
  assert.equal(calls.some((line) => line.includes('http.proxy=')), false);
});

test('日记推送：常规推送失败后清空代理重试成功', async () => {
  const { run, calls } = fakeGit({ changes: true, pushFails: 1 });
  const result = await pushDiaryRepo({ dir: 'D:/deepseek/diary', dayKey: '2026-11-06', run });
  assert.equal(result.ok, true);
  assert.equal(result.viaBypass, true);
  assert.ok(calls.includes('-c http.proxy= -c https.proxy= push origin HEAD'));
});

test('日记推送：两次推送都失败时报错且不吞掉原因', async () => {
  const { run } = fakeGit({ changes: true, pushFails: 9 });
  const result = await pushDiaryRepo({ dir: 'D:/deepseek/diary', dayKey: '2026-11-06', run });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'push-failed');
  assert.match(result.detail, /proxy refused/);
});

test('日记推送：没有新改动但昨天还有未推送提交时照样推', async () => {
  const { run, calls } = fakeGit({ changes: false, ahead: 1 });
  const result = await pushDiaryRepo({ dir: 'D:/deepseek/diary', dayKey: '2026-11-06', run });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.ok(calls.includes('push origin HEAD'));
});

test('日记状态保留每日推送字段，默认从空开始', () => {
  const now = new Date(2026, 10, 6, 12, 0);
  const state = normalizeDiaryState({ lastPushDate: '2026-11-06', pushAttempts: 2, lastPushAttemptAt: 123 }, now);
  assert.equal(state.lastPushDate, '2026-11-06');
  assert.equal(state.pushAttempts, 2);
  assert.equal(state.lastPushAttemptAt, 123);
  assert.equal(normalizeDiaryState({}, now).lastPushDate, '');
});
