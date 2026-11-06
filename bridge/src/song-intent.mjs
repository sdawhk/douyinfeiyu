// 点歌入口的「意图层」。
//
// 背景：qq-bot.mjs 以前用 parseExistingSongCommand 的正则在模型之前直接命中
// 「来一首X / 唱X」并把整条消息吞掉，命中后只是模板回复，模型完全没参与，
// 所以「刚才那首再来一遍」「来首抒情的」这类需要上下文的说法要么被硬匹配成
// 一个假歌名，要么直接落到模板。这里把入口拆成两条路：
//   1. 确定性快路：点歌 歌名 / 翻唱 歌名 / 原唱 歌名 / 搜歌 歌名 / 唱完整首 歌名 …
//      仍然本地直接处理，不花模型调用。
//   2. 模糊口语：带明确点歌语气、但需要上下文或只有风格描述时，交给小模型输出
//      结构化 JSON（intent/action/songName/version/ack），再由桥接转成上面那
//      条确定性命令，复用原有 60s / 整首 / 变调 / 缓存链路。
//
// 本模块只做判定与文本拼装，不接触音频、不发消息，便于单测。

const CONTEXT_REFERENCE_RE = /(?:刚才|刚刚|上一首|那首|这首歌|这个版本|那个版本|换一首|换个版本|换一个版本|再来一遍|再放一遍|再发一遍|重发)/u;

// 只在「确实像在点歌」的说法上才走模型，避免纯闲聊提到“歌”也付一次模型调用的延迟。
const MODEL_MARKER_RE = /(?:来一首|来首|点歌|点唱|翻唱|原唱|搜歌|唱一首|唱一下|唱首|唱给我|给我唱|帮我唱|想听你唱|听你唱|想听(?!你|您|说|解释|讲|听|看|问)|发整首|唱整首|唱完整首|接着唱|再来一段|下一段|续唱|用语音唱|换一首|换个版本|换一个版本|换一种|再放一遍|再发一遍|重发刚才|刚才那首|刚刚那首|上一首|想听那个|想听那首|想听这首|想听这个|点《)/u;

// 换版本/再来一遍必须有上一首才能判断，否则更可能是普通聊天。
const LAST_SONG_ONLY_RE = /(?:换一首|换个版本|换一个版本|换一种|再来一遍|再放一遍|再发一遍)/u;

const COMMAND_PREFIX_RE = /^\/?(?:搜歌|原唱|翻唱|唱歌|点歌|歌单|新歌试听|唱完整首|唱整首|发整首|整首|来整首|我的点歌额度|点歌帮助|点歌说明|怎么点歌|如何点歌|点歌怎么用)(?:\s|[:：]|$)/iu;

// 歌单类命令由 song-library-commands 处理，意图层不能抢。
const LIBRARY_COMMAND_RE = /^(?:歌单(?:\s+\d{1,4})?|点歌\s*(?:\d{1,4}|[a-f0-9]{12})|试听\s*(?:\d{1,4}|[a-f0-9]{12})|新歌试听(?:\s+.+)?|好友列表(?:\s+\d{1,3})?|我的点歌额度|点歌帮助|点歌说明|怎么点歌|如何点歌|点歌怎么用)$/i;

const ACTION_SET = new Set(['cover', 'original', 'search', 'replay', 'continuation', 'full', 'clarify']);

export const SONG_INTENT_SYSTEM_PROMPT = [
  '你是 QQ 聊天的点歌意图判定器。根据【最近对话】【最近一首歌】【当前消息】判断当前消息是不是在要求机器人唱歌、放歌或找歌。',
  '只输出一行 JSON，不要解释，也不要输出任何多余文字：',
  '{"intent":"song_request或not_song","action":"cover|original|search|replay|continuation|full|clarify","songName":"","version":"","ack":""}',
  '规则：',
  '- 只有当前消息确实在要求机器人现在唱歌/放歌/找歌时 intent=song_request。讨论歌曲、评价好不好听、问歌词或歌手、说自己会唱歌、转述别人的话，都算 not_song。',
  '- action：cover=用机器人音色翻唱（默认）；original=要听原唱；search=只想看候选音源，或要求“换一版/换个版本/换一个音源”；full=要整首；replay=重发刚才那首；continuation=接着唱下一段；clarify=想听歌但没给歌名、只说了风格或情绪。',
  '- “换一个版本/换一版/换个音源”用 search：桥接现有能力只能列出其他候选，由用户再指定 #序号，不能凭空换一版。',
  '- songName 只写歌名本身：去掉书名号、版本词和候选序号。用【最近对话】或【最近一首歌】补全“刚才那首/上一首/再来一遍/换个版本”等指代；不要编造没出现过的歌名。',
  '- version 只在当前消息明确提到版本或歌手时才写（如“司凤版”“周杰伦版”），不要从最近一首歌照抄；没有就留空。',
  '- ack 是 15 字以内的自然回应，例如“《夜曲》是吧，我找找。”，不要写成命令；clarify 时 ack 必须是反问歌名。',
  '- 拿不准时 intent=not_song。',
].join('\n');

