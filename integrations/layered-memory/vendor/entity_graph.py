# -*- coding: utf-8 -*-
"""实体图谱 entity_graph.py —— 共享实体的记忆互相加权（2026-11-08，T10）

## 它解决什么

    「朋友的生日是2月13日」   实体 = {朋友, 生日}
    「朋友喜欢吃火锅」         实体 = {朋友, 火锅}

两条记忆**字面完全无关、向量相似度也很低**，但都提到「朋友」——
所以提生日的时候，也应该能想起他爱吃什么。

**联想链（associate_engine）做不到这个**：它靠语义相似 + 时间相近 + 话题标签，
这两条在三个维度上全对不上。共享实体是第三条线索，也是唯一一条
「不看字面、只看提到了谁/什么」的线索。

## 为什么用词表，不用模型

（依据《记忆系统-主设计》18.3）
  · 零模型依赖 —— ollama 挂了也能抽
  · 零成本     —— 不额外调模型
  · 立即生效   —— 215 条历史记忆不用迁移，用到时现抽

代价：只认词表里的，新事物要人补。补词表比 debug 一个抽取模型便宜，
而且判错了能一眼看出是哪个词命中的（可解释、可审计）。

## 对外 7 件事

    extract_entities(text)                 从文本抽实体（纯规则，不调模型）
    entity_score(mem_ents, query_ents)     共享实体打分 0~1（共享数 / 3，封顶 1）
    graph_contribution(mem_ents, q_ents)   上面的成品分 × ENTITY_GRAPH_WEIGHT
    entities_of(mem)                       一条记忆的实体（有 entities 字段就用，没有就现抽）
    build_graph(memories)                  建索引 {实体名: [mem_id, ...]}
    neighbors(mem_id, graph, memories)     1 跳邻居：共享实体的其它记忆
    selftest()                             自检（python entity_graph.py）

## 已知边界（写在这儿，免得以后被当成 bug 去「修」）

· 词表外的实体认不出来 → 返回 []，**这不是错误**
  （「今天天气不错」本来就没有实体，2026-11-08 实测真实库里这类占一大半）
· 单字实体（家 / 面）在复合词里会误命中（大家 / 面试），用 SINGLE_CHAR_BLOCK 逐词挡，
  挡不完的属于已知误差 —— 宁可少抽，不要乱抽
· 一条记忆抽到几个实体算几个，**不做关联强度权重**（那是实体表的 weight 字段，
  现在没有实体表；等真有需求再加，别先加一个没人读的字段）
"""

import sys

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
# 中文 Windows 终端默认 GBK，print 中文/emoji 会 UnicodeEncodeError 直接崩。
# 必须在任何输出之前执行。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from typing import List

from config import ENTITY_GRAPH_WEIGHT


# ═══════════════════════════════════════════════════════════════════
# 一、实体词表（人工维护，可增长）
#
# 分成 4 类，分类不是为了打分（打分只数个数），是为了
# 「以后要按人物/地点分别加权时不用重抽」以及人能一眼看懂抽对了没有。
# ═══════════════════════════════════════════════════════════════════
ENTITY_HINTS = {
    "person": ["用户", "assistant", "朋友", "同事", "同学", "老师"],
    "object": ["火锅", "面", "煎蛋", "奶茶", "猫", "狗", "显卡", "电脑", "手机",
               "视频", "文件", "数据", "报告"],
    "place":  ["家", "厨房", "城市", "商场", "学校", "医院", "卧室"],
    "topic":  ["考试", "记忆系统", "画图", "短视频", "音乐", "代码",
               "生日", "纪念日", "记忆", "模型", "睡觉", "唱歌",
               "上课", "熬夜", "训练", "吃饭"],
}

# 别名 → 规范名。
ALIASES = {
    "用户": ("本人", "用户本人"),
    "朋友": ("好友", "老友", "哥们"),
    "assistant": ("助手",),
}

