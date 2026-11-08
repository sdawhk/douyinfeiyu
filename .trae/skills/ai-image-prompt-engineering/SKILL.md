---
name: ai-image-prompt-engineering
description: Debug image-generation prompts — budget truncation, layer order, reference-image canvas, shot scale vs subject ratio, style pools, and backend quirks. Use when tuning 画图提示词 or adding an image backend. Not for text-LLM prompts.
---

# AI 生图提示词工程

面向"单次 HTTP 调用"的生图链路：只有 prompt + negative_prompt + 参考图 + 尺寸，没有 ControlNet、LoRA、工作流节点。先拿数据，再改措辞。凡是"改了 prompt 没效果"，第一怀疑是没送达，第二怀疑是画布对抗。

## 0. 五条铁律

1. **先量后改**：字符数、层起始偏移、参考图几何，三个数没拿到就不要动 prompt。
2. **预算是硬约束**：超限通常不报错，而是服务端静默截断；必须在客户端断言。
3. **关键约束前置**：顺序服从 token 到达顺序，不服从语义重要性。
4. **参考图是画布，不是素材**：构图冲突时换锚点，不要用措辞硬顶。
5. **负向词有代价**：每条负向都在封死一类合法结果，必须能按风格豁免。

## 1. 提示词预算

### 踩坑

- 正向实测 1505 字符，接口上限 800 Token（部分系列 1300），超出自动截断，客户端无感知。
- 构图层排第 7 位，累计 1086 字符才开始，按 1 字符≈1 Token 估算，构图段整段没送到模型。
- 负向实测 535 字符，上限 500；`裁切脚部` 从第 498 字符才出现，等于没写。
- 截断是静默的：接口返回 200，图也出了，只是约束没生效，于是被误判为"模型不听话"。

### 判断方法

1. 按实际发送字符串量长度，不要按"我写了多少层"估算。
2. 同时算两套口径并取更保守的一套：
   - Unicode 码点数（中文一字算一个；`Array.from(str).length`）。
   - 粗略 token 估算：CJK 1 字≈1 token，ASCII 约 4 字符≈1 token。
3. 打印每层起始偏移：任何"必需层"的起点超过预算，就是没送达。
4. 用一次真实请求验证：日志记录 `prompt-chars positive=… negative=…`；出图后检查约束是否生效（脚是否完整、头顶是否留白、风格是否变化）。
5. 写回归断言：完整配置拼装出的 prompt 必须落在预算内，超限直接失败，不允许悄悄截。

```js
export const PROMPT_BUDGET = {
  positive: { max: 780 },   // 官方 800 Token，留余量
  negative: { max: 480 }    // 官方 500 字符，留余量
};

export function measurePromptChars({ positive = '', negative = '' } = {}) {
  return {
    positive: Array.from(String(positive)).length,
    negative: Array.from(String(negative)).length
  };
}

export function assertPromptBudget(parts) {
  const chars = measurePromptChars(parts);
  const issues = [];
  if (chars.positive > PROMPT_BUDGET.positive.max) {
    issues.push(`正向 ${chars.positive} 超过 ${PROMPT_BUDGET.positive.max}`);
  }
  if (chars.negative > PROMPT_BUDGET.negative.max) {
    issues.push(`负向 ${chars.negative} 超过 ${PROMPT_BUDGET.negative.max}`);
  }
  if (issues.length) throw new Error(`提示词超限，拒绝发送：${issues.join('；')}`);
  return chars;
}
```

预算不足时给用户描述留"剩余空间"，宁可截用户描述也不要截身份锁：

```js
const room = Math.max(0, PROMPT_BUDGET.positive.max - measureChars(base) - 1);
const body = Array.from(content).slice(0, room).join('');
// 必须回传 descriptionTrimmed 并打日志，不允许无声消失
```

### 正确做法

- **超限删除优先级**（从先删到后删）：
  1. 画质同义词（高清、细节丰富、通透、精致、超精细）。
  2. 重复的人物/服装描述（同一身份锁被拼两遍会白占 300+ 字符）。
  3. 光影、背景的形容词堆叠（保留光源方向与层次，删修饰）。
  4. 用户描述尾部。
- **永远保留**：身份不变量、构图契约（景别+占比+留白+脚落地）、负向裁脚词、安全红线。
- 负向词先压缩再前置：裁脚类放最前，画质类去重，低价值词删掉。
- 断言之外还要记录 `promptChars` 与 `descriptionTrimmed` 到出图 meta，方便事后归因。

