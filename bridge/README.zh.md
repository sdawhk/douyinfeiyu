# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) ｜ **中文**（本文） ｜ **总览**: [README.md](README.md)

> 📘 详细内外核说明书见 **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**（架构、数据流、配置全解、调试与改进指南）。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 项目展示

> 介绍视频与立绘（原 `assets/`）未包含在公开仓库中：12 MB 二进制对 clone 不友好，且不影响运行。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：复用官方 `@deepseek-ai/dsh-host-apiproxy` 的 `AbstractApiClient` 与 zod schema，桥接进程实现 Node 传输层（fetch unary + WebSocket 下行事件流）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：`snowluma_status`（默认只读探活）；`start_snowluma` / `stop_snowluma` 需显式开启 `snowluma.allowProcessControl: true` 且仅在 `closed-agent` 模式可用
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`；搜索优先 Bing RSS，再试 Bing 网页与 DuckDuckGo，网页抓取带 SSRF 防护。明确询问“是什么梗”“梗的出处”等会先联网检索再回答。
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset（`~/.dsh/.agent-presets/qq-chat/agent.cordis.yml`），`reserved2` 使用 `qq-chat-v2`（`~/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml`）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ router-standard 完整工具，可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录（供 agent 自动启动/停止） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |
| `speechRecognition.modelDir` | 本地 SenseVoice 模型目录，默认 `D:/deepseek/state/voice-asr` |

首次启用 QQ 语音识别时运行 `node --use-env-proxy scripts/install-local-stt.mjs`，下载并校验约 240 MB 的离线模型。机器人通过 OneBot 获取 WAV，在本机识别语音后按文字消息处理；识别失败会写入桥接日志。模型文件保存在运行目录，不入库。

### 固定音色克隆

语音回复可接本机 [GPT-SoVITS api_v2](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)。先按上游说明安装并启动服务，监听 `127.0.0.1:9882`，再在 `http://127.0.0.1:18902/settings` 的「克隆音色」中填写服务地址、参考音频的 Windows 绝对路径及对应的逐字原文，保存后点「测试克隆音色」。试听成功后再启用；默认仅在用户明确要求语音时使用。参考音频需事先放在本机，并确保 GPT-SoVITS 进程可以读取。合成失败时机器人发送文字。请仅使用有权使用的声音。

### 原创歌曲与流萤 RVC

现成歌曲点唱只允许主人使用：“唱歌 歌名”或“翻唱 歌名”会搜索歌曲、默认从约 30 秒处截取 30 秒、转换成流萤音色并发送 QQ 语音；“唱一首雨夜 DJ 版的歌”等自然说法也会进入这条链路，指定“唱10秒钟雨夜”则截取 10 秒。“原唱 歌名”只发原唱片段，“搜歌 歌名”查看候选。搜索会排除标明伴奏、KTV、短剧等结果；歌名不完全匹配时会先列候选，不自动发错歌。确认候选可用“翻唱 雨夜 #2”等序号命令。流萤转换前会检查分离后的人声音量，过低就停止发送。先运行 `scripts/setup-singing-rvc.ps1` 准备模型，再运行 `scripts/setup-song-cover.ps1` 安装 yt-dlp 等依赖。运行设置中的“现成歌曲点唱”可独立开关，不需要 Mureka Key。B 站搜索受限时会试 YouTube；转换失败不会把原唱冒充翻唱发出。

已成功制作的歌曲语音会持久保存在 `bridge/state/song-cache/`。相同歌名、模式、候选、片段位置和音色再次请求时直接复用本地成品，不再重新搜索、下载或做音色转换；原创唱歌也会按主题和音色复用已保存结果。最近一首仍按主人保留一小时，跨群说“这个群也来一首雨爱司凤版”或“唱出来”可直接重发。说“再来一段”“再来一段60秒的”“接着唱”会先查本地是否已有该段，没有才继续制作下一段。

#### 本地歌单试听