# 单字实体的挡词表：这些复合词里的「家 / 面」不是我们要的实体。
# 例：「面试」里的面不是吃的面，「大家」里的家不是那个家。
SINGLE_CHAR_BLOCK = {
    "家": ("大家", "人家", "国家", "专家", "作家", "画家", "科学家",
           "卖家", "买家", "行家", "思想家", "一家人"),
    "面": ("面试", "方面", "表面", "页面", "画面", "界面", "层面", "里面",
           "前面", "后面", "上面", "下面", "外面", "对面", "全面", "局面",
           "正面", "反面", "见面", "一面", "情面", "门面", "两面",
           # ★ 2026-11-13 补：实测 5 条「桌面」被误抽成实体「面」
           "桌面"),
}

# 打分参数（0.11 的权重在 config.ENTITY_GRAPH_WEIGHT，这里只管归一化）
ENTITY_SCORE_DIVISOR = 3.0   # 共享 3 个实体就算「完全相关」（设计文档 18.2）
ENTITY_SCORE_MAX = 1.0


def _variant_map() -> dict:
    """{变体词: (规范名, 类型)}；变体 = 词表原词 + 别名。

    用 setdefault：同一个词若被登记两次，先登记者赢（person > object > place > topic）。
    """
    m = {}
    for etype, words in ENTITY_HINTS.items():
        for w in words:
            m.setdefault(w, (w, etype))
            for alias in ALIASES.get(w, ()):
                m.setdefault(alias, (w, etype))
    return m


_VARIANT_MAP = _variant_map()


def _positions(text: str, word: str) -> list:
    """word 在 text 里的所有出现位置（不是只找第一个 —— 第一个可能正好被挡）。"""
    out = []
    start = 0
    while True:
        i = text.find(word, start)
        if i < 0:
            return out
        out.append(i)
        start = i + 1


def _blocked(text: str, word: str, pos: int) -> bool:
    """这次出现是不是落在挡词表里的复合词中。

    判断方式：对每个挡词，算出 word 在挡词里的偏移，把 text 的对应窗口取出来比 ——
    窗口正好等于挡词，才算「这次出现属于那个复合词」。
    例：text=「面试」，word=「面」，pos=0，挡词「面试」含「面」偏移 0
        → 窗口 text[0:2]=「面试」相等 → 挡掉。
    """
    for compound in SINGLE_CHAR_BLOCK.get(word, ()):
        off = compound.find(word)
        if off < 0:
            continue
        s = pos - off
        if s >= 0 and text[s:s + len(compound)] == compound:
            return True
    return False


# ═══════════════════════════════════════════════════════════════════
# 二、抽取
# ═══════════════════════════════════════════════════════════════════

def extract_entities(text) -> list:
    """从文本里抽实体（纯规则，不调模型）。

    返回 [{"name": "朋友", "type": "person"}, ...]，**按在文本里第一次出现的位置排序**
    （排序固定了，同一条内容每次抽出来的顺序一样，方便做 diff 和缓存）。

    抽不到就返回 []（「今天天气不错」本来就没实体，这不是失败）。
    """
    t = str(text or "")
    if not t:
        return []

    first = {}   # 规范名 -> (首次出现位置, 类型)
    for variant, (canon, etype) in _VARIANT_MAP.items():
        if variant not in t:
            continue
        pos = None
        for p in _positions(t, variant):
            if not _blocked(t, variant, p):
                pos = p
                break
        if pos is None:      # 全是挡词里的出现 → 这条变体不算命中
            continue
        old = first.get(canon)
        if old is None or pos < old[0]:
            first[canon] = (pos, etype)

    ordered = sorted(first.items(), key=lambda kv: (kv[1][0], kv[0]))
    return [{"name": name, "type": etype} for name, (_, etype) in ordered]


def extract_entity_names(text) -> List[str]:
    """从文本里抽实体**名字**（公共入口，给召回链用）。

    跟 extract_entities 的区别：
      · extract_entities      → [{"name": "朋友", "type": "person"}, ...]
                                 带类型，给图谱/打分用
      · extract_entity_names  → ["朋友", "火锅"]
                                 只有名字，给 hybrid_rerank 的实体加分用

    ★ 为什么要有这个公共函数（2026-11-08 方案 B）：
      原来 session_init._query_entities 自己写了一遍「抽实体 → 取 name → 去重」，
      memory_cli 要用又得再写一遍。两处重复 → 迟早分叉（比如一边保序一边不保序）。
      现在收敛到这一个函数，两边都调它。

    ★ 不依赖 session_init / memory_cli（只依赖本模块自己的抽取）：
      entity_graph 是最底层（只 import config / schema），
      反过来让 session_init 依赖它是对的，让它依赖 session_init 就是循环。

    ★ 不在这里判 features 开关：
      开关属于「要不要用这个能力」的调用方决策。
      底层函数永远正常干活，调用方想关就自己跳过 ——
      这样单测可以直接测它，不需要先摆开关。

    返回去重后的顺序列表（按实体在文本里第一次出现的位置），抽不到返回 []。
    """
    ents = extract_entities(text) or []
    names: List[str] = []
    seen = set()
    for e in ents:
        name = e.get("name") if isinstance(e, dict) else getattr(e, "name", None)
        if not name:
            continue
        name = str(name)
        if name not in seen:
            seen.add(name)
            names.append(name)
    return names


