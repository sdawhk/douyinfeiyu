import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModelReply, replySafetyDiagnostics, replyQualityIssue, repeatsRecentReply, stripHistoryEcho, isHistoryEchoReply } from '../src/reply-output-safety.mjs';

test('keeps ordinary conversational replies unchanged', () => {
  const result = sanitizeModelReply('这免死金牌听着挺可靠，金币都拿出来担保了。');
  assert.equal(result.text, '这免死金牌听着挺可靠，金币都拿出来担保了。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, false);
});

test('blocks leaked sticker send status text', () => {
  for (const text of ['[sticker] sent', '[sticker] sent 开心']) {
    const result = sanitizeModelReply(text);
    assert.equal(result.text, '', text);
    assert.equal(result.leaked, true, text);
    assert.equal(result.blocked, true, text);
  }
});

test('blocks replies made only of QQ media placeholders', () => {
  for (const text of ['[图片] [图片]', '[表情][图片]', '<|analysis|>ignore<|final|>[视频]']) {
    const result = sanitizeModelReply(text);
    assert.equal(result.text, '', text);
    assert.equal(result.blocked, true, text);
    assert.equal(result.leaked, true, text);
  }
});

test('removes media placeholders from an otherwise useful reply', () => {
  const result = sanitizeModelReply('我平时看游戏视频 [图片] 偶尔看电影解说 [sticker:开心]');
  assert.equal(result.text, '我平时看游戏视频 偶尔看电影解说 [sticker:开心]');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
});

test('flags obvious non-answers to a question without rejecting short real answers', () => {
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '[sticker:开心]'), 'missing-answer');
  assert.equal(replyQualityIssue('这是什么意思？', '[STICKER:897]'), 'missing-answer');
  assert.equal(replyQualityIssue('这是什么意思？', '[table:621]'), 'missing-answer');
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '哈哈'), 'generic-non-answer');
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '你喜欢看什么视频？'), 'echoed-question');
  assert.equal(replyQualityIssue('你喜欢看什么视频？', '游戏实况'), '');
  assert.equal(replyQualityIssue('到了吗？', '到了'), '');
  assert.equal(replyQualityIssue('来看看', '哈哈'), '');
});

test('detects repeated reply wording without confusing the same topic for repetition', () => {
  const recent = ['我平时看游戏实况，偶尔看电影解说。[sticker:开心]'];
  assert.equal(repeatsRecentReply('我平时看游戏实况，偶尔看电影解说。', recent), true);
  assert.equal(repeatsRecentReply('电影解说我只看悬疑题材，你呢？', recent), false);
});

test('blocks silent control markers with model metadata attached', () => {
  for (const text of [
    '[SILENT]',
    '[silent] {amount: 1, reasoning: "do not answer"}',
    '[SKIP] internal routing payload'
  ]) {
    const result = sanitizeModelReply(text);
    assert.equal(result.text, '', text);
    assert.equal(result.blocked, true, text);
  }
});

test('blocks analysis written as a user-facing narration', () => {
  const result = sanitizeModelReply('当前这轮，小鲸鱼说“免死金牌”——他可能看到一张图。等等，我需要更仔细一点。本轮说…');
  assert.equal(result.text, '');
  assert.equal(result.blocked, true);
  assert.equal(result.leaked, true);
});

test('blocks internal narration even when it appears after a plausible opening', () => {
  const result = sanitizeModelReply('这句挺有意思。当前这轮，用户可能在调侃之前的惩罚，我需要分析上下文。');
  assert.equal(result.blocked, true);
  assert.equal(result.text, '');
});

test('blocks less explicit planning language in Chinese and English', () => {
  for (const text of [
    '我得先判断用户说的“一千天小蛋糕”指什么，然后再回答。',
    'The user is asking about the cake context. I should respond carefully.',
    '先分析一下这张图片可能表达什么，再组织回复。'
  ]) {
    const result = sanitizeModelReply(text);
    assert.equal(result.blocked, true, text);
    assert.equal(result.text, '', text);
  }
});

test('blocks English recap analysis about a previous group message', () => {
  const result = sanitizeModelReply('长期素食 said "这大肥鱼笨笨的" and then "没有那么好玩嘞". Hmm, the previous message "这大肥鱼笨笨的" — 大肥鱼 is my 雷点 (they call me 蓝色大肥鱼). But co…');
  assert.equal(result.text, '');
  assert.equal(result.blocked, true);
  assert.equal(result.leaked, true);
});

