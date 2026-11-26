# 大肥鱼共享记忆接入

上游：https://github.com/yinomo23-a11y/layered-memory ，固定版本 `3d07f84`，MIT 许可证保留在 `vendor/LICENSE`。

主聊天进程 `bridge/src/qq-bot.mjs` 托管一个 Python JSONL worker。`bridge/src/layered-memory.mjs` 负责生命周期、请求超时、旧数据迁移和真实消息票据。现有 snowluma MCP 中的 `qq_shared_memory` 调用主进程的 `127.0.0.1:3101/memory`；需同时通过本地控制台令牌和当前入站消息票据。

运行数据与代码分离：配置 `sharedMemory.enabled`、`sharedMemory.python`、`sharedMemory.dataDir`。本机数据默认在工程外层的 `state/layered-memory`，Python 环境在 `state/layered-memory-runtime`。依赖见 `vendor/requirements.txt`。不要将运行数据、票据或配置凭据提交到仓库。

## 记忆范围

- 使用机器人 QQ 和真实发送者 QQ 归属，不按昵称选择人物。
- 自述的低敏偏好等稳定短句可在同一人的群聊与私聊间召回。自动抽取保守地使用规则，问题、引用、转发、假设、保密内容和凭据不自动入库。
- 普通私聊事实、历史导入与保密内容保持原会话；明确保密的条目不转为公开摘要。
- 群规只在来源群生效。共享摘要的检索先执行范围过滤，再按关键词和上游强度衰减排序。
- 机器人公开经历只在实际发送成功后记录已识别的聊天主题，不把模型输出当作经历事实。
- 上游原文窗口、泛用召回、情景聚合和模型蒸馏不对 QQ 数据开放。上游 `schema.py` 增加 `qq_memory` 元数据持久化，`services/recall_policy.py` 拒绝泛用入口读取这些条目，`services/qq_policy.py` 实现显式准入。

## 分层与维护

复用上游 `MemoryManager` 文件锁、`MemoryItem` 数据模型、`atomic_io` 原子写和 `peek_strength` 遗忘曲线。自动事实写入短期池，满一天巩固到活跃池，180 天未活动转到冷池；明确记住直接进入活跃池。适配器按小时活动触发维护，召回本身不增强强度。默认召回最近/活跃池；冷池中的记忆仍支持纠错与忘记。每人最多 100 条有效事实，每天最多 400 条自动事实。

QQ 元数据必须跨池保留，因此本数据目录由本适配器维护；不要把上游原版 daily_consolidation 或蒸馏脚本另行指向此目录。上游独立测试始终使用临时数据。

## 使用

- `我的记忆`：查询当前本人可用记忆与编号。
- `记住，我喜欢乌龙茶`：明确记录。
- `更正记忆：我喜欢乌龙茶改为我喜欢红茶`：更正完全匹配的旧事实。
- `忘记，我喜欢红茶`：同步撤回旧事实的各范围副本。
- 群聊需要 @ 机器人或使用 `/我的记忆` 等命令；主人可直接发命令。
- 自然语言的复杂纠错可由 `qq_shared_memory` 查询编号后处理，人物与会话固定在当前入站消息，模型不能另选 QQ。

纠错/忘记先持久化过滤标记，再更新池文件；旧导入和排队观察不能重建已撤回的原文。清空主进程中的 DSH 会话及短期摘要，使后续轮次使用新会话；在途回复核对修订世代，旧世代不发送。日志不写记忆正文。

## 迁移与回滚

先备份旧状态，用 `LayeredMemory.migrate(..., {dryRun:true})` 预览，再执行迁移。迁移记录固定批次，重复运行不重复导入。只导入有 QQ 归属的旧条目；仅昵称的旧印象不猜归属，权限配置不进入事实池。导入保持原范围。

启用后设置 `sharedMemory.legacyMigrated: true`，旧长期事实不再重复注入，原人格、情绪、关系语气与权限机制保留。停用时只改 `enabled:false`，保留 `legacyMigrated:true`、数据目录和过滤标记，避免旧库中的已忘记事实重新注入。恢复时重新启用即可。不要用旧备份覆盖新库或删除过滤标记。

## 验证

```powershell
node --test bridge/tests/layered-memory.test.mjs bridge/tests/persona-runtime.test.mjs
# 在 vendor 目录运行上游回归；环境必须放在 vendor 目录外。
python tests/run_all.py
```

专项测试通过真实 Python worker 验证跨场景、同名人物、隐私范围、群规则、纠错/忘记、冷迁、迁移与票据，使用合成数据，不发送 QQ 消息。
