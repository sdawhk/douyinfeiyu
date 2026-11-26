> 安装/升级 1.1 时先读包根目录 INSTALL-AI.md，逐项介绍可选更新并记录用户选择；不默认全部启用。游戏设置中的模块面板已移除，使用安装 AI 或 update.cmd 调整。

# 在 DeepSeek Harness (DSH) 里玩小屋世界

DSH 通过 **MCP** 使用外部工具。小屋世界自带一个零依赖的 MCP 服务器（`bridge/mcp-server.mjs`）。它把和 HTTP 桥一样的 19 个工具交给 DSH 里的模型：走路、使用家具、买东西、餐厅、电玩城、住户，以及 1.1 模块更新。

## 一键安装

1. 先装好 DeepSeek Harness，并至少打开过一次。
2. 双击 `install-dsh.cmd`（就在这个文件夹里）。
   - 它往 DSH 的 `cordis.patch.yml` 里加一段带标记的 `mcp-cabin-world` 条目，原文件备份为 `cordis.patch.yml.bak-cabin-world`。
   - 它还会把 `cabin-world` 技能放进 DSH 的 `skills` 文件夹，模型就知道怎么用这些工具。
   - 如果 `cordis.patch.yml` 里已经有别人写的同名条目，它会停下来，什么都不改。
3. 双击小屋世界的 `start.cmd`，等游戏打开、桥显示"准备好了"。
4. 重启 DSH。之后就可以在对话里让模型去小屋世界里玩了。

想卸载：在命令行运行 `node install-dsh.mjs --uninstall`，然后重启 DSH。

## 手动安装

不想用脚本，就把 `cordis.patch.yml.example` 里的这段内容粘贴进 `%USERPROFILE%\.dsh\cordis.patch.yml` 末尾，把三个路径改成你自己的：

- `node.exe` 的路径；
- `bridge\mcp-server.mjs` 的路径；
- 小屋世界的 `data` 文件夹。

DSH 设置了 `DSH_HOME` 时，配置文件在那个文件夹里。

## 其他 MCP 客户端

Claude Desktop、Cursor 等也能用同一个服务器：命令是 `node`，参数是 `<小屋世界>\bridge\mcp-server.mjs --data <小屋世界>\data`。

## 常见问题

- **工具说"小屋世界桥没有运行"**：先用 `start.cmd` 打开小屋世界。MCP 服务器只是转发，桥关着时什么都做不了。
- **工具列表里没有小屋世界**：确认改的是 DSH 正在用的 `cordis.patch.yml`，然后完全重启 DSH。