群聊和私聊可用 `歌单 [页码]` 查看已核验的本地 30 秒音频，再用 `试听 <歌单显示的12位ID>` 免费试听。机器人全局共用每日 30 次、滚动 10 分钟 3 次的额度；同一会话同时只处理第一条有效试听。试听文件会核对时长、哈希和完整解码，发送超时会暂停同一会话并交由主人私聊 `试听待核对` 处理。主人可私聊 `好友列表 [页码]`、`红包账本`、`余额` 查询。

这些命令由当前运行的 `src/bridge.js` 在模型唤醒前直接处理。试听只有在 OneBot HTTP 对 `send_group_msg` / `send_private_msg` 返回成功状态后才计入额度；发送被拒时会释放预留次数。

当前 OneBot/NapCat 适配器没有经验证的 QQ 红包领取回执或 QQ 钱包查询接口，因此不能自动领取红包或查询真实钱包余额。主人核对实际收款后手动记入的用户额度可用于 `新歌试听 <歌名>`（1 元，30 秒流萤翻唱）和 `唱完整首 <歌名>`（3 元，按同一完整音源分段翻唱）；付费订单会先预留额度，仅在 OneBot 确认发送后结算，结果不确定时由主人核对。`余额` 不会伪称为 QQ 钱包余额。歌单解码扫描还要求可用的 ffmpeg；若本机 ffmpeg 无法启动，可通过环境变量 `DSH_FFMPEG` 指向可用的 ffmpeg 可执行文件后重启桥接。新加入群聊默认不主动插话；主人可在群内发送 `主动插话 开启` 或 `主动插话 关闭`，明确 @ 与命令仍正常响应。

原创歌曲仍用 Mureka：在运行设置填写音乐 API Key 并开启后，由主人发送“原创唱歌 主题”或“/原创唱歌 主题”。开启“原创歌声转换为流萤音色”后，机器人会在人声分离后用 `liuying.pth` 转换歌声并混回伴奏。Windows CPU 环境安装脚本为 `scripts/setup-singing-rvc.ps1`，默认将模型和虚拟环境放在 `D:\deepseek\state\singing-rvc`，不纳入 Git；安装需要网络和约 3 GB 空间。没有可用的 RVC 环境时会明确报错，不发送未转换的原唱语音。CPU 转换会比较慢。

普通语音回复也可独立开启「普通语音转流萤音色」。它先使用当前选中的 GPT-SoVITS、Edge、讯飞或 Azure 服务合成，再直接转换为流萤音色；试听按钮只在本机设置页生成样例，不发送 QQ 消息。此开关与原创歌曲的 RVC 开关和音高分别保存。

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（另一台设备 / 新环境）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖，可手动在 DSH 设置页的 `qq-mode` 卡片切换。

详细步骤见 **[docs/DSH_SETUP.md](docs/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 5 步，DSH 和桥接都已就绪，缺的只是 SnowLuma 本体：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

3. **首次引导（WebUI）**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）

4. **填写桥接配置**（`config.json`）
   ```json
   "snowluma": {
     "wsUrl": "ws://127.0.0.1:3001",
     "httpUrl": "http://127.0.0.1:3000",
     "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
   }
   ```
   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。
   建议顺手把 `allow.private` / `allow.groups` 白名单填上。

5. **启动桥接**
   ```bash
   cd qq-bridge
   npm start          # 或双击 start.bat
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 不需要动桥接**：桥接会自动检测 DSH 恢复（每 5 秒探活），DSH 重启期间收到的 QQ 消息会**入队缓存**（最多 50 条/会话），恢复后自动补投，不会丢
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `~/.dsh/.agent-presets/qq-chat*/` 或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```
```

## 自测（不需要 SnowLuma / QQ）

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  docs/
    PROJECT_GUIDE.md    # 公开版项目说明书
  dsh/agent-presets/    # qq-chat / qq-chat-v2 的 DSH agent preset 模板
  plugins/qq-mode-console  # DSH 设置页 qq-mode 卡片插件
  src/
    bridge.js           # 主程序
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
```

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 4000 字自动分段
- QQ 图片与视频目前仍以占位文本交给 agent；语音消息会先在本机转成文字
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
