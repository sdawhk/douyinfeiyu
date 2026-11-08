// 画图：provider 抽象 + 冷却/限额 + 内容审核 + 本地落盘 + base64 发送段。
// 默认走 pollinations（免 Key）；provider 字段可切到 openai 兼容接口（如智谱）。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inspectDrawPrompt, shouldBlockImageStorage } from './image-content-policy.mjs';
import { sha256Of, writeImageMeta } from './image-gen-meta.mjs';
import { measureComposition, measureHeadBodyRatio, planOutpaintOffsets } from './image-composition.mjs';
import { outpaintImage, OUTPAINT_MODEL, OUTPAINT_COST_CNY } from './image-outpaint.mjs';

// ── 分层提示词模板（2026-11 针对 qwen-image-3.0 重写）────────────────────────
// 九层可独立替换，拼装顺序固定：quality → character → faceStyle → composition → hairstyle → vibe → expression → clothing → lighting → background。
// config.imageGen.promptLayers 可按字段整段覆盖任意一层，字段名见 PROMPT_LAYER_LABELS。
// faceStyle 紧跟身份层：先锁“脸怎么画”，再谈构图；表情层只负责动作。
// 构图第 4 位：画质、身份与脸部画法之后立刻给景别/机位/占比/留白，确保不被截断；
// 背景、光影放在最后，被压缩时优先牺牲它们。
export const PROMPT_LAYER_ORDER = ['quality', 'character', 'faceStyle', 'composition', 'hairstyle', 'vibe', 'expression', 'clothing', 'lighting', 'background'];

// 字符预算：qwen-image 正向 800 Token、负向 500 字符，超出会被接口静默截断。
// 这里按“宁可留余量”取 780 / 480，并作为硬断言；超限直接报错，不再悄悄截。
export const PROMPT_BUDGET = Object.freeze({
  positive: Object.freeze({ min: 700, max: 780 }),
  negative: Object.freeze({ min: 450, max: 480 })
});

/** 实际要发给接口的字符数：按 Unicode 码点计，中文一字算一个。 */
export function measurePromptChars(parts = {}) {
  return {
    positive: Array.from(String(parts.positive ?? '')).length,
    negative: Array.from(String(parts.negative ?? '')).length
  };
}

/** 超限即抛错：根因是以前没人发现被截断，这里不允许再静默通过。 */
export function assertPromptBudget(parts = {}) {
  const chars = measurePromptChars(parts);
  const issues = [];
  if (chars.positive > PROMPT_BUDGET.positive.max) {
    issues.push(`正向 ${chars.positive} 字符，超过上限 ${PROMPT_BUDGET.positive.max}`);
  }
  if (chars.negative > PROMPT_BUDGET.negative.max) {
    issues.push(`负向 ${chars.negative} 字符，超过上限 ${PROMPT_BUDGET.negative.max}`);
  }
  if (issues.length) throw new Error(`[imagegen] 提示词超限，拒绝发送：${issues.join('；')}`);
  return chars;
}

// 比例重画的强化约束：与人物层同口径，但更短更硬，只压头身比。
const PROPORTION_RETRY_LOCK = '严格头身比：头高占全身 1/6.5–1/7，腿长不超过 3.5 头高，禁止八头身九头身';

/** 比例检测配置：默认开启，超过 7.6 头身重画一次。 */
export function normalizeProportionCheckConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled !== false,
    maxHeads: clampFloat(source.maxHeads, 5, 12, 7.6)
  };
}

/**
 * 头身比超标时重画用的提示词：先丢背景、光影层腾预算，再追加硬约束。
 * 返回结构与 buildPromptParts 一致，可直接送 provider。
 */
export function strengthenProportionPrompt(parts = {}) {
  const segments = String(parts.positive ?? '').split('；');
  const kept = segments.filter((segment) => !/^【(?:背景与氛围|光影)】/.test(segment));
  const base = kept.join('；');
  const suffix = `【严格比例】${PROPORTION_RETRY_LOCK}`;
  const room = PROMPT_BUDGET.positive.max - measurePromptChars({ positive: `${base}；` }).positive;
  const positive = room > 0 ? `${base}；${Array.from(suffix).slice(0, room).join('')}` : base;
  return { positive, negative: String(parts.negative ?? ''), descriptionTrimmed: parts.descriptionTrimmed === true };
}

export const PROMPT_LAYER_LABELS = {
  quality: '画质与风格',
  character: '固定人物，不可替换',
  faceStyle: '脸部画法',
  hairstyle: '发型（可变）',
  vibe: '气质与年龄表现',
  expression: '表情',
  clothing: '服装',
  composition: '构图与视角',
  lighting: '光影',
  background: '背景与氛围'
};

// 固定人物：DeepSeek 女化形象的身份特征（发色/眼型/脸型/耳饰/体型）。
// 2026-11 按主人给的新锚点图重写：宝蓝长发、半杏眼、鹅蛋脸、蓝鳍耳饰，不再有呆毛。
// 服装（outfit）、尾巴（tail）与表情（expression）都是可切换字段，都不得改变这里的脸与发型。
// 比例全部写成占全高的百分比：腰线 33%–35%、膝 72%–74%、肩 1.9 / 胯 1.5 头宽，
// 不再用“略高于中点/略低于中点”这种和中点绑定的含糊说法（中点=50% 会把躯干拉长）。
const CHARACTER_BASE_CLAUSES = [
  'DeepSeek 女化形象，禁止替换',
  '成年女性，鹅蛋脸带婴儿肥，头高占全身 1/6.5–1/7，腰线在全高 33%–35%，膝在 72%–74%，腿长（胯到脚底）占 43%–46%',
  '肩宽 1.9 头宽、胯宽 1.5 头宽',
  '纯宝蓝长发，发型见发型层',
  '细长半杏眼、眼尾微垂，深海蓝瞳',
  '鲸鳍状耳，外深蓝内白褶',
  '鲸鱼造型发饰至少两处',
  // 身份锁只写一次：后面各层不再重复这段，省下的字符留给构图。
  '五官发色瞳色不变'
];

// 尾巴三档：required=立绘正身必带，optional=构图拥挤/侧身时省略，off=完全不画。
// 写法沿用社区返修经验：数量 + 连接点 + 朝向 + 遮挡，模型会数错。
export const TAIL_MODES = ['required', 'optional', 'off'];
export const DEFAULT_TAIL_MODE = 'optional';

const TAIL_CLAUSES = {
  required: [
    '只有一条鲸尾从后侧裙摆下伸出，末端两片水平尾鳍',
    '画面里只有一条尾、两只手、两只脚'
  ],
  optional: [
    '可省略鲸尾，最多一条'
  ],
  off: [
    '不画鲸尾，身后没有尾巴'
  ]
};

// 自定义人物层里可能已经写了尾巴，按档位重写前先把旧尾巴从句剔掉，避免同段里自相矛盾。
function stripTailClauses(text) {
  let out = String(text ?? '');
  // 先精确删掉模板里生成过的整句尾巴（含“向侧后方弯曲”这类不含关键词的后续分句），
  // 再按分句兜底剔除自定义文本里的尾巴片段。
  for (const mode of TAIL_MODES) {
    for (const clause of TAIL_CLAUSES[mode]) out = out.split(clause).join('，');
  }
  out = out
    .split(/[，；]/)
    .filter((segment) => !/(?:鲸尾|鲸鱼尾|尾巴|cetacean_tail)/.test(segment))
    .join('，');
  return out
    .replace(/[，；]{2,}/g, '，')
    .replace(/^[，；\s]+|[，；\s]+$/g, '');
}

export function normalizeTailMode(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return TAIL_MODES.includes(key) ? key : DEFAULT_TAIL_MODE;
}

export function buildCharacterTemplate(tailMode = DEFAULT_TAIL_MODE, customBase = '') {
  const mode = normalizeTailMode(tailMode);
  const base = stripTailClauses(customBase) || CHARACTER_BASE_CLAUSES.join('，');
  return `${base}，${TAIL_CLAUSES[mode].join('，')}`;
}

export const CHARACTER_TEMPLATE = buildCharacterTemplate(DEFAULT_TAIL_MODE);

// ── 表情层 ─────────────────────────────────────────────────────────────────
// 表情只动眉毛、眼睛开合、瞳孔大小、嘴角与脸红；脸型/眼型/五官位置/发型发色/耳饰一律不动。
// 瞳孔高光、眼睑画法这类“怎么画”的词放 faceStyle 层，这一层只写“做什么表情”。
const EXPRESSION_IDENTITY_LOCK = '只动表情不动脸型';

export const EXPRESSIONS = {
  gentle: {
    label: '温柔浅笑',
    text: '眉毛平缓、眉尾略垂，眼睛半眯，嘴角轻扬，脸颊淡粉',
    faceHint: 'smile, closed mouth'
  },
  happy: {
    label: '开心大笑',
    text: '眉毛上扬成弯弧，眼睛弯成月牙、露出笑眼纹，嘴巴张开露出上排牙齿、嘴角明显上扬，脸颊与鼻尖泛红',
    faceHint: 'open mouth, big smile, happy'
  },
  shy: {
    label: '害羞脸红',
    text: '眉毛微微下垂、眉尾向内收，眼睛下垂视线偏向一侧，嘴角抿起小幅上扬，双颊与耳尖明显泛红',
    faceHint: 'blush, embarrassed, looking away'
  },
  pout: {
    label: '委屈撅嘴',
    text: '眉毛呈八字形向中间上方蹙起，眼睛睁到中等大小、下眼睑略微上推、眼里像含泪，嘴唇向前嘟起、嘴角向下，鼻头与脸颊微红',
    faceHint: 'pout, puffed cheeks, teary eyes'
  },
  smug: {
    label: '得意坏笑',
    text: '一侧眉毛挑起、另一侧压低，眼睛半眯，嘴角单边上扬成坏笑、露出一点犬齿，脸红很淡',
    faceHint: 'smirk, one eyebrow raised, half-closed eyes'
  },
  surprised: {
    label: '惊讶睁大眼',
    text: '眉毛高高扬起、眉形变圆，眼睛睁到最大、上下眼白露出一点、瞳孔缩小，嘴巴微张成小圆形，脸颊泛红很淡',
    faceHint: 'wide eyes, surprised, open mouth'
  },
  sleepy: {
    label: '困倦半睡',
    text: '眉毛放松平放、眉尾略下垂，眼睛半闭、目光向下发沉，嘴巴微张像打哈欠、嘴角放松下垂，眼下有淡淡青色与浅红',
    faceHint: 'sleepy, half-closed eyes, yawning'
  },
  serious: {
    label: '认真皱眉',
    text: '眉毛向中间压低、眉间有浅浅竖纹，眼睛睁到中等大小、目光正视有焦点，嘴唇抿成一条直线、嘴角平放，脸红几乎不可见',
    faceHint: 'serious, frown, closed mouth'
  }
};

export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);
export const DEFAULT_EXPRESSION = 'gentle';

// 语境关键词 → 表情。按“越具体越先匹配”的顺序排列，匹配不到就回默认温柔浅笑。
const EXPRESSION_CONTEXT_RULES = [
  { name: 'shy', re: /害羞|脸红|不好意思|羞|亲亲|抱抱|贴贴|喜欢你|想你|告白|撒娇/ },
  { name: 'pout', re: /委屈|生气|哼|坏蛋|欺负|不理你|讨厌|难过|哭|凶我|骂我|批评/ },
  { name: 'happy', re: /开心|高兴|哈哈|笑死|太好了|棒|厉害|可爱|夸|表扬|奖励|成功|恭喜/ },
  { name: 'smug', re: /得意|骄傲|当然|那是|哼哼|小看我|赢|厉害吧|羡慕吧/ },
  { name: 'surprised', re: /惊讶|震惊|居然|竟然|不会吧|真的假的|哇|天哪|突然/ },
  { name: 'sleepy', re: /困|睡|晚安|凌晨|熬夜|打哈欠|累了|疲惫/ },
  { name: 'serious', re: /认真|严肃|工作|作业|学习|考试|开会|写代码|加班|专注/ }
];

export function normalizeExpression(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (EXPRESSION_NAMES.includes(key)) return key;
  // 允许直接传中文表情名。
  const byLabel = EXPRESSION_NAMES.find((name) => EXPRESSIONS[name].label === String(value ?? '').trim());
  return byLabel || '';
}

/** 从对话上下文推断表情；没有明显情绪信号时返回默认温柔浅笑。 */
export function inferExpression(contextText) {
  const text = String(contextText ?? '');
  if (!text.trim()) return { name: DEFAULT_EXPRESSION, source: 'default' };
  for (const rule of EXPRESSION_CONTEXT_RULES) {
    if (rule.re.test(text)) return { name: rule.name, source: 'context' };
  }
  return { name: DEFAULT_EXPRESSION, source: 'default' };
}

/** 表情优先级：显式传参 → 语境推断 → 默认温柔浅笑。 */
export function resolveExpression({ expression, context } = {}) {
  const explicit = normalizeExpression(expression);
  if (explicit) return { name: explicit, source: 'explicit' };
  return inferExpression(context);
}

export function expressionLayerFor(name) {
  const item = EXPRESSIONS[normalizeExpression(name)] || EXPRESSIONS[DEFAULT_EXPRESSION];
  return `${item.label}，${item.text}，${EXPRESSION_IDENTITY_LOCK}`;
}

// ── 脸部画法层 ─────────────────────────────────────────────────────────────
// 只决定“脸怎么画”，不改身份、不改表情动作；表情层永远优先于脸部画法。
// 只落有两批样张支撑的两档，其余先留名字占位（词条为空），避免没样本也硬写。
export const FACE_STYLE_PRIORITY = '表情动作优先，脸部画法只决定表现方式';

export const FACE_STYLES = {
  grad_soft: {
    label: '渐变柔光脸',
    text: '瞳色柔和渐变、多层高光，皮肤空气刷，腮红虚化'
  },
  closed_arc: {
    label: '闭眼弧线',
    text: '闭眼用两条下弯粗弧线加眼尾三根睫毛、不画瞳孔，睁眼沿用柔光瞳'
  },
  // 每档只改画法，不改骨相；档内自带锚点句，防止换画法时把瞳色/鳍耳/脸型带跑。
  cel_clean: {
    label: '赛璐璐干净脸',
    text: '赛璐璐平涂上色，瞳孔单高光平涂、眼线细且加深，鼻一个阴影点、嘴一条短线，腮红块面轻扫；眼型与瞳色不变'
  },
  sharp_mature: {
    label: '锐利御姐脸',
    text: '上挑杏眼、眼尾眼线加深，眉峰明确，鼻梁有轻阴影，唇线清晰、皮肤哑光；上挑不超过十五度，下颌不变尖'
  },
  round_sweet: {
    label: '圆润甜美脸',
    text: '脸颊更圆润、外眼角微垂，腮红大面积柔边，鼻无鼻梁线、小嘴；成熟女性脸型轮廓不变，眼睛不放大'
  },
  ink_minimal: {
    label: '水墨简笔脸',
    text: '水墨单线五官、瞳孔只留一层墨蓝、无高光，鼻一个墨点、嘴用细笔线；鳍耳与发饰用墨线勾清'
  },
  film_natural: {
    label: '电影自然脸',
    text: '五官结构更自然，鼻梁有柔和体积、双眼皮褶清晰、唇有厚度、皮肤低对比；保持二维动画质感，眼型与瞳色不变'
  }
};

