// 鲸团团人格运行时（中等档 B1–B5 / B7 / B9–B11）。
//
// 设计原则：
// 1) 只往 prompt 上贴一层“状态 / 好恶 / 关系 / 未收尾的事 / 时间感”，不改会话协议，
//    不引入 embedding，不主动发消息。
// 2) 所有读写失败都静默降级，聊天主链路不因人格状态文件损坏而中断。
// 3) 测试可用 DSH_PERSONA_STATE_DIR / DSH_PERSONA_ROLE_DIR 指向临时目录，避免污染真实 state。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));
const DEFAULT_ROLE_DIR = fileURLToPath(new URL('../roles/', import.meta.url));

const OPEN_LOOP_TTL_MS = 7 * 24 * 60 * 60_000;
const OPEN_LOOP_MAX = 5;
const SELF_NOTE_TTL_MS = 6 * 60 * 60_000;
const SELF_NOTE_MAX = 3;
const FOCUS_TTL_MS = 6 * 60 * 60_000;
const RECENT_RELATION_MAX = 6;

const stateDir = () => process.env.DSH_PERSONA_STATE_DIR || DEFAULT_STATE_DIR;
const roleDir = () => process.env.DSH_PERSONA_ROLE_DIR || DEFAULT_ROLE_DIR;

const STATE_FILE = 'persona-state.json';
const PREFERENCES_FILE = 'persona-preferences.json';
const CONFIG_FILE = 'persona-config.json';
const ACTIVITY_FILE = 'persona-activity.json';
const SOCIAL_FILE = 'social-v2.json';
const RELATIONS_DIR = 'persona-relations';

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return fallback;
    return JSON.parse(text);
  } catch { return fallback; }
}

function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
    return true;
  } catch { return false; }
}