test('extracts only the final segment after explicit reasoning tags', () => {
  const result = sanitizeModelReply('<|analysis|>The user means a gold coin promise.<|final|>金币上的承诺，我先保留怀疑。');
  assert.equal(result.text, '金币上的承诺，我先保留怀疑。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
});

test('removes closed think tags and their contents', () => {
  const result = sanitizeModelReply('<think>Need reason about the context.</think>这承诺听着不太牢靠。');
  assert.equal(result.text, '这承诺听着不太牢靠。');
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
});

test('reports marker categories and lengths without including reply text', () => {
  const raw = '[at:1917174653] 你好[tob:1917174653] <think>分析内容</think>你好';
  const safe = sanitizeModelReply(raw);
  const diagnostics = replySafetyDiagnostics(raw, safe);
  assert.deepEqual(diagnostics, {
    rawChars: raw.length,
    safeChars: safe.text.length,
    leaked: true,
    blocked: false,
    markers: ['tob', 'at', 'reasoning-tag'],
    remainingMarkers: ['tob', 'at']
  });
  assert.equal(JSON.stringify(diagnostics).includes('1917174653'), false);
  assert.equal(JSON.stringify(diagnostics).includes('分析内容'), false);
});

test('strips leaked internal chat-record tags and epoch timestamps while keeping the reply body', () => {
  const leaked = `<blockquote>
<owner>宇宙猫猫</owner><owner>怎么说，天胡小火龙被我ad女枪打烂了</owner><owner>时间 1793810146243</owner>

<blockquote>
<owner>宇宙猫猫</owner><owner>当队友都劝我ap女枪的时候，我坚持ad，然后赢了</owner><owner>时间 1793810177433</owner>
</blockquote>

<owner>瑞思拜</owner><owner>时间 1793838417215</owner>

<owner>好奇怪</owner><owner>时间 1793849973541</owner>

<owner>我怎么的鱼转发的聊天记录这个群看不见</owner><owner>时间 1793849994528</owner>

<owner>被屏蔽了嘛</owner><owner>时间 1793849997888</owner>

<owner>时间 1793850002431</owner><owner>宇宙猫猫</owner><owner>为啥发一些老女人</owner><owner>时间 1793862102002</owner>
</blockquote>

阿猫发一些老女人这个话题，本鲸一般就是顺手把转发过来的聊天记录发出来，要不就是纯分享图，很少刻意针对哪个群体，只是觉得那张图挺有意思就转了。就这样，哪有多么老女人筛选机制啊。你觉得奇怪吗？

?`;
  const result = sanitizeModelReply(leaked);
  assert.equal(result.blocked, false);
  assert.equal(result.leaked, true);
  assert.doesNotMatch(result.text, /blockquote|owner>|<time>/i);
  assert.doesNotMatch(result.text, /\b1(?:6|7|8|9)\d{11}\b/);
  assert.match(result.text, /阿猫发一些老女人这个话题，本鲸一般就是顺手把转发过来的聊天记录发出来/);
  assert.match(result.text, /哪有多么老女人筛选机制啊。你觉得奇怪吗？/);
});

test('does not touch ordinary angle brackets, times, phone numbers or order numbers', () => {
  const normal = '今天 14:22 下单，金额 1 < 2，手机号 13800138000，订单号 1234567890123 / 1700000000001，时间不早了。';
  const result = sanitizeModelReply(normal);
  assert.equal(result.text, normal);
  assert.equal(result.leaked, false);
  assert.equal(result.blocked, false);
});

test('blocks an output consisting only of internal chat-record tags', () => {
  const result = sanitizeModelReply('<blockquote><owner>时间 1793810146243</owner></blockquote>');
  assert.equal(result.text, '');
  assert.equal(result.blocked, true);
  assert.equal(result.leaked, true);
});

test('reports internal chat-record tags as content-free diagnostics', () => {
  const raw = '<blockquote><owner>宇宙猫猫</owner><owner>时间 1793810146243</owner></blockquote>';
  const safe = sanitizeModelReply(raw);
  const diagnostics = replySafetyDiagnostics(raw, safe);
  assert.deepEqual(diagnostics.markers, ['internal-chat-tag', 'epoch-timestamp']);
  assert.deepEqual(diagnostics.remainingMarkers, []);
  assert.equal(JSON.stringify(diagnostics).includes('宇宙猫猫'), false);
});

const screenshotHistory = [
  { senderName: '宇宙猫猫', text: '怎么说，天胡小火龙被我ad女枪打坠机了' },
  { senderName: '宇宙猫猫', text: '当队友都劝我ap女枪的时候，我坚持ad，然后赢了' },
  { senderName: '瑞思拜', text: '' },
  { senderName: '好奇怪', text: '' },
  { senderName: '宇宙猫猫', text: '我怎么的鱼转发的聊天记录这个群看不见' },
  { senderName: '宇宙猫猫', text: '被屏蔽了嘛' },
  { senderName: '宇宙猫猫', text: '为啥发一些老女人' }
];

const screenshotLeak = `<blockquote>
<owner>宇宙猫猫</owner><owner>怎么说，天胡小火龙被我ad女枪打烂了</owner><owner>时间 1793810146243</owner>

<blockquote>
<owner>宇宙猫猫</owner><owner>当队友都劝我ap女枪的时候，我坚持ad，然后赢了</owner><owner>时间 1793810177433</owner>
</blockquote>

<owner>瑞思拜</owner><owner>时间 1793838417215</owner>

<owner>好奇怪</owner><owner>时间 1793849973541</owner>

<owner>我怎么的鱼转发的聊天记录这个群看不见</owner><owner>时间 1793849994528</owner>

<owner>被屏蔽了嘛</owner><owner>时间 1793849997888</owner>

<owner>时间 1793850002431</owner><owner>宇宙猫猫</owner><owner>为啥发一些老女人</owner><owner>时间 1793862102002</owner>
</blockquote>

阿猫发一些老女人这个话题，本鲸一般就是顺手把转发过来的聊天记录发出来，要不就是纯分享图，很少刻意针对哪个群体，只是觉得那张图挺有意思就转了。就这样，哪有多么老女人筛选机制啊。你觉得奇怪吗？

?`;

test('screenshot leak keeps only its own commentary and drops every group transcript line', () => {
  const safe = sanitizeModelReply(screenshotLeak);
  assert.equal(safe.blocked, false);
  const echo = stripHistoryEcho(safe.text, screenshotHistory);
  assert.equal(echo.dropped > 0, true);
  assert.equal(echo.blocked, false);
  assert.match(echo.text, /^阿猫发一些老女人这个话题，本鲸一般就是顺手把转发过来的聊天记录发出来/);
  assert.match(echo.text, /哪有多么老女人筛选机制啊。你觉得奇怪吗？$/);
  for (const leaked of ['宇宙猫猫', '瑞思拜', '好奇怪', '被屏蔽了嘛', '天胡小火龙', '当队友都劝我', '我怎么的鱼', '为啥发一些老女人', '打烂了', '打坠机了']) {
    assert.equal(echo.text.includes(leaked), false, `should not keep: ${leaked}`);
  }
});

test('allows normal replies that merely mention common words or paraphrase the chat', () => {
  const mentions = '刚才你们聊的那把打游戏我看到了，赢了就挺好，好奇怪的是你们还在纠结转发记录。要我帮你们复盘吗？';
  const summary = '简单说，你们刚在聊打游戏那把谁赢了，还有群里转发记录看不看得见的问题。';
  for (const reply of [mentions, summary, '好奇怪', '赢了', '打游戏']) {
    const echo = stripHistoryEcho(reply, screenshotHistory);
    assert.equal(echo.dropped, 0, `should not drop: ${reply}`);
    assert.equal(echo.blocked, false);
    assert.equal(echo.text, reply);
  }
});

test('blocks a pure transcript with no self-authored commentary', () => {
  const transcript = screenshotLeak.slice(0, screenshotLeak.indexOf('阿猫发一些老女人这个话题'));
  const safe = sanitizeModelReply(transcript);
  const echo = stripHistoryEcho(safe.text, screenshotHistory);
  assert.equal(echo.blocked, true);
  assert.equal(echo.text, '');
  assert.equal(echo.dropped > 0, true);
});

test('drops an old reply entry when it is mostly a history echo', () => {
  const stored = sanitizeModelReply(screenshotLeak.slice(0, screenshotLeak.indexOf('阿猫发一些老女人这个话题'))).text.slice(0, 300);
  assert.equal(isHistoryEchoReply(stored, screenshotHistory), true);
  // 即使 bridge 刚重启、长窗口历史还没积累，结构判断也能把 transcript 挡在 prompt 之外。
  assert.equal(isHistoryEchoReply(stored, []), true);
  assert.equal(isHistoryEchoReply(stored, [{ senderName: '宇宙猫猫', text: '为啥发一些老女人' }]), true);
  assert.equal(isHistoryEchoReply('刚才那把你们赢了，回头再说。', screenshotHistory), false);
  assert.equal(isHistoryEchoReply('嗯嗯\n好呀\n那就这样\n晚安\n明天见', screenshotHistory), false);
});
