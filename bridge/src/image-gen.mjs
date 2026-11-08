// 画图：provider 抽象 + 冷却/限额 + 内容审核 + 本地落盘 + base64 发送段。
// 默认走 pollinations（免 Key）；provider 字段可切到 openai 兼容接口（如智谱）。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { inspectDrawPrompt, shouldBlockImageStorage } from './image-content-policy.mjs';
import { sha256Of, writeImageMeta } from './image-gen-meta.mjs';

// ── 分层提示词模板（2026-11 针对 qwen-image-3.0 重写）────────────────────────
// 七层可独立替换，拼装顺序固定：quality → character → vibe → expression → clothing → composition → lighting → background。
// config.imageGen.promptLayers 可按字段整段覆盖任意一层，字段名见 PROMPT_LAYER_LABELS。
export const PROMPT_LAYER_ORDER = ['quality', 'character', 'vibe', 'expression', 'clothing', 'composition', 'lighting', 'background'];

export const PROMPT_LAYER_LABELS = {
  quality: '画质与风格',
  character: '固定人物，不可替换',
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
// 表情独立成层：人物层只锁五官结构，不写死任何表情。
const CHARACTER_BASE_CLAUSES = [
  'DeepSeek 女化形象（唯一指定角色，禁止替换成其他角色）',
  '成年女性，二十岁上下，柔和成熟的鹅蛋脸，下巴圆润，带一点软糯的婴儿肥，成人比例约七头身',
  '纯宝蓝、钴蓝色长发，发丝细密、轮廓不规则，发梢自然散开，没有紫色或青色渐变',
  '细长半杏眼，眼尾微微下垂，tareme 垂眼，瞳色深海蓝，眼型基础形状固定',
  '两侧鲸鳍状耳，外缘深蓝、内侧白色羽状褶边，像鲸鱼鳍而不是羽毛，左右都要有',
  '另有鲸鱼造型的发饰或挂件，鲸鱼元素至少两处',
  '静态五官结构固定，不含任何表情，head_fins'
];

// 尾巴三档：required=立绘正身必带，optional=构图拥挤/侧身时省略，off=完全不画。
// 写法沿用社区返修经验：数量 + 连接点 + 朝向 + 遮挡，模型会数错。
export const TAIL_MODES = ['required', 'optional', 'off'];
export const DEFAULT_TAIL_MODE = 'optional';

const TAIL_CLAUSES = {
  required: [
    '只有一条鲸尾，尾柄藏在衣物内，从后侧裙摆下方伸出，向侧后方弯曲，末端两片水平尾鳍',
    '画面中只有一条尾、两只手、两只脚',
    'cetacean_tail'
  ],
  optional: [
    '鲸尾可选：构图宽松时从后侧裙摆下方伸出一条鲸尾，向侧后方弯曲，末端两片水平尾鳍；构图拥挤、侧身或被衣物遮挡时直接省略尾巴',
    '最多一条尾，不出现第二条',
    'cetacean_tail'
  ],
  off: [
    '不画鲸鱼尾，身后没有尾巴',
    '鲸鱼辨识度改由鲸鳍状耳、鲸鱼造型发饰与服装上的小鲸鱼刺绣提供，至少三处'
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
// 表情只动眉毛、眼睛开合、瞳孔高光、嘴角与脸红；脸型/眼型/五官位置/发型发色/耳饰一律不动。
const EXPRESSION_IDENTITY_LOCK = '只改变眉毛弧度、眼睛开合度、瞳孔高光、嘴角方向与脸红程度，脸型、眼型基础形状、五官位置、发型发色与耳饰保持固定人物模板不变';

export const EXPRESSIONS = {
  gentle: {
    label: '温柔浅笑',
    text: '眉毛平缓舒展、眉尾略下垂，眼睛半眯成柔和弧线，瞳孔高光偏小且柔和，嘴角轻轻上扬约五度，脸颊一层淡淡的粉红',
    faceHint: 'smile, closed mouth'
  },
  happy: {
    label: '开心大笑',
    text: '眉毛上扬成弯弧，眼睛弯成月牙、露出笑眼纹，瞳孔高光清亮，嘴巴张开露出上排牙齿、嘴角明显上扬，脸颊与鼻尖泛红',
    faceHint: 'open mouth, big smile, happy'
  },
  shy: {
    label: '害羞脸红',
    text: '眉毛微微下垂、眉尾向内收，眼睛下垂视线偏向一侧、上眼睑略降，瞳孔高光含水，嘴角抿起小幅上扬，双颊与耳尖明显泛红、有斜线红晕',
    faceHint: 'blush, embarrassed, looking away'
  },
  pout: {
    label: '委屈撅嘴',
    text: '眉毛呈八字形向中间上方蹙起，眼睛睁到中等大小、下眼睑略微上推，瞳孔高光湿亮像含泪，嘴唇向前嘟起、嘴角向下，鼻头与脸颊微红',
    faceHint: 'pout, puffed cheeks, teary eyes'
  },
  smug: {
    label: '得意坏笑',
    text: '一侧眉毛挑起、另一侧压低，眼睛半眯、瞳孔高光集中，嘴角单边上扬成坏笑、露出一点犬齿，脸红很淡',
    faceHint: 'smirk, one eyebrow raised, half-closed eyes'
  },
  surprised: {
    label: '惊讶睁大眼',
    text: '眉毛高高扬起、眉形变圆，眼睛睁到最大、上下眼白露出一点，瞳孔缩小且高光集中，嘴巴微张成小圆形，脸颊泛红很淡',
    faceHint: 'wide eyes, surprised, open mouth'
  },
  sleepy: {
    label: '困倦半睡',
    text: '眉毛放松平放、眉尾略下垂，上眼睑压到瞳孔上半、眼睛半闭，瞳孔高光模糊，嘴巴微张像打哈欠、嘴角放松下垂，眼下有淡淡青色与浅红',
    faceHint: 'sleepy, half-closed eyes, yawning'
  },
  serious: {
    label: '认真皱眉',
    text: '眉毛向中间压低、眉间有浅浅竖纹，眼睛睁到中等大小、目光正视有焦点，瞳孔高光清晰锐利，嘴唇抿成一条直线、嘴角平放，脸红几乎不可见',
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

// ── 气质/年龄表现层 ────────────────────────────────────────────────────────
// 只调“幼态感 / 脸部圆润度 / 眼神氛围 / 姿态气质”，成年女性体型与比例始终不变。
const VIBE_IDENTITY_LOCK = '成年女性体型与比例（约七头身、成人肩宽与骨架）始终不变；只调整幼态感、脸部圆润度、眼神氛围与姿态气质，脸的基础轮廓、深海蓝瞳、宝蓝长发（发根深、发梢略浅）、鲸鳍状耳与瞳色位置保持不变，不换人、不改发色、不换耳饰';

export const VIBES = {
  cute: {
    label: '萌系',
    text: '脸部线条更圆润一点、脸颊更饱满，眼睛偏大偏亮、眼神又软又亮，姿态轻快放松、肩膀微微内收，整体气质软萌亲和，但仍是成年女性的身形与成熟骨架，不是小孩',
    faceHint: 'soft round face, bright eyes, cute but adult woman'
  },
  youth: {
    label: '青春少女',
    text: '脸颊饱满、气色明亮，眼睛清亮有精神，站姿轻快自然，气质干净有活力，介于软萌与沉静之间，成年女性的身形比例',
    faceHint: 'youthful adult woman, bright complexion, lively'
  },
  mature: {
    label: '成熟御姐',
    text: '脸部线条偏修长、下颌更清晰，眼睛半眯、眼神沉静内敛，姿态舒展、肩颈线条挺直，气质成熟从容',
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
  return `${item.label}，${item.text}，${VIBE_IDENTITY_LOCK}`;
}



// 服装池：六套日常/正装，鲸鱼元素只做刺绣、挂件或印花，不能抢人物主体。
// 统一追加一句身份锁：换衣服不改脸、不改发型。
const CLOTHING_IDENTITY_LOCK = '服装只换衣服，脸型、五官、发型、发色与耳饰保持固定人物模板不变';

export const CLOTHING_POOL = {
  maid: {
    label: '女仆装',
    clothing: '深海军蓝与纯白撞色的长袖女仆装，层叠荷叶边围裙，裙长过膝，围裙口袋上一枚巴掌大的小鲸鱼刺绣，衣物整洁、褶皱自然'
  },
  jk: {
    label: 'JK 水手服',
    clothing: '白底深蓝领的水手服上衣，深蓝色格纹及膝百褶裙，白色及膝袜与深蓝领结，胸口别一枚小鲸鱼金属胸针，衣摆与裙腰衔接整齐'
  },
  hoodie: {
    label: '休闲卫衣+短裙',
    clothing: 'oversize 浅蓝灰连帽卫衣配深色 A 字短裙，卫衣抽绳末端是小鲸鱼形状的金属头，裙摆到膝盖上方，衣着完整'
  },
  knit: {
    label: '针织衫+百褶裙',
    clothing: '米白色粗针织开衫内搭白衬衫，深蓝百褶中长裙，开衫左胸一处小鲸鱼刺绣，衣物柔软整洁'
  },
  yukata: {
    label: '和风浴衣',
    clothing: '藏青色底白浪纹的和风浴衣，浅蓝腰带，袖口与衣摆有细小的鲸鱼印花，衣领整齐交叠、不露肩，衣着完整'
  },
  shirt: {
    label: '简约白衬衫',
    clothing: '简约白色衬衫配深蓝及膝半身裙，袖口卷起，衬衫口袋绣一只很小的鲸鱼，领口扣好，衣物干净利落'
  }
};

export const OUTFIT_NAMES = Object.keys(CLOTHING_POOL);
// auto=每次出图随机一套；none=沿用上层（preset/promptLayers）里的服装描述。
export const DEFAULT_OUTFIT = 'auto';

export function normalizeOutfit(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'none') return 'none';
  if (OUTFIT_NAMES.includes(key)) return key;
  return DEFAULT_OUTFIT;
}

// 气质 × 服装适配：auto 选服装时避开明显违和的组合（萌系不配女仆装、御姐不配 JK 等）。
const VIBE_OUTFIT_POOL = {
  cute: ['hoodie', 'knit', 'jk', 'shirt'],
  youth: ['jk', 'hoodie', 'knit', 'shirt', 'yukata'],
  mature: ['knit', 'shirt', 'yukata', 'maid']
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
  return preset ? `${preset.clothing}，${CLOTHING_IDENTITY_LOCK}` : '';
}

export const DEFAULT_PROMPT_LAYERS = {
  quality: '高质量日系动漫插画，精细线稿，线条干净且粗细有变化，赛璐璐上色与厚涂混合，平涂区域干净、厚涂区域有笔触，发丝分层清晰并带通透高光，皮肤与布料柔和渐变，刺绣与金属饰件细节清楚，画面干净通透，高分辨率，细节丰富',
  character: CHARACTER_TEMPLATE,
  vibe: vibeLayerFor('mature'),
  expression: expressionLayerFor(DEFAULT_EXPRESSION),
  clothing: '深蓝色旗袍式长裙，白色滚边与盘扣，裙身小鲸鱼刺绣图案，侧开摆便于行动，衣物整洁、褶皱自然',
  composition: '日系立绘构图，人物为唯一主体，主体清晰不被遮挡，平视视角，姿态舒展自然，画面留白适中',
  lighting: '主光来自左前上方，柔和轮廓光勾出发丝与肩线边缘，暗部保留细节，环境光偏冷蓝，冷暖对比，体积光，浅景深虚化背景',
  background: '背景有前后景层次，散景与灯光形成氛围，不抢主体'
};

const NEGATIVE_CORE = [
  // 画质类：qwen-image-3.0 对“糊/低分辨率”这类词反应明显。
  '低分辨率', '模糊', '糊', '噪点', '颗粒', '过曝', '欠曝', '过度锐化', '边缘锯齿',
  // 肢体类：手部是这类模型的主要翻车点。
  '多指', '少指', '手指畸形', '肢体错误', '手部崩坏', '断肢',
  '脸部崩坏', '五官错位', '眼睛不对称', '大小眼',
  // 画面杂物。
  '水印', '文字', '签名', '角标', 'logo', '二维码', '画框',
  // 风格与角色锁。以下词来自两批失败样张的返修记录（见 IMAGE_LIBRARY 反面教材标签）：
  // 紫发/天蓝发色、鳍耳退化成羽毛耳饰或耳坠、Q版幼态、半写实 BJD、无尾/布带尾。
  '写实照片', '真人', '真人风格', '3D渲染', 'Q版', '三头身', '二头身', '四头身', '大头小身', '圆脸大眼',
  '黏土人', '平涂卡通', '粗描边扁平上色', '猫耳毛线帽', '兽耳帽', '极简服装', '僵硬站姿',
  '其他动漫角色', '其他 IP 角色', '换发色', '蓝紫渐变发色', '紫发', '淡紫发', '薰衣草色头发', '天蓝发色',
  '青蓝发尾', '大圆眼', '呆毛', '白色羽状耳饰', '羽毛耳饰', '耳坠', '蝴蝶结耳饰', '人类耳朵',
  '幼态', '儿童体型', '幼女', '半写实', 'BJD 娃娃感', '3D 人偶', '黑发', '真人照片',
  // 萌系红线：可以软萌，但绝不能滑向未成年。
  '萌系画成小孩', '幼童', '小学生', '幼儿', '儿童身材', '未发育', '娃娃脸幼童', '小孩子',
  // 尾巴/肢体计数错误是这类角色最常见的翻车点。
  '尾从头发长出', '尾从侧腰长出', '多条尾巴', '两条尾巴', '布带尾巴', '丝带尾巴', '树枝尾巴', '藤蔓尾巴',
  '多余的手', '多余的脚',
  // 表情类：换表情不能让脸跟着变，重点压大笑拉宽脸、圆眼化、五官漂移与换脸。
  '表情改变脸型', '大笑拉宽脸型', '脸型变宽', '眼睛变成大圆眼', '瞳孔放大失真', '表情换脸', '五官漂移', '夸张表情',
  // 红线。
  '露点', '裸露', '性行为', '强烈性暗示'
];

export const DEFAULT_NEGATIVE_PROMPT = [...NEGATIVE_CORE, '背景杂乱'].join('、');

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
    negativePrompt: [...NEGATIVE_CORE, ...extraNegative].join('、')
  };
}

export const STYLE_PRESETS = {
  // 默认档：质量词给满，对应「成人比例日系立绘」。
  keyvisual: definePreset('成人比例日系立绘', {
    composition: '全身日系立绘构图，人物为唯一主体，姿态舒展有张力，及腰长发被风扬起形成动势，画面留白适中',
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
    clothing: '深蓝色旗袍式长裙，白色滚边与盘扣，裙身小鲸鱼刺绣图案，侧开摆便于行动，贴身剪裁曲线自然，白色丝袜，衣着完整',
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
  ['qwen-image', 'dashscope']
]);

const PROVIDER_DEFAULTS = {
  openai: { baseUrl: '', model: 'cogview-3-flash' },
  pollinations: { baseUrl: 'https://image.pollinations.ai', model: 'flux' },
  // 百炼：编辑（吃参考图）与纯文生图是两个模型，走同一个多模态端点。
  // 2026-11 实测：该空间的图像模型为 qwen-image-3.0 系列，编辑与文生图共用同一模型。
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image-3.0', textModel: 'qwen-image-3.0' }
};

// 能力声明：调用方按能力走，而不是在业务代码里判断后端名字。
const PROVIDER_CAPABILITIES = {
  openai: { negativePrompt: false, referenceImage: false, lora: false, async: false, maxReferenceImages: 0 },
  pollinations: { negativePrompt: false, referenceImage: false, lora: false, async: false, maxReferenceImages: 0 },
  dashscope: { negativePrompt: true, referenceImage: true, lora: false, async: false, maxReferenceImages: 3 }
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
  if (expressionChoice.name !== config.expression) {
    const layers = { ...config.promptLayers, expression: expressionLayerFor(expressionChoice.name) };
    // 只在 stylePrompt 由分层拼装而来时重建，避免覆盖控制台显式写的整段风格词。
    if (stylePrompt === assemblePromptLayers(config.promptLayers)) stylePrompt = assemblePromptLayers(layers);
  }
  const promptParts = request.prompt
    ? asPromptParts(request.prompt)
    : buildPromptParts(request.description, stylePrompt, config.negativePrompt, config.characterPrompt);
  // 文本型后端仍要整段 prompt；支持负向词的适配器用 promptParts 分开传。
  const prompt = promptParts.negative
    ? `${promptParts.positive}；【严格禁止】${promptParts.negative}`
    : promptParts.positive;
  const seat = `${request.isGroup ? 'group' : 'private'}:${request.target ?? ''}`;
  const chatKey = String(request.chatKey || seat);
  const trigger = ['command', 'random', 'tool'].includes(request.trigger) ? request.trigger : 'command';
  const senderId = String(request.senderId ?? '');
  const started = Date.now();

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

  const mime = sniffImageMime(buffer, contentType);

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
    description: String(request.description ?? ''),
    provider: chosen.provider,
    model: String(providerMeta.model || chosen.model),
    tier: chosen.tier,
    stylePreset: chosen.stylePreset || '',
    outfit: chosen.outfit || '',
    tail: chosen.tail || '',
    vibe: config.vibe || '',
    vibeSource: ['explicit', 'auto'].includes(request.vibeSource) ? request.vibeSource : (config.vibeSource || 'auto'),
    expression: expressionChoice.name,
    expressionSource: expressionChoice.source,
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
    + ` bytes=${buffer.length} mime=${mime} seed=${seed} refs=${references.length} moderation=pass file=${filePath} meta=${metaPath || '-'}`);
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
    analysis
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
  // 气质层只由 vibe 字段驱动，自定义人物层里残留的气质描述会被这里覆盖。
  layers.vibe = vibeLayerFor(options.vibe || 'mature');
  // 表情层只由 expression 字段驱动，避免自定义人物层里残留的表情描述与这里打架。
  layers.expression = expressionLayerFor(options.expression || DEFAULT_EXPRESSION);
  const outfitClothing = options.outfit && options.outfit !== 'none' ? clothingLayerFor(options.outfit) : '';
  if (outfitClothing) layers.clothing = outfitClothing;
  return layers;
}

/** 把 config.json / 控制台里的原始值收敛成内部配置。 */
export function normalizeImageGenConfig(raw = {}) {
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
  const promptLayers = normalizePromptLayers(raw, preset, { outfit, tail: tailMode, expression, vibe });
  const timeoutMs = clampInt(raw.timeoutMs, 10_000, 300_000, 120_000);
  // Key 只从配置或环境变量读，永不回显；apiKeyEnv 便于把密钥留在环境里。
  const apiKey = String(raw.apiKey || (raw.apiKeyEnv ? process.env[String(raw.apiKeyEnv)] || '' : ''));
  const baseNegative = String(raw.negativePrompt || preset.negativePrompt);
  const tailNegative = TAIL_NEGATIVE[tailMode] || [];
  const negativePrompt = tailNegative.length
    ? [...baseNegative.split('、').filter(Boolean), ...tailNegative].join('、')
    : baseNegative;
  return {
    enabled: raw.enabled !== false,
    provider,
    baseUrl: String(raw.baseUrl || defaults.baseUrl).replace(/\/+$/, ''),
    model: String(raw.model || defaults.model),
    textModel: String(raw.textModel || defaults.textModel || defaults.model),
    apiKey,
    apiKeyEnv: String(raw.apiKeyEnv || ''),
    width,
    height,
    size: `${width}x${height}`,
    stylePreset: preset.name,
    styleRotate: raw.styleRotate === true,
    outfit,
    tail: tailMode,
    vibe,
    vibeSource,
    expression,
    characterPrompt: promptLayers.character,
    promptLayers,
    // 显式 stylePrompt 仍然优先（控制台临时覆盖）；否则由分层模板拼装。
    stylePrompt: String(raw.stylePrompt || assemblePromptLayers(promptLayers)),
    negativePrompt,
    // 正常出图一律带参考图：没有传参考图时用角色锚点兜底，连锚点都读不到就拒绝出图。
    referencePolicy: raw.referencePolicy === 'optional' ? 'optional' : (provider === 'dashscope' ? 'require' : 'optional'),
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
  const description = match[1].replace(/^["“”'「」]+|["“”'「」]+$/g, '').trim().slice(0, 200);
  return description.length >= 2 ? { description } : null;
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
  // 主人无论在私聊还是群聊都直接放行，不受「允许群友触发」开关限制。
  if (isOwner) return { allowed: true };
  if (!config.allowGroup) return { allowed: false, reply: '画图还没对群里开放，先私聊找主人吧。' };
  if (!mentioned) return { allowed: false, reply: '要画图的话 @我 一下再发“画图 描述”。' };
  if (config.groupWhitelist.length && !config.groupWhitelist.includes(String(target))) {
    return { allowed: false, reply: '这个群还没开放画图。' };
  }
  if (quota) {
    const perUser = quota.check(`u:${sender}`, { cooldownMs: config.groupUserCooldownMs });
    if (!perUser.ok) return { allowed: false, reply: '你刚画过，等一会儿再来吧。' };
    const perGroup = quota.check(`g:${target}`, { cooldownMs: config.groupCooldownMs, dailyLimit: config.groupDailyLimit });
    if (!perGroup.ok) {
      return {
        allowed: false,
        reply: perGroup.reason === 'daily-limit' ? '这个群今天的画图次数用完了，明天再来吧。' : '群里刚画过，稍等一会儿。'
      };
    }
  }
  return { allowed: true };
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
  const parts = [];
  if (character) parts.push(`【固定人物，不可替换】${character}`);
  if (style) parts.push(`【画风硬约束，优先级高于画面内容】${style}`);
  if (content) parts.push(`【画面内容，只描述动作、场景与光线，人物沿用固定模板】${content}`);
  return { positive: parts.join('；'), negative };
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
  if (result.reason === 'prompt-blocked') return `这次没画：描述里出现了不能画的内容（${result.error || '疑似未成年、真人或其他 IP 角色'}）。`;
  if (result.reason === 'reference-invalid') return `参考图没通过校验：${result.error || '格式不支持'}。`;
  if (result.reason === 'reference-required') return '这次缺参考图，为了不画歪已经拦下：请先发一张参考图再让我画。';
  if (result.reason === 'reference-unsupported') return '当前生图后端不支持参考图，这次没有画。';
  if (result.reason === 'image-too-large') return '图生成出来了但体积超过发送上限，这次没有发。';
  if (result.reason === 'timeout') return '这次等太久了，图没出来。';
  if (result.reason === 'no-key') return '生图后端还没配置密钥，这次没有画。';
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
  if (config.provider === 'openai') return buildOpenAIRequest(config, parts, options, capabilities);
  return buildPollinationsRequest(config, parts, options);
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

async function readProviderImage(response, config, fetchImpl, timeoutMs = config.timeoutMs) {
  if (config.provider === 'dashscope') return readDashScopeImage(response, config, fetchImpl, timeoutMs);
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
  if (config.provider === 'dashscope' && !config.apiKey) {
    const error = new Error('dashscope apiKey 未配置（DASHSCOPE_API_KEY）');
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

