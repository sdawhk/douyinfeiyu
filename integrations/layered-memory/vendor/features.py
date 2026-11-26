# -*- coding: utf-8 -*-
"""能力开关中心（2026-11-07 新增）。

所有新增能力默认 **关**，等于今天的行为。
开一个测一个，出问题关掉就回滚，不用改代码。

用法：
    from features import on
    if on("candidate_pool"):
        # 新逻辑
    else:
        # 老逻辑（等价于今天）

设计原则（跟 memory-brain / dsh-chain 一致）：
  · 人格/核心文件只读，所有增强都是「追加」
  · 每个模块一个开关，默认关
  · 显式打开才会工作

⚠️ 不要在代码里直接写 ``FEATURES["x"] = True``——
   要用 ``enable("x")`` / ``disable("x")``，这样能留痕。
"""

# __UTF8_STDOUT_GUARD__ (2026-11-08)
# 中文 Windows 终端默认 GBK，print emoji（✅⚠️）会 UnicodeEncodeError 直接崩。
# 全项目其它模块都有这段，features.py 之前没有 —— 因为以前它不打印 emoji。
# 2026-11-08 加了「摆设开关检查」会打印 ⚠️/✅，所以必须补上。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 2026-11-07 注意：这个 dict 是「唯一真源」。
# 加新能力时在这里加一行，别在别处另开开关。

# ── 摆设开关检查用的生产文件清单（2026-11-08）───────────────
# ⚠️ 千万别用 os.listdir('.') 全扫 —— 仓库根目录常年堆着几十个一次性脚本
#    （_rev_*.py / _v2.py / verify*.py），它们会把「没人读」的开关算成「有人读」。
#    实测踩过：EPISODE_MAX_PER_DAY 因此被误判成有两个读者。
# ═══════════════════════════════════════════════════════════════════════
# ⚠️ 未实现开关（2026-11-09 审计）
#
# 下面这些开关**只存在于配置里，没有任何代码判断它们**。
# 也就是说：把它们改成 True **不会有任何效果**。
#
#   episodic_segment   情境段（按 90 分钟切话题段）
#   two_tier_store     两档存储（重要留原话、闲聊存摘要）
#   fact_card          事实卡（1500 字一次注入）
#   emotion_half_life  情绪半衰期
#   event_stream       事件流（只追加 + 墓碑）
#   topic_tree         主题树 + 槽位
#   schedule           课表
#
# 为什么保留而不是删：
#   它们在《记忆系统-主设计》的「第三层：灰度替换」和「第四层：结构性改造」
#   里都有明确设计，属于「将来要做」而非「做错了」。删掉会丢掉设计意图。
#
# 为什么必须标出来：
#   审计发现这 7 个开关从没被判断过。如果不标，下次有人打开它们
#   会发现「开关不生效」，然后花时间 debug 一个不存在的问题。
#
# 检查工具：_vh/chk_dead_flags.py
#   · 会验证「清单里的开关确实没被判断」（防误标）
#   · 也会提示「某个开关现在被判断了，可以从清单里去掉」
# ═══════════════════════════════════════════════════════════════════════
DEAD_FLAGS = frozenset({
    "episodic_segment",
    "two_tier_store",
    "fact_card",
    "emotion_half_life",
    "event_stream",
    "topic_tree",
    "schedule",
})