## 2. 分层拼装顺序

### 踩坑

- 早期顺序是 quality → character → hairstyle → vibe → expression → clothing → **composition** → lighting → background。
- 语义上构图很重要，token 上它排第 7，直接被截掉。改措辞当然没效果。
- 重复归一化会在同一层反复追加景别句，prompt 每次变长，最终再次超限。

### 判断方法

- 把拼装结果按分隔符切开，列出"层名 / 起始偏移 / 长度 / 是否在预算内"。
- 做单变量实验：只把某一层前移，其他不动，看输出是否开始响应。响应了 = 之前是顺序问题；仍不响应 = 画布或模型问题。
- 检查幂等性：同一份配置连续归一化两次，字符数应不变；变长说明层内追加没先清理旧句。

### 正确做法

固定顺序，预算不够时从后往前牺牲：

```
quality → character → composition → hairstyle → vibe → expression → clothing → lighting → background
```

- `composition` 必须排第 3：画质与身份之后，立刻给景别、机位、人物占比、留白。
- `lighting`、`background` 放最后，它们是"氛围层"，被压缩时损失最小。
- **层级顺序 ≠ 语义顺序**：模型按 token 序列读 prompt，不按你心里的重要性读。写作上读起来最顺的顺序，往往是最差的送达顺序。
- 层内也要前置：身份层把不可变特征放句首；构图层的"占比/留白/脚落地"放在机位与镜头描述之前。
- 拼装要幂等：加新景别句前先 `strip` 掉旧景别句；判断人物层是否已包含在风格串里，避免重复拼接。
- 配置覆盖要收敛：`config.json` 里写死的 quality/lighting/background 会盖掉代码默认值，改代码不生效时先查配置。

## 3. 参考图即画布

### 踩坑

- 锚点是 832×1216 的坐姿近景，人物占画面 90%–95%，下缘截在膝上，脚完全不在画面里。
- prompt 要求"站姿全身、占 65%–72%"，输出仍然跟锚点走：坐姿、近景、脚被裁。
- 编辑/参考图模式里，输入图被当作 canvas，其构图与未被点名的内容会保留；prompt 只是修改指令，不是重画指令。

### 判断方法

1. 量参考图：尺寸、人物 bbox 高度占比、头顶留白、下缘裁切位置、脚是否完整。
2. 量出图：同样的四个数。若出图几何≈参考图，而 prompt 明确要求了别的几何，判定为画布主导。
3. 对照实验（最可靠）：同一 prompt，有锚点 / 无锚点各 3 张。
   - 无锚点会变、有锚点不变 → 锚点是主因，继续改 prompt 是浪费。
   - 两者都不变 → 约束没送达，回到第 1、2 节。
4. 查后端语义：该模型是文生图还是编辑模型？多图输入是否要求显式声明 `<image1>` 是画布、`<image2>` 是身份？

### 正确做法

- **换锚点而不是改措辞**：站姿全身、2:3 竖幅、头顶留白 8%–10%、脚下留地 6%–8%、人物高度 65%–72%、脚完整踩地、背景完整。
- prompt 第一句显式声明身份-only：
  `参考图只提供身份与外观，不沿用其姿势、景别、机位、构图与背景`
- 参考图策略用 `require`：缺参考图直接拒绝出图，不要静默降级成文生图（身份会漂）。
- 两段式写法（Seedream 类）：`Reference Target`（只保留什么）+ `Generated Scene Description`（要生成什么）。
- 多图拆分：`<image1>` 空画布定构图，`<image2>` 锚点定身份；必须逐张说明取什么、不取什么。
- 不要用纯白边 `pad` 校准构图，模型会把白边画成白色条带；优先边缘拉伸、模糊填充或先扩背景。
- 出图后做占比检测，超阈值再走扩图/二次 edit 兜底，不要指望首次生成 100% 达标。

## 4. 景别 ≠ 占比

### 踩坑

- 以为写了 `full body` 就是"人物占 60%–75%"，实际二次元模型常给 80%–95%。
- `cowboy shot` 只保证画到大腿，脚一定不在画面里，与"脚落地"直接冲突。
- 三档景别全写死"平视机位"，构图语言只剩"人站中间"。

### 判断方法

