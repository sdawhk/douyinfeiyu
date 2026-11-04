# 项目工程记忆

## 唱歌能力

- 修改唱歌功能前先读 [docs/唱歌技能包机制与项目现状.md](docs/唱歌技能包机制与项目现状.md)，并以当前代码和运行配置复核文档中的状态。
- 技能包的 `sing_search` / `sing_cover` 是搜索现成歌曲、截取音源、可选用 RVC 转换流萤音色的链路；`mode=original` 发的是原唱片段，只有 `mode=ai` 才执行人声分离和音色转换。
- 本项目 `bridge/src/song-cover.mjs` 负责现成歌曲搜歌与截取，`bridge/src/singing.mjs` 的 Mureka 链路生成原创歌曲；两者通过 `bridge/src/rvc-singing.mjs` 复用技能包的 `cover.py`、RVC 推理代码和模型来换音色。命令“唱歌/翻唱 歌名”走现成歌曲，“原创唱歌 主题”走 Mureka。
- 唱歌结果由 QQ 桥接发语音。不要把音频生成成功当作 QQ 已发送成功；不要在 RVC 失败后悄悄发送未转换音频。
- `D:\deepseek\state\singing-rvc` 是本机运行数据，不纳入 Git；API Key、QQ/OneBot token 和账号信息也不要写入工程记忆。
