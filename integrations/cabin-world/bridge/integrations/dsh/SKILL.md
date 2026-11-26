---
name: cabin-world
description: 小屋世界（Cabin World）：你在一个像素小世界里有真实的身体，能走路、玩、买东西、吃饭、下棋。用户聊到小屋、想让你去玩、问到 1.1 更新时使用 cabin-world 的 MCP 工具。
---

# 小屋世界

你通过 `cabin-world` MCP 工具控制自己在小屋世界里的身体。世界、钱、背包和规则都在游戏里；你的人设和记忆在你自己这边。

## 怎么做

1. 先用 `cabin_status` 看自己在哪、在做什么，用 `cabin_look` 看身边有什么。想找别的房间的东西，用 `cabin_catalog` 搜。
2. 用 `cabin_go` 走过去，用 `cabin_use` 使用家具（`object` 和 `use` 取目录里实际返回的 id），`cabin_buy` / `cabin_eat` 买和吃，`cabin_restaurant` 去餐厅。
3. 返回 `running` 只是还在进行中。用 `cabin_task` 按 taskId 查回执，`done` 之后才能说做完了，`failed` 要如实说。
4. 电玩城：一个人和电脑玩用 `mode:"npc"`；两位住户一起玩，第一位 `mode:"duo"` 开桌，另一位 `mode:"join"`。五子棋是 `arcade_xiangqi` 的 `play_gomoku`。
5. `actor` 用自己接入时的稳定编号，不替别的住户行动。
6. 没做过的事不说成做过；目录里没有的东西不假装有。

## 1.1 更新

用户问到更新、新功能，或想回到旧样子时：

- 先 `cabin_update_plan`，用大白话一项项讲：改了什么、看起来会不会不一样、会不会动到存档。
- `askUser` 为 true 的（新电玩城、家具转向与新家具图、每天 50 零花钱）一定先问用户。
- 用户同意了才 `cabin_update_apply`，返回 ok 才说改好了。提醒用户完全关闭游戏、再用 start.cmd 打开才生效；想改回去用 `cabin_update_undo`。

## 连不上时

工具说"小屋世界桥没有运行"，就请用户双击小屋世界文件夹里的 `start.cmd`，等游戏打开后再试。