- 只管"包含范围"的词不能定量：`close-up / portrait / upper body / cowboy shot / full body / wider shot` 描述的是"画面里包含什么"，不是"占多大"。
- 要定量就量 bbox：`height_ratio = 人物bbox高度 / 画面高度`。
- 验收阈值示例：P50 落在 65%–72%，P90 ≤ 78%，脚部完整率 ≥ 90%，头顶留白 ≥ 5%。
- 百分比对模型没有可靠 grounding。把"65%"翻译成可见事实：头顶上方有空白、双脚完整踩在地面、人物约占画面三分之二、左右能看到背景。

### 正确做法

景别词负责"包含范围"，距离/留白短语负责"占比"，画幅负责"空间"，负向词负责"防裁切"，四者叠加才有效：

```
full body, feet visible, shoes touching the ground, head not touching the top edge,
captured from a distance, shot with room to breathe,
the figure occupies about two-thirds of the frame height
```

- 构图契约模板（放在第 3 层）：
  `全身景别，从头到脚完整入画，人物高约占 65%–72%，头顶留白 9%，脚下留 7% 落地空间、脚尖不裁切；平视，远景距离，双脚踩地`
- 全身默认竖幅（如 1024×1536）；方形画幅塞全身会让人物变小、背景被挤没。
- 负向前置：`裁切脚部、脚部出画、脚尖被裁、头顶贴边、人物占满画面`。
- 不要同时堆 `full body + cowboy shot + upper body + close-up`，景别标签会互相打架。
- 泳装/水下等特殊服装可默认七分身，但七分身必须接受"脚不在画面"这一事实，不能同时要求脚落地。

## 5. 风格维度

### 踩坑

- 真正决定画风的只有 quality 层一句"赛璐璐上色与厚涂混合"，且被配置原样覆盖；发型池、气质池、服装池只在换"画什么"，没有一处换"怎么画"。
- 负向词反向封死风格：`颗粒/噪点` 干掉胶片与水粉，`平涂卡通/粗描边扁平上色` 干掉赛璐璐，`写实照片/半写实/3D渲染` 干掉轻写实与电影感，`背景杂乱` 压掉高密度叙事背景。
- lighting 永远一种布光、background 永远"三层纵深+虚化"、三档景别永远平视，缺 tone / camera / post 三个维度。

### 判断方法

1. **单值锁审计**：把出图反推成层，与配置逐层对比。若某层在 10 张图里文字几乎相同，它就是"一个值打死"的元凶。
2. **负向词审计**：对每个负向词问两句——"它本来防什么？""它同时封死了什么合法结果？"封死了就列入待豁免。
3. **量化风格分离度**（本地可算，无需新依赖）：
   - 每张图 HSV 三维直方图（如 H32/S16/V16），两两 L1 距离取均值；目标 ≥ 单一风格基线的 2 倍。
   - 主色相覆盖数：至少 4 个色相中心（冷蓝 / 暖橙 / 白高调 / 靛墨 / 粉彩）。
   - 线条强度：灰度 Laplacian 方差 + Canny 边缘密度；赛璐璐显著高于柔光厚涂（目标 +30%）。
   - 明度分布：应同时出现高调与低调两种直方图。
4. **盲评**：找 10 人看 8 张图，问"这些是不是同一种画风"；认同率从 ~90% 降到 <40% 才算真的分开了。
5. **锚点干扰实验**：同一风格词，有锚点/无锚点各 3 张。若只有无锚点时风格才生效，先处理锚点，不要继续堆风格词。

### 正确做法

- 先把 quality 拆成"纯画质词"（分辨率、清晰度、细节量），所有风格词搬到独立 `style` 层。
- 风格池每档必须自带四件套：**渲染词条（线条/上色/笔触）+ 色调 tone + 后期 post + 负向豁免清单**。只给一句"水粉风"不算风格档。
- 选型规则：按 outfit/vibe/framing 收窄 → 权重随机 → 同一会话避开上一档 → 可显式指定 → `none` 完全回退现状。
- 风格层只改"怎么画"，禁止出现服装、发型、表情、身体结构、构图朝向。身份层补一句"只锁身份，不锁画风"。
- 负向词拆三段：
  - `BASE`：画质、肢体、文字、身份红线，永远生效。
  - `STYLE_GUARD`：防廉价化，可按风格替换。
  - `SCENE_GUARD`：防背景杂乱等，按背景密度开关。
