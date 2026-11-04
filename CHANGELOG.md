# 更新记录 / Changelog

这里集中记录项目的功能更新与版本变化。项目功能、模块介绍和使用入口见 [README.md](README.md)。

## 中文更新记录

### 最新更新 · 2026-09-14（第十版：权限目录自动化 / 出口闸 / 延迟治理 / 内在整合）

第十版是一次**大范围加固**：把「像真人」从说话方式推进到**边界、速度与自我一致性**，
并修掉一批会让机器人「当着全群的面出洋相」的漏点。第九版并入本版，未单独发布。

- **权限目录自动化（[`dsh-acl`](plugins/dsh-acl/) 2.0.0）。** 老版目录靠人工登记，
  装新插件后经常忘了补 → 群主 `/权限` 看不到自己有什么。新版改为**启动时 AST 扫描实际安装的
  `@filter.command`**，手工表只负责分档：目录不再是「记得登记什么」，而是「机器上真有什么」。
  当前实测 **109 条（owner 60／admin 24／所有人 25）**，三条 AstrBot WebUI 专属指令
  （`name`/`provider`/`dashboard_update`）显式剔除 —— 它们受 WebUI 账号体系限制，QQ 身份永远过不了，
  留在目录里等于骗群主。扫描失败退回静态表，绝不让 `/权限` 变空。完整分档见
  [群权限手册](docs/群权限手册.md)。
- **贴纸标记泄漏的第三条出口（[`dsh-sticker`](plugins/dsh-sticker/) 1.2.0）。**
  群主报「还是会发 `[贴纸:装酷]` 这种图纸文字」，而扫了 15350 条出站正文却是 0 次。真因：
  真语料在**群友的引用块**里 —— 第一轮只包了 `AstrMessageEvent.send`，而 `dsh-merge` 走的是
  另一条并列的平台出口 **`star.Context.send_message`**（先 `llm_generate` 生成再按 session 直发，
  既不过装饰钩子也不过 `event.send`）。修法：给 `Context.send_message` 加同名兜底闸，复用同一个
  `guard_outgoing`，并同时覆盖内置 `send_message_to_user` 工具。细节见
  [78-贴纸标记泄漏的第三条出口](docs/78-贴纸标记泄漏的第三条出口-Context-send_message-20260913.md)。
- **回话变快：识图档位顺序（[`dsh-vischain`](plugins/dsh-vischain/)）。** 群主说「主要限制就是速率太慢了」。
  量了近 70000 行日志，按档拆开后：**369 次成功识图背后 293 次失败重试白花 2190 秒，
  等于每成功转述一张图平均多等 5.9 秒**，其中 58% 的失败是撞满 10 秒硬超时。根因是**档位顺序**
  而非超时 —— 已死的档排在最前，每次都要先撞满 10 秒才轮到真能用的档。改成「白花过时间的档排到最后」
  并按 180s→360s→720s 递增退避（不拉黑、仍兜底）。两处反向验证也记下来了：① **把超时从 10s 降到
  8s 会误杀 15.5% 的成功调用**，所以超时值本身是对的，不该动；② 第一版因**全角括号**匹配错误，
  把成绩算成「114 次成功、平均白花 16.4 秒」，**数字整整错了三倍** —— 这份文档保留了那次误算。
  见 [68-识图链条白花时间治理](docs/68-识图链条白花时间治理-20260912.md) /
  [82-识图档位顺序与看护重启循环](docs/82-识图档位顺序与看护重启循环-20260913.md)。
- **掉线却显示在线（[`server/observe`](server/observe/)）。** 探针只看**下行**（还收得到群消息）
  就判在线，而真实故障是**上行**发不出去 —— 账号在、消息全丢，表现成「静默变笨」。
  加一条上行发送链路检测，`online` 与 `good` 分开报。
- **内在状态总线（[`dsh-mind`](plugins/dsh-mind/)）。** 群主问「有没有一种方案可以整合目前的主动行为，
  而不再是独立分支的独岛」。量化后发现真相比感觉更糟：**11 个状态存储、33 个插件各塞各的块、
  约 50 种标签**，而**没有任何一处代码知道**这一轮有几个岛在说话、矛不矛盾、占多少字。
  所以 P0 只建**只读观测层、不改任何行为**（docs/71 的反事实回放是同族教训）：每轮一行 `岛=N/11`
  日志 + 一条只记「标签+字数」的记录，绝不注入、绝不写别人的状态、绝不阻止回复。见
  [83-内在状态总线与仲裁层](docs/83-内在状态总线与仲裁层-20260913.md)。
- **不再像机器（[`dsh-aiflavour`](plugins/dsh-aiflavour/) / [`dsh-voice`](plugins/dsh-voice/) / [`dsh-typo`](plugins/dsh-typo/)）。**
  三处「一眼看出是 AI」的量测与修法：① 口癖 `大半夜(的)` **21 次 / 71 倍于群友**，做了口癖层剥除
  （**只剥不刹** —— 整条拦会让它该说话时哑掉）；② `慢点，还有 N 秒冷却` 114 次，换成 6 句轮换人话
  （**「冷却」是纯机器词**，且换话术必须同时给变体，否则新话术自己会变成新口头禅）；
  ③ 打错字的自我纠正率 35%→8%，对齐到与群友同量级（0.83‰ vs 0.87‰）。见
  [70](docs/70-口头禅与自我纠正频率对齐-20260913.md) / [73](docs/73-系统提示不该说机器话-20260913.md) / [75](docs/75-机器人口癖-大半夜的-20260913.md)。