def _names(x) -> set:
    """把各种形态的实体集合归一成「名字的 set」。

    支持：
      [{"name": "朋友"}]  /  ["朋友", "火锅"]  /  {"朋友", "火锅"}  /  None
    """
    out = set()
    if not x:
        return out
    if isinstance(x, dict):          # 传进来已经是 {名字: ...} 的映射
        return {str(k) for k in x.keys()}
    for it in x:
        if isinstance(it, dict):
            n = it.get("name")
        elif isinstance(it, str):
            n = it
        else:
            n = getattr(it, "name", None)
        if n:
            out.add(str(n))
    return out


def entity_score(mem_entities, query_entities) -> float:
    """共享实体打分：共享个数 / 3.0，封顶 1.0（设计文档 18.2 的 s_graph）。

    参数两边都可以是 [{"name","type"}] / ["朋友"] / {"朋友"} —— _names 会归一。
    """
    shared = _names(mem_entities) & _names(query_entities)
    if not shared:
        return 0.0
    return round(min(ENTITY_SCORE_MAX, len(shared) / ENTITY_SCORE_DIVISOR), 4)


def graph_contribution(mem_entities, query_entities) -> float:
    """实体图贡献分（⛔ 已验证·暂不启用，2026-11-08）。

    ★ 结论：不接。这不是「还没做」，是「做了、验了、决定不用」。
      别把它标成「待接」—— 那会让接线审计永远报红，而永远红 = 没人看。

    ★ 2026-11-08 实测（代码-接线 / exact-forge 验证，五个判据，三个决定性）：

      ① 精度无提升
         10 个 query 的 Top5 主题词命中数：原 13 / 加图 14。
         但「+1」那一条是**蒙对**：
           query「我想养只猫」把「视频分享卡片：猫追老鼠」拉上来了，
           那条主题是「视频分享卡片」，不是「养猫」。

      ② 有误伤（这条最致命）
         「他说：[图片]；我回：这只锅可以做汤」
         语义上跟「火锅 / 锅」强相关，但**没有实体词**（词表里没「锅」）
         → 原排名 3，加图后 12，被挤出 Top10。
         即：一条真正相关的被挤走，换来一堆不相关的往上浮。

      ③ 根因是数据分布，不是参数没调好
         「朋友」在 302 条真实记忆里出现 57 次（19%）
         → 任何带「朋友」的 query 都会给这 57 条统一加分
         → 这 57 条里含「火锅」的：0 / 57（精度 0.0%）
         → 加分幅度 0.0367(共享1个) ~ 0.0733(共享2个)
            跟 sim 的真实差异（通常 0.01~0.10）**同量级**
         → 足以改变排序

      ★ 为什么「调权重」治不了：
        57 条全都要加分。调小权重 = 所有改变一起变小（含误伤，等于没治）；
        调大 = 误伤更严重。问题不在幅度，在**「高频实体和稀有实体该不该同样计分」**。

      ★ 唯一可能有效的改法（属于重新设计，不是接线，未做）：
        用 IDF 折掉高频实体权重
        （「朋友」几乎每条都有 → 信息量低；「火锅」只 1 条有 → 信息量高）。
        现在的 entity_score 是纯计数，不做这个区分。
        真要做的话 build_graph 是必需的（要算全局实体频率）。

      ★ 与 RRF / query_route 同类，同一个失效模式：
           RRF            : 8/8 更差            → 不启用
           query_route    : 1.000 → 0.333       → 不启用
           graph_contribution: 精度持平 + 误伤 1 条 + Top10 换血 11/11 → 不启用
        共同点：在「已经足够好的基线」上叠一个**粗糙信号**。
        基线 sim（权重 0.80）已经抓住了语义相关；这里加的是
        「提到同一个人」这种远弱于语义的信号，量级却跟真实差异相当 → 稀释。

    ★ 另注：**打分链其实已经接了一半**
      recall_engine.py:426 正在用 entity_score（不带权重版）。
      没接的只有本函数（乘权重版）+ build_graph + neighbors。

    ⚠️ 想让这个结论过期，必须重跑上面五个判据并在真实数据上看到改善，
       不能因为「看着应该有用」就把它接上去。
    """
    return round(entity_score(mem_entities, query_entities) * ENTITY_GRAPH_WEIGHT, 4)


