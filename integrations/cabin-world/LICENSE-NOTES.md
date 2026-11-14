# 许可说明 / Licence notes

作者：**VADS**。本项目开源：代码用 **MIT**，美术、数据和文档用 **CC BY 4.0**。两种许可都允许任何人免费使用、修改、分享，**包括商业用途**，只要注明作者 VADS。正式条款见根目录的 [`LICENSE`](LICENSE)。

*Author: **VADS**. Open source: code under **MIT**, art, data and docs under **CC BY 4.0**. Both allow anyone to use, modify and share, including commercially, with credit to VADS. Binding terms in [`LICENSE`](LICENSE).*

| 部分 | 位置 | 许可 |
|---|---|---|
| 游戏代码（GDScript、场景） | `game/**/*.gd`、`*.tscn`、`project.godot` | [MIT](LICENSE) |
| 桥、示例、工具代码 | `bridge/`、`examples/`、`tools/`、`*.cmd` | MIT |
| 美术素材（像素画、角色、家具、图标、截图） | `game/assets/**/*.png`、`*.ico`、`docs/images/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)（Naiwa 店员的图除外，见下） |
| 游戏数据（房间、商品、文案） | `game/assets/**/*.json`、`bridge/catalog.json`、`bridge/openai-tools.json` | CC BY 4.0 |
| 文档 | `README.md`、`docs/`、本文件 | CC BY 4.0 |
| Godot 引擎（游戏 EXE 内含） | `third-party/godot/` | MIT，© Juan Linietsky、Ariel Manzur 与 Godot 贡献者；第三方组件见 `third-party/godot/COPYRIGHT.txt` |

## 要求只有一条：署名 / The one condition: credit

- 用代码：保留 `LICENSE` 里的版权声明（“Copyright (c) 2026 VADS”）。
- 用美术、数据、文档：注明“Cabin World by VADS”，附上许可链接，说明是否改动过。

## 例外：Naiwa 店员的图 / Exception: the Naiwa sprites

小卖部收银员、电玩城和餐厅的店员叫 Naiwa（`game/assets/npcs.json` 里的 `"skin": "naiwa"`）。它的像素图（`game/assets/npcs/naiwa-*.png`、`shop-cashier-*.png`）**不在上面的许可范围内**：图是 VADS 自己（借助 GPT）画的，但造型参考了他人拥有的角色，VADS 不能替别人授权这个造型。这些图只能当作非商业同人使用，版权方要求时需要撤下，**任何商业用途之前都要先换掉**。名字 Naiwa 和店员的代码、数据照常适用 MIT / CC BY 4.0。

要让整个项目都能放心商用，把这些图换成原创造型即可（`npcs.json` 已有另一套 `mochi` 造型，游戏设置里也能切换）。

## 其他

- 字体：游戏使用系统字体（微软雅黑 / 黑体），没有打包字体文件。
- 不在本仓库里：原作者的另一位住户（芊夏）及其家和全部专属美术、地图编辑器、开发用的身体实验室、记忆层、聊天与模型接入代码。