export const FACE_STYLE_NAMES = Object.keys(FACE_STYLES);
export const DEFAULT_FACE_STYLE = 'grad_soft';

export function normalizeFaceStyle(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'none' || key === 'auto') return key;
  if (FACE_STYLE_NAMES.includes(key)) return key;
  const byLabel = FACE_STYLE_NAMES.find((name) => FACE_STYLES[name].label === String(value ?? '').trim());
  return byLabel || 'auto';
}

/** 选中档没有词条时回落渐变柔光，并带上 requested 方便回看。 */
export function resolveFaceStyle(value) {
  const normalized = normalizeFaceStyle(value);
  if (normalized === 'none') return { name: 'none', source: 'none' };
  const name = normalized === 'auto' ? DEFAULT_FACE_STYLE : normalized;
  if (FACE_STYLES[name]?.text) return { name, source: normalized === 'auto' ? 'auto' : 'explicit' };
  return { name: DEFAULT_FACE_STYLE, source: 'fallback', requested: name };
}

export function faceStyleLayerFor(name) {
  const resolved = resolveFaceStyle(name);
  if (resolved.name === 'none') return '';
  const item = FACE_STYLES[resolved.name];
  return `${item.label}，${item.text}，${FACE_STYLE_PRIORITY}`;
}

// ── 气质/年龄表现层 ────────────────────────────────────────────────────────
// 只调“幼态感 / 脸部圆润度 / 眼神氛围 / 姿态气质”，成年比例由人物层锁死。

// 露肤较多的场景（泳装/比基尼）把成年约束再收紧一档，宁可偏成熟。
const ADULT_HARD_LOCK = '年龄外观必须明确成年，不画萝莉或儿童头身比';

export const VIBES = {
  cute: {
    label: '萌系',
    text: '脸部更圆、脸颊饱满，眼睛大而亮，姿态轻快，气质软萌亲和',
    faceHint: 'soft round face, bright eyes, cute but adult woman'
  },
  youth: {
    label: '青春少女',
    text: '脸颊饱满、气色明亮，眼神清亮，站姿轻快，气质干净有活力',
    faceHint: 'youthful adult woman, bright complexion, lively'
  },
  mature: {
    label: '成熟御姐',
    // 不写“脸部修长”：那会被模型读成“把脸画窄再把身体拉长”，头高必须保持不变。
    text: '下颌清晰但头高不变，眼神沉静内敛，姿态舒展，气质成熟从容',
    faceHint: 'mature adult woman, elegant, composed'
  }
};

export const VIBE_MODES = Object.keys(VIBES);
export const DEFAULT_VIBE = 'auto';
// auto 权重：萌系与青春各多一点，成熟少一点。
const VIBE_WEIGHTS = { cute: 0.4, youth: 0.4, mature: 0.2 };
// 同一会话连续出图时记住上一档，尽量避免连续重复。
const LAST_VIBE_BY_CHAT = new Map();

export function normalizeVibe(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'auto') return 'auto';
  if (VIBE_MODES.includes(key)) return key;
  const byLabel = VIBE_MODES.find((name) => VIBES[name].label === String(value ?? '').trim());
  return byLabel || '';
}

export function pickVibe(random = Math.random, exclude = '') {
  const pool = VIBE_MODES.filter((name) => name !== exclude);
  const total = pool.reduce((sum, name) => sum + VIBE_WEIGHTS[name], 0);
  let roll = random() * total;
  for (const name of pool) {
    roll -= VIBE_WEIGHTS[name];
    if (roll <= 0) return name;
  }
  return pool[pool.length - 1];
}

/** 按会话避开上一档；chatKey 为空时纯随机。 */
export function pickVibeForChat(chatKey = '', random = Math.random) {
  const previous = chatKey ? LAST_VIBE_BY_CHAT.get(chatKey) || '' : '';
  const picked = pickVibe(random, previous);
  if (chatKey) LAST_VIBE_BY_CHAT.set(chatKey, picked);
  return picked;
}

export function resolveVibe(value, chatKey = '', random = Math.random) {
  const normalized = normalizeVibe(value);
  if (normalized && normalized !== 'auto') return { name: normalized, source: 'explicit' };
  return { name: pickVibeForChat(chatKey, random), source: 'auto' };
}

export function vibeLayerFor(name) {
  const item = VIBES[normalizeVibe(name)] || VIBES.mature;
  return `${item.label}，${item.text}`;
}

// ── 发型层 ─────────────────────────────────────────────────────────────────
// 只改头发形态：发色、发质、五官、瞳色、鳍耳与鲸鱼发饰一律不动，保证“换了发型还是同一个人”。
const HAIR_FIXED_TEXT = '宝蓝、钴蓝色长发自然披落，发丝细密、发梢自然散开，耳侧一枚小鲸鱼发饰';

export const HAIRSTYLES = {
  bun: {
    label: '丸子头',
    text: '宝蓝长发在头顶盘成一个圆润的高丸子，鬓角留少量碎发，后颈清爽露出，耳侧别一枚小鲸鱼发夹'
  },
  high_ponytail: {
    label: '高马尾',
    text: '宝蓝长发在头顶偏后位置扎成高马尾，发尾自然垂落过肩，额前留少许碎发，发圈是一只小鲸鱼'
  },
  low_ponytail: {
    label: '低马尾',
    text: '宝蓝长发在颈后低低扎成一束马尾，发尾垂到肩胛，两侧鬓发柔软，发绳上挂着小小的鲸鱼挂坠'
  },
  twintails: {
    label: '双马尾',
    text: '宝蓝长发在两侧耳后各扎一束双马尾，发梢自然外翘，刘海轻柔，两侧各一枚鲸鱼造型发饰'
  },
  half_up: {
    label: '半披长发',
    text: '宝蓝长发上半部分在脑后松松扎起一个小髻，下半部分自然披落，发丝柔软，髻侧一枚小鲸鱼发饰'
  },
  side_braid: {
    label: '侧编麻花辫',
    text: '宝蓝长发编成一条松散的侧麻花辫垂在左肩前，辫尾用小鲸鱼发圈固定，额前留几缕碎发'
  },
  low_updo: {
    label: '低盘发',
    text: '宝蓝长发在颈后盘成低低的发髻，鬓角留出柔和碎发修饰脸型，发髻侧边别一枚小鲸鱼发针'
  },
  short_bob: {
    label: '短内扣',
    text: '宝蓝头发剪成齐下巴的短发，发尾内扣贴住下颌，刘海轻薄，耳侧戴一枚小鲸鱼耳夹'
  },
  shoulder_straight: {
    label: '齐肩直发',
    // 只写“齐肩”会被画成过腰长发：加可判定的长度上限。
    text: '宝蓝头发垂到肩线，发尾止于肩线、不超过肩线，不垂到胸前，发尾内收，刘海轻柔，耳侧别一枚小鲸鱼发夹'
  }
};

export const HAIRSTYLE_NAMES = Object.keys(HAIRSTYLES);
export const DEFAULT_HAIRSTYLE = 'auto';
const LAST_HAIRSTYLE_BY_CHAT = new Map();

// 气质与服装都参与选型：大体量发型配活泼气质，收敛的发型配成熟气质；
// 露肤或贴身场景优先清爽、不挡脸的发型。
const HAIR_POOL_BY_VIBE = {
  cute: ['twintails', 'bun', 'high_ponytail', 'shoulder_straight', 'half_up'],
  youth: ['high_ponytail', 'half_up', 'side_braid', 'shoulder_straight', 'twintails'],
  mature: ['low_updo', 'low_ponytail', 'side_braid', 'shoulder_straight', 'bun']
};

const HAIR_POOL_BY_OUTFIT = {
  swim: ['bun', 'high_ponytail', 'low_updo'],
  bikini: ['bun', 'high_ponytail', 'low_updo'],
  nightgown: ['half_up', 'low_ponytail', 'shoulder_straight'],
  jk: ['high_ponytail', 'twintails', 'shoulder_straight'],
  hoodie: ['high_ponytail', 'shoulder_straight', 'twintails'],
  knit: ['half_up', 'low_ponytail', 'shoulder_straight'],
  shirt: ['low_ponytail', 'half_up', 'short_bob'],
  maid: ['low_updo', 'side_braid', 'half_up'],
  yukata: ['low_updo', 'side_braid', 'bun'],
  dress: ['half_up', 'low_ponytail', 'side_braid']
};

export function normalizeHairstyle(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  if (key === 'auto' || key === 'none') return key;
  if (HAIRSTYLE_NAMES.includes(key)) return key;
  const byLabel = HAIRSTYLE_NAMES.find((name) => HAIRSTYLES[name].label === raw);
  return byLabel || '';
}

/** 按气质/服装取候选集，再避开本会话上一次用过的发型。 */
export function pickHairstyle(random = Math.random, options = {}) {
  const vibe = normalizeVibe(options.vibe) || 'youth';
  const allowed = Array.isArray(options.pool) && options.pool.length
    ? options.pool.map((item) => normalizeHairstyle(item)).filter((item) => HAIRSTYLE_NAMES.includes(item))
    : HAIRSTYLE_NAMES;
  const vibePool = (HAIR_POOL_BY_VIBE[vibe] || HAIRSTYLE_NAMES).filter((name) => allowed.includes(name));
  const outfitPool = (HAIR_POOL_BY_OUTFIT[options.outfit] || []).filter((name) => allowed.includes(name));
  const intersect = outfitPool.filter((name) => vibePool.includes(name));
  let pool = intersect.length ? intersect : (vibePool.length ? vibePool : allowed);
  const exclude = String(options.exclude || '');
  const narrowed = pool.filter((name) => name !== exclude);
  if (narrowed.length) pool = narrowed;
  if (!pool.length) return HAIRSTYLE_NAMES[0];
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export function pickHairstyleForChat(chatKey = '', random = Math.random, options = {}) {
  const previous = chatKey ? LAST_HAIRSTYLE_BY_CHAT.get(chatKey) || '' : '';
  const picked = pickHairstyle(random, { ...options, exclude: previous });
  if (chatKey) LAST_HAIRSTYLE_BY_CHAT.set(chatKey, picked);
  return picked;
}

/**
 * 发型取值：enabled=false 或 none 时回落到固定长发（旧行为）；
 * auto 时按会话选型并记住上一次，显式 key 则原样使用。
 */
export function resolveHairstyle(value, { chatKey = '', random = Math.random, vibe = '', outfit = '', pool = [], enabled = true } = {}) {
  if (!enabled) return { name: '', source: 'disabled' };
  const normalized = normalizeHairstyle(value);
  if (normalized === 'none') return { name: '', source: 'disabled' };
  if (normalized && normalized !== 'auto') return { name: normalized, source: 'explicit' };
  return { name: pickHairstyleForChat(chatKey, random, { vibe, outfit, pool }), source: 'auto' };
}

export function hairstyleLayerFor(name) {
  const key = normalizeHairstyle(name);
  const item = HAIRSTYLES[key];
  if (!item) return HAIR_FIXED_TEXT;
  return `${item.label}，${item.text}`;
}

function stripFramingClauses(text) {
  let out = String(text ?? '');
  // 重复归一化（MCP 合并配置）时先去掉参考图语义句，避免同一句叠加两次。
  out = out.split(REFERENCE_IDENTITY_ONLY).join('');
  for (const key of FRAMING_NAMES) {
    out = out.split(`${FRAMINGS[key].label}，${FRAMINGS[key].text}`).join('');
    out = out.split(FRAMINGS[key].text).join('');
  }
  return out.replace(/[，；]{2,}/g, '，').replace(/^[，；\s]+/, '').trim();
}

// ── 景别层（写进构图层，不新增层） ─────────────────────────────────────────
// 三档都明确写清：人物占画幅比例、头顶留空、脚下落脚点、视线高度与镜头距离，
// 避免模型把人怼满画面、背景被挤没。
export const FRAMINGS = {
  full: {
    label: '全身',
    // 口径：人物 65%–72% + 头顶 12%–15% + 脚底 15%–20%，三者以合计 100% 为约束。
    text: 'full body shot, from a distance，从头到脚完整入画，人物占画幅 65%–72%，头顶留白 12%–15%，脚下留出 15%–20% 落地空间、脚尖不裁切；平视，双脚踩地'
  },
  medium: {
    label: '七分身',
    text: '七分身景别，人物头顶到大腿以上入画，人物高度约占画幅 65%–80%，头顶留白约 8%，画面下缘落在大腿、不切断膝盖；平视机位，中景距离'
  },
  closeup: {
    label: '半身',
    text: '半身景别，人物头顶到腰部以上入画，人物高度约占画幅 70%–85%，头顶留白约 5%；平视机位，半身距离'
  }
};

export const FRAMING_NAMES = Object.keys(FRAMINGS);
// 景别负向词：全身最容易被模型裁掉脚，单独补几条。
const FRAMING_NEGATIVE = {
  full: ['裁切脚部', '脚部出画', '脚尖被裁', '半身构图', '七分身构图', '头顶贴边', '人物占满画面'],
  medium: [],
  closeup: []
};
// auto：泳装/比基尼带环境与站姿，默认七分身；其余默认全身，不默认贴脸。
export const DEFAULT_FRAMING = 'auto';
const FRAMING_BY_OUTFIT = { swim: 'medium', bikini: 'medium' };

export function normalizeFraming(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'auto' || key === '') return DEFAULT_FRAMING;
  if (FRAMING_NAMES.includes(key)) return key;
  const byLabel = FRAMING_NAMES.find((name) => FRAMINGS[name].label === String(value ?? '').trim());
  return byLabel || DEFAULT_FRAMING;
}

export function resolveFraming(value, outfit = '') {
  const normalized = normalizeFraming(value);
  if (normalized !== DEFAULT_FRAMING) return { name: normalized, source: 'explicit' };
  return { name: FRAMING_BY_OUTFIT[outfit] || 'full', source: 'auto' };
}