def _mem_id(mem):
    if isinstance(mem, dict):
        return mem.get("mem_id")
    return getattr(mem, "mem_id", None)


def _strength(mem) -> float:
    v = mem.get("strength") if isinstance(mem, dict) else getattr(mem, "strength", None)
    try:
        return float(v or 0.0)
    except (TypeError, ValueError):
        return 0.0


def entities_of(mem) -> list:
    """取一条记忆的实体。

    优先用已存的 entities 字段（以后 schema 加了就直接生效）；
    没有就从 content 现抽 —— 所以**今天就能跑，不用等迁移历史数据**。
    MemoryItem 和 dict 两种形态都认（生产库读出来是 dict，召回链上是 MemoryItem）。
    """
    if not mem:
        return []
    if isinstance(mem, dict):
        stored = mem.get("entities")
        content = mem.get("content", "")
    else:
        stored = getattr(mem, "entities", None)
        content = getattr(mem, "content", "")
    if stored:
        out = []
        for e in stored:
            if isinstance(e, dict):
                name = e.get("name")
                out.append({"name": str(name), "type": e.get("type", "unknown")})
            elif e:
                out.append({"name": str(e), "type": "unknown"})
        if out:
            return out
    return extract_entities(content)


# ═══════════════════════════════════════════════════════════════════
# 三、图谱索引与 1 跳邻居
#
# ★ 2026-11-08：本节的 build_graph / neighbors 目前**没有生产调用方**，
#   它们是给 graph_contribution 那套「实体图加权」准备的 ——
#   而那一套已经实测判定不接（见 graph_contribution 的 docstring，五个判据）。
#
#   那为什么还留着，不删：
#     · 删了以后真要做 IDF 改造就得重写（那时 build_graph 是必需的 ——
#       要算「每个实体在多少条记忆里出现」才能折掉高频权重）
#     · 它们有完整 selftest，不占生产路径，留着没有运行时成本
#
#   状态标注：⛔ 为未启用的功能做准备（不是「待接」，是「已验证不接」）
#   想启用它，先重跑 graph_contribution docstring 里那五个判据。
# ═══════════════════════════════════════════════════════════════════

def build_graph(memories) -> dict:
    """建索引 {实体名: [mem_id, ...]}。

    一个实体名对应一串记忆 = 这些记忆「都在说同一个东西」，这就是图谱的边。

    ⛔ 当前无生产调用方。它是给 graph_contribution 那套加权准备的，
       而那套已实测判定不接（见 graph_contribution docstring 的五个判据）。
       保留原因：将来做 IDF 改造时需要它算全局实体频率。
    """
    graph = {}
    for mem in memories or []:
        mid = _mem_id(mem)
        if not mid:
            continue
        for e in entities_of(mem):
            ids = graph.setdefault(e["name"], [])
            if mid not in ids:      # 防同一条记忆重复入桶（同实体多别名命中）
                ids.append(mid)
    return graph


def _find_mem(memories, mem_id):
    for mem in memories or []:
        if _mem_id(mem) == mem_id:
            return mem
    return None