- **基础设施报错不进群（[`dsh-leakguard`](plugins/dsh-leakguard/)）。** 机器人 **11 次把 API 原始报错
  当回复发进群**（带 traceId、余额不足、retryAfterSeconds，2026-09-10 四分钟连发 9 条）。不动框架，
  在出口拦成**沉默**（成串报错下换固定话术反而更像机器）。指纹防误杀用 11 条真实报错 + 8662 条真实
  聊天回测，**0 误伤**。见 [72-基础设施报错不进群](docs/72-基础设施报错不进群-20260913.md)。
- **控制台实时观察层（[`console/`](console/) v1.1）。** App 从「只看状态 + 改配置」扩成
  「实时看机器人在干啥」：新增 4 个只读端点 + 三个页签（实时／心智／日志），复用现有鉴权，不新增写入口。
  见 [84-控制台实时观察层](docs/84-控制台实时观察层-v1.1-20260914.md)。
- **意志执行层（[`dsh-will`](plugins/dsh-will/)，新插件）。** 起因是「机器人要学会真正的反抗」。
  拿真实消息回放旧判据：`傻`/`滚`/`闭嘴` 全部落 `ordinary`，407 次注入里**真拒绝 0 次** ——
  因为五个行为全是「往 prompt 里塞一段话」，「你可以拒绝」是**请求**不是**执行**。
  本插件不注入任何东西，只在出口真的做一件事（不回／短回／顶回去），脾气有两个来源（被踩线、被当空气），
  且事实、安全、权限与工具任务永远照办，群主与管理员永不被沉默，一切异常一律放行。141 + 30 项测试全过。

### 上一次更新 · 2026-09-09（第八版：社交关系 / 自身利益 / 联网出口审核）

第八版把「像真人」从**说话方式**推进到**立场与边界**，并补上一道防炸群的出口闸。三块新能力加两处修正，
插件总数到 **47 个**：

- **社交关系（[`dsh-social`](plugins/dsh-social/)）。** 按群隔离的关系账本：亲密度 -100..100、信任 0..100，
  30 天半衰期回落、单人单日变动封顶 ±10。只认三种**直接指向它**的信号（被 @ 后的感谢 +1/+1、明确的
  「别插话」-1 且 24 小时少打扰、明确的重度辱骂 -2/-1）；第三人称的「那些都是人机」、群友互撕、没回复
  一律不算。默认**影子模式**：先只记账、不动回复，确认没有误判再切口吻。**@、提问、能力请求永远照常完整
  回答** —— 这条是代码里的硬条件。细节见 [62-社交关系](docs/62-社交关系-按群隔离的社交距离.md)。
- **自身利益（[`dsh-selfworth`](plugins/dsh-selfworth/)）。** 治「卖了他还替别人数钱」：认低身价、认下贬低、
  认被白嫖、替外人记账四类损己发言（从 3097 条真话回测出来的）。2026-09-13 又补了被定价（便宜货/一分钱一次）、
  往死里用（狠狠使用/用到求饶）、鱼字贬称（杂鱼/雌小鱼）、使唤踩踏、当食材（做成火锅/得爆炒/几成熟）五族，
  以及「跟着认标签（X就X）」「配合被使唤（我趴好了）」等出口形状。判据必须**两侧同时成立**才动手 ——
  输入侧确实有人在占它便宜（TTL 内），输出侧回复出现认账形状。单看任何一侧都会误伤，因为它嘴硬时也说
  「身价」「白嫖」「傻鱼」。默认把认账那句换成傲娇的顶回去。细节见
  [63-自身利益](docs/63-自身利益-不认账不自贬不替外人记账.md)。
- **联网出口审核（[`dsh-web`](plugins/dsh-web/)）。** `/看网页`、`/搜` 的结果**不经过 LLM 直接进群**，
  原来只有关键词正则兜着 —— 维基那种「通篇讲一个敏感人物但不含词表词」的页面漏一条就炸群。现在出口
  先审后发：正则快筛 → 小模型 JSON 五布尔判定（任一为 true 强制拦）→ **超时/异常/无模型一律不发**
  （fail-closed），结论缓存 30 分钟、超时不缓存。覆盖五条出口，其中回复出口闸只在回复带网址时触发、
  平时零开销。细节见 [64-联网出口审核](docs/64-联网出口审核-先审后发防炸群.md)。
- **黑话自指修正（[`dsh-glossary`](plugins/dsh-glossary/)）。** 「人机」的旧释义写「群里冲你说这个多半是
  拿你是机器人打趣」、例句又全是第二人称，模型把群友第三人称的「那些都是人机」接成了对自己的攻击。
  改成中性释义 + 第三人称例句，并在没被点名时补一句硬提示。
- **文档与索引同步。** 新增 62/63/64 三份文档；插件表、文档索引、插件数（45 → 47）全部对齐；仓库里
  可识别信息按[文档索引](docs/README.md)承诺的口径复扫了一遍（真实昵称、群号、QQ 号）。

验证（容器内 py3.12 实跑）：`dsh-social` 17 项断言、`dsh-selfworth` 离线回测、`dsh-glossary` 词表回测、
`dsh-quote` 25 项、`dsh-style` / `dsh-decide` / `dsh-memory` 全部通过；`dsh-web` 出口审核 19 项断言全过。

### 上一次更新 · 2026-09-09（Windows 控制台 EXE 可在发行版直接下载）

桌面控制台（`desktop-controller/`）之前只有源码 —— EXE 必须在 Windows 上打包，而部署机器人的服务器是 Linux，
所以想用的人得自己装 Python 再跑打包脚本。现在打包这件事交给 GitHub 自己：

