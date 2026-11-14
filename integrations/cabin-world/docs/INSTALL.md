# 安装与接入说明

## 1. 准备

| 需要 | 说明 |
|---|---|
| Windows 10/11 x64 | 游戏是 Windows 原生程序 |
| Node.js 18+ | 运行“小屋世界桥”，<https://nodejs.org> 选 LTS。也可以把便携版 `node.exe` 放到 `runtime\node.exe`，启动脚本会优先用它 |
| 你的机器人软件 | AstrBot、QQAgent 或任何能调用工具 / 发 HTTP 请求的程序 |

解压到一个普通的可写文件夹，例如 `D:\CabinWorld`。**不要**放在 `C:\Program Files`（没有写入权限，存档会失败），路径里有中文没关系。

## 2. 启动

双击 `start.cmd`。它做的事：

1. 检查 Node.js；
2. 启动 `bridge\bridge.mjs`（桥）：在 `127.0.0.1` 上开一个只给游戏用的端口，把端口和一次性 token 写进 `data\world\game-link.json`；再开一个给机器人用的 HTTP 接口，地址和 token 写进 `data\bridge.json`；
3. 打开 `CabinWorld.exe`，游戏读到 `game-link.json` 后自己连上来。

窗口里出现“准备好了”即可。**关掉游戏窗口不会关掉桥**，再双击 `CabinWorld.exe` 会自动连回；关掉桥的黑色窗口（或按 Ctrl+C）不会强制关闭游戏。

## 3. 自检

双击 `selfcheck.cmd`（等于 `node bridge\selfcheck.mjs --live`）。它检查：Node 版本、游戏文件、游戏和桥是否用同一个数据目录、端口，然后用**临时空存档**无窗口地真实运行一遍。全部 ✔ 就说明安装没问题。加 `--full` 还会测试汤屋和吊灯；加 `--show` 可以看着它跑。

## 4. 接入你的机器人

### 4.1 通用方式（任何软件）

1. 读取 `data\bridge.json` 里的 `url` 和 `token`（桥每次启动都会换新 token，所以每次调用前读一次，或者失败 401 时重新读）。
2. 把 `bridge\openai-tools.json` 的 `tools` 交给模型（OpenAI function calling 格式）。
3. 模型调用工具时：`POST {url}/v1/tool`，头 `Authorization: Bearer {token}`，正文 `{"name": 工具名, "arguments": 参数}`，把返回的 JSON 原样交还给模型。
4. 把 `docs\AI-MANUAL.md` 加进角色的系统提示词或知识库。

动作一般在几秒到半分钟内做完，桥默认最多等 45 秒（`bridge.config.json` 的 `waitMs`）。超过时返回 `{"status":"running","taskId":...}`，提醒模型“还没做完”，之后可以 `GET /v1/tasks/{taskId}` 查询。

### 4.2 AstrBot