function cleanSongName(value) {
  if (typeof value !== 'string') return '';
  let name = value.normalize('NFKC').replace(/[《》「」“”"']/g, '').replace(/[\r\n\t]+/g, ' ')
    .replace(/^\s*(?:歌名|歌曲)\s*[:：]\s*/u, '').trim();
  name = name.replace(/[<>{}[\]\\]/g, '').trim();
  if (!name || name.length > 40) return '';
  if (/CQ:/i.test(name)) return '';
  return name;
}

function cleanAck(value) {
  if (typeof value !== 'string') return '';
  const ack = value.replace(/[\r\n\t]+/g, ' ').replace(/[<>{}[\]\\]/g, '').replace(/CQ:/gi, '').trim();
  if (!ack || ack.length > 30 || ack.startsWith('/')) return '';
  return ack;
}

/** 把模型返回的一行 JSON 解析成受控的意图对象；任何格式问题都返回 null，由调用方回落。 */
export function parseSongIntentReply(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const matched = text.match(/\{[\s\S]*\}/)?.[0];
  if (!matched) return null;
  let data = null;
  try { data = JSON.parse(matched); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const intent = data.intent === 'song_request' ? 'song_request' : 'not_song';
  if (intent === 'not_song') return { intent, action: 'none', songName: '', version: '', ack: '' };
  let action = ACTION_SET.has(String(data.action)) ? String(data.action) : 'cover';
  const version = typeof data.version === 'string'
    ? data.version.normalize('NFKC').replace(/[《》「」“”]/g, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 12) : '';
  let songName = cleanSongName(data.songName);
  if (songName && version && !songName.includes(version)) songName = `${songName}${version}`;
  if (action === 'clarify') songName = '';
  if (!songName && action !== 'replay' && action !== 'continuation' && action !== 'clarify') action = 'clarify';
  return { intent, action, songName, version, ack: cleanAck(data.ack) };
}

/** 明确指令（本地直接处理，不走模型）。 */
export function isExplicitSongCommand(text) {
  return COMMAND_PREFIX_RE.test(String(text ?? '').trim());
}

/**
 * 「点歌 歌名」这一条以前没有：点歌 N 是歌单，点歌 <歌名> 现在作为明确的点歌快路。
 * 纯数字/12 位哈希仍交给歌单逻辑，返回 null。
 */
export function parseNamedSongCommand(text) {
  const value = String(text ?? '').trim();
  const match = value.match(/^点歌\s*[:：]?\s*([^#\s][\s\S]{0,39})$/) ?? value.match(/^点歌\s*[:：]?\s*([^\s]+)$/);
  if (!match) return null;
  const song = match[1].trim().replace(/^[《「]([\s\S]*?)[》」]$/u, '$1').trim();
  if (!song || song.length > 40) return null;
  if (/^\d{1,4}$/.test(song) || /^[a-f0-9]{12}$/i.test(song)) return null;
  if (/[\r\n\t]/.test(song)) return null;
  const indexed = song.match(/\s+#?([1-8])$/u);
  if (!indexed) return { mode: 'ai', song, candidate: 1 };
  const base = song.slice(0, indexed.index).trim();
  if (!base) return null;
  return { mode: 'ai', song: base, candidate: Number(indexed[1]), candidateExplicit: true };
}

/** 歌名其实是「那首/刚才的/抒情的」这类指代或风格词，不能当确定歌名直接搜。 */
export function isVagueSongName(song) {
  const name = String(song ?? '').trim();
  if (!name) return false;
  if (/^(?:那首|那个|这首|这个|刚才那首|刚刚那首|上一首|前面那首|刚才的|你说的|你说的那首|那首歌)$/u.test(name)) return true;
  if (/^[\p{Script=Han}]{1,8}的$/u.test(name)) return true;
  return /^(?:抒情|欢快|伤感|温柔|轻快|慢歌|快歌|摇滚|民谣|流行|情歌|儿歌|古风|国风|dj)/iu.test(name);
}

/** 这句话是否值得交给意图模型（只有真正的点歌语气、且不是确定性命令时才为 true）。 */
export function shouldResolveSongIntent(text, { hasLastSong = false } = {}) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 100) return false;
  if (isExplicitSongCommand(value)) return false;
  if (LIBRARY_COMMAND_RE.test(value)) return false;
  if (!MODEL_MARKER_RE.test(value)) return false;
  if (!hasLastSong && LAST_SONG_ONLY_RE.test(value)) return false;
  return true;
}

/**
 * 入口决策：
 * fast  = 现有确定性链路，直接执行
 * model = 交给意图模型做判定和抽取
 * none  = 普通聊天，继续走原来的模型对话
 */
export function planSongIntake(text, { parsedCover = null, hasLastSong = false } = {}) {
  const value = String(text ?? '').trim();
  if (LIBRARY_COMMAND_RE.test(value)) return { path: 'none' };
  if (isExplicitSongCommand(value)) return { path: 'fast' };
  if (parsedCover) {
    if (!parsedCover.song) return { path: 'fast' };
    if (isVagueSongName(parsedCover.song) || CONTEXT_REFERENCE_RE.test(value)) {
      return shouldResolveSongIntent(value, { hasLastSong }) ? { path: 'model' } : { path: 'fast' };
    }
    return { path: 'fast' };
  }
  if (shouldResolveSongIntent(value, { hasLastSong })) return { path: 'model' };
  return { path: 'none' };
}

/** 把受控的意图对象转成桥接原本就认识的点歌命令；无法执行时返回 null（调用方改用自然追问）。 */
export function buildSongCommand(intent) {
  if (!intent || intent.intent !== 'song_request') return null;
  if (intent.action === 'replay') return '再发一遍';
  if (intent.action === 'continuation') return '再来一段';
  if (!intent.songName || intent.action === 'clarify') return null;
  const prefix = { cover: '翻唱', original: '原唱', search: '搜歌', full: '唱完整首' }[intent.action] ?? '翻唱';
  return `${prefix} ${intent.songName}`.slice(0, 120);
}

/** 找不到完全匹配的音源时，用人话给候选，而不是只报错。 */
export function formatSongNotFoundReply(query, results = []) {
  const asked = String(query ?? '').slice(0, 24);
  const lines = (Array.isArray(results) ? results : []).slice(0, 5).map((item, index) => {
    const seconds = Number(item?.duration);
    return `${index + 1}. ${String(item?.title ?? '（无标题）').slice(0, 80)}${seconds > 0 ? `（${Math.round(seconds)} 秒）` : ''}`;
  });
  if (!lines.length) return `按《${asked}》找了一圈，没找到能用的录音。换个更完整的歌名再试试？`;
  return `按《${asked}》找了一圈，没有完全对得上的录音。\n相近的有：\n${lines.join('\n')}\n想指定哪首就说“翻唱 ${asked} #序号”，或者把完整歌名发我。`;
}

/** 命中后先给一句自然的回应，再说清这次做多长、是不是整首。 */
export function formatSongFoundReply({ title, seconds, mode = 'ai', query = '' }) {
  const name = String(title ?? '').slice(0, 80);
  const length = Number(seconds) || 60;
  const kind = mode === 'ai' ? '翻唱' : '原唱';
  const fullHint = mode === 'ai' ? `；要整首就说“唱完整首 ${String(query ?? '').slice(0, 24)}”` : '';
  return `找到《${name}》了，先做 ${length} 秒${kind}，不是整首${fullHint}。`;
}

/**
 * 调一次意图模型，返回受控意图；调用失败或输出不合格都返回 null（调用方回落原逻辑）。
 * callModel 由桥接注入为 ({system, user}) => Promise<string>，单测可直接替换。
 */
export async function resolveSongIntent({ text, lastSong = null, recentExchanges = [], callModel } = {}) {
  if (typeof callModel !== 'function') return null;
  const history = (Array.isArray(recentExchanges) ? recentExchanges : []).slice(-3)
    .map((item) => `对方：${String(item?.input ?? '').slice(0, 120)}\n你：${String(item?.reply ?? '').slice(0, 120)}`)
    .join('\n');
  const last = lastSong
    ? `《${String(lastSong.title || lastSong.query || '').slice(0, 40)}》${lastSong.mode === 'ai' ? '（翻唱）' : lastSong.mode === 'original' ? '（原唱）' : ''}`
    : '（无）';
  const user = `【最近对话】\n${history || '（无）'}\n【最近一首歌】${last}\n【当前消息】${String(text ?? '').slice(0, 200)}`;
  let raw = '';
  try { raw = await callModel({ system: SONG_INTENT_SYSTEM_PROMPT, user }); } catch { return null; }
  return parseSongIntentReply(raw);
}