export function framingLayerFor(name) {
  const item = FRAMINGS[normalizeFraming(name)] || FRAMINGS.full;
  // 景别名已经写在 text 开头，不再重复拼 label，省字符且避免“全身，……全身景别”这种叠词。
  return item.text;
}

// ── 画幅取向：竖幅人像 / 横幅广角场景 ──────────────────────────────────────
// wide_scene 用来解决“背景被挤掉、人物太大”：16:9、广角纵深、前景物件、人物不占满。
export const SCENE_FRAMINGS = {
  portrait: { label: '竖幅人像', text: '' },
  wide_scene: {
    label: '横幅广角',
    text: 'wide scene，16:9 横幅，广角纵深透视，前景有物件从画面下缘入画并虚化，全身从头到脚入画，人物占画幅高度 50%–60%，头顶留白 8%–12%，人物不占满画面，左右留出环境'
  }
};
export const SCENE_FRAMING_NAMES = Object.keys(SCENE_FRAMINGS);
export const DEFAULT_SCENE_FRAMING = 'portrait';

export function normalizeSceneFraming(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (SCENE_FRAMING_NAMES.includes(key)) return key;
  return DEFAULT_SCENE_FRAMING;
}

// ── 背景密度 ───────────────────────────────────────────────────────────────
// rich 只虚化最远一层，让货架/招牌/道具承担叙事；minimal 用于干净头像。
export const BACKGROUND_DETAILS = {
  minimal: { label: '极简', text: '背景极简，大面积纯色与强虚化，只保留光源方向' },
  mid: { label: '标准', text: '三层纵深，人物在场景里，中景清晰、远景虚化' },
  rich: { label: '高密度', text: '高密度实景背景，货架与道具细节可辨，只虚化最远一层' }
};
export const BACKGROUND_DETAIL_NAMES = Object.keys(BACKGROUND_DETAILS);
export const DEFAULT_BACKGROUND_DETAIL = 'mid';

export function normalizeBackgroundDetail(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (BACKGROUND_DETAIL_NAMES.includes(key)) return key;
  return DEFAULT_BACKGROUND_DETAIL;
}

const LEGACY_BACKGROUND_DEPTH = '三层纵深，人物在场景里';

/** 重复归一化时先剔掉旧背景密度句，保证幂等（同一份配置两次归一化字符数不变）。 */
function stripBackgroundDepth(text) {
  let out = String(text ?? '');
  for (const key of BACKGROUND_DETAIL_NAMES) out = out.split(BACKGROUND_DETAILS[key].text).join('');
  out = out.split(LEGACY_BACKGROUND_DEPTH).join('');
  return out.replace(/[，；]{2,}/g, '，').replace(/^[，；\s]+/, '').replace(/[，；\s]+$/, '');
}



// 服装池：按款式、版型、颜色、材质描述，默认不绑定任何图案。
// 统一追加一句身份锁：换衣服不改脸、不改发色。
const CLOTHING_IDENTITY_LOCK = '只换衣服';

// 服装图案默认不绑定任何主题元素；需要时由 clothingMotif 显式给一个，且只出现一处。
export function normalizeClothingMotif(value) {
  const text = String(value ?? '').replace(/[\r\n,，。；;]/g, ' ').trim();
  return text.slice(0, 16);
}

// 布料表现：款式决定「穿什么」，这里决定「布料怎么立起来」。
// 每条都写清垂坠与褶皱体积、身体接触处的贴合与遮挡阴影、缝线/包边/纽扣等结构细节，
// 末尾统一收敛光泽：只在受光面出现，暗部保留织物本色，避免整块平涂的塑料感与纸片感。
export const FABRICS = {
  cotton: {
    label: '棉麻',
    text: '棉麻偏哑光有纤维纹理，垂坠有重量，褶皱立体有体积，贴合处压出遮挡阴影，缝线纽扣清楚'
  },
  stiff: {
    label: '制服呢',
    text: '制服呢硬挺有骨架，褶裥挺括有厚度，贴合处压紧，明线与金属扣清楚，只在受光边留窄缎面微光'
  },
  jersey: {
    label: '卫衣抓绒',
    text: '抓绒厚实柔软，落肩袖口有量感，褶皱圆润有重量，罗纹收口贴合，漫反射柔光'
  },
  knit: {
    label: '粗针织',
    text: '粗针织罗纹与针脚立体，织物厚实，袖口下摆弹性收边，柔和高光'
  },
  linen: {
    label: '棉麻平织',
    text: '棉麻平织哑光透气，腰带处压出放射褶皱，衣摆垂坠有重量，包边缝线清楚'
  },
  silk: {
    label: '丝绸',
    text: '丝绸轻薄却有垂坠，褶皱细长层叠，贴合处轻微拉伸，方向性光泽只在受光面'
  },
  swim: {
    label: '高弹锦纶',
    text: '高弹锦纶贴身有张力，弧面紧绷平滑，肩带侧缝有压痕，接缝微皱，柔和微光'
  },
  chiffon: {
    label: '雪纺',
    text: '外层雪纺轻薄有层次，内衬不透明有投影，微透但轮廓完整，包边清楚'
  }
};

export const CLOTHING_POOL = {
  maid: {
    label: '女仆装',
    fabric: 'cotton',
    clothing: '深海军蓝与纯白撞色的长袖女仆装，层叠荷叶边围裙，裙长过膝，围裙正面有简洁的贴袋，衣物整洁、褶皱自然'
  },
  jk: {
    label: 'JK 水手服',
    fabric: 'stiff',
    clothing: '白底深蓝领的水手服上衣，深蓝色格纹及膝百褶裙，白色及膝袜与深蓝领结，版型挺括，衣摆与裙腰衔接整齐'
  },
  hoodie: {
    label: '休闲卫衣+短裙',
    fabric: 'jersey',
    clothing: 'oversize 浅蓝灰连帽卫衣配深色 A 字短裙，卫衣抽绳末端是简洁的金属头，裙摆到膝盖上方，衣着完整'
  },
  knit: {
    label: '针织衫+百褶裙',
    fabric: 'knit',
    clothing: '米白色粗针织开衫内搭白衬衫，深蓝百褶中长裙，开衫版型宽松、针脚整齐，衣物柔软整洁'
  },
  yukata: {
    label: '和风浴衣',
    fabric: 'linen',
    clothing: '藏青色底白浪纹的和风浴衣，浅蓝腰带，袖口与衣摆留白干净，衣领整齐交叠、不露肩，衣着完整'
  },
  shirt: {
    label: '简约白衬衫',
    fabric: 'cotton',
    clothing: '简约白色衬衫配深蓝及膝半身裙，袖口卷起，衬衫有简洁的单口袋，领口扣好，衣物干净利落'
  },
  swim: {
    label: '简约连体运动泳装',
    fabric: 'swim',
    clothing: '深海军蓝拼纯白的连体运动泳装，宽肩带、平角下摆，覆盖锁骨下方到大腿根部，纯色无图案，厚实不透光，保守运动款'
  },
  dress: {
    label: '简约连衣裙',
    fabric: 'silk',
    clothing: '简约的深蓝色（或白色）连衣裙，裙长及膝，圆领、短袖或无袖，裙摆自然垂落，纯色无图案，领口不低、裙长不过短'
  },
  bikini: {
    label: '简约两件式泳装',
    fabric: 'swim',
    clothing: '深海军蓝拼纯白的两件式泳装，宽肩带平角款，纯色无图案，面料厚实不透明，不透不露点、无湿身走光'
  },
  nightgown: {
    label: '薄纱睡裙',
    fabric: 'chiffon',
    clothing: '及踝长袖长裙，外层薄纱、内层不透明纯白棉衬，覆盖到脚踝，领口扣合、裙摆不开叉，纯色无图案，不透视、无湿身走光'
  }
};

export const OUTFIT_NAMES = Object.keys(CLOTHING_POOL);

// 受限服装：只在主人私聊里可用，群聊与非主人请求直接拒绝，不调模型也不落盘。
export const PRIVATE_ONLY_OUTFITS = ['bikini', 'nightgown'];
// auto=每次出图随机一套；none=沿用上层（preset/promptLayers）里的服装描述。
export const DEFAULT_OUTFIT = 'auto';

export function normalizeOutfit(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'none') return 'none';
  if (OUTFIT_NAMES.includes(key)) return key;
  return DEFAULT_OUTFIT;
}

// 气质 × 服装适配：auto 选服装时避开明显违和的组合（萌系不配女仆装、御姐不配 JK 等）。
// swim / dress 三档通用；连衣裙在萌系与青春里排前面。
const VIBE_OUTFIT_POOL = {
  cute: ['hoodie', 'knit', 'dress', 'jk', 'shirt', 'swim'],
  youth: ['jk', 'dress', 'hoodie', 'knit', 'shirt', 'yukata', 'swim'],
  mature: ['knit', 'shirt', 'yukata', 'maid', 'dress', 'swim']
};

export function outfitPoolForVibe(vibe = '') {
  return VIBE_OUTFIT_POOL[vibe] || OUTFIT_NAMES;
}

export function pickOutfit(random = Math.random, vibe = '') {
  const pool = outfitPoolForVibe(vibe);
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}

function resolveOutfit(value, random = Math.random, vibe = '') {
  const outfit = normalizeOutfit(value);
  return outfit === DEFAULT_OUTFIT ? pickOutfit(random, vibe) : outfit;
}

export function clothingLayerFor(outfit) {
  const preset = CLOTHING_POOL[outfit];
  if (!preset) return '';
  // 每款服装声明推荐材质，缺省按棉麻处理，避免出现没有布料表现的款式。
  const fabric = FABRICS[preset.fabric] || FABRICS.cotton;
  return `${preset.clothing}，${fabric.text}，${CLOTHING_IDENTITY_LOCK}`;
}

// 环境纵深：默认中等密度，任何背景层都补上，保证人物站在场景里而不是贴在背景板前。
const BACKGROUND_DEPTH = BACKGROUND_DETAILS.mid.text;

// 参考图语义固定句：qwen 带参考图时按“画布”处理，必须显式声明只取身份。
const REFERENCE_IDENTITY_ONLY = '参考图只取身份与外观，不沿用其姿势与构图';

export const DEFAULT_PROMPT_LAYERS = {
  quality: '高质量日系动漫插画，精细线稿，赛璐璐上色与厚涂混合',
  character: CHARACTER_TEMPLATE,
  faceStyle: faceStyleLayerFor(DEFAULT_FACE_STYLE),
  vibe: vibeLayerFor('mature'),
  expression: expressionLayerFor(DEFAULT_EXPRESSION),
  clothing: '深蓝色旗袍式长裙，白色滚边与盘扣，纯色无图案，侧开摆便于行动，衣物整洁、褶皱自然',
  composition: '人物为唯一主体',
  lighting: '左前上方主光，轮廓光勾发丝肩线，冷蓝环境光',
  background: BACKGROUND_DEPTH
};

const NEGATIVE_CORE = [
  // 画质类：qwen-image-3.0 对“糊/低分辨率”这类词反应明显。
  '低分辨率', '模糊', '噪点', '过曝', '欠曝', '边缘锯齿',
  // 肢体类：手部是这类模型的主要翻车点。
  '多指', '少指', '手指畸形', '肢体错误', '手部崩坏', '断肢',
  '脸部崩坏', '五官错位', '眼睛不对称', '大小眼',
  // 画面杂物。
  '水印', '文字', '签名', 'logo',
  // 风格与角色锁。以下词来自两批失败样张的返修记录（见 IMAGE_LIBRARY 反面教材标签）：
  // 紫发/天蓝发色、鳍耳退化成羽毛耳饰或耳坠、Q版幼态、半写实 BJD、无尾/布带尾。
  '写实照片', '3D渲染', 'Q版', '三头身', '大头小身', '圆脸大眼',
  // 比例上限：只封下限会让模型往八头身、十头身画，超长腿同样属于比例崩坏。
  // 下半身结构类新词对应腰线 33%–35%、膝 72%–74% 的可判定口径。
  '八头身', '九头身', '超长腿', '筷子腿', '腿长超过三个半头高', '躯干过长', '腰线过低', '腰线过高', '膝盖过低', '头小身大',
  '黏土人', '平涂卡通', '粗描边扁平上色', '猫耳毛线帽', '兽耳帽', '极简服装', '僵硬站姿',
  '其他动漫角色', '换发色', '蓝紫渐变发色', '紫发', '天蓝发色',
  '青蓝发尾', '呆毛', '羽毛耳饰', '耳坠', '蝴蝶结耳饰', '人类耳朵',
  '儿童体型', '幼女', '半写实', 'BJD 娃娃感', '黑发',
  // 萌系红线：可以软萌，但绝不能滑向未成年。
  '萌系画成小孩', '儿童身材',
  // 尾巴/肢体计数错误是这类角色最常见的翻车点。
  '尾从头发长出', '尾从侧腰长出', '多条尾巴', '两条尾巴', '布带尾巴',
  '多余的手',
  // 布料质感：衣服不能像贴上去的纸片，褶皱要有体积，衣缘要贴合身体。
  '纸片感', '贴图感', '无褶皱', '衣缘生硬', '悬浮在身体外',
  // 表情类：换表情不能让脸跟着变，重点压大笑拉宽脸、圆眼化、五官漂移与换脸。
  '表情改变脸型', '大笑拉宽脸型', '脸型变宽', '眼睛变成大圆眼', '瞳孔放大失真', '表情换脸', '五官漂移', '夸张表情', '眼距过宽', '下颌拉长',
  // 泳装/裙装相关负向词已按 2026-11 放宽规则整体移除（比基尼、透视、湿身、走光、深V、高叉等全部放开）。
  // 纤细不等于幼态：瘦可以，未成年不行。
  '儿童头身比', '未成年',
  // 红线：只压露点与真实性行为，其它一律放开。
  '露点', '性行为'
];