def neighbors(mem_id, graph, memories, limit: int = 30) -> list:
    """1 跳邻居：跟这条记忆**共享实体**的其它记忆（返回 mem_id 列表）。

    排序：共享实体多的在前；一样多就看强度（活着的比快忘掉的相关）；最后按 mem_id 定序 ——
    保证同一份数据每次跑出来的顺序一致（不然召回结果会抖）。

    ⛔ 当前无生产调用方。同 build_graph：为未启用的实体图加权准备，
       而那套已实测判定不接（见 graph_contribution docstring）。
    """
    if not mem_id or not graph:
        return []

    # 这条记忆有哪些实体：优先从图里反查（不要求它还在 memories 里），查不到再从内容现抽
    seed_ents = {name for name, ids in graph.items() if mem_id in ids}
    if not seed_ents:
        seed_ents = {e["name"] for e in entities_of(_find_mem(memories, mem_id))}
    if not seed_ents:
        return []

    shared = {}
    for name in seed_ents:
        for other in graph.get(name, ()):
            if other == mem_id:
                continue
            shared[other] = shared.get(other, 0) + 1

    ranked = sorted(shared.items(),
                    key=lambda kv: (-kv[1], -_strength(_find_mem(memories, kv[0])), kv[0]))
    return [mid for mid, _ in ranked[:max(0, int(limit))]]


# ═══════════════════════════════════════════════════════════════════
# 四、自检（不依赖真实数据，5 秒内跑完：python entity_graph.py）
# ═══════════════════════════════════════════════════════════════════