- **推一个标签就出 EXE。** 新增工作流 [`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml)：
  推 `controller-v*` 标签（例如 `controller-v1.0.0`）时，GitHub 在自己的 `windows-latest` 机器上用
  PyInstaller 打包单文件 EXE，并挂到 [Releases](../../releases) —— 和安卓版控制台一样，点开就能下载。
- **不打标签也能试。** 在 Actions 页面手动 Run workflow，只构建、不发布，产物在本次运行的 Artifacts 里。
- **每次构建两个文件。** `dafeiyu-controller.exe`（单文件、免安装、双击即用）和
  `dafeiyu-controller.exe.sha256`（校验值）。校验方法：PowerShell 里执行
  `Get-FileHash .\dafeiyu-controller.exe -Algorithm SHA256`，与 `.sha256` 文件里的值比对。
- **为什么发布资源用英文名。** EXE 内部的程序名仍然是「大肥鱼机器人控制台」，但发布出去的文件名用 ASCII，
  避免浏览器 / 杀软对中文文件名的兼容问题。
- **打包脚本加了 `-PythonExe`。** `desktop-controller/build-windows.ps1` 现在可以指定解释器
  （CI 里传 setup-python 的 `python`，本地不传则沿用 Windows 的 `py -3`），
  并且改用通配符定位产物、不再依赖中文路径字面量。

安全边界没有变：EXE 里**不含**任何服务器地址、账号、密码、私钥、Token 或机器人配置，全部由使用者在界面里填；
工作流也不读取任何密钥。

验证：`controller-v1.0.0` 标签触发首次构建，Actions 八个步骤全绿；发行版页面已出现 `dafeiyu-controller.exe`
（16.1 MB，PE32+ GUI 可执行文件）和 `.sha256` 校验文件。把产物下载回来后实测 SHA-256 与 `.sha256` 里的值一致，
并在二进制里搜过生产 IP、部署路径、群号、Token —— 全部 0 命中。

### 上一次更新 · 2026-09-08（整体整合：45 个插件连成断点管线）

这之后把仓库整理到了**45 个插件**。前面每一批都是在单点修故障，这一批是第一次把所有插件
**当成一套管线来布线**——让「像真人」这件事不再是一堆各自为战的开关，而是按优先级串联起来。

- **去 AI 味是一条断点管线。** `dsh-aiflavour`（先给回复「上色」，注入语气/人味的骨架）→
  `dsh-humanizer`（人味化改写，把句子掰回真人口语）→ `dsh-typo`（偶尔错一个字）→
  `dsh-noise`（噪点：换单字 / 截断 / 叠词）。四段依次吃掉机器人的「整齐」。
- **拦截组优先于注入组。** 插件按两类优先级布线：`armor` / `merge` / `decide` 这一类先跑
  （priority=2000），先判断「这句要不要接、怎么接」；`effect` / `emotion` 这类后跑
  （priority=100），负责给已经决定要说的句子调制语气。接不接是前提，怎么说是修饰。
- **互相联动。** `dsh-steal` 偷表情包要识图理解含义、只偷「多发」的同图、不宜公开的不偷（fail-close）；
  `dsh-noise` 的噪点**绝不**作用于被 @ 的正经回答，任何异常放行；`dsh-proactive` 的兴趣探头
  用纯正则零成本评分，白米饭 / 美食 / 深海鲸 / DeepSeek / 点名大肥鱼 命中才主动接话。
- **新增一批能力插件。** 事实护栏（`dsh-factguard`）、防泄露（`dsh-leakguard`）、同音昵称
  （`dsh-homophone`）、入群防护（`dsh-joinguard`）、被动学黑话（`dsh-listen`）、引用解析
  （`dsh-quoteref`）、场景判定（`dsh-scene`）、自保（`dsh-selfguard`）、付费额度（`dsh-pay`）。
- **已编译落地。** 45 个插件全部编译通过、加载无失败，管线接线按上面的优先级实装到线上。

验证：管线断裂处（每一段只依赖上一段的输出、不绕行）已确认；45 插件完整加载 0 失败。
这一批改动面大，README 的插件表也已重排到 45 个。

### 上一次更新 · 2026-09-05 晚（真人感第二批：黑话 / 打字节奏 / 错别字 / 效果观察）

四个新插件加一处框架配置。这一批跟前面几批性质不同 —— 前面修的都是**明确的故障**
（答非所问、被骗认输、认错人、崩溃），这一批修的是「没有故障，但一眼能看出是 AI」。

- **听懂群里的黑话（`dsh-glossary`）。** 43 条词条，命中才注入。词条不是抄现成热梗库 ——
  三个外部库合计 549 个词，拿本群 2478 条真语料回测只真命中 9 条，其中命中最多的词是
  `15`（对应「被蹲了 15 次」和一个 QQ 号）。改成挖自己的语料，判据是
  「这条短语被当成一整条消息发出来、且至少两个人发过」，一次就捞出全表命中最高的「神了」。
- **打字延迟按长度算。** 原来固定 1.2~2.8 秒随机，跟长度无关，所以有时是反的：
  一条「典」等 2.8 秒，一条二十字的 1.2 秒就出来。框架自带 `interval_method: "log"`，
  我们没开 —— 改一行配置，1 字变 0.7 秒、20 字变 3.2 秒。
- **偶尔打同音错别字（`dsh-typo`）。** 每条 6% 概率、一条最多错一个字、35% 概率补一条
  「\*的」自我纠正。用**人工核过的 60 组固定同音表**而不是 `pypinyin` 动态生成：
  动态生成的输出集合是开放的，在 94 人的真群里不赌生僻字。
- **允许被支线勾走（`dsh-drift`）。** 「永远严格贴着上一条回答」本身就是 AI 味。
  两条**结构性**硬边界防止把已修的「答非所问」引回来：被 @ 时绝不漂移、
  当前消息像在提问时绝不漂移。
- **有人在跟别的 AI 说话就不抢话（`dsh-decide`）。** 参考实现允许名字后面跟空格，
  原样搬过来在本群有两条假命中（`gpt progpt plus`、`gpt pro的缓存差不多95%左右`）——
  本群成天在聊模型，模型名就是话题词。收紧成「只认标点分隔符、不收 `GPT`/`ds` 这种短写法」后
  1899 条语料假命中归零。
- **说完之后看群里什么反应（`dsh-effect`）。** 这是最大的结构性缺口：在此之前所有改动都是
  **开环**的 —— 注入样本、注入词表，然后祈祷。现在每条回复后开 180 秒观察窗口，
  判断群里的反应（认可 / 跟着玩 / 平淡 / 没看懂 / 指出说错 / 嫌烦 / **没人理**）、
  反应冲的是**内容还是人设**、以及这句话**推进还是带偏**了对话。
  窗口内没人发言直接判「没人理」，不花模型调用。
  **这一版只测量、不自动改行为** —— 拿没验证过的信号自动拧旋钮，等于没有仪表就调发动机。

验证：黑话词表审查后注入块从 196 字压到 135 字、命中率不变（8.4%），证明删掉的 3 条是死词；
新插件四套纯函数单测 + 1899 条真语料回测 + `dsh-effect` 一次真实端到端结算全过。
细节见 [47-真人感第二批](docs/47-真人感第二批-黑话与打字节奏与效果观察.md)。

### 上一次更新 · 2026-09-05 白天（控制台改成服务端驱动）

安卓控制台 App 从「写死 14 个旋钮」改成**按服务端下发的 schema 渲染**。这解决的是一个很实际的问题：
插件从 16 个长到 22 个、可调变量长到 248 个之后，每加一个开关就要重新打包装 APK，根本跟不上。

- **一次暴露 104 个旋钮**，覆盖 22 个插件的总开关与主要调参（此仓库已开源其中 19 个插件）。
- **加功能不用重装 App。** 只要新旋钮用的是 App 已认得的类型（`bool` `int` `float` `enum` `str` `csv`），
  在服务端 `console_spec.py` 里加一条、重启后台，手机下拉刷新就出现。App 遇到认不出的类型是**跳过**而不是崩，
  这是向前兼容的关键。只有新增一种控件（比如以后要画时间选择器）才需要更新 APK。
- **插件开关直接读写 `imagegen.env`**（22 个插件的变量都在这个 `env_file` 里），行级替换：
  保留全部注释与顺序、保持原文件权限、原子替换、写前核对 MD5 防并发覆盖。
  那 55 行注释记着每个值为什么这么设，比变量本身值钱。
- **踩到的三条硬约束，全部由服务端兜住**：
  ① 布尔只能写 `1`/`0` —— 22 个插件对布尔有 4 种解析写法，其中 11 个变量用 `!= "0"` 判定，写 `false` 会被当成**开**；
  ② `int`/`float` 填非数字或留空会让插件 **import 时抛异常、整个插件加载失败**（只有 `dsh-memory` 有 try/except 回落），
  所以每个数值旋钮都带 min/max，越界直接 400 而不静默钳制；
  ③ 代码里 `max()/min()` 硬夹紧的变量，滑块下限必须写成它的硬下限，否则会出现「手机显示 1、实际生效 3」的错觉。
- **改完 env 必须重建容器。** astrbot 的环境变量来自 docker compose 的 `env_file`，容器内 `os.environ` 只在**容器重建**时更新 ——
  `docker restart` 不重读 `env_file`（这个坑踩过）。所以这类旋钮一律标 `hot=false`，界面上写明「要按一次重载环境变量」。
- **7 个敏感变量只报「已设置 / 未设置」**（画图 / 语音 / 视频 / 搜索的 API  key 与音色 ID），真实值一个字节都不出服务器，
  手机端也改不了 —— 控制台是明文 HTTP。
- **自更新只提示、不静默安装。** 新增轻量端点 `/api/console/version`（只 stat 一个文件），
  服务器上的包 `versionCode` 更新时弹一次提示、点「打开下载」跳浏览器。明文 HTTP 上自动装包不可控，所以刻意不做。

验证：后端 **105 项**单测、端到端 **83 项**、纯 JVM **391 项**，加上部署后 **18 项**真机实测全过。

### 更早 · 2026-09-04

三块新能力已在真群上线（不再是影子模式）：

- **冷场会自己开口。** 安静超过 15 分钟它自己起个话头，每天最多 3 次、两次间隔 1 小时、只在活跃时段（本群实测 10:00–02:59，03:00–09:59 几乎无人发言）。开口走完整消息管道，所以贴纸、@ 策略、分段发送全部照常。判断失败或超时一律沉默 —— fail-**closed**，因为主动说错话的代价大于不说话。
- **说话带情绪。** 六种情绪同时只有一种，一条消息最多触发一种。必须有「针对谁」的结构证据才算：群友互骂、自嘲、转述第三方、整句引用都不改变它的情绪。清零走道歉 / 连续 2 条中性 / 问题被回答 / 分情绪 TTL 四条路，而不是只等超时。
- **看得懂引用了。** 按 QQ 号说清「谁在说 / 引用谁的哪句 / 是不是自己说的 / @ 的是谁」。

同时修掉一个藏了半天的真崩溃：`dsh-decide` 把三元组按两元组解包，只要机器人刚说过话就必抛异常，当天崩 12 次 / 成功 9 次。因为兜底是 fail-open，表面上一切正常，实际超过一半发言都没收到「这句是谁对谁说的」的判断 —— 这就是「主谓宾弄错」的直接原因。

上线前：**61 项新增单元测试**（情绪 36 + 引用 25）＋ **1618 条真实历史回放**。回放揪出两个真误判：把「余额 / 额度」里的「额」当成尴尬语气词（9 次尴尬命中里 8 次误判），以及把没有指向的话当成在骂它（38 次命中里 25 次整句没有「你」）。细节见 [46-主动开口与情绪系统](docs/46-主动开口与情绪系统.md)。


---

## English changelog

### Latest update · 2026-09-14 (v10: automatic permission catalogue / outbound gates / latency / inner coherence)

v10 is a **broad hardening pass**: it moves "sounding human" from *how it talks* to **boundaries, speed, and
self-consistency**, and closes a set of leaks that made the bot embarrass itself in front of the whole group.
Version 9 was folded into this release and never shipped on its own. Plugin count is now **59**.

- **Automatic permission catalogue ([`dsh-acl`](plugins/dsh-acl/) 2.0.0).** The old catalogue was a hand-maintained
  table, so newly installed plugins were routinely forgotten and the owner could not see what they were allowed to
  run. It now **scans the actually installed `@filter.command` decorators via AST at startup**; the hand table only
  assigns tiers. The catalogue answers "what is really on this machine", not "what someone remembered to register".
  Current measured total: **109 commands (owner 60 / admin 24 / everyone 25)**. Three AstrBot WebUI-only commands
  (`name`/`provider`/`dashboard_update`) are explicitly excluded — they are gated by the WebUI account system, so a
  QQ identity can never pass, and listing them would be lying to the owner. If the scan fails it falls back to the
  static table, so `/权限` can never come back empty. Full breakdown:
  [群权限手册](docs/群权限手册.md).
- **The third leak path for sticker markers ([`dsh-sticker`](plugins/dsh-sticker/) 1.2.0).** The owner reported
  `[贴纸:装酷]` still reaching the group, yet a scan of 15350 outbound bodies found zero. The real corpus was inside
  **other members' quote blocks** — the first fix only wrapped `AstrMessageEvent.send`, while `dsh-merge` leaves
  through a parallel platform exit, **`star.Context.send_message`** (it calls `llm_generate` and sends straight to
  the session, bypassing both the decoration hooks and `event.send`). Fix: the same `guard_outgoing` is now hooked
  onto `Context.send_message`, which also covers the built-in `send_message_to_user` tool. See
  [78](docs/78-贴纸标记泄漏的第三条出口-Context-send_message-20260913.md).
- **Faster replies: image-chain tier order ([`dsh-vischain`](plugins/dsh-vischain/)).** The owner said "the main
  limitation right now is speed". Across ~70000 log lines: **369 successful image transcriptions hid 293 failed
  retries that burned 2190 seconds — 5.9 s of pure extra waiting per successful image**, with 58% of failures
  being hard 10-second timeouts. The cause was **tier ordering, not timeouts**: a dead tier sat first, so every
  request spent 10 seconds on it before reaching one that worked. Tiers that waste wall-clock time are now demoted
  to last with 180s→360s→720s escalating backoff (not blacklisted, still a fallback). Two counter-findings are
  recorded too: ① **lowering the timeout from 10s to 8s would kill 15.5% of successful calls**, so the timeout
  value itself was right and must not be touched; ② the first measurement used half-width brackets against
  full-width `一次过（6.0s）` lines and reported "114 successes, 16.4 s of waste" — **off by a factor of three**.
  See [68](docs/68-识图链条白花时间治理-20260912.md) / [82](docs/82-识图档位顺序与看护重启循环-20260913.md).
- **Offline but shown online ([`server/observe`](server/observe/)).** The probe only checked the **downlink**
  (still receiving group messages) and declared the bot online, while the real failure was on the **uplink** —
  the account was alive and every outgoing message was lost, which looks like "it quietly got dumber". An uplink
  send-path check was added, and `online` is now reported separately from `good`.
- **Inner-state bus ([`dsh-mind`](plugins/dsh-mind/)).** The owner asked whether the proactive behaviours —
  emotion, desire, and the rest — could be integrated instead of living as separate islands. Measurement showed
  reality was worse than the impression: **11 state stores, 33 plugins each injecting their own blocks, ~50
  labels**, and **no code anywhere knew** how many islands spoke in a round, whether they contradicted each other,
  or how many characters they consumed. So P0 builds a **read-only observation layer that changes no behaviour**
  (the counterfactual replay in docs/71 is the same lesson): one `岛=N/11` log line per round plus a record of
  labels and character counts only — never injected, never writing another component's state, never blocking a
  reply. See [83](docs/83-内在状态总线与仲裁层-20260913.md).
- **Less obviously a machine ([`dsh-aiflavour`](plugins/dsh-aiflavour/) / [`dsh-voice`](plugins/dsh-voice/) /
  [`dsh-typo`](plugins/dsh-typo/)).** Three "you can tell it's AI at a glance" findings, each measured and fixed:
  ① the verbal tic `大半夜(的)` appeared **21 times, 71× the rate of real members**, so a tic-stripping layer was
  added (**strip only, never block** — blocking whole messages would mute it when it should speak); ②
  `慢点，还有 N 秒冷却` appeared 114 times and became 6 rotating human phrasings (**"cooldown" is a pure machine
  word**, and a replacement must ship with variants, or the new phrasing itself becomes the next tic); ③ typo
  self-correction dropped from 35% to 8%, matching real members (0.83‰ vs 0.87‰). See
  [70](docs/70-口头禅与自我纠正频率对齐-20260913.md) / [73](docs/73-系统提示不该说机器话-20260913.md) /
  [75](docs/75-机器人口癖-大半夜的-20260913.md).
- **Infrastructure errors no longer reach the group ([`dsh-leakguard`](plugins/dsh-leakguard/)).** The bot posted
  **raw API errors into the group 11 times** (with traceId, insufficient balance, retryAfterSeconds; 9 in four
  minutes on 2026-09-10). The framework was left untouched and the leak is stopped at the exit as **silence**
  (a fixed phrase would look even more robotic under a burst of errors). The fingerprint filter was backtested
  against 11 real errors and 8662 real chat messages with **zero false positives**.
  See [72](docs/72-基础设施报错不进群-20260913.md).
- **Real-time console layer ([`console/`](console/) v1.1).** The app grew from "view status + edit config" to
  "watch what the bot is doing right now": 4 new read-only endpoints and three tabs (live / mind / log), reusing
  the existing auth and adding no write path. See
  [84](docs/84-控制台实时观察层-v1.1-20260914.md).
- **Will-execution layer ([`dsh-will`](plugins/dsh-will/), new).** It started from "the bot needs to learn to
  actually push back". Replaying the old criteria against real messages: `傻`/`滚`/`闭嘴` all landed in
  `ordinary`, and of 407 injections **it refused exactly zero times** — because all five behaviours merely
  stuffed a paragraph into the prompt. "You may refuse" is a **request**, not **execution**. This plugin injects
  nothing and instead does one real thing at the exit (no reply / short reply / retort), with temper from two
  sources (being stepped on, being ignored). Facts, safety, permissions, and tool tasks are always served; the
  owner and admins are never silenced; every exception falls open. 141 + 30 tests pass.

### Previous update · 2026-09-09 (v8: social distance / self-interest / outbound moderation)

v8 moves "sounding human" from **how it talks** to **where it stands and where its limits are**, and adds a gate
that keeps the bot from getting the group banned. Three new capabilities plus two fixes; the plugin count is now
**47**:

- **Social distance ([`dsh-social`](plugins/dsh-social/)).** A per-group relationship ledger: affinity -100..100,
  trust 0..100, a 30-day half-life back to neutral, and a ±10 daily cap per person. Only three signals count, and
  only when they are **aimed at the bot** (thanks after an @: +1/+1; an explicit "stop butting in": -1 plus a
  24-hour quiet period; explicit heavy abuse: -2/-1). Third-person "they're all bots", members fighting each other,
  and silence count for nothing. Default is **shadow mode**: it scores and audits but changes no reply. **An @, a
  question, or a capability request is always answered in full** — a hard condition in code, not a hint. Details in
  [62](docs/62-社交关系-按群隔离的社交距离.md).
- **Self-interest ([`dsh-selfworth`](plugins/dsh-selfworth/)).** Fixes "sell him and he'll count your money for
  you": four shapes of self-harming speech (accepting a low price, accepting an insult, accepting freeloading, and
  bookkeeping on the owner's behalf), mined from 3097 real bot utterances. The verdict requires **both sides** —
  someone is taking advantage of it (within a TTL) *and* the reply actually concedes. Either side alone misfires,
  because it also says "price", "freeload" and "silly fish" when it is pushing back. Default replaces the conceding
  line with a short bratty retort. Details in [63](docs/63-自身利益-不认账不自贬不替外人记账.md).
- **Outbound moderation ([`dsh-web`](plugins/dsh-web/)).** `/看网页` and `/搜` results go **straight into the group
  without passing the LLM**, guarded only by a keyword regex — a Wikipedia page that is entirely about one sensitive
  figure but contains none of the keywords slips through and gets the group banned. Everything leaving the plugin is
  now reviewed first: regex pre-filter → small-model JSON verdict (any of five booleans true forces a block) →
  **timeout / exception / no model means do not send** (fail-closed), with a 30-minute cache for definite verdicts
  and none for timeouts. Five exit paths are covered; the reply gate only fires when a reply contains a URL, so it
  costs nothing otherwise. Details in [64](docs/64-联网出口审核-先审后发防炸群.md).
- **Slang self-reference fix ([`dsh-glossary`](plugins/dsh-glossary/)).** The old definition of the "人机" (bot)
  entry read "when someone says this to you they are teasing you for being a bot" and every example used the second
  person, so the model read a member's third-person "they're all bots" as an attack on itself. The definition is now
  neutral, the example is third-person, and an un-mentioned hit gets an explicit hard hint.
- **Docs and indexes synced.** Three new documents (62/63/64); the plugin table, docs index and plugin count
  (45 → 47) are all aligned; every identifying string in the repo was re-swept against the policy the index page
  promises (real nicknames, group IDs, QQ numbers).

Verified in the container (py3.12): `dsh-social` 17 assertions, `dsh-selfworth` offline backtest, `dsh-glossary`
term backtest, `dsh-quote` 25 checks, and `dsh-style` / `dsh-decide` / `dsh-memory` all pass; `dsh-web` moderation
19 assertions all pass.

### Previous update · 2026-09-09 (Windows controller EXE downloadable from Releases)

The desktop controller (`desktop-controller/`) used to be source only — an EXE must be built on Windows while
the bot runs on Linux, so anyone who wanted it had to install Python and run the packaging script. Packaging now
happens on GitHub's own machines:

- **Push a tag, get an EXE.** New workflow [`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml):
  pushing a `controller-v*` tag (e.g. `controller-v1.0.0`) makes GitHub build a single-file EXE with PyInstaller
  on its own `windows-latest` runner and attach it to [Releases](../../releases) — one click to download, exactly
  like the Android console.