/** 合并多组负向词并去重，避免配置与默认词重复追加把清单堆爆。 */
export function mergeNegativeTerms(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    const terms = Array.isArray(group) ? group : String(group ?? '').split('、');
    for (const term of terms) {
      const text = String(term ?? '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

export const DEFAULT_NEGATIVE_PROMPT = mergeNegativeTerms(NEGATIVE_CORE, ['背景杂乱']).join('、');

// 尾巴档位 off 时额外压掉尾巴，避免模型把"鲸鱼元素"理解成必须长尾；
// required 档反向压掉"无尾"，防止该画的时候偷懒省掉。
const TAIL_NEGATIVE = {
  required: ['没有尾巴', '无尾', '尾巴缺失'],
  off: ['鲸鱼尾', '鱼尾', '兽尾', '尾巴']
};

export function assemblePromptLayers(layers = {}, order = PROMPT_LAYER_ORDER) {
  const parts = [];
  for (const key of order) {
    const text = String(layers?.[key] ?? '').trim();
    if (text) parts.push(`【${PROMPT_LAYER_LABELS[key]}】${text}`);
  }
  return parts.join('；');
}

function definePreset(label, overrides = {}, extraNegative = []) {
  const layers = { ...DEFAULT_PROMPT_LAYERS, ...overrides };
  return {
    label,
    layers,
    stylePrompt: assemblePromptLayers(layers),
    negativePrompt: mergeNegativeTerms(NEGATIVE_CORE, extraNegative).join('、')
  };
}

export const STYLE_PRESETS = {
  // 默认档：质量词给满，对应「成人比例日系立绘」。
  keyvisual: definePreset('成人比例日系立绘', {
    composition: '人物为唯一主体',
    background: '夜景散景背景，前后景有光影层次，灯牌与光斑虚化，不抢主体'
  }),
  // 番剧特写：半身、赛璐璐平光但保留手绘线稿。
  closeup: definePreset('番剧半身特写', {
    quality: '日系动画番剧截图质感，清晰手绘线稿，赛璐璐平光上色，边缘干净，高光简洁，画面通透',
    clothing: '白色荷叶边领口配蓝色蝴蝶结，领口与肩部完整遮挡，衣物整洁',
    composition: '半身特写构图，胸部以上占画面主体，轻微侧身，视线看向镜头',
    lighting: '主光明确，面部受光均匀，发丝边缘有细轮廓光，浅景深',
    background: '虚化的室内场景，前后景层次清楚'
  }, ['全身构图', '背景杂乱']),
  // 女仆装立绘：三分之二身、厚涂细节。
  maid: definePreset('女仆装三分之二身立绘', {
    clothing: '深海军蓝与纯白撞色的长袖女仆装，层叠荷叶边围裙，裙长过膝，衣物整洁、褶皱自然',
    composition: '三分之二身构图，双臂自然交叠，姿态舒展，人物为唯一主体',
    lighting: '室内散景，主光源明确，冷暖对比打光，发丝有边缘轮廓光',
    background: '室内散景背景，前后景层次清楚'
  }, ['单调白底']),
  // JK 制服夜景。
  jk: definePreset('JK 制服夜景立绘', {
    clothing: '水手服制服：白色短袖水手服上衣，深蓝色格纹及膝百褶裙，白色及膝长袜，深蓝色领结；上衣完整覆盖肩部与胸口，衣摆与裙腰衔接整齐，衣着完整',
    composition: '成人比例立绘，三分之二身，自然坐姿，双臂自然安放，姿态舒展',
    lighting: '窗边冷暖对比光，主光来自侧面，体积光与强透视层次',
    background: '夜景室内散景，窗外城市灯光虚化'
  }, ['超短裙', '吊带', '露肩', '低胸']),
  // 旗袍夜景：坐姿/靠姿、侧开摆与白丝都允许，只守不露点。
  qipao: definePreset('旗袍夜景立绘', {
    clothing: '深蓝色旗袍式长裙，白色滚边与盘扣，纯色无图案，侧开摆便于行动，贴身剪裁曲线自然，白色丝袜，衣着完整',
    composition: '三分之二身坐姿或靠姿，姿态自然放松，人物为唯一主体',
    lighting: '室内暖光夜景，主光源明确，冷暖对比光，画面有强透视层次',
    background: '室内暖光夜景散景，窗边光斑虚化'
  }, ['单调白底'])
};

export const STYLE_PRESET_NAMES = Object.keys(STYLE_PRESETS);
export const DEFAULT_STYLE_PRESET = 'keyvisual';

export function resolveStylePreset(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return { name: STYLE_PRESETS[key] ? key : DEFAULT_STYLE_PRESET, ...STYLE_PRESETS[key] || STYLE_PRESETS[DEFAULT_STYLE_PRESET] };
}

export function pickStylePreset(random = Math.random) {
  const index = Math.min(STYLE_PRESET_NAMES.length - 1, Math.max(0, Math.floor(random() * STYLE_PRESET_NAMES.length)));
  return STYLE_PRESET_NAMES[index];
}

export const DEFAULT_STYLE_PROMPT = STYLE_PRESETS[DEFAULT_STYLE_PRESET].stylePrompt;
// 负向清单：同样写进 prompt（CogView 系列不接收 negative_prompt 参数）。
export const NEGATIVE_STYLE_PROMPT = STYLE_PRESETS[DEFAULT_STYLE_PRESET].negativePrompt;

// 模型自己写描述时很容易带上「Q版/三头身/猫耳帽/别的发色」，先清洗掉再拼 prompt。
const CHIBI_RE = /(?:[Qq]\s*版|三头身|二头身|四头身|大头娃娃|大头小身|萌系|萌化|扭蛋|盲盒|手办感|黏土人|粘土人|超级变形|chibi)/g;
const KNIT_HAT_RE = /(?:猫耳|兽耳|猫耳状|兽耳状)?(?:毛线帽|针织帽|毛绒帽)/g;
const ANIMAL_EAR_RE = /猫耳帽|兽耳帽|猫耳|兽耳/g;
const HAIR_COLOR_RE = /(?:银白|银发|金发|黑发|白发|红发|粉发|棕发|栗发|亚麻色|灰发|黑长直|银长直)/g;

export function sanitizeDrawDescription(value) {
  let text = String(value ?? '');
  text = text.replace(CHIBI_RE, '').replace(KNIT_HAT_RE, '').replace(ANIMAL_EAR_RE, '').replace(HAIR_COLOR_RE, '');
  return text
    .replace(/[，,、；;]{2,}/g, '，')
    .replace(/^[，,、；;：:\s]+|[，,、；;：:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const IMAGE_STATE_DIR = fileURLToPath(new URL('../state/imagegen/', import.meta.url));

const RANDOM_THEMES = [
  '蓝发少女在午后咖啡馆窗边整理白色蕾丝围裙，阳光落在长发上',
  '蓝发少女抱着鲸鱼玩偶站在雨后的街道，屋檐滴水，远处有暖色灯光',
  '蓝发少女在海边礁石上回望，海风吹起青蓝色发梢，天空有薄云',
  '蓝发少女在夜晚的书桌前写日记，台灯暖光，窗外是安静的城市',
  '蓝发少女端着托盘穿过蓝白色调的小店，裙摆与发丝轻轻飘起',
  '蓝发少女在雪后的站台等车，围巾和长发被风吹起，呼出白气'
];

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

// 扩图兜底配置：默认关闭，主开关一次关掉整条链路；失败只记日志，不影响出图。
export function normalizeOutpaintConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled === true,
    // 占比超阈值才扩，用户口径示例 >80%。
    threshold: clampFloat(source.threshold, 0.5, 0.99, 0.8),
    // 用户口径：向下 25%–35%、向上 8%–10%，超出范围按边界收敛。
    downScale: clampFloat(source.downScale, 0.25, 0.35, 0.25),
    upScale: clampFloat(source.upScale, 0.08, 0.10, 0.09),
    // 脚底留白必须大于 0.5% 才允许扩图：脚已经出画时续画会接出畸形脚。
    minFootspace: clampFloat(source.minFootspace, 0, 0.1, 0.005),
    model: String(source.model || OUTPAINT_MODEL),
    baseUrl: String(source.baseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, ''),
    apiKey: String(source.apiKey || ''),
    apiKeyEnv: String(source.apiKeyEnv || ''),
    timeoutMs: clampInt(source.timeoutMs, 30_000, 300_000, 120_000),
    pollMs: clampInt(source.pollMs, 500, 10_000, 2_000),
    costCny: clampFloat(source.costCny, 0, 10, OUTPAINT_COST_CNY)
  };
}

export function localDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// 未显式配置 provider 时的默认值；生产配置一定会写 provider，这里只服务离线单测与旧调用。
export const DEFAULT_PROVIDER = 'openai';

// provider 注册表：只认显式列出的名字，未知值直接报错，不再静默回落 pollinations。
const PROVIDER_ALIASES = new Map([
  ['openai', 'openai'],
  ['openai-compatible', 'openai'],
  ['zhipu', 'openai'],
  ['bigmodel', 'openai'],
  ['pollinations', 'pollinations'],
  ['dashscope', 'dashscope'],
  ['bailian', 'dashscope'],
  ['qwen', 'dashscope'],
  ['qwen-image', 'dashscope'],
  ['ark', 'ark'],
  ['volcengine', 'ark'],
  ['volc', 'ark'],
  ['doubao', 'ark'],
  ['seedream', 'ark']
]);

const PROVIDER_DEFAULTS = {
  openai: { baseUrl: '', model: 'cogview-3-flash' },
  pollinations: { baseUrl: 'https://image.pollinations.ai', model: 'flux' },
  // 百炼：编辑（吃参考图）与纯文生图是两个模型，走同一个多模态端点。
  // 2026-11 实测：该空间的图像模型为 qwen-image-3.0 系列，编辑与文生图共用同一模型。
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image-3.0', textModel: 'qwen-image-3.0' },
  // 火山方舟：Seedream 4.0 支持单图/多图参考（最多 14 张），只作为可选档位，不进默认链首。
  ark: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-0-250828' }
};

// 能力声明：调用方按能力走，而不是在业务代码里判断后端名字。
const PROVIDER_CAPABILITIES = {
  openai: { negativePrompt: false, referenceImage: false, lora: false, async: false, maxReferenceImages: 0 },
  pollinations: { negativePrompt: false, referenceImage: false, lora: false, async: false, maxReferenceImages: 0 },
  dashscope: { negativePrompt: true, referenceImage: true, lora: false, async: false, maxReferenceImages: 3 },
  // Seedream 没有独立的 negative_prompt 字段，负向词只能挑关键项并进正向提示词。
  ark: { negativePrompt: false, referenceImage: true, lora: false, async: false, maxReferenceImages: 14 }
};

export function normalizeProvider(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return DEFAULT_PROVIDER;
  const provider = PROVIDER_ALIASES.get(key);
  if (!provider) throw new Error(`不支持的图片 provider: ${value}`);
  return provider;
}

export function providerCapabilities(provider, override = null) {
  const base = PROVIDER_CAPABILITIES[normalizeProvider(provider)] || PROVIDER_CAPABILITIES[DEFAULT_PROVIDER];
  return override && typeof override === 'object' ? { ...base, ...override } : { ...base };
}

/** 主 provider 鉴权/额度失败时的兜底配置（免 Key 的 pollinations）。 */
export function pollinationsFallbackConfig(config = {}) {
  return normalizeImageGenConfig({
    ...config, provider: 'pollinations', model: 'flux', baseUrl: '', apiKey: '', apiKeyEnv: '', responseFormat: ''
  });
}

const PROVIDER_TIERS = ['free', 'paid', 'fallback'];
const PROVIDER_GATES = ['always', 'onError', 'onQuotaExhausted', 'never'];

/**
 * 配置驱动的 provider 链：
 *   imageGen.chain = [{ provider, model, tier, when, enabled, baseUrl?, apiKey? }]
 * 未配置 chain 时退化为单 provider（保持旧行为）。
 */
// 跨 provider 的链项不能继承这些字段，否则会拿智谱的 Key/baseUrl/model 去打别家。
const PROVIDER_SCOPED_KEYS = [
  'baseUrl', 'model', 'textModel', 'apiKey', 'apiKeyEnv', 'responseFormat',
  'watermark', 'promptExtend', 'sendSize', 'capabilities'
];

export function normalizeImageGenChain(raw = {}) {
  const base = normalizeImageGenConfig(raw);
  const entries = Array.isArray(raw.chain) ? raw.chain.filter((item) => item && typeof item === 'object') : [];
  const single = [{
    ...base,
    tier: base.provider === 'pollinations' ? 'fallback' : 'free',
    when: 'always',
    name: `${base.provider}:${base.model}`
  }];
  if (!entries.length) return single;

  const rootProvider = normalizeProvider(raw.provider);
  const chain = entries.map((entry) => {
    const entryProvider = entry.provider || raw.provider || DEFAULT_PROVIDER;
    const provider = normalizeProvider(entryProvider);
    const merged = { ...raw, ...entry, provider: entryProvider };
    delete merged.chain;
    // 同 provider 的链项（如智谱免费档 → 付费档）沿用主配置的 Key/baseUrl；
    // 跨 provider 的链项只认自己声明的字段，没声明就用该 provider 的默认值。
    if (provider !== rootProvider) {
      for (const key of PROVIDER_SCOPED_KEYS) {
        if (!Object.hasOwn(entry, key)) delete merged[key];
      }
    }
    const config = normalizeImageGenConfig(merged);
    return {
      ...config,
      tier: PROVIDER_TIERS.includes(entry.tier) ? entry.tier : (config.provider === 'pollinations' ? 'fallback' : 'free'),
      when: PROVIDER_GATES.includes(entry.when) ? entry.when : 'onError',
      name: String(entry.name || `${config.provider}:${config.model}`)
    };
  }).filter((item) => item.enabled !== false);
  if (!chain.length) return single;
  return chain.map((item, index) => (index === 0 ? { ...item, when: 'always' } : item));
}

/** 免费额度耗尽判定：优先看接口返回码/文案，不靠本地计数猜。 */
export function isQuotaExhausted(result = {}) {
  if (result.reason === 'rate-limit') return true;
  if (Number(result.status) === 402) return true;
  if (String(result.providerCode ?? '') === '1113') return true;
  return /额度|余额|quota|insufficient|exhaust|balance/i.test(String(result.error ?? ''));
}

function shouldUseProvider(candidate, previous, index) {
  if (index === 0 || candidate.when === 'always') return true;
  if (!previous) return false;
  if (candidate.when === 'onError') return true;
  if (candidate.when === 'onQuotaExhausted') return isQuotaExhausted(previous);
  return false;
}

/**
 * 生成一张图。依赖可注入，便于离线单测。
 * 返回 {ok:true, buffer, mime, filePath, width, height, provider, tier, attempts, ms, analysis}
 * 或 {ok:false, reason, error, attempts, ms}（reason: provider/rate-limit/moderation/moderation-unavailable/storage）
 */
export async function generateImage(request = {}, dependencies = {}) {
  const chain = normalizeImageGenChain(request.config || {});
  const config = chain[0];
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const inspectImage = dependencies.inspectImage;
  const logger = dependencies.logger || ((line) => console.log(line));
  const stateDir = dependencies.stateDir || IMAGE_STATE_DIR;
  const now = dependencies.now ? dependencies.now() : Date.now();
  // 表情优先级：显式 request.expression → 对话语境 request.contextText → 配置（默认温柔浅笑）。
  const expressionChoice = resolveExpression({ expression: request.expression, context: request.contextText });
  // 调用方已自行判定来源（显式传参/语境推断/默认）时以调用方为准，仅用于元数据回看。
  if (['explicit', 'context', 'default'].includes(request.expressionSource)) {
    expressionChoice.source = request.expressionSource;
  }
  let stylePrompt = config.stylePrompt;
  // 发型：显式 request.hairstyle 优先于配置；auto 时按会话选型并避开上一张。
  const hairChoice = resolveHairstyle(request.hairstyle || config.hairstyle, {
    chatKey: request.chatKey || '',
    vibe: config.vibe,
    outfit: config.outfit,
    pool: config.hairstylePool,
    enabled: config.hairstyleEnabled !== false,
    random: dependencies.random || Math.random
  });
  const hairLayer = hairstyleLayerFor(hairChoice.name);
  const styleLayered = stylePrompt === assemblePromptLayers(config.promptLayers);
  if (styleLayered && (hairLayer !== config.promptLayers.hairstyle || expressionChoice.name !== config.expression)) {
    const layers = { ...config.promptLayers, hairstyle: hairLayer };
    if (expressionChoice.name !== config.expression) layers.expression = expressionLayerFor(expressionChoice.name);
    stylePrompt = assemblePromptLayers(layers);
  }
  const promptParts = request.prompt
    ? asPromptParts(request.prompt)
    : buildPromptParts(request.description, stylePrompt, config.negativePrompt, config.characterPrompt);
  // 发出前先量一次实际字符数并断言；超限直接失败，不再让接口静默截断。
  const promptChars = assertPromptBudget(promptParts);
  logger(`[imagegen] prompt-chars positive=${promptChars.positive} negative=${promptChars.negative}`);
  // 文本型后端仍要整段 prompt；支持负向词的适配器用 promptParts 分开传。
  const prompt = promptParts.negative
    ? `${promptParts.positive}；【严格禁止】${promptParts.negative}`
    : promptParts.positive;
  const seat = `${request.isGroup ? 'group' : 'private'}:${request.target ?? ''}`;
  const chatKey = String(request.chatKey || seat);
  const trigger = ['command', 'random', 'tool'].includes(request.trigger) ? request.trigger : 'command';
  const senderId = String(request.senderId ?? '');
  const started = Date.now();

  // 比基尼与薄纱睡裙是受限服装：只允许主人在私聊里用，群聊与非主人请求一律不生成。
  if (PRIVATE_ONLY_OUTFITS.includes(config.outfit) && !(request.isOwner === true && request.isGroup === false)) {
    logger('[imagegen] reject reason=outfit-private-only');
    return { ok: false, reason: 'outfit-private-only', attempts: [], ms: Date.now() - started };
  }

  // 新后端没有服务端输入过滤：先过提示词闸门，只检查调用方写的画面描述。
  if (request.description) {
    const gate = inspectDrawPrompt(request.description);
    if (!gate.ok) {
      logger(`[imagegen] reject reason=prompt-blocked match=${gate.reason} text=${gate.matched}`);
      return { ok: false, reason: 'prompt-blocked', error: gate.reason, matched: gate.matched, attempts: [], ms: Date.now() - started };
    }
  }

  // 参考图：统一在这里校验，各适配器只拿校验过的 buffer/mime。
  // 没有传参考图时用配置里的角色锚点兜底；锚点也读不到且策略为 require 就拒绝出图，不降级成纯文生图。
  let referenceInput = request.referenceImages ?? request.referenceImage;
  let referenceOrigin = referenceInput ? 'request' : '';
  if (!referenceInput && config.defaultReferenceImage) {
    referenceInput = config.defaultReferenceImage;
    referenceOrigin = 'anchor';
  }
  let referenceResult = referenceInput ? normalizeReferenceImages(referenceInput) : { ok: true, images: [] };
  if (!referenceResult.ok) {
    logger(`[imagegen] reject reason=reference-invalid origin=${referenceOrigin} detail=${referenceResult.error}`);
    return {
      ok: false,
      reason: referenceOrigin === 'anchor' ? 'reference-required' : 'reference-invalid',
      error: referenceResult.error,
      attempts: [],
      ms: Date.now() - started
    };
  }
  const references = referenceResult.images;
  if (!references.length && (config.referencePolicy === 'require' || request.referenceRequired === true)) {
    logger('[imagegen] reject reason=reference-required (no reference, policy=require)');
    return { ok: false, reason: 'reference-required', error: '缺少参考图', attempts: [], ms: Date.now() - started };
  }
  const seed = Number.isFinite(request.seed) ? request.seed : Math.floor(Math.random() * 1_000_000_000);

  let buffer = null;
  let contentType = '';
  let chosen = config;
  let providerMeta = {};
  let failure = null;
  const attempts = [];
  let referenceSkipped = 0;

  for (let index = 0; index < chain.length; index += 1) {
    // 输入被内容审核拦下（智谱 code=1301）时换 provider 也没用，直接停链，别白烧付费额度。
    if (index > 0 && String(failure?.providerCode ?? '') === '1301') {
      logger(`[imagegen] stop chain reason=content-filter providerCode=1301`);
      break;
    }
    const candidate = chain[index];
    if (!shouldUseProvider(candidate, failure, index)) continue;
    const capabilities = candidate.capabilities || providerCapabilities(candidate.provider);
    // 带参考图时跳过不支持参考图（或张数超出上限）的后端：换人比不出图更糟。
    const referenceCapacity = Number(capabilities.maxReferenceImages) || 0;
    if (references.length && (!capabilities.referenceImage || references.length > referenceCapacity)) {
      referenceSkipped += 1;
      attempts.push({
        provider: candidate.provider, model: candidate.model, tier: candidate.tier,
        ok: false, reason: 'reference-unsupported', skipped: true
      });
      logger(`[imagegen] skip provider=${candidate.provider} tier=${candidate.tier} reason=reference-unsupported`);
      continue;
    }
    logger(`[imagegen] start provider=${candidate.provider} tier=${candidate.tier} model=${candidate.model}`
      + ` size=${candidate.size} refs=${references.length} seed=${seed} chat=${seat}`);
    try {
      const response = await fetchProviderImage(candidate, promptParts, { seed, references }, fetchImpl, sleep);
      ({ buffer, contentType, ...providerMeta } = await readProviderImage(response, candidate, fetchImpl, candidate.timeoutMs));
      if (!buffer?.length) throw new Error('provider returned empty image');
      chosen = candidate;
      attempts.push({ provider: candidate.provider, model: candidate.model, tier: candidate.tier, ok: true, ms: Date.now() - started });
      break;
    } catch (error) {
      const detail = shortError(error, candidate);
      const reason = error?.code === 'rate-limit' ? 'rate-limit'
        : error?.code === 'no-key' ? 'no-key'
          : (error?.code === 'budget' || error?.code === 'timeout') ? 'timeout'
            : 'provider';
      failure = {
        ok: false,
        reason,
        error: detail,
        status: error?.status,
        providerCode: error?.providerCode,
        retryAfterMs: error?.retryAfterMs,
        tier: candidate.tier
      };
      attempts.push({
        provider: candidate.provider, model: candidate.model, tier: candidate.tier,
        ok: false, reason, status: error?.status ?? null, ms: Date.now() - started
      });
      logger(`[imagegen] fail reason=${reason} provider=${candidate.provider} tier=${candidate.tier}`
        + ` ms=${Date.now() - started} detail=${detail}`);
    }
  }

  if (!buffer) {
    if (references.length && referenceSkipped === chain.length) {
      return { ok: false, reason: 'reference-unsupported', error: '没有支持参考图的后端', attempts, ms: Date.now() - started };
    }
    return { ...(failure || { ok: false, reason: 'provider', error: 'no provider available' }), attempts, ms: Date.now() - started };
  }

  // 体积前置校验：放在审核之前，别等审核跑完才在发图那一步 413。
  const maxOutputBytes = chosen.maxOutputBytes || 5 * 1_048_576;
  if (buffer.length > maxOutputBytes) {
    logger(`[imagegen] reject reason=image-too-large provider=${chosen.provider} tier=${chosen.tier}`
      + ` bytes=${buffer.length} limit=${maxOutputBytes}`);
    return { ok: false, reason: 'image-too-large', error: `图片 ${buffer.length} 字节超过上限 ${maxOutputBytes}`, bytes: buffer.length, attempts, ms: Date.now() - started };
  }

  let mime = sniffImageMime(buffer, contentType);

  let analysis = null;
  if (typeof inspectImage === 'function') {
    try {
      analysis = await inspectImage(buffer.toString('base64'), mime);
    } catch (error) {
      const detail = shortError(error, chosen);
      logger(`[imagegen] fail reason=moderation-unavailable provider=${chosen.provider} tier=${chosen.tier} ms=${Date.now() - started} detail=${detail}`);
      return { ok: false, reason: 'moderation-unavailable', error: detail, attempts, ms: Date.now() - started };
    }
    if (shouldBlockImageStorage(analysis)) {
      logger(`[imagegen] reject reason=moderation provider=${chosen.provider} tier=${chosen.tier} ms=${Date.now() - started}`
        + ` confidence=${Number(analysis?.confidence) || 0} safety=${String(analysis?.safetyReason || '').slice(0, 80)}`);
      return { ok: false, reason: 'moderation', analysis, attempts, ms: Date.now() - started };
    }
  }

  // ── 比例检测 ──────────────────────────────────────────────────────────────
  // 头身比 > maxHeads 就带强化约束重画一次；仍超标只标 proportion-outlier 写进 meta，不再重试。
  const proportionConfig = config.proportionCheck || normalizeProportionCheckConfig();
  const proportionImpl = dependencies.measureHeadBodyRatio || measureHeadBodyRatio;
  let proportion = proportionImpl(buffer);
  const proportionRecord = {
    enabled: proportionConfig.enabled,
    maxHeads: proportionConfig.maxHeads,
    first: proportion,
    retried: false,
    triggered: Boolean(proportion && proportion.headBodyRatio > proportionConfig.maxHeads)
  };
  if (proportionConfig.enabled && proportionRecord.triggered) {
    proportionRecord.retried = true;
    const retryParts = strengthenProportionPrompt(promptParts);
    logger(`[imagegen] proportion-retry heads=${proportion.headBodyRatio} max=${proportionConfig.maxHeads}`
      + ` prompt-chars positive=${measurePromptChars(retryParts).positive} negative=${measurePromptChars(retryParts).negative}`);
    try {
      const response = await fetchProviderImage(chosen, retryParts, { seed, references }, fetchImpl, sleep);
      const retry = await readProviderImage(response, chosen, fetchImpl, chosen.timeoutMs);
      const retryBuffer = retry.buffer;
      if (!retryBuffer?.length) throw new Error('proportion retry returned empty image');
      let accepted = true;
      let retryAnalysis = null;
      if (typeof inspectImage === 'function') {
        try {
          retryAnalysis = await inspectImage(retryBuffer.toString('base64'), sniffImageMime(retryBuffer, retry.contentType));
          if (shouldBlockImageStorage(retryAnalysis)) accepted = false;
        } catch {
          accepted = false;
        }
      }
      // 只接受确实更接近目标的那一张；重画更差就保留原图。
      const next = proportionImpl(retryBuffer);
      if (accepted && (!next || next.headBodyRatio < proportion.headBodyRatio)) {
        buffer = retryBuffer;
        mime = sniffImageMime(buffer, retry.contentType);
        proportion = next;
        analysis = retryAnalysis || analysis;
        attempts.push({ provider: chosen.provider, model: chosen.model, tier: chosen.tier, ok: true, retry: 'proportion', ms: Date.now() - started });
      } else {
        attempts.push({ provider: chosen.provider, model: chosen.model, tier: chosen.tier, ok: true, retry: 'proportion-rejected', ms: Date.now() - started });
      }
      proportionRecord.second = next;
    } catch (error) {
      proportionRecord.error = shortError(error, chosen);
      logger(`[imagegen] proportion-retry-fail detail=${proportionRecord.error} keep=first`);
    }
    // 重画后仍然超标才标记；没有可测结果不误伤。
    proportionRecord.outlier = Boolean(proportion && proportion.headBodyRatio > proportionConfig.maxHeads);
    if (proportionRecord.outlier) {
      logger(`[imagegen] proportion-outlier heads=${proportion.headBodyRatio} max=${proportionConfig.maxHeads}`);
    } else if (proportion) {
      logger(`[imagegen] proportion-ok heads=${proportion.headBodyRatio} after=retry`);
    }
  }

  // ── 扩图兜底 ──────────────────────────────────────────────────────────────
  // 只在人物占比超标时触发；扩图失败/审核不过一律保留原图，不阻塞出图。
  const outpaintConfig = config.outpaint || normalizeOutpaintConfig();
  const outpaintImpl = dependencies.outpaintImage || outpaintImage;
  let composition = measureComposition(buffer);
  const outpaintRecord = {
    enabled: outpaintConfig.enabled,
    threshold: outpaintConfig.threshold,
    triggered: false,
    before: composition
  };
  if (!outpaintConfig.enabled) {
    outpaintRecord.reason = 'disabled';
  } else if (!composition) {
    outpaintRecord.reason = 'unmeasurable';
  } else if (composition.feetCut || composition.footspace <= outpaintConfig.minFootspace) {
    // 脚已经出画或贴边：续画会接出畸形脚，宁可发原图。
    outpaintRecord.reason = 'feet-cut';
    outpaintRecord.footspace = composition.footspace;
    logger(`[imagegen] outpaint skip reason=feet-cut footspace=${(composition.footspace * 100).toFixed(2)}%`
      + ` min=${(outpaintConfig.minFootspace * 100).toFixed(2)}%`);
  } else if (composition.personRatio <= outpaintConfig.threshold) {
    outpaintRecord.reason = 'within-threshold';
  } else {
    outpaintRecord.triggered = true;
    const offsets = planOutpaintOffsets({
      width: composition.width,
      height: composition.height,
      downScale: outpaintConfig.downScale,
      upScale: outpaintConfig.upScale
    });
    // 扩图走百炼，凭据优先用 outpaint 自己的，其次借链上的 dashscope 档案。
    const dashscopeEntry = chain.find((item) => item.provider === 'dashscope' && item.apiKey)
      || (config.provider === 'dashscope' ? config : null);
    const apiKey = outpaintConfig.apiKey
      || (outpaintConfig.apiKeyEnv ? process.env[outpaintConfig.apiKeyEnv] || '' : '')
      || String(dashscopeEntry?.apiKey || '');
    logger(`[imagegen] outpaint start provider=dashscope model=${outpaintConfig.model}`
      + ` occupancy=${(composition.personRatio * 100).toFixed(2)}% threshold=${(outpaintConfig.threshold * 100).toFixed(0)}%`
      + ` top=${offsets.topOffset}px bottom=${offsets.bottomOffset}px`);
    try {
      const expanded = await outpaintImpl({
        buffer,
        mime,
        width: composition.width,
        height: composition.height,
        baseUrl: outpaintConfig.baseUrl,
        apiKey,
        topOffset: offsets.topOffset,
        bottomOffset: offsets.bottomOffset,
        model: outpaintConfig.model,
        timeoutMs: outpaintConfig.timeoutMs,
        pollMs: outpaintConfig.pollMs,
        fetchImpl,
        sleep
      });
      const after = measureComposition(expanded.buffer);
      let accepted = true;
      let rejectReason = '';
      if (typeof inspectImage === 'function') {
        try {
          const next = await inspectImage(expanded.buffer.toString('base64'), expanded.mime);
          if (shouldBlockImageStorage(next)) {
            accepted = false;
            rejectReason = 'moderation';
          } else {
            analysis = next;
          }
        } catch {
          accepted = false;
          rejectReason = 'moderation-unavailable';
        }
      }
      Object.assign(outpaintRecord, {
        ok: accepted,
        reason: accepted ? '' : rejectReason,
        after,
        offsets,
        ms: expanded.ms,
        costCny: outpaintConfig.costCny,
        taskId: expanded.taskId || '',
        requestId: expanded.requestId || ''
      });
      if (accepted) {
        buffer = expanded.buffer;
        mime = expanded.mime;
        composition = after;
        logger(`[imagegen] outpaint ok ms=${expanded.ms}`
          + ` before=${(outpaintRecord.before.personRatio * 100).toFixed(2)}%`
          + ` after=${after ? `${(after.personRatio * 100).toFixed(2)}%` : 'unmeasurable'}`
          + ` cost=${outpaintConfig.costCny}`);
      } else {
        logger(`[imagegen] outpaint-fail reason=${rejectReason} ms=${expanded.ms} keep=original`);
      }
    } catch (error) {
      Object.assign(outpaintRecord, {
        ok: false,
        reason: 'error',
        error: shortError(error, chosen),
        costCny: 0
      });
      // 扩图失败不能影响主人收图：原样发原图，只留一条日志。
      logger(`[imagegen] outpaint-fail reason=error detail=${shortError(error, chosen)} keep=original`);
    }
  }

  let filePath = '';
  try {
    const dir = join(stateDir, localDayKey(now));
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, `gen-${now}-${randomBytes(4).toString('hex')}.${extensionForMime(mime)}`);
    writeFileSync(filePath, buffer);
  } catch (error) {
    const detail = shortError(error, chosen);
    logger(`[imagegen] fail reason=storage provider=${chosen.provider} tier=${chosen.tier} ms=${Date.now() - started} detail=${detail}`);
    return { ok: false, reason: 'storage', error: detail, attempts, ms: Date.now() - started };
  }

  // 元数据与图片同名落盘，后续上下文/复看图按文件名或 sha256 反查。
  const sha256 = sha256Of(buffer);
  // 编辑类后端的输出尺寸跟随参考图，优先记录图片头里的真实宽高。
  const actualSize = readImageDimensions(buffer);
  const width = actualSize?.width || chosen.width;
  const height = actualSize?.height || chosen.height;
  const meta = {
    file: basename(filePath),
    path: filePath,
    prompt,
    negativePrompt: promptParts.negative,
    promptChars,
    description: String(request.description ?? ''),
    descriptionTrimmed: promptParts.descriptionTrimmed === true,
    provider: chosen.provider,
    model: String(providerMeta.model || chosen.model),
    tier: chosen.tier,
    stylePreset: chosen.stylePreset || '',
    outfit: chosen.outfit || '',
    framing: chosen.framing || '',
    framingSource: chosen.framingSource || '',
    tail: chosen.tail || '',
    vibe: config.vibe || '',
    vibeSource: ['explicit', 'auto'].includes(request.vibeSource) ? request.vibeSource : (config.vibeSource || 'auto'),
    expression: expressionChoice.name,
    expressionSource: expressionChoice.source,
    hairstyle: hairChoice.name,
    hairstyleSource: hairChoice.source,
    referenceOrigin: references.length ? referenceOrigin : '',
    size: `${width}x${height}`,
    width,
    height,
    seed,
    mime,
    bytes: buffer.length,
    sha256,
    references: references.map((reference) => ({
      sha256: reference.sha256, mime: reference.mime, width: reference.width, height: reference.height, source: reference.source
    })),
    providerRequestId: providerMeta.providerRequestId || '',
    usage: providerMeta.usage || null,
    createdAt: new Date(now).toISOString(),
    chatKey,
    trigger,
    senderId,
    composition,
    outpaint: outpaintRecord,
    proportion: proportionRecord,
    // 重画一次仍超 7.6 头身：只标记，不再重试，方便事后筛图。
    proportionOutlier: proportionRecord.outlier === true,
    ...(analysis ? {
      moderation: {
        appropriate: analysis.appropriate !== false,
        confidence: Number(analysis.confidence) || 0,
        safetyReason: String(analysis.safetyReason || '')
      }
    } : {})
  };
  let metaPath = '';
  try {
    metaPath = writeImageMeta(filePath, meta);
  } catch (error) {
    logger(`[imagegen] meta-fail provider=${chosen.provider} file=${filePath} detail=${shortError(error, chosen)}`);
  }

  const ms = Date.now() - started;
  logger(`[imagegen] ok provider=${chosen.provider} tier=${chosen.tier} model=${meta.model} ms=${ms} size=${meta.size}`
    + ` bytes=${buffer.length} mime=${mime} seed=${seed} refs=${references.length} moderation=pass`
    + ` composition=${composition ? `${(composition.personRatio * 100).toFixed(2)}%` : 'unmeasurable'}`
    + ` heads=${proportion ? proportion.headBodyRatio : 'unmeasurable'}`
    + ` proportion=${proportionRecord.triggered ? (proportionRecord.outlier ? 'outlier' : 'retried-ok') : 'ok'}`
    + ` outpaint=${outpaintRecord.triggered ? (outpaintRecord.ok ? 'applied' : 'failed') : (outpaintRecord.reason || 'skipped')}`
    + ` file=${filePath} meta=${metaPath || '-'}`);
  return {
    ok: true,
    buffer,
    mime,
    filePath,
    metaPath,
    meta,
    sha256,
    width,
    height,
    provider: chosen.provider,
    tier: chosen.tier,
    attempts,
    model: meta.model,
    size: meta.size,
    seed,
    references: references.map((reference) => reference.sha256),
    providerRequestId: meta.providerRequestId,
    ms,
    analysis,
    composition,
    outpaint: outpaintRecord,
    proportion: proportionRecord,
    proportionOutlier: proportionRecord.outlier === true
  };
}

/**
 * 分层模板合并：预设层 → config.imageGen.promptLayers 里的同名字段覆盖。
 * 只认 PROMPT_LAYER_ORDER 里的六个字段，其他键忽略，避免把拼装顺序写乱。
 * outfit 指定具体名字时覆盖 clothing 层；tail 档位会重写人物层里的尾巴描述。
 */
function normalizePromptLayers(raw, preset, options = {}) {
  const source = raw.promptLayers && typeof raw.promptLayers === 'object' ? raw.promptLayers : {};
  const tailMode = normalizeTailMode(options.tail);
  const layers = {};
  for (const key of PROMPT_LAYER_ORDER) {
    const fallback = preset.layers?.[key] ?? DEFAULT_PROMPT_LAYERS[key] ?? '';
    const value = key === 'character'
      ? (source.character ?? raw.characterPrompt ?? fallback)
      : (source[key] ?? fallback);
    layers[key] = String(value ?? '').replace(/\s+/g, ' ').trim();
  }
  layers.character = buildCharacterTemplate(tailMode, layers.character);
  // 脸部画法层只由 faceStyle 驱动：没有词条的档回落渐变柔光，避免留空又被自定义文本污染。
  layers.faceStyle = faceStyleLayerFor(options.faceStyle || 'auto');
  // 气质层只由 vibe 字段驱动，自定义人物层里残留的气质描述会被这里覆盖。
  layers.vibe = vibeLayerFor(options.vibe || 'mature');
  // 泳装/比基尼/睡裙露肤或贴身程度高，年龄外观必须毫无歧义地成年，宁可偏成熟。
  if (['swim', 'bikini', 'nightgown'].includes(options.outfit)) layers.vibe = `${layers.vibe}，${ADULT_HARD_LOCK}`;
  // 表情层只由 expression 字段驱动，避免自定义人物层里残留的表情描述与这里打架。
  layers.expression = expressionLayerFor(options.expression || DEFAULT_EXPRESSION);
  // 发型层：显式指定或关闭时在这里定稿；auto 只落固定长发占位，真正选型在出图时按会话决定。
  layers.hairstyle = hairstyleLayerFor(options.hairstyleName || '');
  const outfitClothing = options.outfit && options.outfit !== 'none' ? clothingLayerFor(options.outfit) : '';
  if (outfitClothing) {
    const motif = normalizeClothingMotif(options.clothingMotif);
    layers.clothing = motif ? `${outfitClothing}，服装上只有一处${motif}，不要重复出现其他图案` : outfitClothing;
  }
  // 景别、机位、人物占比、留白写进构图层第 4 位（画质、身份与脸部画法之后），确保送达。
  // 已归一化的层会被再次归一化（MCP 合并配置），先剔除旧景别句避免叠加。
  const wideScene = normalizeSceneFraming(options.sceneFraming) === 'wide_scene';
  const compositionText = wideScene
    ? SCENE_FRAMINGS.wide_scene.text
    : `${framingLayerFor(options.framing || 'full')}，${stripFramingClauses(layers.composition)}`;
  layers.composition = `${REFERENCE_IDENTITY_ONLY}，${compositionText}`;
  // 背景层补背景密度：rich 只虚化最远层，minimal 强虚化，mid 保持三层纵深。
  const detail = normalizeBackgroundDetail(options.backgroundDetail);
  const detailText = BACKGROUND_DETAILS[detail].text;
  const backgroundBase = stripBackgroundDepth(layers.background);
  layers.background = backgroundBase ? `${backgroundBase}，${detailText}` : detailText;
  return layers;
}

/** 把 config.json / 控制台里的原始值收敛成内部配置。 */
export function normalizeImageGenConfig(input = {}) {
  // 多 provider 档案：imageGen.providers.<provider> 只存该家的 Key/baseUrl/model，
  // 切到备选 provider 时自动带上，避免把密钥散落到每个链项里。
  // 档案优先于主配置的同名字段，否则切到 ark 还会拿着 dashscope 的 model/baseUrl。
  const profileProvider = normalizeProvider(input.provider);
  const profile = input.providers && typeof input.providers === 'object' ? input.providers[profileProvider] : null;
  const profileFields = profile && typeof profile === 'object'
    ? Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== '' && value !== undefined && value !== null))
    : null;
  const raw = profileFields ? { ...input, ...profileFields } : input;
  const provider = normalizeProvider(raw.provider);
  const defaults = PROVIDER_DEFAULTS[provider];
  const width = clampInt(raw.width, 256, 1536, 1024);
  const height = clampInt(raw.height, 256, 1536, 1024);
  const preset = resolveStylePreset(raw.stylePreset);
  const tailMode = normalizeTailMode(raw.tail);
  const vibeValue = normalizeVibe(raw.vibe);
  const vibe = vibeValue && vibeValue !== 'auto' ? vibeValue : pickVibe();
  const vibeSource = vibeValue && vibeValue !== 'auto' ? 'explicit' : 'auto';
  const outfit = resolveOutfit(raw.outfit, Math.random, vibe);
  const expression = normalizeExpression(raw.expression) || DEFAULT_EXPRESSION;
  const hairstyleEnabled = raw.hairstyleEnabled !== false;
  const hairstylePool = Array.isArray(raw.hairstylePool)
    ? raw.hairstylePool.map((item) => normalizeHairstyle(item)).filter((item) => HAIRSTYLE_NAMES.includes(item))
    : [];
  const requestedHairstyle = normalizeHairstyle(raw.hairstyle);
  const hairstyleMode = !hairstyleEnabled || requestedHairstyle === 'none'
    ? 'off'
    : (requestedHairstyle && requestedHairstyle !== 'auto' ? 'explicit' : 'auto');
  const hairstyleName = hairstyleMode === 'explicit' ? requestedHairstyle : '';
  const clothingMotif = normalizeClothingMotif(raw.clothingMotif);
  const framingChoice = resolveFraming(raw.framing, outfit);
  const framing = framingChoice.name;
  const faceStyleChoice = resolveFaceStyle(raw.faceStyle);
  const faceStyle = faceStyleChoice.name;
  const sceneFraming = normalizeSceneFraming(raw.sceneFraming);
  const backgroundDetail = normalizeBackgroundDetail(raw.backgroundDetail);
  // 方形画幅塞全身会显小、背景被挤掉：全身/七分身默认改竖幅 2:3，
  // wide_scene 改 16:9 横幅（1536×864），显式非方形尺寸则原样保留。
  const portrait = framing !== 'closeup' && width === height;
  const wide = sceneFraming === 'wide_scene' && width === height;
  const finalWidth = wide ? 1536 : (portrait ? 1024 : width);
  const finalHeight = wide ? 864 : (portrait ? 1536 : height);
  const promptLayers = normalizePromptLayers(raw, preset, {
    outfit, tail: tailMode, expression, vibe, hairstyleName, clothingMotif, framing,
    faceStyle: faceStyleChoice.name === 'none' ? 'none' : faceStyleChoice.name,
    sceneFraming, backgroundDetail
  });
  const timeoutMs = clampInt(raw.timeoutMs, 10_000, 300_000, 120_000);
  // Key 只从配置或环境变量读，永不回显；apiKeyEnv 便于把密钥留在环境里。
  const apiKey = String(raw.apiKey || (raw.apiKeyEnv ? process.env[String(raw.apiKeyEnv)] || '' : ''));
  const baseNegative = String(raw.negativePrompt || preset.negativePrompt);
  const tailNegative = TAIL_NEGATIVE[tailMode] || [];
  // 裁脚类负向词放最前：负向也有 500 字符上限，放最后等于没写。
  const negativePrompt = mergeNegativeTerms(FRAMING_NEGATIVE[framing] || [], baseNegative, tailNegative).join('、');
  return {
    enabled: raw.enabled !== false,
    provider,
    baseUrl: String(raw.baseUrl || defaults.baseUrl).replace(/\/+$/, ''),
    model: String(raw.model || defaults.model),
    textModel: String(raw.textModel || defaults.textModel || defaults.model),
    apiKey,
    apiKeyEnv: String(raw.apiKeyEnv || ''),
    width: finalWidth,
    height: finalHeight,
    size: `${finalWidth}x${finalHeight}`,
    stylePreset: preset.name,
    styleRotate: raw.styleRotate === true,
    outfit,
    framing,
    framingSource: framingChoice.source,
    sceneFraming,
    backgroundDetail,
    faceStyle,
    faceStyleSource: faceStyleChoice.source,
    tail: tailMode,
    vibe,
    vibeSource,
    expression,
    hairstyle: hairstyleName,
    hairstyleMode,
    hairstyleEnabled,
    hairstylePool,
    clothingMotif,
    characterPrompt: promptLayers.character,
    promptLayers,
    // 显式 stylePrompt 仍然优先（控制台临时覆盖）；否则由分层模板拼装。
    stylePrompt: String(raw.stylePrompt || assemblePromptLayers(promptLayers)),
    negativePrompt,
    // 正常出图一律带参考图：没有传参考图时用角色锚点兜底，连锚点都读不到就拒绝出图。
    referencePolicy: raw.referencePolicy === 'optional' ? 'optional' : (provider === 'dashscope' || provider === 'ark' ? 'require' : 'optional'),
    defaultReferenceImage: String(raw.defaultReferenceImage || ''),
    timeoutMs,
    // 单次请求超时之外的整体预算：含重试、下载与轮询，防止一条链跑十几分钟。
    budgetMs: clampInt(raw.budgetMs, 15_000, 900_000, Math.max(180_000, timeoutMs * 2)),
    maxRetries: clampInt(raw.maxRetries, 0, 1, 1),
    maxOutputBytes: clampInt(raw.maxOutputBytes, 1_048_576, 5 * 1_048_576, 5 * 1_048_576),
    watermark: raw.watermark === true,
    promptExtend: raw.promptExtend === true,
    // DashScope 编辑默认输出 2048²（约 4.6MB），默认按配置尺寸出图，避免贴 5MB 上限。
    sendSize: raw.sendSize === true || (raw.sendSize === undefined && provider === 'dashscope'),
    // 扩图兜底：只在人物占比超标时触发，开关在 outpaint.enabled。
    outpaint: normalizeOutpaintConfig(raw.outpaint),
    // 出图后比例检测：头身比超过 maxHeads 重画一次，仍超标只标记不重试。
    proportionCheck: normalizeProportionCheckConfig(raw.proportionCheck),
    capabilities: providerCapabilities(provider, raw.capabilities),
    allowGroup: raw.allowGroup === true,
    groupDailyLimit: clampInt(raw.groupDailyLimit, 0, 20, 3),
    groupUserCooldownMs: clampInt(raw.groupUserCooldownMs, 0, 3_600_000, 600_000),
    groupCooldownMs: clampInt(raw.groupCooldownMs, 0, 3_600_000, 30_000),
    ownerDailyLimit: clampInt(raw.ownerDailyLimit, 1, 100, 40),
    ownerCooldownMs: clampInt(raw.ownerCooldownMs, 0, 3_600_000, 60_000),
    randomEnabled: raw.randomEnabled !== false,
    randomChance: clampInt(raw.randomChance, 0, 100, 3),
    randomMinGapMs: clampInt(raw.randomMinGapMs, 600_000, 86_400_000, 6 * 3_600_000),
    randomDailyLimit: clampInt(raw.randomDailyLimit, 0, 10, 1),
    groupWhitelist: Array.isArray(raw.groupWhitelist) ? raw.groupWhitelist.map(String).filter(Boolean) : [],
    responseFormat: raw.responseFormat === 'b64_json' ? 'b64_json' : '',
    // 保留 provider 链，避免调用方先 normalize 一次就把链丢掉（退化成单 provider）。
    chain: Array.isArray(raw.chain) ? raw.chain : undefined
  };
}

// 群消息常带「[CQ:at,qq=...] 画图 ...」或「@小鲸鱼 画图 ...」，先剥掉再匹配命令。
const MENTION_PREFIX = /^(?:\s*\[CQ:at,[^\]]+\]\s*|\s*@\S+\s*)+/;

