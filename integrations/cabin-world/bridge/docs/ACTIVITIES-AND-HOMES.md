# 活动与私人房屋补丁（2026-11-13）

本补丁适用于 1.1 参考桥。AI、人设与长期记忆仍由机器人宿主提供。在游戏中新增住户只建立身份、身体和房屋；宿主必须连接真实模型，并在工具参数中填写该住户的 `actor`。参考桥本身不自动调用模型。

## 主活动与副活动

新增 `cabin_process`，通过现有 `POST /v1/tool` 或 MCP 调用：

```json
{"name":"cabin_process","arguments":{"actor":"my_bot","action":"start","kind":"body","tool":"cabin_use","arguments":{"object":"beanbag","use":"sink_in","durationSeconds":0}}}
```

`action` 可为 `list/start/promote/stop/finish`。`start` 返回活动 `process.id`；后续操作使用这个 `id`。`kind` 为 `body/chat/think/read`，`role` 为 `primary/secondary`。存在活动时只保留一个主活动，可随时 `promote` 选择另一个。已结束的活动会保留近期回执，但不再占主活动身份。

身体活动只能串行执行，其余身体任务等待；聊天、思考、查询可以并行。将排队身体活动提升为主活动，会先请求中断当前身体活动；提交阶段不能撤回时明确拒绝切换。认知活动是注意力登记，内容需要宿主的真实模型执行，不能把登记成功当成已经思考或聊天。

`cabin_use.durationSeconds` 在支持持续时长的休闲活动中接受 `0–3600`：`0` 持续保持，直到主动 `stop/finish` 或连接断开。不改变喂食、付款等一次性操作。桥续期座位与动作效果，每分钟发出 `process_review` 事件供宿主重新决定。`stop` 取消，不记作完成；`finish` 只对正在进行的持续活动正常收尾，须继续查任务或活动回执。掉线不会伪报完成，重连后由 AI 重新决定是否继续。

## 房屋与删除

- `cabin_rename_home({actor,name})`：自建住户私人房屋独立改名，1–32 字；不改变住户名。
- `cabin_remove_resident({actor,confirm})`：`confirm` 必须准确等于住户编号。移除该自建住户、私人房间和世界入口；内置角色不可删除。提交中的活动或在家的访客会阻止删除。
- 设置 → 住户 → 新增住户 / 分配房间，也有房屋改名和删除确认按钮。
- 删除保留恢复资料和原始地图模板。登记表中的 `deleted` 标记阻止旧宿主重连后自动注册复活；创建新住户请使用新编号。恢复是手动维护操作，目前没有一键恢复入口。
- 新增房间地图存放在当前存档旁的 `maps` 子目录，可由 `--maps-dir` 显式指定。旧版地图如在全局 `user://maps` 中，便携存档需把地图目录复制到当前存档的 `maps`；原文件可保留。

游戏协议 `resident.do` 新增 `rename_home`（`actor/name`）与 `remove`（`actor`），回复仍为 `resident.result`。`list` 额外返回 `deleted` 编号列表；住户描述额外返回 `homeName`。成功变更广播 `resident.changed`；删除时 `removed:true`。宿主收到删除广播须卸载对应住户，不能沿用旧身体或恢复存档发起活动。