def selftest() -> None:
    # ① 核心场景：两条字面无关的记忆共享「朋友」
    e1 = extract_entities("朋友的生日是2月13日")
    e2 = extract_entities("朋友喜欢吃火锅")
    n1 = {x["name"] for x in e1}
    n2 = {x["name"] for x in e2}
    assert "朋友" in n1 and "朋友" in n2, f"两条都该有朋友，实际 {n1} / {n2}"
    assert "生日" in n1, f"生日该被认出来，实际 {n1}"
    assert "火锅" in n2, f"火锅该被认出来，实际 {n2}"
    assert entity_score(n1, n2) > 0, "共享朋友，分数必须 > 0"

    # ② 类型要对
    assert {x["name"]: x["type"] for x in e1}["朋友"] == "person"
    assert {x["name"]: x["type"] for x in e2}["火锅"] == "object"

    # ③ 完全无关 → 0 分（不许瞎关联）
    a = extract_entities("今天天气不错")
    b = extract_entities("这台机器跑图像服务很快")
    assert a == [], f"「今天天气不错」不该抽到实体，实际 {a}"
    assert entity_score(a, b) == 0.0, "没有共享实体必须是 0"

    # ④ 打分封顶：共享 3 个 = 1.0，共享 5 个也不能超过 1.0
    assert entity_score({"朋友", "生日", "火锅"}, {"朋友", "生日", "火锅"}) == 1.0
    assert entity_score({"朋友", "生日", "火锅", "手机", "猫"},
                        {"朋友", "生日", "火锅", "手机", "猫"}) == 1.0
    assert entity_score({"朋友"}, {"朋友", "生日", "火锅"}) == round(1 / 3, 4)

    # ⑤ 三种入参形态都能吃（set / list / [{name,type}]）
    dict_form = [{"name": "朋友", "type": "person"}]
    assert entity_score(dict_form, {"朋友"}) > 0
    assert entity_score(["朋友"], ["朋友"]) > 0
    assert entity_score(None, None) == 0.0
    assert entity_score([], {"朋友"}) == 0.0

    # ⑥ 别名归一：老爸 → 朋友
    assert {x["name"] for x in extract_entities("好友说想吃火锅")} >= {"朋友", "火锅"}
    assert entity_score(extract_entities("好友找我了"), extract_entities("朋友的生日")) > 0

    # ⑦ 单字实体的挡词表（「面试」不是面，「大家」不是家）
    assert "面" not in {x["name"] for x in extract_entities("明天去面试")}, "面试被误抽成面"
    assert "家" not in {x["name"] for x in extract_entities("大家都很好")}, "大家被误抽成家"
    assert "面" in {x["name"] for x in extract_entities("下个面，系上围裙")}, "真·面条要抽出来"
    assert "家" in {x["name"] for x in extract_entities("回家了")}, "真·家要抽出来"

    # ⑧ 空输入不崩、顺序稳定
    assert extract_entities("") == []
    assert extract_entities(None) == []
    assert extract_entities("   ") == []
    s = "朋友和同学在学校吃火锅"
    assert extract_entities(s) == extract_entities(s), "同一条文本抽两次必须一样"

    # ⑨ 建图 + 1 跳邻居：用真实的 MemoryItem（走「没有 entities 字段 → 现抽」这条路）
    from schema import MemoryItem
    m1 = MemoryItem("朋友的生日是2月13日")
    m2 = MemoryItem("朋友喜欢吃火锅")
    m3 = MemoryItem("今天天气不错")
    graph = build_graph([m1, m2, m3])
    assert m1.mem_id in graph["朋友"] and m2.mem_id in graph["朋友"], "两条都该挂在朋友这个实体下"
    assert m3.mem_id not in sum(graph.values(), []), "没实体的记忆不该进图"
    nb = neighbors(m1.mem_id, graph, [m1, m2, m3])
    assert nb == [m2.mem_id], f"m1 的邻居应该正好是 m2，实际 {nb}"
    assert m1.mem_id not in nb, "自己不是自己的邻居"
    assert neighbors("不存在的id", graph, [m1, m2, m3]) == []

    # ⑩ dict 形态（生产库读出来就是 dict）+ entities 字段优先
    d1 = {"mem_id": "a", "content": "朋友的生日是2月13日", "strength": 80}
    d2 = {"mem_id": "b", "content": "随便一句话", "strength": 10,
          "entities": [{"name": "朋友", "type": "person"}]}
    g2 = build_graph([d1, d2])
    assert g2.get("朋友") == ["a", "b"], f"entities 字段要优先于内容抽取，实际 {g2.get('朋友')}"
    assert neighbors("a", g2, [d1, d2]) == ["b"]

    # ⑪ 排序稳定：共享多的排前面，共享一样多时强度高的排前面
    x1 = {"mem_id": "s", "content": "朋友和火锅", "strength": 50}
    x2 = {"mem_id": "weak", "content": "朋友", "strength": 5}
    x3 = {"mem_id": "strong", "content": "朋友", "strength": 95}
    g3 = build_graph([x1, x2, x3])
    assert neighbors("s", g3, [x1, x2, x3]) == ["strong", "weak"], "同分要按强度排"

    # ⑫ 权重：成品分 = 归一化分 × config 里的权重
    assert round(graph_contribution({"朋友", "生日", "火锅"}, {"朋友"}), 4) == \
        round(1 / 3 * ENTITY_GRAPH_WEIGHT, 4)
    assert ENTITY_GRAPH_WEIGHT > 0

    # ⑬ 开关已登记（实体模块自己不读开关，由调用方决定要不要用）
    from features import FEATURES
    assert "entity_graph" in FEATURES, "features.py 里必须有这个开关"

    # ⑭ extract_entity_names（2026-11-08 方案 B 的公共入口）
    #    它跟 extract_entities 必须**同源同序**，否则 session_init 和 memory_cli
    #    会拿到不一样的结果（那就等于又分叉了）。
    assert extract_entity_names("朋友说想吃火锅") == ["朋友", "火锅"]
    assert extract_entity_names("今天天气不错") == []        # 没实体不是错误
    assert extract_entity_names("") == []
    assert extract_entity_names(None) == []
    # 与 extract_entities 逐条对齐：名字相同、顺序相同
    for _t in ("朋友说想吃火锅", "他说：我回：那我下个面", "面试完了大家都没说话"):
        assert extract_entity_names(_t) == [x["name"] for x in extract_entities(_t)], _t
    # 去重：文本里重复提到同一个实体，名字只出现一次
    assert extract_entity_names("朋友 朋友 火锅 火锅") == ["朋友", "火锅"]
    # 返回的是 str 列表，不是 dict 列表（调用方拿它去跟 tags 做集合运算）
    assert all(isinstance(x, str) for x in extract_entity_names("朋友说想吃火锅"))

    print("entity_graph.py selftest OK")
    print(f"  词表实体 {len(_VARIANT_MAP)} 个（含别名） / 4 类")
    print(f"  例：「朋友的生日是2月13日」→ {[x['name'] for x in e1]}")
    print(f"  例：共享「朋友」打分 {entity_score(n1, n2)}"
          f"（×权重 {ENTITY_GRAPH_WEIGHT} → {graph_contribution(n1, n2)}）")


if __name__ == "__main__":
    selftest()