export function stripMentionPrefix(text) {
  return String(text ?? '').replace(MENTION_PREFIX, '').trim();
}

/** 解析「/画图 描述」「画图 描述」。 */
export function parseImageCommand(text) {
  const value = stripMentionPrefix(text);
  const match = value.match(/^(?:\/画图|\/draw|画图)\s*[:：]?\s*([\s\S]+)$/i);
  if (!match) return null;
  let body = match[1].replace(/^["“”'「」]+|["“”'「」]+$/g, '').trim();
  // 可选前缀：发型=丸子头 / hairstyle=high_ponytail、景别=全身 / framing=full，解析后从描述里剔除。
  let hairstyle = '';
  let framing = '';
  for (let round = 0; round < 2; round += 1) {
    const hair = body.match(/^(?:发型|hairstyle)\s*[=:：]\s*([^\s,，]+)\s*[,，]?\s*/i);
    if (hair && !hairstyle) {
      const name = normalizeHairstyle(hair[1]);
      if (name) {
        hairstyle = name;
        body = body.slice(hair[0].length).trim();
        continue;
      }
    }
    const frame = body.match(/^(?:景别|framing)\s*[=:：]\s*([^\s,，]+)\s*[,，]?\s*/i);
    if (frame && !framing) {
      const name = normalizeFraming(frame[1]);
      if (name !== DEFAULT_FRAMING) {
        framing = name;
        body = body.slice(frame[0].length).trim();
      }
    }
  }
  const description = body.slice(0, 200);
  if (description.length < 2) return null;
  const parsed = { description };
  if (hairstyle) parsed.hairstyle = hairstyle;
  if (framing) parsed.framing = framing;
  return parsed;
}

/** 判断当前这条画图请求能不能执行；返回 {allowed:true} 或 {allowed:false, reply}。 */
export function decideImageAccess({ isGroup, isOwner, mentioned, target, sender, config, quota = null }) {
  if (!config.enabled) return { allowed: false, reply: '画图功能现在关着，去控制台打开一下。' };
  if (!isGroup) {
    if (!isOwner) return { allowed: false, reply: '画图现在只对主人开放。' };
    if (quota) {
      const check = quota.check(`u:${sender}`, { cooldownMs: config.ownerCooldownMs, dailyLimit: config.ownerDailyLimit });
      if (!check.ok) {
        return { allowed: false, reply: check.reason === 'daily-limit' ? '今天的画图额度用完了，明天再画。' : '刚画过一张，歇一会再画。' };
      }
    }
    return { allowed: true };
  }
  // 生图只允许主人使用：主人私聊，或主人在群里下命令。群友在任何场景都直接拒绝。
  if (isOwner) {
    if (quota) {
      const check = quota.check(`u:${sender}`, { cooldownMs: config.ownerCooldownMs, dailyLimit: config.ownerDailyLimit });
      if (!check.ok) {
        return { allowed: false, reply: check.reason === 'daily-limit' ? '今天的画图额度用完了，明天再画。' : '刚画过一张，歇一会再画。' };
      }
    }
    return { allowed: true };
  }
  return { allowed: false, reply: '画图功能只对主人开放，别人这边就不画了。' };
}

/**
 * 正/负两段分开返回：
 * - 支持原生 negative_prompt 的后端只发正向，负向单独传；
 * - 不支持的后端由 buildPrompt 回退拼进正向。
 */
export function buildPromptParts(description, stylePrompt = DEFAULT_STYLE_PROMPT, negativePrompt = NEGATIVE_STYLE_PROMPT,
  characterPrompt = CHARACTER_TEMPLATE) {
  const original = String(description ?? '').trim();
  const content = sanitizeDrawDescription(original) || original;
  const style = String(stylePrompt ?? '').trim();
  const negative = String(negativePrompt ?? '').trim();
  const character = String(characterPrompt ?? '').trim();
  // 人物层已经包含在 style 里时不再重复前置：以前同一段角色锁被拼了两遍，白占 300+ 字符。
  const characterBlock = character && !style.includes(character) ? character : '';
  const base = characterBlock ? `${characterBlock}；${style}` : style;
  // 描述只吃剩余预算：宁可把用户描述截短（会记录），也不能让接口把构图和身份锁截掉。
  const room = Math.max(0, PROMPT_BUDGET.positive.max - measurePromptChars({ positive: base }).positive - 1);
  const contentChars = Array.from(content);
  const body = room > 0 ? contentChars.slice(0, room).join('') : '';
  const positive = body ? `${base}；${body}` : base;
  return { positive, negative, descriptionTrimmed: body.length < content.length };
}

/** 文本型后端的整段 prompt（负向词拼进正向，接口不认识 negative_prompt）。 */
export function buildPrompt(description, stylePrompt = DEFAULT_STYLE_PROMPT, negativePrompt = NEGATIVE_STYLE_PROMPT,
  characterPrompt = CHARACTER_TEMPLATE) {
  const parts = buildPromptParts(description, stylePrompt, negativePrompt, characterPrompt);
  // 不用换行：pollinations 兜底会把 prompt 拼进 URL，换行会带来额外编码开销。
  return parts.negative ? `${parts.positive}；【严格禁止】${parts.negative}` : parts.positive;
}

/** 画图失败时的统一对外文案：不静默兜底，也不含糊其辞。 */
export function drawFailureReply(result = {}) {
  if (result.reason === 'moderation') {
    const detail = String(result.analysis?.safetyReason || '').trim();
    return `这张没过内容审核${detail ? `（${detail}）` : '（涉及露点或裸露）'}，已拦下，没有保存也没有发送。`;
  }
  if (result.reason === 'moderation-unavailable') return '图片审核服务暂时不可用，为稳妥起见这次没有出图。';
  if (result.reason === 'storage') return '图片保存失败，这次没有出图。';
  if (result.reason === 'prompt-blocked') return `这次没画：描述里出现了不能画的内容（${result.error || '疑似未成年角色'}）。`;
  if (result.reason === 'reference-invalid') return `参考图没通过校验：${result.error || '格式不支持'}。`;
  if (result.reason === 'reference-required') return '这次缺参考图，为了不画歪已经拦下：请先发一张参考图再让我画。';
  if (result.reason === 'reference-unsupported') return '当前生图后端不支持参考图，这次没有画。';
  if (result.reason === 'image-too-large') return '图生成出来了但体积超过发送上限，这次没有发。';
  if (result.reason === 'timeout') return '这次等太久了，图没出来。';
  if (result.reason === 'no-key') return '生图后端还没配置密钥，这次没有画。';
  if (result.reason === 'outfit-private-only') return '这套衣服只在主人的私聊里画，群里就先不画了。';
  if (result.reason === 'owner-only') return '画图功能只对主人开放，别人这边就不画了。';
  return '画图额度不足，这次没有画。';
}

function asPromptParts(prompt) {
  if (typeof prompt === 'string') return { positive: prompt, negative: '' };
  return { positive: String(prompt?.positive ?? ''), negative: String(prompt?.negative ?? '') };
}

/**
 * 按 provider 适配请求体。prompt 可以是字符串（旧调用），
 * 也可以是 buildPromptParts 返回的 { positive, negative }。
 */
export function buildImageRequest(config, prompt, options = {}) {
  const parts = asPromptParts(prompt);
  const capabilities = config.capabilities || providerCapabilities(config.provider);
  if (config.provider === 'dashscope') return buildDashScopeRequest(config, parts, options);
  if (config.provider === 'ark') return buildArkRequest(config, parts, options);
  if (config.provider === 'openai') return buildOpenAIRequest(config, parts, options, capabilities);
  return buildPollinationsRequest(config, parts, options);
}

// Seedream 没有 negative_prompt，只能把最关键的身份/红线词并进正向提示词。
// 全量 98 条会把正向描述冲淡，这里只挑会直接毁角色或踩红线的那一类。
const ARK_INLINE_NEGATIVE = /幼态|儿童|幼女|幼童|幼儿|三头身|二头身|四头身|Q版|娃娃|换发色|紫发|青蓝|人类耳朵|羽毛耳饰|多条尾巴|树枝尾巴|水印|文字|签名|多指|少指|脸部崩坏/;

function compactNegativeForArk(negative) {
  return String(negative ?? '')
    .split(/[、,，]/)
    .map((term) => term.trim())
    .filter((term) => term && ARK_INLINE_NEGATIVE.test(term))
    .slice(0, 24)
    .join('、');
}

function buildArkRequest(config, parts, options) {
  const references = Array.isArray(options.references) ? options.references : [];
  const negative = compactNegativeForArk(parts.negative);
  // Seedream 4.x / 5.0 lite 支持组图开关；5.0 pro/flash 不支持，传了会 400。
  const supportsSequential = !/seedream-5-0-(pro|flash)/.test(String(config.model || ''));
  return {
    url: `${config.baseUrl}/images/generations`,
    init: {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model: config.model,
        prompt: negative ? `${parts.positive}；【严格禁止】${negative}` : parts.positive,
        // 参考图用 data URL 传，省一次上传；Seedream 4.0 支持 1–14 张。
        ...(references.length
          ? { image: references.map((reference) => `data:${reference.mime};base64,${reference.data.toString('base64')}`) }
          : {}),
        size: config.size,
        // 关掉组图，保证一次请求只出一张、只计一次费。
        ...(supportsSequential ? { sequential_image_generation: 'disabled' } : {}),
        response_format: 'b64_json',
        watermark: config.watermark === true
      })
    }
  };
}

