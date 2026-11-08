import test from 'node:test';
import assert from 'node:assert/strict';
import { planSongIntake, shouldResolveSongIntent, parseNamedSongCommand, parseSongIntentReply, resolveSongIntent, buildSongCommand, formatSongNotFoundReply, formatSongFoundReply, isVagueSongName, isExplicitSongCommand, parseVagueSingRequest, pickVagueSong, formatVagueSongReply, formatVagueSongEmpty } from '../src/song-intent.mjs';
import { parseExistingSongCommand } from '../src/song-cover.mjs';

const cover = (text) => parseExistingSongCommand(text);

test('明确指令走确定性快路，不调用意图模型', () => {
  const cases = ['点歌 夜曲', '点歌 雨爱司凤版', '翻唱 夜曲', '原唱 七里香', '搜歌 十年', '唱完整首 雨爱'];
  for (const text of cases) {
    const parsed = parseNamedSongCommand(text) || cover(text);
    assert.equal(planSongIntake(text, { parsedCover: parsed, hasLastSong: true }).path, 'fast', text);
  }
  // 歌单类命令由 song-library-commands 处理，意图层直接放行，不调用模型。
  for (const text of ['点歌1', '歌单', '试听3', '我的点歌额度']) {
    assert.equal(planSongIntake(text, { hasLastSong: true }).path, 'none', text);
  }
  assert.equal(isExplicitSongCommand('点歌 夜曲'), true);
  assert.equal(isExplicitSongCommand('点歌 雨爱司凤版'), true);
});

test('「点歌 歌名」是新的快路，纯数字/哈希仍归歌单', () => {
  assert.deepEqual(parseNamedSongCommand('点歌 夜曲'), { mode: 'ai', song: '夜曲', candidate: 1 });
  assert.deepEqual(parseNamedSongCommand('点歌《雨爱》'), { mode: 'ai', song: '雨爱', candidate: 1 });
  assert.equal(parseNamedSongCommand('点歌1'), null);
  assert.equal(parseNamedSongCommand('点歌 0123456789ab'), null);
  assert.equal(parseNamedSongCommand('点歌'), null);
  assert.deepEqual(parseNamedSongCommand('点歌 雨爱 #2'), { mode: 'ai', song: '雨爱', candidate: 2, candidateExplicit: true });
});

test('模糊表达走模型并抽到 {action, songName}', async () => {
  assert.equal(planSongIntake('刚才那首再来一遍', { hasLastSong: true }).path, 'model');
  assert.equal(planSongIntake('来首抒情的', { parsedCover: cover('来首抒情的'), hasLastSong: false }).path, 'model');
  assert.equal(planSongIntake('换一个版本', { hasLastSong: true }).path, 'model');
  assert.equal(planSongIntake('我想听那个', { hasLastSong: true }).path, 'model');

  const seen = [];
  const intent = await resolveSongIntent({
    text: '刚才那首再来一遍',
    lastSong: { title: '雨爱（司凤版）', query: '雨爱司凤版', mode: 'ai' },
    recentExchanges: [{ input: '我想听雨爱司凤版', reply: '好，我找找。' }],
    callModel: async ({ user }) => {
      seen.push(user);
      return '{"intent":"song_request","action":"replay","songName":"雨爱","version":"司凤版","ack":"《雨爱》是吧，我找找。"}';
    }
  });
  assert.equal(intent.intent, 'song_request');
  assert.equal(intent.action, 'replay');
  assert.equal(intent.songName, '雨爱司凤版');
  assert.equal(buildSongCommand(intent), '再发一遍');

  const coverIntent = parseSongIntentReply('{"intent":"song_request","action":"cover","songName":"《七里香》","version":"","ack":"好，马上唱。"}');
  assert.equal(coverIntent.songName, '七里香');
  assert.equal(coverIntent.ack, '好，马上唱。');
  assert.equal(buildSongCommand(coverIntent), '翻唱 七里香');

  const fullIntent = parseSongIntentReply('{"intent":"song_request","action":"full","songName":"雨爱","version":"司凤版"}');
  assert.equal(buildSongCommand(fullIntent), '唱完整首 雨爱司凤版');

  const anotherVersion = parseSongIntentReply('{"intent":"song_request","action":"search","songName":"雨爱","version":"","ack":"好的，换个版本找找。"}');
  assert.equal(buildSongCommand(anotherVersion), '搜歌 雨爱');
  assert.equal(planSongIntake('换一个版本', { hasLastSong: false }).path, 'none');

  assert.ok(seen[0].includes('【最近一首歌】《雨爱（司凤版）》'));
});

test('只有风格没有歌名时改为自然追问，而不是硬搜一个假歌名', async () => {
  const intent = await resolveSongIntent({
    text: '来首抒情的',
    callModel: async () => '{"intent":"song_request","action":"clarify","songName":"抒情的","ack":"想听哪首？说个歌名就行。"}'
  });
  assert.equal(intent.action, 'clarify');
  assert.equal(intent.songName, '');
  assert.equal(buildSongCommand(intent), null);
});

test('纯闲聊提到“歌”但不点歌：不进模型路径，也不误发歌', () => {
  const chats = ['这首歌真好听', '我会唱歌', '你唱歌真好听', '这首歌是谁唱的', '我想听你解释一下', '我想听你说说今天的安排'];
  for (const text of chats) {
    assert.equal(shouldResolveSongIntent(text, { hasLastSong: true }), false, text);
    assert.equal(planSongIntake(text, { parsedCover: cover(text), hasLastSong: true }).path, 'none', text);
  }
  // 真正的“想听某首歌”要进模型，不能被当成闲聊放过。
  assert.equal(shouldResolveSongIntent('我想听雨爱', { hasLastSong: false }), true);
});