- 豁免规则示例：`颗粒` 只在胶片/水粉/电影感三档豁免，且必须同时加回"数码噪点"；`写实照片/真人/3D渲染/Q版/三头身/未成年` 永不豁免。
- 配置侧同步删掉写死的 quality/lighting/background，否则代码改了也不生效。
- **注意仓库现状**：风格池目前只在方案文档里，尚未落地；`STYLE_PRESETS` 的 5 档共用同一句 quality，不要误以为已经能切画风。

## 6. 失败模式清单

| 现象 | 确认方法 | 修复 / 预防 |
|---|---|---|
| 改了 prompt 没反应 | 日志里的正/负向字符数是否超限；层起始偏移是否越界 | 客户端断言 + 关键层前置 + 按优先级删词 |
| 出图几何≈参考图 | 对比参考图与出图的 bbox、留白、下缘 | 换锚点 + 身份-only 声明 + 出图后占比检测 |
| 删了负向词仍无变化 | 负向词按风格审计；逐条删除做 A/B | 建立 per-style remove/add 豁免表 |
| 换表情/气质把脸换了 | 出图与锚点做发色、瞳色、鳍耳可辨识度核对 | 分层锁：表情层只动眉/眼/嘴；身份层写"只锁身份" |
| 后端 200 但参数没生效 | 同一 prompt 改一个参数，看输出是否响应；查 capabilities | 不支持就不发，并在链上跳过该 provider，记录 skipped |
| 带参考图时被换到别的 provider | 检查 attempts 里是否有 `reference-unsupported` 跳过 | 明确参考图能力与最大张数，不要静默降级 |
| 输入风控直接停链 | 错误码（如 1301）是否来自负向词 | 文本型后端把敏感负向词剔除后再拼 |
| 请求尺寸与实际尺寸不一致 | 读图片头真实宽高；编辑模式常跟随参考图比例 | 以真实尺寸入 meta，不信任请求值 |
| 重复归一化导致层膨胀 | 连续归一化两次，字符数是否变长 | 追加前先 strip 旧句，保持幂等 |
| 用户长描述被砍 | `descriptionTrimmed` 是否为 true | 记录并告知；优先砍描述尾部，不砍身份与构图 |
| 参考图被当画布且 prompt 对抗失败 | 有/无锚点对照实验 | 换锚点、双图拆分、扩图兜底三选一 |

## 7. 新接一个生图后端时检查什么

1. **输入上限**：正向 token、负向字符、尺寸范围、参考图张数/体积/最小最大边长。
2. **参数契约**：是否支持 `negative_prompt`、`image`、`size`、`seed`、`watermark`；不支持时是 4xx 还是 200 静默忽略。
3. **参考图语义**：canvas / identity / style 三者是哪种；多图是否要显式编号并声明角色。
4. **返回形态**：b64 还是 url；实际尺寸；有无水印；同步还是异步轮询。
5. **风控**：输入过滤码、输出审核、负向词是否会被当成违规输入。
6. **计费与重试**：一次出几张、额度耗尽错误码与文案、整体预算（budgetMs）与重试上限。
7. **落盘元数据**：provider / model / tier / promptChars / descriptionTrimmed / 参考图 sha256 / 真实宽高 / seed。
8. **A/B 验收**：同 prompt 换后端，至少要看到 2–3 项可量化差异（风格、尺寸、参考图响应）；全都没变说明参数根本没生效。

## 8. 交付前自检

- [ ] 正向 ≤ 上限、负向 ≤ 上限，日志有实际字符数。
- [ ] 打印层偏移，构图/身份层起点在预算内。
- [ ] 负向裁脚词在最前面。
- [ ] 参考图策略为 `require`，锚点几何达标（站姿、全身、65%–72%、脚完整）。
- [ ] 出图核对：人物占比、脚部完整、头顶留白、发色/瞳色/鳍耳。
- [ ] meta 记录 provider/model/tier/promptChars/真实尺寸/references sha。
- [ ] 若改了风格：负向豁免表已同步，盲评与直方图指标有对照。

## 资源

- 真实案例数字、逐层偏移表、锚点实测、风格池八档与实验矩阵：`references/case-notes.md`
- 预算与截断快速自检：`node scripts/check-prompt-budget.mjs --positive-file p.txt --negative-file n.txt`
  （也可 `--positive "…" --negative "…"`；退出码 1 表示超限，可直接接进测试）