PROD_FILES = [
    "memory_cli.py", "daily_consolidation.py", "memory_manager.py",
    "recall_engine.py", "decay_logic.py", "schema.py", "session_init.py",
    "associate_engine.py", "async_summarizer.py", "policy.py", "mcp_server.py",
    "memory_health.py", "nightly_patrol.py", "episode.py", "candidate_pool.py",
    "handover.py", "window_ledger.py", "entity_graph.py",
    "query_route.py", "ollama_embedding.py",
]
FEATURES = {
    "lexical_edges": False,  # only enabled after equal-budget corpus evaluation

    # ── 基础能力 ──────────────────────────────────────────
    # 窗口账本：每轮原话/发言/块顺序
    # 2026-11-08 开：只写不读（不接召回），先把「每轮留底」跑起来
    "window_ledger": True,
    # 候选池：判不准的先进缓冲，不直接进主库（海马体）
    # 2026-11-08 打开（T07）：先只写不读，攒 1-2 周数据再决定怎么裁决。
    #   注意：此开关只管「写不写候选池」，**不参与召回**（candidate_pool.py 只 import L1/L2）。
    "candidate_pool": True,
    # 情景档：多轮聚合成「一件事」
    # 2026-11-08 打开（评审 派 T-接线）：
    #   写入侧早就好了（11 条档已落盘），读取侧 4 个函数也有了，
    #   但 memory_cli.recall 里一直没判断这个开关 —— 于是档只能当普通记忆
    #   被召回，走通用格式、**没有任何防污染标注**（模型会把它当成原话）。
    #   现在两处都接上了：
    #     · memory_cli._apply_episode_recall —— 档走专用格式 + 双向去重
    #     · 关掉 → 完全退回接线前行为（档当普通记忆，或干脆不出现）
    #   回滚方式：把这里改回 False 即可，不用改任何代码。
    "episode": True,
    # 情境段：按 90 分钟切话题段（索引，不进注入）
    "episodic_segment": False,

    # ── 写入治理 ──────────────────────────────────────────
    # 三档门控 pass/mark/block（依赖 candidate_pool）
    "gate_triage": False,
    # 两档存储：重要对话留原话，普通闲聊存摘要
    "two_tier_store": False,

    # ── 检索增强 ──────────────────────────────────────────
    # 实体图谱：共享实体的记忆互相加权（2026-11-08 T10，默认开）
    "entity_graph": True,
    # RRF 融合 / 问法路由 / 联想去重：
    #   2026-11-08 删（评审 派 T-摆设开关）。
    #   这三个键原来都写着 True，但**没有任何生产代码查它们**：
    #     · rrf_fuse      —— recall_engine.rrf_fuse() 只有它自己的 selftest 在调，
    #                        memory_manager.recall 走的是 hybrid_rerank，压根没接 RRF
    #     · query_route   —— query_route.apply_route_bonus() 同样只有自检在调
    #     · assoc_dedup   —— 真正的去重写在 bridge.js（JS）里，Python 的 features
    #                        它根本读不到，在 Python 侧留个键毫无意义
    #   留着它们＝假承诺：用户以为「关掉能回滚」，实际关了行为一点不变。
    #   等哪天真的接线了，再把键加回来（并当场证明「关掉有区别」）。

    # ── 遗忘治理 ──────────────────────────────────────────
    # 冲突判据用极性（2026-11-07 已改，默认开）
    #   2026-11-08 接线：memory_health._is_dup 里真正判断它
    "polarity_conflict": True,
    # 去重用包含度而非 Jaccard（2026-11-07 已改，默认开）
    #   2026-11-08 接线：memory_health._is_dup 里真正判断它
    "dedup_containment": True,
    # 半衰期按提及次数对数拉长（2026-11-07 已改，默认开）
    #   2026-11-08 接线：decay_logic.calculate_current_strength 里真正判断它
    "half_life_boost": True,
    # 问法路由的记忆归类用方案C（2026-11-08 新增）
    #   开（默认）= query_route.mem_kinds_v2：mem_type 优先，不信内容正则
    #   关        = 退回老实现（category 不可信就无条件猜内容）
    #   为什么要开关：方案C 把 event 覆盖从 48.8% → 27.4%，
    #     实测 20 条对照「变好 10 / 变差 1 / 不变 9」，但万一有没测到的场景
    #     依赖宽判据，一行回滚。
    "query_route_memkinds": True,
    # 情绪半衰期：情绪强度随时间消退
    "emotion_half_life": False,

    # ── 注入优化 ──────────────────────────────────────────
    # 按字数装箱（2026-11-07 已改，默认开）
    "inject_pack": True,
    # 事实卡：1500 字一次注入，替代每轮召回
    "fact_card": False,
    # 轮转契约：token ≥70% 自动换会话
    "rotation": False,

    # ── 交接（2026-11-08）────────────────────────────────
    # 交接单：换会话时带一张 80 字状态快照（聊到哪 / 什么情绪 / 没说完 / 琐事）
    # 唯一一个「默认开」的新能力：纯追加，不依赖任何上游，关掉就等于没有
    "handover": True,

    # ── 自动化 ────────────────────────────────────────────
    # 夜巡 + 主动推送报告
    # 2026-11-08 打开：负责「每天跑一次检查，有异常能看见」。
    #   注意 nightly_patrol.push_report() 现在**只写 TODO 不真推送**
    #   （推送机制还没设计），所以打开它不会往用户屏幕上弹任何东西。
    #   关掉它 → 夜巡不跑，其余功能完全不受影响（各走各的开关）。
    "nightly_patrol": True,
    # 注入块 marker：session_init 注入时用 <!--MEM_START-->…<!--MEM_END-->
    #   包住，重复注入时先删旧的再加新的（防止同一段内容注入两遍）。
    #   2026-11-08 打开：包一层注释 marker 对模型是无害的，
    #   但**没被包过的旧路径完全不变**（开关关掉时行为等同今天）。
    "inject_marker": True,
    # 经验提炼（从见闻里提「可以照着做的道理」）
    # 2026-11-08 打开（T16）：**只写不读** —— 生成经验并写进 active.json，
    #   但 MemoryManager.NON_RECALL_TYPES 把它挡在召回之外，
    #   先攒数据观察质量。关掉 → 巩固不再提炼，已有数据不受影响。
    "lessons": True,
    # 反思（从做过的事里提「我的理解」）
    # 2026-11-08 打开（T17）：同样只写不读，靠 NON_RECALL_TYPES 挡住召回。
    "reflection": True,

    # ── 结构改造（改动最大，最后做） ──────────────────────
    # 时间锚：事实时间是「说出口那一轮」
    "said_at": False,
    # 事件流：只追加+墓碑，不覆盖写
    "event_stream": False,
    # 主题树 + 槽位
    "topic_tree": False,
    # 课表
    "schedule": False,
}