function authHeaders(config) {
  return {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
  };
}

// 智谱的输入风控会对"露点/裸露/性行为/强烈性暗示"这类词直接 400（code 1301），
// 即使它们出现在负向词里。文本型后端合并负向词前先剔除这几项。
const TEXT_PROVIDER_BLOCKED_TERMS = ['露点', '裸露', '性行为', '强烈性暗示'];

function inlineNegativeForTextProvider(negative) {
  const text = String(negative ?? '');
  if (!text) return '';
  return text
    .split(/[、,，]/)
    .map((term) => term.trim())
    .filter((term) => term && !TEXT_PROVIDER_BLOCKED_TERMS.includes(term))
    .join('、');
}

function buildOpenAIRequest(config, parts, options, capabilities) {
  return {
    url: `${config.baseUrl}/images/generations`,
    init: {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model: config.model,
        // 不支持 negative_prompt 的后端（智谱等）把负向词并进正向，否则禁忌会整段丢掉。
        prompt: !capabilities.negativePrompt && inlineNegativeForTextProvider(parts.negative)
          ? `${parts.positive}；【严格禁止】${inlineNegativeForTextProvider(parts.negative)}`
          : parts.positive,
        size: config.size,
        n: 1,
        // 只有声明支持 negative_prompt 的后端才单独传，避免智谱这类接口报错。
        ...(capabilities.negativePrompt && parts.negative ? { negative_prompt: parts.negative } : {}),
        ...(config.responseFormat ? { response_format: config.responseFormat } : {})
      })
    }
  };
}