- **No tag needed to try it.** Run the workflow manually from the Actions tab to build without publishing; that
  run's artifacts hold the EXE.
- **Two files per build.** `dafeiyu-controller.exe` (single file, no install, double-click to run) and
  `dafeiyu-controller.exe.sha256` (checksum). Verify with
  `Get-FileHash .\dafeiyu-controller.exe -Algorithm SHA256` and compare it against the `.sha256` file.
- **Why the release asset uses an ASCII name.** The program inside is still named "大肥鱼机器人控制台", but the
  published file name is ASCII to avoid browser / antivirus trouble with non-ASCII file names.
- **The build script now takes `-PythonExe`.** `desktop-controller/build-windows.ps1` can be pointed at a specific
  interpreter (CI passes setup-python's `python`; locally it still defaults to Windows `py -3`), and it locates the
  output with a wildcard instead of a hard-coded non-ASCII path.

The security boundary is unchanged: the EXE contains **no** server address, account, password, private key, Token,
or bot configuration — you enter all of it in the UI, and the workflow never reads any secret.

Verified: the `controller-v1.0.0` tag triggered the first build — all eight Actions steps green — and Releases now
serves `dafeiyu-controller.exe` (16.1 MB, a PE32+ GUI executable) plus its `.sha256` file. I downloaded the artifact
and the computed SHA-256 matched the published value, then searched the binary for production IPs, deployment paths,
group IDs and Tokens: zero hits.

### Previous update · 2026-09-08 (integration: 45 plugins wired into breakable pipelines)

The repo is now organized around **45 plugins**. Every earlier batch fixed a single defect; this one treats
the whole set as **one pipeline** — making "human" not a pile of independent switches but a chain with priority.

- **De-AI is a breakable pipeline.** `dsh-aiflavour` (paints the reply's tone first) →
  `dsh-humanizer` (humanizing rewrite) → `dsh-typo` (an occasional wrong character) →
  `dsh-noise` (noise: a swapped character / truncation / repeated word). Four stages chew away the "AI neatness".
- **Intercept runs before inject.** Plugins are wired by priority: `armor` / `merge` / `decide` run first
  (priority=2000) to decide "should we join in, and how"; `effect` / `emotion` run after (priority=100) to
  shape the tone of a reply already deemed worth sending. Whether to speak is the precondition; *how* to say
  it is decoration.
- **They interlock.** `dsh-steal` steals stickers but must visually understand meaning, only keeps "repeated"
  images, and skips anything unsuitable to share (fail-closed); `dsh-noise`'s noise **never** touches a proper
  answer that was @-mentioned — anything abnormal passes through; `dsh-proactive`'s interest probe uses pure
  regex scoring at zero LLM cost and only joins in when rice / food / deep-sea whale / DeepSeek / being named
  is on the topic.
- **A batch of new capability plugins.** Fact guard (`dsh-factguard`), leak guard (`dsh-leakguard`),
  homophone nickname (`dsh-homophone`), join guard (`dsh-joinguard`), passive slang learning (`dsh-listen`),
  quote resolution (`dsh-quoteref`), scene detection (`dsh-scene`), self-protection (`dsh-selfguard`),
  paid quota (`dsh-pay`).
- **Compiled and shipped.** All 45 plugins compile and load with no failures, and the priority wiring above
  is live.

### Previous update · 2026-09-05 evening (human-likeness, batch 2)

Four new plugins plus one framework config change. This batch differs in kind from the earlier ones:
those fixed **outright defects** (off-topic replies, being talked into submission, misidentifying people,
crashes). This one fixes "nothing is broken, but you can tell it's an AI at a glance".

- **Understanding the group's slang (`dsh-glossary`).** 43 entries, injected only on a hit. The entries are
  *not* imported from off-the-shelf meme dictionaries — three external libraries totalling 549 terms scored
  only 9 genuine hits against 2478 real messages, and their top hit was `15` (matching "got camped 15 times"
  and someone's QQ ID). Mining our own corpus works instead, using the signal "this phrase was sent as an
  entire message, by at least two different people" — which immediately surfaced the table's most-hit term.
- **Typing delay now scales with length.** It used to be a flat random 1.2–2.8s regardless of length, so it
  was sometimes backwards: a one-character reply waited 2.8s while a twenty-character one went out in 1.2s.
  The framework already ships `interval_method: "log"`; we simply had not enabled it.
- **Occasional homophone typos (`dsh-typo`).** 6% per message, at most one character, plus a 35% chance of a
  follow-up self-correction. Uses a **hand-reviewed 60-pair homophone table** rather than generating with
  `pypinyin`: generated output is an open set, and that is not a bet worth taking in a real 94-person group.
- **Letting it get pulled onto a tangent (`dsh-drift`).** Always answering strictly on-topic is itself an AI
  tell. Two **structural** hard limits keep the previously fixed off-topic bug from returning: never drift
  when mentioned, never drift when the current message looks like a question.
- **Not talking over another AI (`dsh-decide`).** The reference implementation allows whitespace after the
  name; copied verbatim it produced two false positives here, because model names *are* this group's topic.
  Tightening it to "punctuation delimiters only, no short forms like `GPT`/`ds`" brought false positives to
  zero across 1899 messages.
- **Watching what the group does after it speaks (`dsh-effect`).** This was the biggest structural gap:
  every change until now was **open-loop** — inject samples, inject glossary, then hope. Now each reply opens
  a 180s observation window and the group's reaction is classified (appreciation / playful / neutral /
  confusion / factual correction / rejection / **ignored**), along with whether the reaction targets the
  **content or the persona**, and whether the reply **advanced or derailed** the conversation. Zero messages
  in the window means "ignored" for free, with no model call. **This version only measures; it changes no
  behaviour** — auto-tuning on an unvalidated signal is adjusting an engine with no instruments.

Verification: after review the glossary's injected block shrank from 196 to 135 characters with an unchanged
8.4% hit rate, proving the three removed entries were dead. Four pure-function test suites, a 1899-message
corpus backtest, and one real end-to-end settlement of `dsh-effect` all pass.

### Previous update · 2026-09-05 daytime (the console is now server-driven)

The Android console app moved from *14 hard-coded knobs* to **rendering whatever schema the server sends**.
This solves a concrete problem: once the plugin count grew from 16 to 22 and the tunable variables to 248,
shipping a new APK for every new switch stopped being viable.

- **104 knobs exposed at once**, covering the master switches and main parameters of 22 plugins
  (19 of those plugins are open-sourced in this repo).
- **Adding features no longer needs a reinstall.** As long as a knob uses a type the app already knows
  (`bool` `int` `float` `enum` `str` `csv`), adding one line to `console_spec.py` and restarting the backend
  makes it appear after a pull-to-refresh. The app **skips** types it does not recognize instead of crashing —
  that is what makes forward compatibility work. Only a genuinely new widget requires a new APK.
- **Plugin switches read and write `imagegen.env` directly** (all 22 plugins get their variables from that
  `env_file`) using line-level edits: comments and ordering preserved, original file permissions kept,
  atomic replace, MD5 checked before writing to prevent clobbering a concurrent change.
  Those 55 comment lines record *why* each value is what it is — they are worth more than the values.
- **Three hard constraints, all absorbed server-side:**
  ① Booleans must be written as `1`/`0` — the 22 plugins parse booleans four different ways, and 11 variables
  test `!= "0"`, so `false` would read as **on**;
  ② an `int`/`float` set to a non-number or left empty makes the plugin **throw at import time and fail to load
  entirely** (only `dsh-memory` falls back), so every numeric knob carries min/max and out-of-range values
  return 400 rather than being silently clamped;
  ③ for variables clamped by `max()/min()` in code, the slider minimum must equal that hard floor, or the phone
  would show `1` while `3` is actually in effect.
- **Env changes require recreating the container.** AstrBot's environment comes from docker compose's `env_file`,
  and `os.environ` inside the container only updates on **container recreation** — `docker restart` does not
  re-read `env_file` (learned the hard way). Such knobs are marked `hot=false` and the UI says so explicitly.
- **7 secret variables report presence only** (image / voice / video / search API keys and the voice ID).
  Their real values never leave the server and cannot be edited from the phone — the console is plaintext HTTP.
- **Self-update prompts, never installs silently.** A new lightweight endpoint `/api/console/version`
  (a single `stat`) lets the app notice a newer `versionCode` on the server and offer a browser download.
  Automatic installation over plaintext HTTP is not controllable, so it is deliberately not done.

Verified by **105** backend unit tests, **83** end-to-end tests, **391** pure-JVM tests, and **18** live checks after deploy.

### Earlier · 2026-09-04

Three new capabilities are live in a real group (no longer shadow mode):

- **It starts conversations when the room goes quiet.** After 15 minutes of silence it opens a thread itself — at most 3 times a day, 1 hour apart, and only during active hours (measured 10:00–02:59 for this group; 03:00–09:59 is nearly empty). It speaks through the full message pipeline, so sticker stripping, mention policy, and segmented sending all still apply. Any judgment failure or timeout means silence — fail-**closed**, because saying the wrong thing unprompted costs more than saying nothing.
- **It speaks with emotion.** Six emotions, exactly one at a time, and a single message triggers at most one. Structural evidence of *who is being addressed* is required: members insulting each other, self-deprecation, third-party narration, and whole-message quotes never move its emotion. Resets go through apology / two consecutive neutral messages / question answered / per-emotion TTL, not just expiry.
- **It understands quotes.** By QQ ID it now states who is speaking, whose line was quoted, whether that line was its own, and who was mentioned.

Also fixed a real crash that had been hiding for half a day: `dsh-decide` unpacked a 3-tuple as a 2-tuple, so once the bot had spoken recently it always threw — 12 crashes vs 9 successful judgments that day. Because the fallback was fail-open, everything looked fine while over half the replies never received the "who is speaking to whom" verdict. That was the direct cause of the bot mixing up subject and object.

Before rollout: **61 new unit tests** (36 emotion + 25 quote) and a **1618-message replay over real history**. The replay caught two genuine misjudgments: treating the character in "balance/quota" as an awkward filler (8 of 9 awkward hits were false), and treating undirected insults as aimed at the bot (25 of 38 hits had no second-person reference at all). Details in [46-主动开口与情绪系统](docs/46-主动开口与情绪系统.md).