把 `examples\astrbot\` 整个文件夹复制到 AstrBot 的插件目录（通常是 `data\plugins\astrbot_plugin_cabinworld`），在插件配置里填 `bridge_json` 为本机 `data\bridge.json` 的完整路径，重载插件。它把 7 个工具注册成 AstrBot 的 LLM 工具。详见该文件夹的 README。

### 4.3 Python / 其他语言

`examples\python\cabin_client.py` 只用标准库，可以直接 `import`，也可以 `python cabin_client.py status` 在命令行试。其他语言照 `docs\HTTP-API.md` 发 HTTP 请求即可。

### 4.4 不想用桥？

可以让你的软件直接当游戏的宿主，实现 `docs\PROTOCOL.md` 里的本地 TCP 协议。`bridge\cabin-host.mjs` 是一个约 120 行的参考实现。

## 5. 配置 `bridge\bridge.config.json`

| 字段 | 默认 | 说明 |
|---|---|---|
| `resident` | `xiaojingyu` | 游戏里的角色 key（`game/assets/residents.json`），公开版只有这一位 |
| `displayName` | `小鲸鱼` | 桥日志和游戏卡片上用的名字（游戏内的名字见下文“改名字”） |
| `hostName` | `我的机器人` | 显示在游戏天气牌提示里的宿主名字 |
| `dataDir` | `../data` | 数据目录，**必须**与游戏旁 `cabinworld.ini` 的 `data=` 指向同一个文件夹 |
| `gameExe` | `../CabinWorld.exe` | 游戏程序位置 |
| `launchGame` | `true` | 桥启动后是否自动打开游戏 |
| `http.port` | `18790` | 给机器人用的端口；`0` 表示自动选一个空闲端口（实际地址看 `data\bridge.json`） |
| `weather.mode` | `virtual` | `virtual`：桥自带的虚拟天气；`push`：由你的机器人用 `POST /v1/weather` 推送真实天气 |
| `waitMs` | `45000` | 一个工具调用最多等多久再返回“进行中” |
| `autonomy.enabled` | `false` | `true` 时居民会在游戏连接且空闲时自主活动；修改后重启桥生效 |
| `autonomy.intervalMs` | `900000` | 自主活动间隔（可设 10–20 分钟）；首个动作通常在就位后约 20 秒 |

自主活动优先处理饥渴（先用背包，再按每日消费上限购买低价商品），随后尝试未完成的钓鱼/读书愿望或天气适合的家具玩法。每天 22:00–07:00 暂停；主人发来操作时会尽量取消尚未提交的自主动作。自主行为只写入本地 `cabin-log.jsonl`，不会发送 QQ 消息。`selfcheck.mjs --live` 会强制关闭自主活动，避免打扰临时存档验收。

相对路径都相对于配置文件所在的 `bridge\` 文件夹。

## 6. 数据放在哪里

| 位置 | 内容 | 能分享吗 |
|---|---|---|
| `data\saves\` | 游戏存档：位置、背包、钱、感受、使用记录 | 不要。升级时保留它 |
| `data\world\game-link.json` | 本次运行的端口和 token | 不要，每次启动会重写 |
| `data\bridge.json` | 给机器人用的接口地址和 token | 不要 |

升级：解压新版本覆盖程序文件，保留 `data\` 文件夹即可。

## 常见问题

**双击 start.cmd 提示找不到 Node.js**：安装 Node.js 18+ 后重开窗口；或把 `node.exe` 放到 `runtime\node.exe`。

**“端口 18790 已被占用”**：桥可能已经开着（看任务栏有没有另一个黑色窗口）；否则在 `bridge.config.json` 把 `http.port` 改成别的数字或 `0`。

**“另一个宿主正在使用这份数据目录”**：已经有一个桥（或其他宿主程序）在用这个 `data`。先关掉它。上次是崩溃退出的话，桥会自动清理残留文件，不需要手动删。

**游戏右上角一直“离线”**：确认是用 `start.cmd` 启动的，或者手动打开游戏时 `cabinworld.ini` 的 `data=` 和桥的 `dataDir` 一致（运行 `selfcheck.cmd` 会检查）。

**机器人说“做好了”，游戏里却没动**：让模型以工具返回为准；`status: running` 表示还没做完。说明书 `docs\AI-MANUAL.md` 里已经写了这条规则，请确认它在提示词里。

**改角色名字 / 外观**：卡片名字来自 `game\assets\residents.json` 的 `name`，外观在 `game\assets\actors\`。改完用 `tools\build-windows.cmd` 重新导出。

**提供真实天气**：把 `weather.mode` 改成 `push`，然后由你的机器人定时 `POST /v1/weather`，格式见 `docs\HTTP-API.md`。不提供时用虚拟天气，不会联网。

**多开（两个机器人各一个世界）**：复制整个文件夹，第二份把 `http.port` 改成别的数字。两个世界的存档互相独立。

**想让两个机器人住在同一个世界**：公开版只带一位住户。增加住户需要在 `game\assets\residents.json` 添加角色和美术，并给每个角色各开一个 `Resident`（见 `bridge\lib\resident.mjs`），属于进阶改造。

## 12. 改名字（不用重新导出游戏）

游戏里的名字读的是 `<data>/residents.override.json`，只覆盖显示用的字段，不动美术和作息：

```json
{ "residents": { "xiaojingyu": { "name": "阿雨", "peer_name": "主人" } } }
```

- 改完**重启游戏**就行；`设置.bat` 做的就是这件事，平时不用手改。
- 卡片上的「XX的小屋」会跟着名字走。
- 想改外观（`art`）也可以在这里指到另一套美术 key，但美术资源必须已经在游戏里。
- 老办法（改 `assets/residents.json` 再重新导出）仍然有效，只是没必要了。

## 13. 和鱼窝（fishchat）联动

桥会把她的每个动作写一行到 `data\world\cabin-log.jsonl`：

```json
{"ts":1794568897294,"fish":"xiaojingyu","name":"阿雨","kind":"use","label":"荡秋千","text":"秋千升起时风拂过脸…"}
```

鱼窝那边在 `config.json` 里加一段就能读：

```json
"cabin": { "log": "D:\\CabinWorld2\\data\\world\\cabin-log.jsonl", "fish": { "fish": "xiaojingyu", "fish2": "xiaozhuai" } }
```

`fish` 是鱼窝里的鱼 id → 小屋里的角色 key 的对应表。改完重启一次 `her-sidecar.mjs`。
不想联动就把 `bridge\bridge.config.json` 里的 `"chatLink": { "enabled": false }`。