function buildDashScopeRequest(config, parts, options) {
  const references = Array.isArray(options.references) ? options.references : [];
  const model = references.length
    ? (config.model || 'qwen-image-3.0')
    : (config.textModel || 'qwen-image-3.0');
  const content = references.map((reference) => ({
    image: `data:${reference.mime};base64,${reference.data.toString('base64')}`
  }));
  content.push({ text: parts.positive });
  const parameters = {
    watermark: config.watermark === true,
    prompt_extend: config.promptExtend === true
  };
  if (parts.negative) parameters.negative_prompt = parts.negative;
  // 文生图必须给尺寸；编辑默认跟随参考图比例，只有显式要求时才传 size。
  if (!references.length || config.sendSize === true) parameters.size = config.size.replace('x', '*');
  return {
    url: `${config.baseUrl}/services/aigc/multimodal-generation/generation`,
    init: {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content }] },
        parameters
      })
    }
  };
}

function buildPollinationsRequest(config, parts, options) {
  const seed = Number.isFinite(options.seed) ? options.seed : Math.floor(Math.random() * 1_000_000_000);
  const url = `${config.baseUrl}/prompt/${encodeURIComponent(parts.positive)}`
    + `?width=${config.width}&height=${config.height}&nologo=true&model=${encodeURIComponent(config.model)}&seed=${seed}`;
  return { url, init: { method: 'GET', headers: { accept: 'image/*' } } };
}

