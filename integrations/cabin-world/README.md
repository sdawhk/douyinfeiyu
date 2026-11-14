# 小屋世界桥（大肥鱼接入版）

这里保存当前接入大肥鱼的小屋世界桥源码、配置示例及安装说明，供 Git 追踪和重新部署。游戏可执行文件、存档、`data/bridge.json`、活动流水和实际 `bridge.config.json` 留在本机，不入库。

桥代码基于 VADS 的 [Cabin World](https://github.com/BabyBus2022/cabin-world) v0.1 发布包修改。原项目代码采用 MIT，文档和游戏数据采用 CC BY 4.0；原许可与署名见本目录的 `LICENSE` 和 `LICENSE-NOTES.md`。这里没有打包游戏程序或美术。

## 本地运行

1. 从原项目取得小屋世界发布包并解压。
2. 将本目录 `bridge/` 中的源码文件复制到发布包的 `bridge/`，保留发布包的实际 `bridge.config.json` 和 `data/`。
3. 初次配置时可参考 `bridge/bridge.config.dafeiyu.example.json`。其中 `autonomy.enabled: true` 开启自主活动；实际配置文件不要提交。
4. 在发布包目录运行 `node bridge/selfcheck.mjs`，然后运行 `node bridge/bridge.mjs`。若游戏窗口已经打开，改用 `node bridge/bridge.mjs --no-launch`。

自主循环在居民就位后约 20 秒首次检查，之后每 15 分钟检查；北京时间 22:00–07:00 暂停。它会按饥渴、背包、未完成愿望和天气选择游戏支持的活动。自动购买单件不超过 8 元、每日合计不超过 12 元。主人操作优先，自主活动完成后只写本地活动流水，不主动发 QQ 消息。

大肥鱼 QQ 侧的安全 MCP 接入位于 `bridge/src/mcp-cabin-world-safe.js`，每次调用都会从发布包的 `data/bridge.json` 读取当前接口和轮换的 token。可通过 `CABIN_BRIDGE_JSON` 指向其他安装位置。