def on(name: str) -> bool:
    """查开关。未知的名字返回 False（安全默认：不认识的能力一律不启用）。"""
    return bool(FEATURES.get(name, False))


def enable(name: str) -> None:
    """打开一个能力（留痕）。"""
    if name not in FEATURES:
        raise KeyError(f"未知能力: {name}（先加到 FEATURES 里）")
    FEATURES[name] = True


def disable(name: str) -> None:
    """关掉一个能力。"""
    if name not in FEATURES:
        raise KeyError(f"未知能力: {name}")
    FEATURES[name] = False


def enabled_list() -> list:
    """当前打开的能力清单（排好序，方便打印）。"""
    return sorted(k for k, v in FEATURES.items() if v)


def summary() -> str:
    """一行摘要：打开了哪些、关着哪些。"""
    on_list = enabled_list()
    off_count = len(FEATURES) - len(on_list)
    return f"已开 {len(on_list)} 项: {', '.join(on_list) or '(无)'} | 关着 {off_count} 项"


def _readers_of(flag: str, prod_files: list = None) -> list:
    """扫生产文件，返回哪些文件真的 `on("flag")` 了。

    ⚠️ 只扫**生产文件**（见 PROD_FILES）。这个仓库根目录常年堆着几十个
    一次性脚本（_rev_*.py / _v2.py / verify*.py），全扫会把它们算成「读者」，
    得出假阳性 —— 实测踩过：EPISODE_MAX_PER_DAY 因此被误判成「有两个读者」。
    """
    import os
    if prod_files is None:
        prod_files = PROD_FILES
    pats = (f'on("{flag}")', f"on('{flag}')")
    out = []
    for fn in prod_files:
        if not os.path.exists(fn):
            continue
        try:
            src = open(fn, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        if any(p in src for p in pats):
            out.append(fn)
    return out


def unread_flags() -> list:
    """当前**打开着、但没有任何生产代码读**的开关（＝摆设开关）。

    这些开关给了「关掉能回滚」的假承诺，实际关掉行为不变。
    正常情况应返回空列表。
    """
    return [f for f in enabled_list() if not _readers_of(f)]


def selftest() -> None:
    """自检（不依赖外部数据，5 秒内跑完）。"""
    # 1. 未知名字返回 False
    assert on("不存在的能力") is False, "未知能力应该返回 False"
    # 2. 已开的能力返回 True
    assert on("polarity_conflict") is True
    # 3. 关着的返回 False
    #    2026-11-08：不写死名字 —— 开关会被别的任务逐个打开，写死就会互相打架。
    #    2026-11-08 再改：原来靠「挑一个当前关着的」，可万一全都打开了这项就**静默跳过**，
    #      「关着的返回 False」这条测试等于不存在（假绿）。现在自己造一个关着再测。
    _probe = "__selftest_probe__"
    FEATURES[_probe] = False
    try:
        assert on(_probe) is False, "关着的开关应该返回 False"
        enable(_probe)
        assert on(_probe) is True, "enable 之后应该返回 True"
        disable(_probe)
        assert on(_probe) is False, "disable 之后应该返回 False"
    finally:
        FEATURES.pop(_probe, None)   # 不留痕
    # 4. enable/disable 生效 + **默认值要还原**
    #    2026-11-08 修：原来写死 window_ledger 并按「它默认开」还原，但那句注释是错的
    #      （window_ledger 默认 False），一旦有人把它打开，这里就会把别人的改动悄悄关掉。
    #      改成先记原值，测完按原值还原 —— 谁开的都还原成谁开的。
    _orig = FEATURES.get("window_ledger", False)
    try:
        enable("window_ledger")
        assert on("window_ledger") is True, "enable 没生效"
        disable("window_ledger")
        assert on("window_ledger") is False, "disable 没生效"
    finally:
        FEATURES["window_ledger"] = _orig
        assert FEATURES["window_ledger"] == _orig, "必须还原成测之前的值"
    # 5. 未知名字 enable 会抛
    try:
        enable("瞎写的")
        raise AssertionError("未知能力 enable 应该抛 KeyError")
    except KeyError:
        pass
    # 6. summary 能跑
    assert "已开" in summary()

    # 7. ★ 2026-11-08 新增：**摆设开关检查**（评审 采纳的机制建议）
    #    「每个开着的 flag 都必须有人读。没人读 = 装饰品，当场暴露。」
    #
    #    为什么只警告不 assert：JS 侧（bridge.js）也确实承载能力，
    #    但 Python 读不到 JS 里的判断，硬 assert 会把正常情况判红。
    #    所以这里打警告，让每次跑 selftest 都能看见。
    _unread = unread_flags()
    if _unread:
        print(f"⚠️ 这些开关没人读（摆设，关掉也不会有区别）: {_unread}")
    else:
        print("✅ 所有开着的开关都有读取者")

    print("features.py selftest OK")
    print(f"  {summary()}")


if __name__ == "__main__":
    selftest()