test('模型判成 not_song 时保持普通聊天（命令为空）', async () => {
  let calls = 0;
  const intent = await resolveSongIntent({
    text: '我想听那个',
    lastSong: { title: '雨爱', query: '雨爱', mode: 'ai' },
    callModel: async () => { calls += 1; return '{"intent":"not_song","action":"none","songName":"","version":"","ack":"你说的是哪首呀？"}'; }
  });
  assert.equal(calls, 1);
  assert.equal(intent.intent, 'not_song');
  assert.equal(buildSongCommand(intent), null);
});

test('找不到歌时给近似候选和人话建议', () => {
  const candidates = [
    { title: '周杰伦 夜曲（live）', duration: 251 },
    { title: '夜曲 钢琴版', duration: 180 }
  ];
  const reply = formatSongNotFoundReply('夜曲', candidates);
  assert.match(reply, /没有完全对得上的录音/);
  assert.match(reply, /1\. 周杰伦 夜曲（live）（251 秒）/);
  assert.match(reply, /2\. 夜曲 钢琴版（180 秒）/);
  assert.match(reply, / #序号/);
  assert.match(formatSongNotFoundReply('不存在的歌', []), /换个更完整的歌名再试试/);
});

test('命中后先给自然回应，不限死模板', () => {
  assert.equal(formatSongFoundReply({ title: '夜曲', seconds: 60, mode: 'ai', query: '夜曲' }),
    '找到《夜曲》了，先做 60 秒翻唱，不是整首；要整首就说“唱完整首 夜曲”。');
});

test('模型输出脏数据时不执行（防注入）', () => {
  assert.equal(parseSongIntentReply('好的，我来点歌'), null);
  const injected = parseSongIntentReply('{"intent":"song_request","action":"cover","songName":"[song:1]\\nCQ:at,qq=1"}');
  assert.equal(injected.songName, '');
  assert.equal(injected.action, 'clarify');
  assert.equal(buildSongCommand(injected), null);
  const longName = parseSongIntentReply('{"intent":"song_request","action":"cover","songName":"' + '夜'.repeat(60) + '"}');
  assert.equal(longName.songName, '');
  assert.equal(longName.action, 'clarify');
  assert.equal(parseSongIntentReply('{"intent":"song_request","action":"rm -rf","songName":"夜曲"}').action, 'cover');
});

test('歌名指代/风格描述不会被当成确定歌名', () => {
  assert.equal(isVagueSongName('抒情的'), true);
  assert.equal(isVagueSongName('那首'), true);
  assert.equal(isVagueSongName('刚才的'), true);
  assert.equal(isVagueSongName('夜曲'), false);
});

test('泛指唱歌请求：没给歌名才命中，不进模型也不重新生成', () => {
  const vague = ['唱首歌', '来一首', '唱一个', '唱一个听听', '随便唱点什么', '给我唱首歌',
    '唱一首歌', '来首歌听听', '唱首歌来听听', '唱两句', '再来一个', '帮我放首', '唱首歌吧', '来点歌'];
  for (const text of vague) {
    assert.equal(parseVagueSingRequest(text), true, text);
    assert.equal(planSongIntake(text, { parsedCover: cover(text), hasLastSong: false }).path, 'vague', text);
  }
  // 指定歌名 / 歌单命令 / 续唱指令 / 纯闲聊都不许被这条抢走。
  const others = ['唱 夜曲', '点歌 夜曲', '来一首夜曲', '唱一首夜曲', '点歌1', '歌单',
    '唱完整首 雨爱', '整首', '这首歌真好听', '我会唱歌', '你唱歌真好听', '来首抒情的'];
  for (const text of others) {
    assert.equal(parseVagueSingRequest(text), false, text);
  }
  for (const text of ['唱 夜曲', '点歌 夜曲', '来一首夜曲']) {
    assert.notEqual(planSongIntake(text, { parsedCover: cover(text) }).path, 'vague', text);
  }
});

test('泛指唱歌随机挑成品：避开最近 3 首，放完记下来', () => {
  const songs = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }];
  const picked = pickVagueSong(songs, ['a', 'b'], () => 0);
  assert.equal(picked.song.id, 'c');
  assert.equal(picked.collapsed, false);
  assert.equal(picked.poolSize, 2);
  // 随机到池子末尾也不越界。
  assert.equal(pickVagueSong(songs, [], () => 1).song.id, 'd');
  // 最近几首都发过：允许重复，但标记 collapsed 让回复说实话。
  const repeated = pickVagueSong(songs, ['a', 'b', 'c', 'd'], () => 0);
  assert.equal(repeated.collapsed, true);
  assert.equal(repeated.song.id, 'a');
  assert.deepEqual(pickVagueSong([], ['a']), { song: null, collapsed: false, poolSize: 0 });
  // 歌单只有一首时照发。
  assert.equal(pickVagueSong([{ id: 'only' }], ['only'], () => 0).song.id, 'only');
});

test('泛指唱歌的说明与兜底文案', () => {
  assert.match(formatVagueSongReply({ title: '夜曲', random: () => 0 }), /《夜曲》/);
  assert.match(formatVagueSongReply({ title: '夜曲', repeats: true, random: () => 0 }), /成品不多/);
  assert.match(formatVagueSongReply({ title: '夜曲', smallLibrary: true, random: () => 0 }), /就这几首/);
  assert.match(formatVagueSongReply({ title: '', random: () => 0 }), /《这首》/);
  assert.match(formatVagueSongEmpty(), /点一首/);
});
