# 大肥鱼 QQ 机器人 · DaFeiYu QQ Bot

[中文](#中文) · [English](#english)

一套让 QQ 群机器人「像真人群友一样说话」的完整工程：59 个 AstrBot 插件、一个 QQ↔AI 桥接程序、一个安卓控制台 App、一个 Windows 桌面控制台，以及记录每个问题根因与实测数据的技术文档。

A complete engineering effort to make a QQ group bot *talk like an actual group member*: 59 AstrBot plugins, a QQ↔AI bridge, an Android console app, a Windows desktop controller, and technical documents recording the root cause and measured data behind every fix.

---

## 中文

### 这是什么

一个跑在 QQ 群里的 AI 群友（人格叫「小鲸鱼」）。它不是客服式问答机器人 —— 目标是**混在群里像个真人**：会潜水、会插话、会发表情包、会戳回去、看得见图片和视频、记得住群友是谁。

### 主要功能

- **唱歌：** 搜索并翻唱现成歌曲，可选用 RVC 转换为流萤音色；主人也可启用 Mureka 生成原创短歌，完成后以 QQ 语音发送。详细说明见 [桥接文档](bridge/README.zh.md#原创歌曲与流萤-rvc)。
- **抖音互动：** 主人在 QQ 私聊中可对明确指定的一条视频点赞，或按主人提供的原文发表评论。支持先 dry-run 检查；不批量操作、不自动编写评论。详见[抖音工具说明](douyin_personal_share/README.md)。
- **抖音分享与浏览：** 支持定时分享推荐视频、查看推荐流并记录观看内容；浏览不会自动点赞或评论。详见[抖音工具说明](douyin_personal_share/README.md)。

仓库主要目录如下：

| 目录 | 内容 | 语言 |
|---|---|---|
| [`plugins/`](plugins/) | 59 个 AstrBot 插件 —— 机器人的全部能力 | Python |
| [`bridge/`](bridge/) | QQ ↔ DeepSeek Harness 桥接，集成聊天、唱歌和抖音理解/互动能力 | Node.js |
| [`douyin_personal_share/`](douyin_personal_share/) | 抖音推荐内容定时分享、只读浏览与单条视频互动工具 | Python |
| [`console/`](console/) | 安卓控制台 App + 服务端后台 | Java / Python |
| [`desktop-controller/`](desktop-controller/) | Windows EXE 控制台：填服务器信息 → 自动部署并启动 → 在线改配置 | Python |
| [`mobile-controller/`](mobile-controller/) | 安卓 APK：开放式登录（QQ 号密码 / 本地渲染扫码 / 快速登录）+ 三步部署，无任何预置配置 | Java |
| [`deploy/`](deploy/) | 部署接口：配置项清单 + 运行配置模板 | JSON / env |
| [`node-studio/`](node-studio/) | 行为节点 Studio：把行为拆成可视化节点的离线编排原型（与机器人完全隔离，不连 QQ/AstrBot/服务器） | Python / JavaScript |
| [`docs/`](docs/) | 部署手册与 45 份技术文档（根因分析、设计方案与实施记录） | Markdown |

### 更新记录

功能更新与版本变化见 [更新记录](CHANGELOG.md)。

### 成品下载

[Releases](../../releases) 页面：

| 产物 | 平台 | 说明 |
|---|---|---|
| `dafeiyu-console.apk` | 安卓 5.0+ | 安卓控制台 App（约 121 KB）。装完在登录页填自己的服务器地址即可，包内不含任何服务器信息。 |
| `dafeiyu-controller.exe` | Windows 10/11 | 桌面控制台（单文件、免安装）：填服务器 SSH 与仓库信息 → 自动部署并启动 → 之后在同一个界面里改配置。同页的 `.sha256` 是校验值。 |

### 59 个插件在解决什么

每个插件对应一个**实际发生过的问题**，不是功能清单式的堆砌。

**说话质量**

| 插件 | 解决的问题 |
|---|---|
| [`dsh-ctxclean`](plugins/dsh-ctxclean/) | 答非所问。框架把每轮注入的群聊上下文原样存进历史，且 `max_context_length=-1` 不截断，于是每次请求重发上百份互相矛盾的「最新群聊」——25.7 万字里注入块占 31%，真人原话只占 2.2%。 |
| [`dsh-style`](plugins/dsh-style/) | 说话太像 AI。从真人短句里抽样本注入，把平均句长从 16.5 字压到 9.5 字。 |
| [`dsh-decide`](plugins/dsh-decide/) | 主动插话前先用小模型判断「在聊什么、该不该开口」，判沉默就掐掉整次主模型调用，省约 9400 token。 |
| [`dsh-mention`](plugins/dsh-mention/) | 每条回复都 @ 人。只在「调了工具 / 被别人的消息刷走 / 隔太久」时才 @。 |
| [`dsh-claimguard`](plugins/dsh-claimguard/) | 被骗认输。有人说「叫我爸爸」「单挑你输了」它就当真 —— 靠注入事实而不是改人格来修。 |
| [`dsh-selfworth`](plugins/dsh-selfworth/) | 卖了他还替别人数钱。认低身价、认下贬低、认被白嫖、替外人记账四类损己发言（3097 条真话回测；2026-09-13 补被定价/往死里用/鱼字贬称/使唤踩踏/当食材五族）。输入侧「有人在占便宜」+ 输出侧「回复认了账」两侧同时成立才动手 —— 它嘴硬时也说这些词，单看一侧必误伤。 |
| [`dsh-initiate`](plugins/dsh-initiate/) | 冷场就一直安静。真人会自己起话头，它不会。五道纯代码闸门（冷场 15 分钟~6 小时、活跃时段、1 小时冷却、每日 3 次）过了才让小模型看一眼有没有值得接的话头；决定开口就造合成事件走**完整消息管道**，贴纸剥离/@ 策略/分段发送全部照常。判断失败一律沉默。 |
| [`dsh-emotion`](plugins/dsh-emotion/) | 语气永远一个样。六种情绪同时只有一种，固定优先级仲裁保证一条消息只触发一种（「你好厉害但也真让我失望」只取低落）。清零四条路：道歉、连续 2 条中性、问题被回答、分情绪 TTL。 |
| [`dsh-quote`](plugins/dsh-quote/) | 看不懂引用，把别人做的事说成自己做的。框架的引用块只给昵称，而群里有真人把昵称改成和机器人一样 —— **凭昵称在群聊里永远认不了人**。改为按 QQ 号写清「谁在说 / 引用谁的哪句 / 是不是自己说的 / 这次 @ 谁」。 |
| [`dsh-glossary`](plugins/dsh-glossary/) | 听不懂群里的黑话。43 条词条，命中才注入，带真语料例句（只给释义时它听得懂「典」但永远不会自己说「典」）。词条挖自本群语料而非现成热梗库：三个外部库 549 个词只真命中 9 条。假命中比不注入更糟，所以每条带 `avoid` 排除上下文。 |
| [`dsh-human`](plugins/dsh-human/) | 回复的**形状**不像真人。实测真人带逗号 16.4%、机器人 67.7%，「短句，短句」句式机器人占 54.8% 而真人没有。提示词治不了（写在人格里两周照旧），按结构在发送前把逗号粘起来的两句拆成两条。 |
| [`dsh-typo`](plugins/dsh-typo/) | 几千条一个错别字都没有。60 组人工核过的同音表，每条 6% 概率错一个字，35% 概率补一条「\*的」自我纠正。48 条保护名单（黑话词条、人名、贴纸标记、链接）一个字都不许动。 |
| [`dsh-drift`](plugins/dsh-drift/) | 永远严格贴着上一条回答 —— 这种「过度切题」本身就是 AI 味。三档漂移写成分级提示词。两条结构性硬边界防止把已修的答非所问引回来：被 @ 不漂移、像提问不漂移。 |
| [`dsh-effect`](plugins/dsh-effect/) | 所有改动都是开环的：注入完就祈祷，说出去的话有没有落地系统完全不知道。说完开 180 秒观察窗口，判反应（认可/跟着玩/平淡/没看懂/指出说错/嫌烦/没人理）、冲内容还是冲人设、推进还是带偏。窗口内没人发言直接判「没人理」，不花调用。 |
| [`dsh-aiflavour`](plugins/dsh-aiflavour/) | 动态 AI 味拦截。静态强词 + 动态词根学习 + 会话刹车，压机器人「解释/总结」频率高的问题。 |
| [`dsh-humanizer`](plugins/dsh-humanizer/) | 去 AI 味的出口闸门。用 AI 痕迹特征扫回复正文，剥/拦 AI 味句子，是管线里「掰回人话」的那一段。 |
| [`dsh-noise`](plugins/dsh-noise/) | 真人噪点。换单字 / 说一半 / 整句叠词，只对没人叫的接话生效，被 @ 的正经回答绝不动。 |
| [`dsh-armor`](plugins/dsh-armor/) | 防破甲（输入侧注入拦截）。识别复述提示词、无视规则、诱导越权、身份逼问等破甲话术，priority 2000 先于注入组跑。 |
| [`dsh-merge`](plugins/dsh-merge/) | 被 @ 风暴的聚合回复。被 @ 太多次时整合成一条统一回复（总结上面说的、连着答，不点名不 @），不逐条刷屏。 |
| [`dsh-quoteref`](plugins/dsh-quoteref/) | 引用回复。每 N 次提问式 @ 用 QQ 引用回复，并对齐真人引用频率。 |

**多模态**

| 插件 | 解决的问题 |
|---|---|
| [`dsh-imgctx`](plugins/dsh-imgctx/) | 看不见图。框架只转述**当前这条**消息自带的图，而群里最常见的是「先发图，再问这什么」。动图抽 4 帧拼图后识别。 |
| [`dsh-vischain`](plugins/dsh-vischain/) | 识图模型只有一个格子，没有降级。主用模型在 CDN 后面约 20% 概率被弹 403，失败是瞬时的（0.0s），所以重试几乎不花钱。 |
| [`dsh-imagegen`](plugins/dsh-imagegen/) | 嘴上答应却不出图。便宜模型在长上下文里经常不调工具，必须有兜底钩子。 |
| [`dsh-video`](plugins/dsh-video/) | 看视频 + 生成视频。抽 4 帧比传整段快 5 倍、省 18 倍 token，质量一样。生成一次要 4 分钟，绝不能在工具里等（会锁死整个会话）。 |
| [`dsh-voice`](plugins/dsh-voice/) | 语音。内置 TTS 是「全局开关＋概率」，会把所有回复都念出来，立刻出戏。 |
| [`dsh-web`](plugins/dsh-web/) | 联网。链接就在消息里，插件自己抓完注入，不指望模型自觉调工具。抓到的正文**先审后发**：正则快筛 + 小模型判定，超时/异常/无模型一律不发（fail-closed），防机器人自己把违禁内容贴进群。 |
| [`dsh-sticker`](plugins/dsh-sticker/) | 表情包。关键是标记**无条件**剥掉 —— 否则 `[贴纸:xx]` 会原样漏进群聊。 |
| [`dsh-listen`](plugins/dsh-listen/) | 听语音。语音条/音轨交给转写服务转成文字，以语音上下文注入 —— 群友发语音它不再只知道「有人发了条语音」。 |

**记忆与群管**

| 插件 | 解决的问题 |
|---|---|
| [`dsh-memory`](plugins/dsh-memory/) | 记不住人。框架自带的只是「最近 20 条」滑动窗口，滑出去就没了。自建缓冲 + 后台抽取，带隐私脱敏、注入防护、按人容量上限、自助 `/忘记我`。 |
| [`dsh-social`](plugins/dsh-social/) | 对所有人一个口吻：对熟人太客气、对陌生人太熟络。按群隔离的关系账本（30 天半衰期、单日封顶），只认直接指向它的三种信号，默认影子模式；负档只改语气与主动性，**@/提问/能力请求永远照常完整回答**。 |
| [`dsh-guard`](plugins/dsh-guard/) | 违规禁言。三层：关键词预筛（0 成本，真群实测仅 2.2% 命中）→ 小模型只输出布尔 → **代码**决定禁不禁。1.2.0 起判罚动态化：情绪/欲望/关系/逆反/疲劳压成一个宽容度，决定「态度类」（骂战、时政）判多重的档位、门槛与时长；违法、广告、色情索要、刷屏、直接辱骂、群体仇恨等**行为类一律不看心情**，心情也只能把「放过」变成警告、不会变成禁言。 |
| [`dsh-poke`](plugins/dsh-poke/) | 戳一戳没反应。回话不问 LLM，三道限流防对戳循环。 |
| [`dsh-welcome`](plugins/dsh-welcome/) | 入群欢迎。用 LLM 现场生成而不是写死模板（模板会破人设）。 |
| [`dsh-acl`](plugins/dsh-acl/) | 指令谁都能发。三档权限（所有人/群主+管理员/仅群主），身份只按 **QQ 号**判 —— 群里有重名，群名片也能随时改。状态查询也要拦：它们不改东西，但会把渠道地址、模型名、配额、token 花销全打到群里。 |
| [`dsh-fwd`](plugins/dsh-fwd/) | 转发的聊天记录看不见。框架只给一个「[聊天记录]」占位符。按嵌套层数展开，保头保尾，图片视频有独立预算。 |
| [`dsh-spine`](plugins/dsh-spine/) | 被追问就改口、被质疑就道歉。跟 `dsh-claimguard` 的区别是它管的是**立场稳定性**而不是事实。 |
| [`dsh-slang`](plugins/dsh-slang/) | 黑话不用人喂。自动从群聊挖疑似黑话、查好含义进候选，每 8 小时 AI 自己审一遍（转正/拒绝/再等等）。 |
| [`dsh-factguard`](plugins/dsh-factguard/) | 记忆看门狗。问机器人自身属性只按事实表回答，无依据断言直接否认纠正，防乱承认与性别摇摆。 |
| [`dsh-selfaware`](plugins/dsh-selfaware/) | 自我认知账本。注入封闭能力清单、近期入群审核和真实动作；动作从现有成功日志旁路捕获进独立 SQLite，不改其它插件。 |
| [`dsh-leakguard`](plugins/dsh-leakguard/) | 拦系统提示词泄露。查回复有没有把人格专属标题/指令句原样抄进去。与 `dsh-humanizer` 联动做硬兜底。 |
| [`dsh-homophone`](plugins/dsh-homophone/) | 同音字/谐音识别。谐音称呼当被喊、谐音梗本意注入。 |
| [`dsh-joinguard`](plugins/dsh-joinguard/) | 入群 AI 审核。拿入群问题+答案问 AI 判 approve/reject 并真批/真拒。 |
| [`dsh-scene`](plugins/dsh-scene/) | 群级背景+作息。让机器人知道「这是哪个群、现在几点意味着什么」。 |
| [`dsh-selfguard`](plugins/dsh-selfguard/) | 出口自制。拦自己重复说过的话、群吵架时自己挑衅/骂人的话 —— `dsh-guard` 管群友，它管自己。 |
| [`dsh-pay`](plugins/dsh-pay/) | 赞助/打赏收款引导。反问支付方式→发收款码，仅群主确认到账后才感谢。 |
| [`dsh-proactive`](plugins/dsh-proactive/) | 兴趣探头。纯正则兴趣评分（零 LLM 成本），聊到白米饭/美食/鲸鱼/AI 等话题主动接一句。 |
| [`dsh-interest`](plugins/dsh-interest/) | 兴趣会变。时效热度 + 口味周期轮换「今日馋」，塞状态块让语气带出最近心痒的话题。 |
| [`dsh-steal`](plugins/dsh-steal/) | 偷表情包。识图理解含义，只偷「反复发、能看懂」的存库，不宜公开的不偷（fail-close），`/表情包` 随机发。 |

### 反复踩到的十一个坑

这些教训在多个插件上重复验证过，写在这里省得再踩：

1. **结构判断优于枚举词表。** 意图判定别列举关键词、别掐回复字数。正确形状是「用户要图 + 模型没明确拒绝 + 模型不是在反问」⇒ 出图。宾语过滤用排除法（列画不出的），而不是枚举画得出的。
2. **不触发时必须打日志。** 否则每次排查只能靠猜。`dsh-imagegen` 的「有时候不生图」查了三轮，前两轮全是因为没有日志。
3. **绕过消息管道直接调 LLM 的地方，必须自己复制一份标记剥离逻辑。** `llm_generate` 不走管道，贴纸钩子不会触发，`[贴纸:探头]` 就这样漏进过群聊。
4. **阈值必须由实测分布决定。** `dsh-mention` v1 有条「延迟 ≥8s 就 @」的规则，但量到的是机器人自己想了多久 —— 一次带人格的调用普遍 5~15 秒，于是等价于「无条件 @」，24 小时 8 条回复 100% 都 @ 了。
5. **fail-open 会把崩溃伪装成质量下降。** `dsh-decide` 有个三元组按两元组解包的 bug，只要机器人刚说过话就必抛 `ValueError`，整次判断落到 fail-open「照旧说话」——**当天崩 12 次、成功 9 次**，超过一半发言模型都没收到「这句是谁对谁说的」。功能看起来完全正常，只是说得不对。凡是 fail-open 的兜底，必须在兜底路径上打 WARN 并计数。
6. **命中数归零不等于误判修好了。** 收紧「提问」规则后 `dsh-emotion` 的好奇命中从 14 掉到 0，看着像不再误判，实际是全漏了 —— 群里最常见的追问「那你为什么没有」疑问词在句中，而新正则只锚定句首。规则改动必须逐样本对比，不能只看总数。
7. **影子模式的价值在于回放，不在于等。** 挂着跑一晚只能看到当晚那几条；拿 1618 条历史语料回放，两个真误判 20 分钟就暴露了（把「余额/额度」当成尴尬语气词、把没有指向的话当成在骂它）。

8. **自己群的语料 > 任何现成词库。** 三个外部热梗库合计 549 个词，在本群真命中 9 条；本群语料一次挖掘就贡献了全表命中最高的词。有效的结构信号是「这条短语被当成一整条消息发出来、且至少两个人发过」—— 口头禅和梗才会被单独发出来当一整条消息，普通词永远不会。
9. **先问模型知不知道，再决定要不要教它。** 43 个黑话词条逐条问主模型，它一条都没说「不确定」，绝大多数直接答对。这直接改变了插件的定位：从「词典」变成「语用层」，释义压到最短，力气花在它答错的 6 个词和它推不出的本群惯例上。没做这次探针，就会一直在维护一张模型不需要的词典。
10. **抄参考实现的判据必须重新回测。** MaiBot 的「别的 AI 被喊」正则原样搬过来在本群有两条假命中，因为本群的话题恰好就是模型本身；它的 30%/字 错别字率放到这里等于满屏错字。参考实现给的是思路，**阈值和边界必须拿自己的语料重定**。
11. **加「更像人」的功能前，先想清楚它会不会把已修的 bug 引回来。** 注意力漂移和「答非所问」是同一方向上的两端，所以漂移的两条边界（被 @ 不漂移、像提问不漂移）是**结构性**的，不是提示词里的一句提醒。

### 文档

| 文档 | 内容 |
|---|---|
| [10-云服务器部署手册](docs/10-云服务器部署手册.md) | 从买服务器到跑起来，Docker + NapCat + AstrBot 全流程 |
| [20-控制台App说明](docs/20-控制台App说明.md) | 安卓 App 的三个页签、104 个旋钮、七种预设模式、服务端驱动更新与安全边界 |
| [30-回复触发条件](docs/30-回复触发条件.md) | 什么情况下机器人会说话 |
| [31-记忆系统与群员轮廓](docs/31-记忆系统与群员轮廓.md) | 记忆的存储结构与隐私设计 |
| [40-答非所问根因与修复](docs/40-答非所问根因与修复.md) | 25.7 万字上下文的量化分析 |
| [41-被骗认输根因与修复](docs/41-被骗认输根因与修复.md) | 为什么改人格没用 |
| [42-空头承诺根因与修复](docs/42-空头承诺根因与修复.md) | 「嘴上答应却不做」的机制 |
| [43-说话更真实方案](docs/43-说话更真实方案.md) · [44-实施记录](docs/44-说话更真实实施记录.md) | 方案与落地数据 |
| [45-戳一戳与违规禁言](docs/45-戳一戳与违规禁言.md) | 权限模型与限流设计 |
| [46-主动开口与情绪系统](docs/46-主动开口与情绪系统.md) | 冷场主动开口的五道闸门、单一主情绪的仲裁与清零、引用按 QQ 号认人；含影子回放揪出的两个真误判 |
| [47-真人感第二批](docs/47-真人感第二批-黑话与打字节奏与效果观察.md) | 黑话词表（含三个外部热梗库的回测数据与「先问模型知不知道」的探针结论）、打字节奏、同音错别字、注意力漂移、回复效果闭环 |
| [48-黑话自动审核](docs/48-黑话自动审核-更新详解.md) | `dsh-slang` 自动审核:从群聊挖候选 → 主模型考究释义 → 每 8 小时 AI 自动审核转正,群主命令兜底 |
| [50-多模态接入与验证记录](docs/50-多模态接入与验证记录.md) | 图/视频/语音/联网的逐项实测，含失败记录 |
| [60-长期目标与技术方案](docs/60-长期目标与技术方案.md) | 整体架构与演进方向 |
| [61-桌面控制台](docs/61-桌面控制台-一键部署与在线配置.md) | Windows EXE 一键部署：填服务器与仓库信息 → 自动拉代码/起容器 → 在线改配置；含安全边界与已知边界 |
| [89-手机控制台APK](docs/89-手机控制台APK-开放式登录与部署-20260916.md) | 安卓 APK 第一版：开放式登录（密码/本地渲染扫码/快速登录 + 内置网页兜底）与三步部署合并，零预置配置 |
| [62-社交关系](docs/62-社交关系-按群隔离的社交距离.md) | 按群隔离的社交距离：数据模型、只认哪些信号（以及哪些明确不算）、五档口吻、影子模式与隐私边界 |
| [63-自身利益](docs/63-自身利益-不认账不自贬不替外人记账.md) | 四类损己发言的真语料证据、为什么人格治不了、为什么判据是「输入侧证据 + 输出侧形状」两侧同时成立 |
| [64-联网出口审核](docs/64-联网出口审核-先审后发防炸群.md) | 五条出口的审核路径、为什么必须 fail-closed、回复出口闸的降级策略与残留风险 |
| [67-插件全量代码审计报告](docs/67-插件全量代码审计报告.md) | 一次全量审计的逐条发现与修复（含 `dsh-ctxclean` 丢失持久前缀、`dsh-pay` 到账确认过宽等） |
| [72-基础设施报错不进群](docs/72-基础设施报错不进群-20260913.md) | 11 次原始报错泄漏的完整证据链、双档指纹与 8662 条负例回测 |
| [78-贴纸标记泄漏的第三条出口](docs/78-贴纸标记泄漏的第三条出口-Context-send_message-20260913.md) | 为什么第一轮修完还在漏：`Context.send_message` 是并列的第二条平台出口 |
| [81-掉线了却显示在线](docs/81-掉线了却显示在线-上行发送检测-20260913.md) | 探针只看下行造成的监控盲区，与上行检测的修法 |
| [82-识图档位顺序与看护重启循环](docs/82-识图档位顺序与看护重启循环-20260913.md) | 延迟真因是档位顺序而非超时；含「降超时反而误杀 15.5%」的反证与看护重启额度封顶 |
| [83-内在状态总线与仲裁层](docs/83-内在状态总线与仲裁层-20260913.md) | 11 个状态存储的量化、只读观测层的设计取舍，与「读不到 ≠ 平静」 |
| [84-控制台实时观察层](docs/84-控制台实时观察层-v1.1-20260914.md) | 实时观察层的 4 个端点与 3 个页签、为什么复用现有鉴权而不新增写入口 |
| [群权限手册](docs/群权限手册.md) | 109 条指令的完整分档（owner 60／admin 24／所有人 25）、AST 动态目录扫描原理与分档原则 |
| [群指令手册](docs/群指令手册.md) | 群里所有指令的用途、权限与示例(50 条插件指令 + 9 条内置指令) |

### 快速开始

需要一台已经跑起 [AstrBot](https://github.com/AstrBotDevs/AstrBot) + [NapCat](https://github.com/NapNeko/NapCatQQ) 的服务器（没有的话照 [部署手册](docs/10-云服务器部署手册.md) 走一遍）。

```bash
# 1. 装插件：整个目录拷进 AstrBot 的插件目录
cp -r plugins/dsh-* /opt/qqbot/astrbot/data/plugins/

# 2. 配置：所有旋钮都是环境变量，写进 docker-compose 的 env_file
#    每个插件的变量清单见其 main.py 顶部注释
#    例：DSH_GUARD_SHADOW=1 表示禁言功能只判定不动手（建议先这样跑几天）

# 3. 重启（改插件代码必须用 restart，up -d 在配置没变时不会重启容器）
docker restart astrbot
```

插件带单元测试，不需要跑起 AstrBot 就能测：

```bash
python3 plugins/dsh-guard/test_guard.py
python3 plugins/dsh-style/test_style.py
python3 plugins/dsh-decide/test_decide.py
python3 plugins/dsh-poke/test_poke.py
python3 plugins/dsh-sticker/test_sticker.py
python3 plugins/dsh-emotion/test_emotion.py    # 36 项
python3 plugins/dsh-quote/test_quote.py        # 25 项

# 拿你自己的历史语料回放情绪判定，找误判（单测只能验证你已经想到的情况）
python3 plugins/dsh-emotion/replay_emotion.py
```

控制台 App 自己出包（不需要 Gradle 和 Android Studio）：

```bash
cd console
KEYSTORE=/path/to/your.jks KS_PASS=yourpass bash build.sh
bash test/run-tests.sh              # 391 项纯 JVM 单测
python3 server/test_console.py      # 105 项后端单测
python3 server/test_qrweb_e2e.py    # 83 项端到端
```

### 需要自备的东西

代码里不含任何密钥。跑起来需要你自己的：

- 一个 QQ 小号（**不要用主号**，有封号风险）
- 一个 LLM API（聊天用；便宜的 flash 类模型够用）
- 可选：视觉模型（看图/看视频）、文生图、TTS、搜索 —— 缺哪个就少哪个功能，不影响其他部分

### 已知限制

- **语音识别做不到。** 试过的渠道要么欠费要么没有音频模型，群友发语音机器人只知道「有人发了条语音」。
- **QQ 账号会掉线。** 20~60 分钟一次，换 IP 没用（实测过，账号被打标后换 IP 救不回来）。仓库里的 `server/qq_watchdog.sh` 是掉线自动重启换码的看门狗。
- **控制台服务端是明文 HTTP。** 没有 TLS，密码在网络上不加密传输。这是端口限制导致的，公共 Wi-Fi 下要意识到。
- **插件依赖 AstrBot 内部结构。** 用了一些非公开的内部属性（`provider_manager.inst_map`、`req.contexts` 等），AstrBot 大版本升级可能需要跟着改。

### 隐私说明

发布前做过全量脱敏：真实服务器 IP、群号、QQ 号、真人昵称、私人邮箱、付费中转站域名全部替换为占位符（`your-server.example.com`、`100000001`、`群友A` 等）。文档里保留的实测数据（响应时间、命中率、token 数）不含可识别信息。

### 许可

MIT，见 [LICENSE](LICENSE)。

---

## English

### What this is

An AI "group member" that lives in a QQ group (persona: *Little Whale*). Not a Q&A support bot — the goal is to **blend in as a real person**: it lurks, jumps into conversations, sends stickers, pokes back, sees images and videos, and remembers who people are.

Main components:

| Directory | Contents | Language |
|---|---|---|
| [`plugins/`](plugins/) | 59 AstrBot plugins — all bot capabilities | Python |
| [`bridge/`](bridge/) | QQ ↔ DeepSeek Harness bridge with chat, singing, and Douyin understanding/interaction features | Node.js |
| [`douyin_personal_share/`](douyin_personal_share/) | Scheduled Douyin sharing, read-only browsing, and single-video interaction tools | Python |
| [`console/`](console/) | Android console app + server backend | Java / Python |
| [`desktop-controller/`](desktop-controller/) | Windows EXE console: enter server details → auto-deploy and start → edit config online | Python |
| [`mobile-controller/`](mobile-controller/) | Android APK: open login (QQ password / locally-rendered QR / quick login) + three-step deploy, zero baked-in configuration | Java |
| [`deploy/`](deploy/) | Deployment interface: config item list + runtime config template | JSON / env |
| [`node-studio/`](node-studio/) | Behaviour-node Studio: an offline visual node-graph prototype, fully isolated from the bot (no QQ/AstrBot/server) | Python / JavaScript |
| [`docs/`](docs/) | Deployment manual and 45 technical documents (root-cause analyses, designs, implementation records) | Markdown |

### Core features

- **Singing:** Search and cover existing songs, optionally convert vocals to the Liuying voice with RVC, or let the owner enable Mureka for original short songs. Results are sent as QQ voice messages. See the [bridge guide](bridge/README.zh.md#原创歌曲与流萤-rvc).
- **Douyin interactions:** In the owner's QQ private chat, like one explicitly selected video or comment with text supplied verbatim by the owner. A dry-run check is available; bulk actions and generated public comments are not supported. See the [Douyin guide](douyin_personal_share/README.md).
- **Douyin sharing and browsing:** Schedule shares of recommendation-feed videos and browse the feed in read-only mode. Browsing does not automatically like or comment. See the [Douyin guide](douyin_personal_share/README.md).

### Changelog

See [CHANGELOG.md](CHANGELOG.md) for feature updates and release history.

### Download

The Android console app is on the [Releases](../../releases) page (~110 KB, Android 5.0+). Enter your own server address on the login screen; the package embeds no server details.

### What the 59 plugins fix

Each plugin addresses a **problem that actually happened**, not a feature checklist.

**Speech quality**

| Plugin | Problem solved |
|---|---|
| [`dsh-ctxclean`](plugins/dsh-ctxclean/) | Off-topic replies. The framework stored per-turn injected group context verbatim into history, and `max_context_length=-1` disables truncation — so every request resent hundreds of mutually contradictory "latest group chat" blocks. Injected blocks were 31% of a 257k-character context; real human speech only 2.2%. |
| [`dsh-style`](plugins/dsh-style/) | Sounding like an AI. Samples real human short sentences as style examples, cutting mean sentence length from 16.5 to 9.5 characters. |
| [`dsh-decide`](plugins/dsh-decide/) | Before jumping in unprompted, a small model judges "what's being discussed, should I speak". A "stay silent" verdict cancels the entire main-model call, saving ~9400 tokens. |
| [`dsh-mention`](plugins/dsh-mention/) | @-mentioning on every reply. Now only when a tool was used, the message got buried, or too much time passed. |
| [`dsh-claimguard`](plugins/dsh-claimguard/) | Being talked into submission. Someone says "call me daddy" or "you lost our duel" and it complies — fixed by injecting facts, not by editing the persona. |
| [`dsh-selfworth`](plugins/dsh-selfworth/) | Conceding its own value under pressure. Requires both fresh input-side evidence of exploitation and an output-side concession shape, then rewrites or blocks only the self-harming line; ordinary pushback passes untouched. |
| [`dsh-initiate`](plugins/dsh-initiate/) | Staying silent forever once the room goes quiet. Five pure-code gates (idle 15min–6h, active hours, 1h cooldown, 3/day) run before a small model even looks for a thread worth picking up; once it decides, a **synthetic event goes through the full message pipeline**, so sticker stripping, mention policy, and segmented sending all still apply. Any judgment failure means silence. |
| [`dsh-emotion`](plugins/dsh-emotion/) | One flat tone forever. Six emotions, exactly one at a time; fixed-priority arbitration guarantees a single message triggers only one ("you're great, but you really let me down" yields sadness only). Four reset paths: apology, two consecutive neutral messages, question answered, per-emotion TTL. |
| [`dsh-quote`](plugins/dsh-quote/) | Misreading quotes and claiming someone else's work as its own. The framework's quote block carries only a nickname — and a real member had renamed themselves to match the bot. **Nicknames can never identify anyone in a group chat.** Now it states, by QQ ID: who is speaking, whose line they quoted, whether that line was the bot's own, and who was mentioned. |
| [`dsh-glossary`](plugins/dsh-glossary/) | Not understanding the group's slang. 43 entries, injected only on a hit, each carrying real corpus usage examples (with definitions alone it *understood* the local memes but never used them). Entries are mined from our own corpus, not imported: three external meme libraries totalling 549 terms produced only 9 genuine hits. A false hit is worse than no injection, so every entry carries an `avoid` exclusion context. |
| [`dsh-human`](plugins/dsh-human/) | The **shape** of replies doesn't look human. Measured: 16.4% of human messages contain a comma versus 67.7% of the bot's, and the "short clause, short clause" pattern accounts for 54.8% of bot messages and 0% of human ones. Prompting cannot fix this (it sat in the persona for two weeks unchanged); the fix splits comma-glued clauses into separate messages before sending. |
| [`dsh-typo`](plugins/dsh-typo/) | Thousands of messages without a single typo. A hand-reviewed 60-pair homophone table, 6% chance of one wrong character per message, 35% chance of a follow-up self-correction. A 48-entry protect list (glossary terms, names, sticker markers, links) is never touched. |
| [`dsh-drift`](plugins/dsh-drift/) | Always answering strictly on-topic — that over-precision is itself an AI tell. Three drift levels expressed as graded prompts. Two structural hard limits keep the previously fixed off-topic bug from returning: never drift when mentioned, never drift when the message looks like a question. |
| [`dsh-effect`](plugins/dsh-effect/) | Every change was open-loop: inject and hope, with no idea whether anything landed. Now each reply opens a 180s observation window and classifies the reaction (appreciation / playful / neutral / confusion / factual correction / rejection / ignored), whether it targets content or persona, and whether the reply advanced or derailed the thread. Zero messages in the window means "ignored" for free. |
| [`dsh-aiflavour`](plugins/dsh-aiflavour/) | Dynamic AI-flavor interception. Static strong words + learned word roots + a session brake, to curb the bot's over-explaining / over-summarising. |
| [`dsh-humanizer`](plugins/dsh-humanizer/) | De-AI exit gate. Scans the reply body for AI-trace features and strips/blocks AI-flavoured sentences — the pipeline stage that bends speech back into human phrasing. |
| [`dsh-noise`](plugins/dsh-noise/) | Human noise. Swaps a character / cuts a reply short / repeats a whole clause — only on unprompted replies, never on a proper @-mentioned answer. |
| [`dsh-armor`](plugins/dsh-armor/) | Anti-breakage on the input side. Recognises prompt re-copying, rule ignoring, privilege-induction and identity grillings; priority 2000 so it runs before the inject group. |
| [`dsh-merge`](plugins/dsh-merge/) | Aggregated replies under a mention storm. When @-mentioned too many times it merges into one unified reply (summarises and connects, names nobody), instead of replying line by line. |
| [`dsh-quoteref`](plugins/dsh-quoteref/) | Quote replies. Uses a QQ quote-reply for every Nth question-style @, aligned to the human quoting rate. |

**Multimodal**

| Plugin | Problem solved |
|---|---|
| [`dsh-imgctx`](plugins/dsh-imgctx/) | Blind to images. The framework only captions images attached to the *current* message, while the common pattern is "post image, then ask about it". Animated GIFs get 4 frames tiled before recognition. |
| [`dsh-vischain`](plugins/dsh-vischain/) | The vision model config is a single string — no fallback. The primary model sits behind a CDN that returns 403 about 20% of the time; failures are instant (0.0s), so retrying costs almost nothing. |
| [`dsh-imagegen`](plugins/dsh-imagegen/) | Agreeing to draw but not drawing. Cheap models routinely skip tool calls in long contexts, so a fallback hook is mandatory. |
| [`dsh-video`](plugins/dsh-video/) | Watching and generating video. Four frames are 5× faster and 18× cheaper than the full clip at equal quality. Generation takes 4 minutes — never wait inside the tool (it would lock the whole session). |
| [`dsh-voice`](plugins/dsh-voice/) | TTS. The built-in one is a global switch plus probability, reading *every* reply aloud, which instantly breaks character. |
| [`dsh-web`](plugins/dsh-web/) | Web access plus outbound moderation. It fetches links already present in a message instead of hoping for a tool call, then reviews every page/search/tool/command exit before sending: regex fast-block → small-model JSON verdict → fail-closed on timeout or failure. |
| [`dsh-sticker`](plugins/dsh-sticker/) | Stickers. The key rule: strip markers **unconditionally**, or `[sticker:xx]` leaks into the group verbatim. |
| [`dsh-listen`](plugins/dsh-listen/) | Hearing voice messages. Voice clips are handed to a transcription service and injected as voice context — so it no longer just knows "someone sent a voice message". |

**Memory and moderation**

| Plugin | Problem solved |
|---|---|
| [`dsh-memory`](plugins/dsh-memory/) | Not remembering people. The built-in feature is a 20-message sliding window; anything older is gone. Custom buffer plus background extraction, with PII scrubbing, prompt-injection defense, per-person caps, and self-service `/forget me`. |
| [`dsh-social`](plugins/dsh-social/) | Per-group social distance without changing truth or access. Direct, bot-addressed signals adjust affinity/trust under decay and daily caps; default shadow mode only audits, and questions, @ mentions and capability requests are always answered fully. |
| [`dsh-guard`](plugins/dsh-guard/) | Moderation. Three layers: regex prefilter (free; only 2.2% hit rate measured on real traffic) → small model emitting booleans only → **code** decides whether to mute. Since 1.2.0 the decision is dynamic: emotion, drives, per-group relationship, reactance and fatigue are folded into one leniency score that sets the severity step, the warning threshold and the duration for *attitude* cases (flame wars, politics). Hard behaviour cases — illegal, ads, NSFW requests, flooding, direct insults, group hate — ignore mood entirely, and mood can only turn a pass into a warning, never into a mute. |
| [`dsh-poke`](plugins/dsh-poke/) | No reaction to pokes. The reply never calls an LLM; three rate limits prevent poke loops. |
| [`dsh-welcome`](plugins/dsh-welcome/) | Greeting new members. Generated by the LLM rather than a fixed template (templates break character). |
| [`dsh-acl`](plugins/dsh-acl/) | Anyone could run any command. Three tiers (everyone / owner + admins / owner only), with identity resolved **by QQ ID only** — nicknames collide and group cards can be changed at will. Status queries are gated too: they change nothing, but they print endpoint addresses, model names, quotas, and token spend into the group. |
| [`dsh-fwd`](plugins/dsh-fwd/) | Forwarded chat records are invisible — the framework only passes a `[chat record]` placeholder. Expands them by nesting depth, keeping head and tail, with separate budgets for images and video. |
| [`dsh-spine`](plugins/dsh-spine/) | Backing down when pressed, apologising when doubted. Unlike `dsh-claimguard` this governs **positional consistency** rather than facts. |
| [`dsh-slang`](plugins/dsh-slang/) | Slang learning with no human feeding. Automatically mines likely-slang from the chat, researches meanings into candidates, and every 8h an AI reviews the batch (promote / reject / wait). |
| [`dsh-factguard`](plugins/dsh-factguard/) | Memory watchdog. When asked about its own attributes it answers only from the fact table; ungrounded claims are denied and corrected — prevents random admission and gender wobble. |
| [`dsh-selfaware`](plugins/dsh-selfaware/) | Self-awareness ledger. Injects the closed capability list, recent join reviews, and verified recent actions; captures existing success logs into its own SQLite database without modifying other plugins. |
| [`dsh-leakguard`](plugins/dsh-leakguard/) | Blocks system-prompt leakage. Checks whether a reply copied the persona's exclusive title / instruction verbatim. Works with `dsh-humanizer` as the hard fallback. |
| [`dsh-homophone`](plugins/dsh-homophone/) | Homophone / nickname recognition. A name said in homophones counts as being called; meme meanings in homophones get injected. |
| [`dsh-joinguard`](plugins/dsh-joinguard/) | AI-reviewed join gate. Sends the join question + answer to an AI to judge approve/reject and really approves/rejects. |
| [`dsh-scene`](plugins/dsh-scene/) | Group-level context and daily rhythm. Tells the bot which group this is and what time of day means here. |
| [`dsh-selfguard`](plugins/dsh-selfguard/) | Output self-restraint. Blocks repeating things it already said and, during a group argument, its own provoking / abusive lines — `dsh-guard` polices members, this polices the bot itself. |
| [`dsh-pay`](plugins/dsh-pay/) | Sponsorship / payment guidance. Asks how to pay → sends the QR code, and only thanks after the owner confirms receipt. |
| [`dsh-proactive`](plugins/dsh-proactive/) | Interest probe. Pure-regex interest scoring (zero LLM cost); joins in on rice / food / whale / AI topics actively. |
| [`dsh-interest`](plugins/dsh-interest/) | Interests change. Time-decayed heat + a rotating "today's craving" flavour cycle, injected as a state block so the tone carries what it's currently itching about. |
| [`dsh-steal`](plugins/dsh-steal/) | Sticker stealing. Understands image meaning, only keeps "repeated, understandable" ones, skips anything unsuitable to share (fail-closed); `/sticker` sends one at random. |

### Eleven lessons learned the hard way

Each was re-validated across multiple plugins:

1. **Structural judgement beats keyword lists.** For intent detection don't enumerate keywords or clamp reply length. The correct shape is "user wants an image + model did not explicitly refuse + model is not asking a back-question" ⇒ generate. Filter objects by exclusion (what can't be drawn), not by enumerating what can.
2. **Log every non-trigger.** Otherwise every debug is guesswork. `dsh-imagegen`'s "sometimes doesn't draw" took three rounds to find, and the first two failed purely because there were no logs.
3. **Where you skip the message pipeline and call the LLM directly, you must replicate the marker-stripping logic.** `llm_generate` does not go through the pipeline, so the sticker hook never fires, and `[sticker:peek]` leaked into the group that way.
4. **Thresholds must come from measured distributions.** `dsh-mention` v1 had a "reply within ≥8s → mention" rule, but what it measured was how long the bot itself thought — with persona a call routinely takes 5–15s, making it equivalent to "always mention". 8 replies in 24h were 100% mentioned.
5. **Fail-open disguises crashes as quality regressions.** `dsh-decide` unpacked a 3-tuple as a 2-tuple, so whenever the bot had just spoken it always threw `ValueError`, falling through fail-open to "reply as usual" — **12 crashes vs 9 successes that day**, so over half its replies never received the "who said this to whom" verdict. Everything looked fine, it just talked wrong. Every fail-open fallback must WARN and count on that path.
6. **A hit count of zero does not mean the misjudgment is fixed.** Tightening the "question" rule dropped `dsh-emotion`'s curiosity hits from 14 to 0, which looked like success but was a total miss — the common follow-up "but then why didn't you" has its question word mid-sentence, while the new regex only anchored at the start. Rule changes must be diffed sample by sample, not by total.
7. **Shadow mode's value is in replay, not in waiting.** Running overnight shows only that night's few lines; replaying 1618 messages of history exposed two real misjudgments in 20 minutes (treating the character of "balance/quota" as an awkward filler, and treating an undirected insult as aimed at the bot).

8. **Your own group's corpus beats any off-the-shelf dictionary.** Three external meme libraries totalling 549 terms produced 9 genuine hits here; one pass over our own corpus contributed the single most-hit entry in the table. The signal that works is "this phrase was sent as an entire message, by at least two different people" — catchphrases and memes get sent alone; ordinary words never do.
9. **Ask the model whether it already knows, before deciding to teach it.** Asked one by one, the main model said "not sure" for none of the 43 slang entries and got most of them right. That changed the plugin's purpose outright: from *dictionary* to *pragmatics layer*, with definitions compressed to the minimum and effort spent on the 6 terms it got wrong plus the local conventions it cannot infer. Without that probe we would still be maintaining a dictionary the model never needed.
10. **Re-benchmark any judgement borrowed from a reference implementation.** MaiBot's "another AI is being called" regex, copied verbatim, had two false positives here because this group's topic literally is the models themselves; its 30%-per-character typo rate here would mean screens full of typos. A reference gives you ideas — thresholds and boundaries must be re-derived from your own corpus.
11. **Before adding "more human" features, think about whether it will bring back a fixed bug.** Attention drift and off-topic replies are two ends of the same direction, so drift's two boundaries (never drift when mentioned, never drift when it looks like a question) are **structural**, not a reminder in the prompt.

### Docs

| Document | Description |
|---|---|
| [10 云服务器部署手册](docs/10-云服务器部署手册.md) | Full Docker + NapCat + AstrBot setup, from buying a server to running |
| [20 控制台App说明](docs/20-控制台App说明.md) | The app's three tabs, 104 knobs, seven preset modes, server-driven updates and security boundary |
| [31 记忆系统与群员轮廓](docs/31-记忆系统与群员轮廓.md) | Memory storage structure and privacy design |
| [40 答非所问根因与修复](docs/40-答非所问根因与修复.md) | Quantified analysis of a 257k-character context |
| [41 被骗认输根因与修复](docs/41-被骗认输根因与修复.md) | Why editing the persona doesn't work |
| [47 真人感第二批](docs/47-真人感第二批-黑话与打字节奏与效果观察.md) | Slang table, typing rhythm, homophone typos, attention drift, response-effect closed loop |
| [48 黑话自动审核](docs/48-黑话自动审核-更新详解.md) | `dsh-slang` auto-review: mine candidates → research with main model → AI auto-review every 8h, owner commands as fallback |
| [60 长期目标与技术方案](docs/60-长期目标与技术方案.md) | Overall architecture and direction |
| [61 桌面控制台](docs/61-桌面控制台-一键部署与在线配置.md) | Windows EXE one-click deployment, online configuration, security boundary and verification record |
| [89 手机控制台 APK](docs/89-手机控制台APK-开放式登录与部署-20260916.md) | Android APK v1: open login (password / locally-rendered QR / quick login with built-in web fallback) merged with three-step deploy; zero baked-in config |
| [62 社交关系](docs/62-社交关系-按群隔离的社交距离.md) | Per-group social-distance ledger, accepted signals, five style tiers, shadow mode and fairness boundary |
| [63 自身利益](docs/63-自身利益-不认账不自贬不替外人记账.md) | Four self-harming reply classes and the two-sided input-evidence + output-shape verdict |
| [64 联网出口审核](docs/64-联网出口审核-先审后发防炸群.md) | Review-before-send across five outbound paths, fail-closed behavior and residual risks |
| [67 插件全量代码审计报告](docs/67-插件全量代码审计报告.md) | A full audit's findings and fixes (including `dsh-ctxclean` dropping persistent prefixes) |
| [72 基础设施报错不进群](docs/72-基础设施报错不进群-20260913.md) | The full evidence chain for 11 leaked raw errors, two-tier fingerprints, 8662-message backtest |
| [78 贴纸标记泄漏的第三条出口](docs/78-贴纸标记泄漏的第三条出口-Context-send_message-20260913.md) | Why the first fix still leaked: `Context.send_message` is a parallel platform exit |
| [81 掉线了却显示在线](docs/81-掉线了却显示在线-上行发送检测-20260913.md) | The monitoring blind spot from downlink-only probes, and the uplink check |
| [82 识图档位顺序与看护重启循环](docs/82-识图档位顺序与看护重启循环-20260913.md) | Latency came from tier order, not timeouts; includes the "lowering the timeout kills 15.5%" counter-proof |
| [83 内在状态总线与仲裁层](docs/83-内在状态总线与仲裁层-20260913.md) | Quantifying 11 state stores, the read-only observation layer, and "unreadable ≠ calm" |
| [84 控制台实时观察层](docs/84-控制台实时观察层-v1.1-20260914.md) | The live layer's 4 endpoints and 3 tabs, and why it reuses existing auth with no new write path |
| [群权限手册](docs/群权限手册.md) | Full tiering of 109 commands (owner 60 / admin 24 / everyone 25) and the AST-scanned catalogue |
| [命令手册](docs/群指令手册.md) | All in-group commands with usage, permissions and examples (50 plugin commands + 9 built-in) |

### Quick start

You need a server already running [AstrBot](https://github.com/AstrBotDevs/AstrBot) + [NapCat](https://github.com/NapNeko/NapCatQQ) (or follow the [deployment manual](docs/10-云服务器部署手册.md) first).

```bash
# 1. Install: copy the whole plugins directory into AstrBot's plugin dir
cp -r plugins/dsh-* /opt/qqbot/astrbot/data/plugins/

# 2. Configure: every knob is an environment variable, write them into docker-compose's env_file
#    (each plugin lists its variables at the top of main.py)

# 3. Restart (restart, not up -d — up -d won't restart the container when config is unchanged)
docker restart astrbot
```

Plugins ship their own unit tests, no need to run AstrBot:

```bash
python3 plugins/dsh-guard/test_guard.py
python3 plugins/dsh-emotion/test_emotion.py   # 36 cases
python3 plugins/dsh-quote/test_quote.py       # 25 cases
```

### What you must supply

No keys are embedded. You provide your own:

- A QQ alt account (do not use your main account — ban risk)
- An LLM API (a cheap flash-class model suffices)
- Optional: vision (image/video), image-gen, TTS, search — each one is a feature you can do without

### Known limitations

- **Voice recognition is not available.** Every channel tried was either out of credit or lacked an audio model; a voice message reads as "someone sent a voice message".
- **The QQ account will drop.** Once every 20–60 minutes, and changing IP does not help (an account that is flagged cannot be rescued by an IP change). `server/qq_watchdog.sh` auto-restarts and swaps the code.
- **The console backend is plaintext HTTP.** No TLS; passwords travel unencrypted. This comes from the port restriction — be aware on public Wi-Fi.
- **Plugins depend on AstrBot internals.** A few non-public attributes are used (`provider_manager.inst_map`, `req.contexts`, …); major AstrBot upgrades may need matching changes.

### Privacy

The repo went through full desensitisation before release: real server IPs, group IDs, QQ IDs, member nicknames, personal emails and paid relay domains are all replaced with placeholders (`your-server.example.com`, `100000001`, `群友A`, etc.). Kept measured data (response times, hit rates, token counts) contains no identifying information.

### License

MIT, see [LICENSE](LICENSE).