/** 参考图：base64 / data URL / 本地路径，做体积、边长、mime、张数校验。 */
export const REFERENCE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxCount: 3,
  minSide: 256,
  maxSide: 4096
};
const REFERENCE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const REFERENCE_EXT = /\.(png|jpe?g|webp)$/i;

function readPngSize(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpSize(bytes) {
  if (bytes.length < 30) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25) return null;
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** 只读图片头拿真实宽高；解析不了返回 null（不猜）。 */
export function readImageDimensions(buffer) {
  const bytes = Buffer.from(buffer ?? []);
  return readPngSize(bytes) || readJpegSize(bytes) || readWebpSize(bytes);
}

function readReferenceBuffer(item) {
  if (Buffer.isBuffer(item)) return { buffer: item, source: 'buffer' };
  if (item && typeof item === 'object') {
    if (item.buffer) return { buffer: Buffer.from(item.buffer), source: 'buffer' };
    const value = String(item.dataUrl || item.base64 || item.path || '').trim();
    return readReferenceText(value);
  }
  return readReferenceText(String(item ?? '').trim());
}

function looksLikeImageBuffer(buffer) {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

function readReferenceText(value) {
  if (!value) throw new Error('参考图为空');
  const dataUri = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(value);
  if (dataUri) return { buffer: Buffer.from(dataUri[2].replace(/\s+/g, ''), 'base64'), source: 'base64' };
  // 纯 base64：先按图片头判断，避免把短路径误判成 base64。
  const compact = value.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(compact)) {
    const decoded = Buffer.from(compact, 'base64');
    if (looksLikeImageBuffer(decoded) || (compact.length > 256 && decoded.length > 0)) {
      return { buffer: decoded, source: 'base64' };
    }
  }
  if (!REFERENCE_EXT.test(extname(value))) throw new Error('参考图只支持 png/jpeg/webp');
  const target = resolve(value);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error('参考图路径不是文件');
  if (stat.size > REFERENCE_LIMITS.maxBytes) throw new Error('参考图超过 10MB');
  return { buffer: readFileSync(target), source: 'path' };
}

export function normalizeReferenceImages(input, options = {}) {
  const items = Array.isArray(input) ? input : [input];
  const maxCount = Math.max(1, Math.min(REFERENCE_LIMITS.maxCount, Number(options.maxCount) || REFERENCE_LIMITS.maxCount));
  if (items.length > maxCount) return { ok: false, error: `参考图最多 ${maxCount} 张` };
  const images = [];
  for (const item of items) {
    let buffer;
    let source;
    try {
      ({ buffer, source } = readReferenceBuffer(item));
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
    if (!buffer?.length) return { ok: false, error: '参考图内容为空' };
    if (buffer.length > REFERENCE_LIMITS.maxBytes) return { ok: false, error: '参考图超过 10MB' };
    const mime = sniffImageMime(buffer);
    if (!REFERENCE_MIMES.has(mime)) return { ok: false, error: '参考图只支持 png/jpeg/webp' };
    const size = readImageDimensions(buffer);
    if (!size) return { ok: false, error: '无法读取参考图尺寸' };
    if (size.width < REFERENCE_LIMITS.minSide || size.height < REFERENCE_LIMITS.minSide) {
      return { ok: false, error: `参考图边长不能小于 ${REFERENCE_LIMITS.minSide}px（当前 ${size.width}×${size.height}）` };
    }
    if (size.width > REFERENCE_LIMITS.maxSide || size.height > REFERENCE_LIMITS.maxSide) {
      return { ok: false, error: `参考图边长不能大于 ${REFERENCE_LIMITS.maxSide}px（当前 ${size.width}×${size.height}）` };
    }
    images.push({ data: buffer, mime, width: size.width, height: size.height, source, sha256: sha256Of(buffer) });
  }
  return { ok: true, images };
}

export function sniffImageMime(buffer, contentType = '') {
  const bytes = Buffer.from(buffer ?? []);
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  const declared = String(contentType).split(';')[0].trim().toLowerCase();
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(declared) ? declared : 'image/jpeg';
}

function extensionForMime(mime) {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
}

/** QQ 发图必须用 base64；本地路径在 highway 上传会失败。 */
export function toImageSegment(buffer) {
  return { type: 'image', data: { file: `base64://${Buffer.from(buffer ?? []).toString('base64')}` } };
}

export function pickRandomTheme(random = Math.random) {
  const index = Math.min(RANDOM_THEMES.length - 1, Math.max(0, Math.floor(random() * RANDOM_THEMES.length)));
  return RANDOM_THEMES[index];
}

export function shouldDrawRandomly({ config, now = Date.now(), lastAt = 0, usedToday = 0, random = Math.random }) {
  if (!config?.enabled || !config.randomEnabled) return false;
  if (now - lastAt < config.randomMinGapMs) return false;
  if (usedToday >= config.randomDailyLimit) return false;
  return random() < config.randomChance / 100;
}

/** 内存版冷却/每日限额（占位实现，重启清零；主人私聊与群友规则共用）。 */
export function createImageGenQuota({ now = () => Date.now() } = {}) {
  const lastAt = new Map();
  const dayCounts = new Map();
  const dayOf = (key) => {
    const item = dayCounts.get(key);
    return item?.day === localDayKey(now()) ? item.count : 0;
  };
  return {
    check(key, { cooldownMs = 0, dailyLimit = Infinity } = {}) {
      const time = now();
      const used = dayOf(key);
      if (Number.isFinite(dailyLimit) && used >= dailyLimit) return { ok: false, reason: 'daily-limit', used, dailyLimit };
      const last = lastAt.get(key) || 0;
      const gap = time - last;
      if (cooldownMs > 0 && last > 0 && gap < cooldownMs) {
        return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - gap, used, dailyLimit };
      }
      return { ok: true, used, dailyLimit };
    },
    record(key) {
      const time = now();
      const day = localDayKey(time);
      lastAt.set(key, time);
      const item = dayCounts.get(key);
      dayCounts.set(key, { day, count: item?.day === day ? item.count + 1 : 1 });
    },
    usedToday(key) {
      return dayOf(key);
    },
    reset() {
      lastAt.clear();
      dayCounts.clear();
    }
  };
}

function shortError(error, config = null) {
  let text = String(error?.message ?? error ?? '');
  if (config?.apiKey) text = text.split(config.apiKey).join('[redacted]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').slice(0, 200);
}

async function downloadProviderImage(url, fetchImpl, timeoutMs) {
  let target;
  try { target = new URL(url); } catch { throw new Error('provider returned invalid image url'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('provider returned non-http image url');
  const imageResponse = await fetchImpl(target.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  if (!imageResponse.ok) throw new Error(`image download HTTP ${imageResponse.status}`);
  return {
    buffer: Buffer.from(await imageResponse.arrayBuffer()),
    contentType: imageResponse.headers?.get?.('content-type') || ''
  };
}

function dashScopeError(data, response) {
  const code = String(data?.code || data?.output?.code || '');
  const message = String(data?.message || data?.output?.message || '').slice(0, 160);
  const error = new Error(`dashscope response missing image${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`);
  error.status = response?.status;
  error.providerCode = code;
  return error;
}

async function readDashScopeImage(response, config, fetchImpl, timeoutMs) {
  const data = await response.json();
  const output = data?.output || {};
  const choice = output?.choices?.[0];
  const content = choice?.message?.content;
  const items = Array.isArray(content) ? content : (content ? [content] : []);
  let imageUrl = '';
  for (const item of items) {
    if (typeof item === 'string' && /^(https?:|data:)/.test(item)) { imageUrl = item; break; }
    if (item?.image) { imageUrl = item.image; break; }
  }
  if (!imageUrl) imageUrl = String(output?.results?.[0]?.url || '');
  if (!imageUrl) throw dashScopeError(data, response);
  const meta = { providerRequestId: String(data?.request_id || ''), usage: data?.usage || null, model: String(data?.model || '') };
  if (imageUrl.startsWith('data:')) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(imageUrl);
    if (!match) throw new Error('dashscope returned invalid data url');
    return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1], ...meta };
  }
  return { ...(await downloadProviderImage(imageUrl, fetchImpl, timeoutMs)), ...meta };
}

function arkError(data, response) {
  const code = String(data?.error?.code || data?.code || '');
  const message = String(data?.error?.message || data?.message || '').slice(0, 160);
  const error = new Error(`ark response missing image${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`);
  error.status = response?.status;
  error.providerCode = code;
  return error;
}

async function readArkImage(response, config, fetchImpl, timeoutMs) {
  const data = await response.json();
  const item = data?.data?.[0];
  const meta = {
    providerRequestId: String(data?.request_id || ''),
    usage: data?.usage || null,
    model: String(data?.model || ''),
    outputSize: String(item?.size || '')
  };
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    // Seedream 4.0 不支持 output_format，默认输出 jpeg 字节。
    return { buffer: Buffer.from(item.b64_json, 'base64'), contentType: 'image/jpeg', ...meta };
  }
  if (typeof item?.url === 'string' && item.url) {
    return { ...(await downloadProviderImage(item.url, fetchImpl, timeoutMs)), ...meta };
  }
  throw arkError(data, response);
}

async function readProviderImage(response, config, fetchImpl, timeoutMs = config.timeoutMs) {
  if (config.provider === 'dashscope') return readDashScopeImage(response, config, fetchImpl, timeoutMs);
  if (config.provider === 'ark') return readArkImage(response, config, fetchImpl, timeoutMs);
  if (config.provider === 'openai') {
    const data = await response.json();
    const item = data?.data?.[0];
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      return { buffer: Buffer.from(item.b64_json, 'base64'), contentType: 'image/png' };
    }
    if (typeof item?.url === 'string' && item.url) {
      return downloadProviderImage(item.url, fetchImpl, timeoutMs);
    }
    throw new Error('openai image response missing data');
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers?.get?.('content-type') || ''
  };
}

const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
const RATE_LIMIT_COOLDOWN_MS = 45_000;
// 冷却按 provider:model 隔离：一个后端的 429 不能连带封掉整条链。
const providerCooldownUntil = new Map();

/** 仅供测试/运维：清掉指定 provider（或全部）的冷却。 */
export function resetProviderCooldown(key = '') {
  if (key) providerCooldownUntil.delete(String(key));
  else providerCooldownUntil.clear();
}

function providerKey(config) {
  return `${config.provider}:${config.model}`;
}

function retryAfterMs(response) {
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('retry-after') : '';
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 120_000) : RATE_LIMIT_COOLDOWN_MS;
}

async function fetchProviderImage(config, prompt, options, fetchImpl, sleep) {
  const key = providerKey(config);
  const remaining = (providerCooldownUntil.get(key) || 0) - Date.now();
  if (remaining > 0) {
    const error = new Error(`provider rate limited, retry in ${Math.ceil(remaining / 1000)}s`);
    error.code = 'rate-limit';
    error.retryAfterMs = remaining;
    throw error;
  }
  if ((config.provider === 'dashscope' || config.provider === 'ark') && !config.apiKey) {
    const error = new Error(`${config.provider} apiKey 未配置`);
    error.code = 'no-key';
    throw error;
  }
  const { url, init } = buildImageRequest(config, prompt, options);
  const startedAt = Date.now();
  const maxAttempts = 1 + Math.max(0, Number(config.maxRetries) || 0);
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    // 整体预算：重试与下载共用，超了就不再打后端。
    if (elapsed >= config.budgetMs) {
      const error = new Error(`provider budget ${config.budgetMs}ms exceeded`);
      error.code = 'budget';
      throw error;
    }
    const requestTimeout = Math.max(1_000, Math.min(config.timeoutMs, config.budgetMs - elapsed));
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(requestTimeout) });
      if (response.ok) return response;
      // pollinations 免费额度用尽时也会返回 402 图片（“Free limit reached”长图），
      // 不能当生成结果使用；直接进入冷却，避免把错误卡片发出去。
      if (response.status === 429 || (config.provider === 'pollinations' && response.status === 402)) {
        const cooldown = retryAfterMs(response);
        providerCooldownUntil.set(key, Date.now() + cooldown);
        const error = new Error(`provider HTTP ${response.status} (rate limited)`);
        error.code = 'rate-limit';
        error.status = response.status;
        error.retryAfterMs = cooldown;
        throw error;
      }
      const body = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      const error = new Error(`provider HTTP ${response.status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      error.status = response.status;
      try {
        const parsed = JSON.parse(body);
        error.providerCode = String(parsed?.error?.code ?? parsed?.code ?? '');
      } catch {}
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts - 1) throw error;
      lastError = error;
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        // 生成非幂等：超时后不重试，避免重复计费。
        const timeout = new Error(`provider timeout after ${requestTimeout}ms`);
        timeout.code = 'timeout';
        throw timeout;
      }
      if (error?.code === 'rate-limit' || (error?.status && !RETRYABLE_STATUS.has(error.status))) throw error;
      if (attempt === maxAttempts - 1) throw error;
      lastError = error;
    }
    await sleep(1_500 * (attempt + 1));
  }
  throw lastError || new Error('provider unavailable');
}