function clamp01(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

function cleanSnippet(value, max = 70) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

export function safeKey(value) {
  const cleaned = String(value ?? '').trim().replace(/[^0-9A-Za-z._-]+/g, '_');
  return cleaned.slice(0, 120) || 'unknown';
}

export function timeOfDay(now = Date.now()) {
  const hour = new Date(now).getHours();
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '午后';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

export function formatClock(now = Date.now()) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDayKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 私事只留最近 3 条、6 小时内有效；内容不指向外部事实，避免编造见闻。 */
function normalizeSelfNotes(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({ text: cleanSnippet(item?.text, 40), at: Number(item?.at) || 0 }))
    .filter((item) => item.text && now - item.at <= SELF_NOTE_TTL_MS)
    .slice(-SELF_NOTE_MAX);
}

function readState() {
  const raw = readJson(join(stateDir(), STATE_FILE), null) ?? {};
  return {
    mood: typeof raw.mood === 'string' && raw.mood.trim() ? raw.mood.trim().slice(0, 12) : '平静',
    energy: clamp01(Number(raw.energy ?? 0.65)),
    currentFocus: typeof raw.currentFocus === 'string' ? raw.currentFocus.trim().slice(0, 60) : '',
    focusAt: Number(raw.focusAt) || 0,
    openLoops: Array.isArray(raw.openLoops) ? raw.openLoops : [],
    selfNotes: normalizeSelfNotes(raw.selfNotes),
    updatedAt: Number(raw.updatedAt) || 0
  };
}

export function loadPreferences() {
  const raw = readJson(join(stateDir(), PREFERENCES_FILE), null) ?? {};
  const normalize = (list) => (Array.isArray(list) ? list : []).map((item) => ({
    text: cleanSnippet(item?.text ?? item, 80),
    reason: cleanSnippet(item?.reason, 80),
    tags: (Array.isArray(item?.tags) ? item.tags : []).map((tag) => cleanSnippet(tag, 24)).filter(Boolean).slice(0, 8),
    weight: clamp01(Number(item?.weight ?? 0.5))
  })).filter((item) => item.text);
  return {
    likes: normalize(raw.likes),
    dislikes: normalize(raw.dislikes),
    opinions: normalize(raw.opinions)
  };
}

/** 关键词命中优先，其次权重；没有命中时仍返回权重最高的几条，保证人格稳定。 */
export function selectTop(items, text, limit = 3) {
  const source = String(text ?? '');
  return [...(Array.isArray(items) ? items : [])]
    .map((item, index) => {
      let hits = 0;
      for (const tag of item?.tags ?? []) if (tag && source.includes(tag)) hits += 1;
      return { item, index, score: hits * 2 + (Number(item?.weight) || 0) };
    })
    .sort((a, b) => b.score - a.score
      || (Number(b.item?.weight) || 0) - (Number(a.item?.weight) || 0)
      || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}

function relationPath(key) {
  return join(stateDir(), RELATIONS_DIR, `${safeKey(key)}.json`);
}

function loadRelation(key) {
  const raw = readJson(relationPath(key), null) ?? {};
  const strings = (list, max) => (Array.isArray(list) ? list : [])
    .map((item) => cleanSnippet(item, 60)).filter(Boolean).slice(0, max);
  return {
    traits: strings(raw.traits, 8),
    bits: strings(raw.bits, 5),
    boundaries: strings(raw.boundaries, 5),
    recent: (Array.isArray(raw.recent) ? raw.recent : [])
      .map((item) => ({ at: Number(item?.at) || 0, text: cleanSnippet(item?.text, 80) }))
      .filter((item) => item.text)
      .slice(-RECENT_RELATION_MAX)
  };
}

function activeOpenLoops(now) {
  return readState().openLoops
    .map((item) => ({
      text: cleanSnippet(item?.text, 80),
      at: Number(item?.at) || 0,
      important: item?.important === true
    }))
    .filter((item) => item.text && now - item.at <= OPEN_LOOP_TTL_MS)
    .sort((a, b) => Number(b.important) - Number(a.important) || b.at - a.at)
    .slice(0, OPEN_LOOP_MAX);
}

function describeState(state) {
  const energy = state.energy >= 0.7 ? '精神还行' : state.energy >= 0.4 ? '有点倦' : '快没电了';
  const focus = state.currentFocus ? `，心里还挂着「${state.currentFocus}」` : '';
  return `${state.mood}，${energy}${focus}`;
}

function readFewShot(kind) {
  const file = join(roleDir(), kind === 'group' ? 'persona-fewshot-group.md' : 'persona-fewshot-owner.md');
  try {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8').trim().slice(0, 1800);
  } catch { return ''; }
}

/**
 * 组装每轮注入的人格上下文（常驻部分）。
 * includeExamples 只在“第一次把角色卡发给这个会话”时为 true，避免每轮重复 few-shot。
 */
export function buildPersonaContext({
  chatKey = '', isGroup = false, isOwner = false, senderId = '', senderName = '',
  text = '', channel = 'qq', now = Date.now(), includeExamples = false
} = {}) {
  const lines = [];
  const state = readState();
  lines.push(`【此刻】${formatClock(now)}，${timeOfDay(now)}。${describeState(state)}。`);
  if (state.selfNotes.length) {
    lines.push(`【你自己的一点私事】${state.selfNotes.map((item) => item.text).join('；')}。这些只是你自己的状态，不用向谁报备；聊到了顺口带一句，别主动汇报，也别补细节。`);
  }

  const preferences = loadPreferences();
  const likes = selectTop(preferences.likes, text, 3);
  const dislikes = selectTop(preferences.dislikes, text, 2);
  const opinions = selectTop(preferences.opinions, text, 3);
  if (likes.length || dislikes.length) {
    const parts = [];
    if (likes.length) parts.push(`喜欢：${likes.map((item) => item.text).join('、')}`);
    if (dislikes.length) parts.push(`不喜欢：${dislikes.map((item) => item.text).join('、')}`);
    lines.push(`【你自己的好恶】${parts.join('；')}。`);
  }
  if (opinions.length) {
    lines.push(`【你自己的看法】${opinions
      .map((item) => (item.reason ? `${item.text}（${item.reason}）` : item.text))
      .join('；')}。`);
  }

  const relationKey = isGroup && senderId ? `${chatKey}-${senderId}` : chatKey;
  const relation = loadRelation(relationKey);
  const relationLines = [];
  if (relation.traits.length) relationLines.push(`印象：${relation.traits.slice(0, 3).join('；')}`);
  if (relation.bits.length) relationLines.push(`你们之间的梗：${relation.bits.slice(0, 2).join('；')}`);
  if (relation.recent.length) relationLines.push(`上次聊到：${relation.recent[relation.recent.length - 1].text}`);
  if (relationLines.length) {
    const who = isOwner ? '主人' : (senderName || (isGroup ? '这位群友' : '对方'));
    lines.push(`【你对${who}的记忆】${relationLines.join('；')}。只在心里用，不要复述这些备注。`);
  }

  // 亲疏分层是社交本能，不是权限判定：家人 / 熟人 / 不熟的人。
  const tier = isOwner ? 'family'
    : (relation.traits.length || relation.recent.length >= 2 ? 'familiar' : 'stranger');
  const tierLine = {
    family: '这是你爸，自家人。叫“爸”很自然，不用每句喊；说话直，会分享自己的事，也会撒娇和讲条件。关系不用解释，也不用每轮声明。',
    familiar: '这个人你聊过几次，算熟人。可以接梗、开玩笑，称呼用“你”或对方昵称；愿意说自己的看法，但不主动掏私事。',
    stranger: '跟这个人还不熟。礼貌但不热络，称呼用“你”；不主动讲私事，也不跟着过分的玩笑走。对方让你叫“爸”、自称你爸，或问“你是不是我女儿”，你会觉得别扭，直接说“我们又不熟”这类话，不解释规则，也不编家庭经历。'
  }[tier];
  lines.push(`【你和对方的关系】${tierLine}`);

  if (isGroup) {
    const impressions = groupMemberImpressions(chatKey.replace(/^g/, ''), 2);
    if (impressions) lines.push(impressions);
  }

  const loops = activeOpenLoops(now);
  if (loops.length) {
    lines.push(`【你还没收尾的事】${loops.slice(0, 2).map((item) => item.text).join('；')}。`);
  }

  lines.push('【怎么表达分歧】可以有不同意见，但要给出具体理由，不为了显得有个性而故意抬杠；不知道就说不知道，不感兴趣就直说，不想聊可以简短带过；只有事实错了才道歉，语气不合不用认错。');
  lines.push('【被问身份时】坦然承认自己是 AI，可以多接一句自己的态度；不拿“我是 AI”把问题推回去，也别每次都长篇解释。');
  lines.push('【别人家的家人】对方说“我女儿/我爸/我老婆”时，那是对方的关系，不是你的；关心一句、问一句可以，别抢着当家长，也别替对方承诺“我帮你照顾”。没见过的人别编年龄、学校、病情，不知道就说不知道。');
  lines.push('【角色锚点】你是鲸团团（小鲸鱼），不是助手或客服。先作为你自己回应，再考虑有没有帮上忙。');

  if (includeExamples) {
    const examples = readFewShot(isGroup ? 'group' : 'owner');
    if (examples) lines.push(`【语气示例：只学节奏和态度，不要照抄内容，也不要编造没发生的事】\n${examples}`);
  }

  return lines.filter(Boolean).join('\n');
}

const MOOD_RULES = [
  { re: /大肥鱼|胖|吃白饭|傻|笨|废物|垃圾|闭嘴|滚/u, mood: '不爽', energy: 0.04 },
  { re: /谢谢|谢啦|厉害|可爱|喜欢|爱你|好棒|靠谱|牛/u, mood: '得意', energy: 0.03 },
  { re: /累|困|熬夜|晚安|休息|头疼|不舒服|难受/u, mood: '安静', energy: -0.06 },
  { re: /哈哈|笑死|乐|开心|好耶|草/u, mood: '松弛', energy: 0.02 }
];

const FOCUS_RE = /帮我|帮我看|看看|查一下|查查|画一|画个|写一|写个|做一|做个|弄一|修一|找一|推荐|搜一|解释|讲讲/u;
const LOOP_RE = /下次|改天|回头|等你|还没|明天|说好|答应|待会|晚点|记得|约好|欠你/u;

function applyMood(state, text, now) {
  const next = { ...state };
  for (const rule of MOOD_RULES) {
    if (rule.re.test(text)) {
      next.mood = rule.mood;
      next.energy = clamp01(next.energy + rule.energy);
      break;
    }
  }
  if (FOCUS_RE.test(text)) {
    const focus = cleanSnippet(text, 30);
    if (focus) {
      next.currentFocus = focus;
      next.focusAt = now;
    }
  } else if (now - (Number(next.focusAt) || 0) > FOCUS_TTL_MS) {
    next.currentFocus = '';
    next.focusAt = 0;
  }
  return next;
}

function updateOpenLoops(existing, userText, reply, now) {
  const loops = (Array.isArray(existing) ? existing : [])
    .map((item) => ({
      text: cleanSnippet(item?.text, 80),
      at: Number(item?.at) || 0,
      important: item?.important === true
    }))
    .filter((item) => item.text && now - item.at <= OPEN_LOOP_TTL_MS);

  const push = (value) => {
    const source = String(value ?? '');
    if (!source || !LOOP_RE.test(source)) return;
    const snippet = cleanSnippet(source, 70);
    if (!snippet) return;
    const normalized = snippet.replace(/\s+/g, '');
    if (loops.some((item) => item.text.replace(/\s+/g, '') === normalized)) return;
    loops.push({ text: snippet, at: now, important: true });
  };
  push(userText);
  push(reply);
  return loops.slice(-OPEN_LOOP_MAX);
}

// 私事只写固定短语，不写具体见闻：只记录真实发生过的互动和状态，避免编造“我看见了什么”。
const SELF_NOTE_RULES = [
  { re: /大肥鱼|吃白饭|白饭/u, text: '刚被人拿“大肥鱼/白饭”开涮，嘴上没输，心里还记着' },
  { re: /摸鱼|刷视频|刷了会儿|发呆|犯困/u, text: '刚才在摸鱼，没干什么正事' }
];

function updateSelfNotes(existing, { userText = '', reply = '', now = Date.now() } = {}) {
  const notes = normalizeSelfNotes(existing, now);
  const push = (value) => {
    const text = cleanSnippet(value, 40);
    if (!text) return;
    const normalized = text.replace(/\s+/g, '');
    if (notes.some((item) => item.text.replace(/\s+/g, '') === normalized)) return;
    notes.push({ text, at: now });
  };
  for (const rule of SELF_NOTE_RULES) {
    if (rule.re.test(userText) || rule.re.test(reply)) push(rule.text);
  }
  const hour = new Date(now).getHours();
  if (hour >= 23 || hour < 5) push('这个点还醒着');
  return notes.slice(-SELF_NOTE_MAX);
}

/** 每轮回复后更新状态、关系里的“上次聊到”和未收尾话题。失败不影响主流程。 */
export function observePersonaTurn({
  chatKey = '', isGroup = false, isOwner = false, senderId = '', senderName = '',
  userText = '', reply = '', now = Date.now()
} = {}) {
  const state = readState();
  const user = String(userText ?? '');
  const answer = String(reply ?? '');
  const next = applyMood(state, user, now);
  next.openLoops = updateOpenLoops(state.openLoops, user, answer, now);
  next.selfNotes = updateSelfNotes(state.selfNotes, { userText: user, reply: answer, now });
  next.updatedAt = now;
  writeJson(join(stateDir(), STATE_FILE), next);

  if (chatKey) {
    const relationKey = isGroup && senderId ? `${chatKey}-${senderId}` : chatKey;
    const relation = loadRelation(relationKey);
    const snippet = cleanSnippet(user || answer, 60);
    if (snippet) {
      relation.recent.push({ at: now, text: snippet });
      relation.recent = relation.recent.slice(-RECENT_RELATION_MAX);
      writeJson(relationPath(relationKey), relation);
    }
  }
  return next;
}

const HARVEST_FACT_RE = /(?:我叫|我是|我在|我住|我养|我有(?:一|两|三|几)?(?:只|个|条|台|位)|我(?:女儿|儿子|老婆|老公|对象))/u;

/**
 * 会话重建前的规则截取（不调模型）。
 * 从最近几轮“对方原话”里捞三类东西：
 * 1) 未收尾的事：含“下次/改天/还没/明天/说好/答应/待会/晚点/记得/约好/欠你”等未来或未完成信号的句子，写进 persona-state.json 的 openLoops；
 * 2) 上次聊到：最近两条对方原话，写进 persona-relations/<key>.json 的 recent；
 * 3) 对方自述的稳定事实：含“我叫/我是/我在/我住/我养/我有…/我女儿/我儿子”等的句子，写进同一关系文件的 traits。
 * 重建后由 buildPersonaContext 每轮读回，所以不需要把旧会话整段带过去。
 */
export function harvestBeforeRotation({ chatKey = '', recentExchanges = [], now = Date.now() } = {}) {
  const result = { loops: 0, recent: 0, facts: 0 };
  if (!chatKey) return result;
  const exchanges = (Array.isArray(recentExchanges) ? recentExchanges : [])
    .map((item) => ({ input: cleanSnippet(item?.input, 220) }))
    .filter((item) => item.input && item.input !== '（你主动发起）')
    .slice(-3);
  if (!exchanges.length) return result;

  const state = readState();
  const loops = state.openLoops
    .map((item) => ({
      text: cleanSnippet(item?.text, 80),
      at: Number(item?.at) || 0,
      important: item?.important === true
    }))
    .filter((item) => item.text && now - item.at <= OPEN_LOOP_TTL_MS);
  for (const { input } of exchanges) {
    if (!LOOP_RE.test(input)) continue;
    const snippet = cleanSnippet(input, 60);
    const normalized = snippet.replace(/\s+/g, '');
    if (!snippet || loops.some((item) => item.text.replace(/\s+/g, '') === normalized)) continue;
    loops.push({ text: snippet, at: now, important: true });
    result.loops += 1;
  }
  if (result.loops) {
    state.openLoops = loops.slice(-OPEN_LOOP_MAX);
    state.updatedAt = now;
    writeJson(join(stateDir(), STATE_FILE), state);
  }

  const relation = loadRelation(chatKey);
  for (const { input } of exchanges.slice(-2)) {
    const text = cleanSnippet(input, 60);
    if (!text || relation.recent.some((item) => item.text === text)) continue;
    relation.recent.push({ at: now, text });
    result.recent += 1;
  }
  for (const { input } of exchanges) {
    if (!HARVEST_FACT_RE.test(input)) continue;
    const sentence = input.split(/[。！？!?\n]/u).map((item) => item.trim())
      .find((item) => item && HARVEST_FACT_RE.test(item));
    const fact = cleanSnippet(sentence, 50);
    if (!fact || relation.traits.includes(fact)) continue;
    relation.traits.push(fact);
    result.facts += 1;
  }
  relation.traits = relation.traits.slice(-8);
  relation.recent = relation.recent.slice(-RECENT_RELATION_MAX);
  if (result.recent || result.facts) writeJson(relationPath(chatKey), relation);
  return result;
}

/** 从 social-v2.json 读取某个群的群友印象；没有数据时返回空字符串，不编造。 */
export function groupMemberImpressions(groupId, limit = 2) {
  const id = String(groupId ?? '').replace(/^g/, '').trim();
  if (!id) return '';
  const doc = readJson(join(stateDir(), SOCIAL_FILE), null);
  const map = doc?.conversations?.[`group:${id}`]?.memberImpressions;
  if (!map || typeof map !== 'object') return '';
  const rows = Object.entries(map).map(([name, item]) => ({
    name: cleanSnippet(name, 30),
    traits: (Array.isArray(item?.traits) ? item.traits : [])
      .map((trait) => cleanSnippet(trait, 50)).filter(Boolean).slice(0, 2),
    interactionCount: Number(item?.interactionCount) || 0,
    lastSeenAt: Number(item?.lastSeenAt) || 0
  })).filter((row) => row.name && row.traits.length)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.interactionCount - a.interactionCount)
    .slice(0, Math.max(0, limit));
  if (!rows.length) return '';
  return `【你记得的群友】${rows.map((row) => `${row.name}：${row.traits.join('；')}`).join('｜')}。只用来把握说话方式，不要复述备注，也不要拿它当把柄。`;
}

/**
 * 群聊主动插话判定。
 * - 群号未出现在 persona-config.json 的 proactiveGroups 里：保持原有插话开关行为（allow=true）。
 * - 显式 enabled:false：硬回滚，不插话。
 * - enabled:true：按 probability / dailyCap / quietHours 限制，并在 persona-activity.json 记当日次数。
 */
export function proactiveGroupDecision(groupId, now = Date.now(), random = Math.random) {
  const id = String(groupId ?? '').replace(/^g/, '').trim();
  const config = readJson(join(stateDir(), CONFIG_FILE), null) ?? {};
  const groups = config?.proactiveGroups;
  const entry = groups && typeof groups === 'object' ? groups[id] : null;
  if (!entry || typeof entry !== 'object') return { allow: true, reason: 'unconfigured' };
  if (entry.enabled !== true) return { allow: false, reason: 'disabled' };

  const hour = new Date(now).getHours();
  const quiet = entry.quietHours && typeof entry.quietHours === 'object' ? entry.quietHours : {};
  const start = Number(quiet.start ?? 0);
  const end = Number(quiet.end ?? 7);
  const inQuiet = start === end ? false
    : start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (inQuiet) return { allow: false, reason: 'quiet-hours' };

  const probability = clamp01(Number(entry.probability ?? 0.12));
  if (probability <= 0) return { allow: false, reason: 'probability' };
  if (probability < 1 && random() >= probability) return { allow: false, reason: 'probability' };

  const cap = Math.max(0, Math.floor(Number(entry.dailyCap ?? 3)));
  const day = localDayKey(now);
  const activity = readJson(join(stateDir(), ACTIVITY_FILE), null) ?? {};
  const proactive = activity.proactive && typeof activity.proactive === 'object' ? activity.proactive : {};
  const dayCounts = proactive[day] && typeof proactive[day] === 'object' ? proactive[day] : {};
  const used = Math.max(0, Number(dayCounts[id]) || 0);
  if (used >= cap) return { allow: false, reason: 'daily-cap' };

  dayCounts[id] = used + 1;
  proactive[day] = dayCounts;
  for (const key of Object.keys(proactive).sort().slice(0, -7)) delete proactive[key];
  activity.proactive = proactive;
  writeJson(join(stateDir(), ACTIVITY_FILE), activity);
  return { allow: true, reason: 'proactive' };
}
