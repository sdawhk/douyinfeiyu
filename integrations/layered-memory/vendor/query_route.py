# -*- coding: utf-8 -*-
"""问法路由 query_route.py —— 从「他怎么问的」推断他要找什么（2026-11-08，T12）

## 它解决什么

    问「我生日是什么时候」   → 他在要一个事实（fact）→ 含日期/事实的记忆该往前
    问「上次一起吃饭那次」   → 他在要一段经历（event）→ 事件类记忆该往前

两种情况向量相似度都在 0.5 上下分不开（bge-m3 对中文短句有基线），
但**问法本身带着意图**：「上次」「生日」这些词是谁都装不出来的信号。

## 为什么是轻量版，不建主题树

（依据《记忆系统-主设计》第 9 节）
完整主题树要定义 24 个槽位 + 把 215 条记忆全量归类，成本高、改错难回滚。
轻量版只看问句里的意图词，50 行拿 70% 的效果；不够用再升级，别一上来就上重的。

## 对外 4 件事

    route(query)                       {"kind": "fact"|"event"|"rule"|"skill"|None,
                                        "bonus": 0~QUERY_ROUTE_BONUS, "hits": [...],
                                        "by": "hint"|"category"|None}
    apply_route_bonus(results, info)   给匹配意图的记忆加分并重排
    matches(mem, kind)                 这条记忆算不算这个意图（拆开测用）
    selftest()                         自检（python query_route.py）

## 怎么判「这条记忆算不算 fact/event/rule/skill」

两层，**都不依赖模型**：
  ① 记忆自带 category 就用它（schema.classify_importance 已经判过 fact/event/…)
  ② category 不可信（空 / misc / speech）时，退回看内容形态：
     rule  看有没有「不许/必须/答应」这类话
     event 看有没有「他说/我回/那天/一起」这类对话或共同经历痕迹
     fact  看有没有生日/日期/「是…」这类断言
     skill 看有没有「用/靠/办法/步骤」这类操作性描述

⚠️ 这里**不新增字段**：意图是「每次现算」的，不落盘。理由是落盘就要迁移 215 条历史数据，
   而且记忆的 category 改了它也得跟着变 —— 一个必然过期的缓存不如不存。
"""

import re
import sys

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from config import QUERY_ROUTE_BONUS


# ═══════════════════════════════════════════════════════════════════
# 一、意图词表
#
# 每个意图两档词：
#   strong —— 这个词只可能指向这一种意图（「生日」「上次」）
#   weak   —— 常见、但别的场景也会用（「多少」「如何」），只在没有强词时算数
#
# 为什么分两档：「这个怎么做」里「这个」不算线索，但「怎么做」是；
#   而「上次怎么弄的」里「上次」比「怎么」更能说明他要的是 event。
# ═══════════════════════════════════════════════════════════════════
INTENT_STRONG = {
    "fact":  ["生日", "几岁", "哪年", "哪一天", "叫什么", "是什么时候", "是多少",
              "号码", "有没有告诉过"],
    "event": ["那次", "上次", "上回", "以前", "当时", "那天", "那时候", "回忆",
              "还记得", "记不记得"],
    "rule":  ["不许", "必须", "不能", "记住", "答应", "别忘", "禁止", "只能",
              "说好了", "约好"],
    "skill": ["怎么做", "如何", "办法", "方法", "怎么弄", "步骤", "怎么搞",
              "咋做", "咋弄"],
}

INTENT_WEAK = {
    # 2026-11-08 补：「朋友喜欢吃什么」是设计文档 18.6 点名的场景，
    #   原来一个词都撞不上（不是问句，也没有「生日/多少」），路由等于是瞎的。
    #   「喜欢/吃什么/有什么」都只在**没有强词**时才算数，且只给一半分。
    "fact":  ["是什么", "多少", "哪里", "哪", "什么时候", "谁",
              "喜欢", "吃什么", "有什么"],
    "event": ["记得", "那次", "当时", "那天", "一起"],
    "rule":  ["一定要", "一定", "保证"],
    "skill": ["怎么"],
}

# 兼容旧写法（有人按这个 dict 抄的，别删）
INTENT_HINTS = {k: sorted(set(list(INTENT_STRONG[k]) + list(INTENT_WEAK.get(k, []))))
                for k in INTENT_STRONG}

# 意图优先级：同一句话撞上多个意图时谁说了算。
#   rule > event > fact > skill
#   理由：「你答应我不许走」既像 rule 又像 event，但它是**约定**，rule 更该赢；
#        「上次生日怎么过的」撞 fact(event)，他要的是那次经历，event 赢。
INTENT_PRIORITY = ["rule", "event", "fact", "skill"]

# 置信度：只有弱词命中时，bonus 打这个折（别让「多少」把整库带偏）
WEAK_CONFIDENCE = 0.5


# ═══════════════════════════════════════════════════════════════════
# 二、问句 → 意图
# ═══════════════════════════════════════════════════════════════════

def _hits(query: str, words) -> list:
    return [w for w in words if w in query]


def route(query) -> dict:
    """从问法识别意图。

    返回：
        {"kind": "fact"|"event"|"rule"|"skill"|None,
         "bonus": 0 ~ QUERY_ROUTE_BONUS   (只命中弱词时减半)
         "hits": ["生日", ...]           命中了哪些词（可解释，方便调词表）
         "by":   "hint" | None}

    识别不出就返回 kind=None / bonus=0（**这不报错**，普通闲聊本来就该走纯向量）。
    """
    q = str(query or "")
    if not q.strip():
        return {"kind": None, "bonus": 0.0, "hits": [], "by": None}

    strong = {k: _hits(q, v) for k, v in INTENT_STRONG.items()}
    weak = {k: _hits(q, v) for k, v in INTENT_WEAK.items()}

    # ① 有强词：按优先级取第一个有强词的意图，满额加分
    for kind in INTENT_PRIORITY:
        if strong.get(kind):
            return {"kind": kind,
                    "bonus": QUERY_ROUTE_BONUS,
                    "hits": strong[kind],
                    "by": "hint"}

    # ② 只有弱词：同样按优先级，但只给一半分
    for kind in INTENT_PRIORITY:
        if weak.get(kind):
            return {"kind": kind,
                    "bonus": round(QUERY_ROUTE_BONUS * WEAK_CONFIDENCE, 4),
                    "hits": weak[kind],
                    "by": "hint"}

    # ③ 什么都没命中 —— 普通陈述/闲聊，交给向量
    return {"kind": None, "bonus": 0.0, "hits": [], "by": None}


# ═══════════════════════════════════════════════════════════════════
# 三、记忆 → 意图判定
# ═══════════════════════════════════════════════════════════════════

# schema.classify_importance 判出来的 category 里，哪些**直接可信**。
# misc / speech / empty / manual 这些不带「事还是话」的信息，退回看内容。
CATEGORY_TRUSTED = {"fact", "date", "event", "commitment", "tool", "about_him", "notes"}

# category → 意图（commitment 就是承诺，等价 rule）
CATEGORY_TO_KIND = {
    "fact": "fact",
    "date": "fact",
    "event": "event",
    "notes": "event",
    "about_him": "fact",
    "commitment": "rule",
    "tool": "skill",
}

# ② 内容形态兜底（不看 category）
KIND_PATTERNS = {
    "rule":  [r"不许|禁止|必须|一定要|不能|别碰|只能",
              r"答应|说好|约好|保证|发誓|记住|别忘了"],
    "event": [r"他说|我回|她说|我说",
              r"那天|那次|当时|那天晚上|一起|第一次|后来"],
    "fact":  [r"生日|纪念日|\d{1,2}\s*月\s*\d{1,2}",
              r"是[^，。]{0,12}[。，]?$",
              r"QQ\s*\d{6,}|\d{6,}"],
    "skill": [r"用|靠|办法|方法|步骤|先.{0,6}再",
              r"工具|接口|命令|设置"],
}


def _mem_field(mem, name, default=None):
    if isinstance(mem, dict):
        return mem.get(name, default)
    return getattr(mem, name, default)


# ═══════════════════════════════════════════════════════════════════
# 三·补、mem_kinds_v2（2026-11-08 方案C）
#
# 老实现的病（实测）：库里 75% 记忆的 category 不可信
# （stable_profile 104 + 空 90），于是全部落到「内容正则兜底」，
# 而 KIND_PATTERNS["event"] 里有 `他说|我回` —— 命中 64 条，
# 结果 event 覆盖 48.8%，工具知识也被判成「经历」。
#
# 更糟：情景档 content 已被 compose_content 洗掉「他说/我回」，判不出任何 kind
# → 17 条情景档里 0 条被判成 event（而它们正是「经历」本身）。
#
# 方案C 的改动只有一条原则：**信可信的，不信猜的**。
#   ① mem_type 最可信 —— 它是写入时明确标的，不是推断的
#   ② category 次可信  —— 但只在它真判出来时（fact/event/notes/commitment…）
#   ③ 内容正则最不可信 —— 只有「mem_type 未知 且 category 完全空」才用
#
# 实测效果（真库 257 条）：
#   event 覆盖 48.8% → 27.4%（68 条，其中 50 条 category 真判断 + 17 条情景档）
#   情景档识别 0/17 → 17/17
#   20 条对照：变好 10 / 变差 1 / 不变 9，平均 ΔNDCG +0.1757
# ═══════════════════════════════════════════════════════════════════

# mem_type → 意图的直接映射（最可信的一层）
MEMTYPE_TO_KINDS = {
    "episode": {"event"},              # 情景档 = 一段经历，本来就该是 event
    "lesson": {"rule", "skill"},       # 经验 = 可照着做的道理
    "reflection": {"rule", "skill"},   # 反思同理
}


def mem_kinds_v2(mem) -> set:
    """方案C：mem_type 优先判，判不出才看 category，最后才看内容。

    跟 mem_kinds 的区别（一句话）：**不再无条件相信内容正则**。

    ⚠️ 2026-11-08 修（已知踩过的坑，记下来免得再犯）：
       第一版漏了「long_term 直接返回」这条分支，于是 category 空的
       long_term 记忆**仍然进了内容兜底** —— 实测多判出 60 条 event
       （128 条 vs 实验时的 68 条）。这个差异是我自己比对实验代码时发现的：
       部署版 `if mt in MEMTYPE_TO_KINDS` 只覆盖了 episode/lesson/reflection，
       long_term 掉到了兜底。现已补上。
    """
    # ── ① mem_type 最可信 ──
    mt = str(_mem_field(mem, "mem_type", "") or "").strip()
    if mt in MEMTYPE_TO_KINDS:
        return set(MEMTYPE_TO_KINDS[mt])

    cat = str(_mem_field(mem, "category", "") or "").strip()

    # ── ② long_term：只信 category，**判不出就不猜**（不进内容兜底）──
    #    为什么长时记忆特殊：它量最大（60%+），一旦进兜底就是「一次宽松决定
    #    影响大半库」。而 short_term/working 量小、且还没被 consolidate 定型，
    #    允许它们用内容兜底。
    if mt == "long_term":
        if cat in CATEGORY_TO_KIND:
            return {CATEGORY_TO_KIND[cat]}
        return set()

    # ── ③ 其它 mem_type：category 可信就映射 ──
    if cat in CATEGORY_TO_KIND:
        return {CATEGORY_TO_KIND[cat]}

    # ── ④ 兜底：只有「category 完全空」才用内容正则 ──
    #    注意这里是 `not cat`（真的空），不是 `cat not in CATEGORY_TRUSTED`。
    #    老实现用了后者，于是 misc/speech/stable_profile 这些**明确标了不可信**的
    #    也去猜内容 —— 那才是 48% 的来源。
    if not cat:
        content = str(_mem_field(mem, "content", "") or "")
        kinds = set()
        for kind, pats in KIND_PATTERNS.items():
            if any(re.search(p, content) for p in pats):
                kinds.add(kind)
        return kinds

    # category 有值但不在映射表里（misc / speech / stable_profile …）→ 明确不猜
    return set()


def _kinds_flag_on() -> bool:
    """方案C 的开关。关掉 → 退回老实现（一行回滚）。"""
    try:
        from features import on
        return bool(on("query_route_memkinds"))
    except Exception:
        return True      # features 缺失时用新实现（已实测不差）


def mem_kinds(mem) -> set:
    """这条记忆同时算哪几种意图。

    2026-11-08 改成**带开关的二选一**：
      features.on("query_route_memkinds") = True（默认）→ 方案C
      False → 老实现（category 不可信就无条件猜内容）

    为什么要留开关：方案C 把 event 覆盖从 48.8% 降到 27.4%，
    万一有没测到的场景依赖「宽判据」，能一行回滚。
    """
    if _kinds_flag_on():
        return mem_kinds_v2(mem)
    return _mem_kinds_legacy(mem)


def _mem_kinds_legacy(mem) -> set:
    """老实现（2026-11-08 之前的版本），保留供开关回滚。

    ⚠️ 已知问题：category 不可信时**无条件**猜内容，
    导致 48.8% 的记忆被判成 event（含大量工具类知识）。
    """
    kinds = set()

    cat = str(_mem_field(mem, "category", "") or "").strip()
    if cat in CATEGORY_TO_KIND:
        kinds.add(CATEGORY_TO_KIND[cat])

    # category 不可信（空/misc/speech/未知）时，看内容形态
    if cat not in CATEGORY_TRUSTED:
        content = str(_mem_field(mem, "content", "") or "")
        for kind, pats in KIND_PATTERNS.items():
            if any(re.search(p, content) for p in pats):
                kinds.add(kind)

    return kinds


def matches(mem, kind) -> bool:
    """这条记忆算不算这个意图。kind 为空 → 永远 False（没有意图就不加分）。"""
    if not kind:
        return False
    return kind in mem_kinds(mem)


# ═══════════════════════════════════════════════════════════════════
# 四、加分与重排
# ═══════════════════════════════════════════════════════════════════

def apply_route_bonus(results, route_info) -> list:
    """给匹配意图的记忆加 bonus 分，然后按新分数重排。

    results 支持两种形态（生产链路是 [(MemoryItem, score), ...]）：
        [(mem, score), ...]  或  [{...mem..., "score": x}, ...]

    **不改原列表、不改内存对象**（跟 hybrid_rerank 一样，打分别污染候选），
    返回一个新的结果列表。
    """
    if not results:
        return []
    info = route_info or {}
    kind = info.get("kind")
    bonus = float(info.get("bonus", 0) or 0)

    if not kind or bonus <= 0:
        return list(results)

    out = []
    for item in results:
        if isinstance(item, (tuple, list)) and len(item) == 2:
            mem, score = item
            try:
                score = float(score)
            except (TypeError, ValueError):
                score = 0.0
            if matches(mem, kind):
                score = round(score + bonus, 4)
            out.append((mem, score))
        elif isinstance(item, dict):
            new = dict(item)      # 浅拷贝：不动调用方的数据
            try:
                score = float(new.get("score", 0) or 0)
            except (TypeError, ValueError):
                score = 0.0
            if matches(new, kind):
                score = round(score + bonus, 4)
            new["score"] = score
            out.append(new)
        else:
            out.append(item)

    def _score_of(x):
        if isinstance(x, (tuple, list)) and len(x) == 2:
            return x[1]
        if isinstance(x, dict):
            return x.get("score", 0)
        return 0

    out.sort(key=_score_of, reverse=True)
    return out


# ═══════════════════════════════════════════════════════════════════
# 五、自检（不依赖真实数据，5 秒内跑完：python query_route.py）
# ═══════════════════════════════════════════════════════════════════

def selftest() -> None:
    # ① 验收里的四个用例（+ 变体）
    cases = [
        ("我生日是什么时候", "fact"),
        ("上次一起吃饭那次", "event"),
        ("你答应我不许走", "rule"),
        ("这个怎么做", "skill"),
        ("朋友几岁了", "fact"),
        ("还记得那天晚上吗", "event"),
        ("必须记住这句话", "rule"),
        ("这个有什么办法", "skill"),
        # 设计文档 18.6 点名的场景：不是问句，靠「喜欢/吃什么」这类弱词也要能判出来
        ("朋友喜欢吃什么", "fact"),
    ]
    for q, expect in cases:
        r = route(q)
        assert r["kind"] == expect, f"{q!r} 期望 {expect}，实际 {r}"
        assert 0 < r["bonus"] <= QUERY_ROUTE_BONUS, f"加分越界: {r}"

    # ② 普通闲聊不许乱判（这是最容易出问题的地方：把日常句子强行归类）
    for q in ("嗯", "", "   ", None, "今天好累啊", "哈哈哈哈", "好呀", "晚安"):
        r = route(q)
        assert r["kind"] is None, f"{q!r} 不该有意图，实际 {r}"
        assert r["bonus"] == 0.0, f"{q!r} 不该加分，实际 {r}"

    # ③ 两条都命中时按优先级：约定 > 经历
    assert route("你答应我不许走")["kind"] == "rule"
    assert route("上次生日怎么过的")["kind"] == "event", "带「上次」时要的是那段经历"

    # ④ 只有弱词 → 只给一半分（并且要标出来命中了什么）
    #   注意「是多少」是强词，这里必须挑一个**只**撞弱词的句子
    weak = route("这个是什么")
    assert weak["kind"] == "fact"
    assert weak["bonus"] == round(QUERY_ROUTE_BONUS * WEAK_CONFIDENCE, 4)
    assert weak["hits"], "命中了弱词要在 hits 里写出来"

    # ⑤ 记忆侧判定：category 可信时直接用
    from schema import MemoryItem
    m_fact = MemoryItem("朋友的生日是2月13日")
    m_event = MemoryItem("他说今天很累，我回那早点睡")
    m_rule = MemoryItem("他说：记住不许熬夜")
    m_skill = MemoryItem("画图用 image-service，先起服务再提交")
    assert "fact" in mem_kinds(m_fact) or "date" in str(m_fact.category)
    assert matches(m_fact, "fact"), f"生日记忆该算 fact，实际 {mem_kinds(m_fact)} / {m_fact.category}"
    assert matches(m_event, "event"), f"对话记忆该算 event，实际 {mem_kinds(m_event)} / {m_event.category}"
    assert matches(m_rule, "rule"), f"承诺记忆该算 rule，实际 {mem_kinds(m_rule)} / {m_rule.category}"
    assert matches(m_skill, "skill"), f"工具记忆该算 skill，实际 {mem_kinds(m_skill)} / {m_skill.category}"

    # ⑥ category 为空时，内容兜底也要能判出来
    #   ⚠️ 这里必须用**普通 dict**，不能用 MemoryItem：
    #     MemoryItem.__init__ 会把空 category 自动补成分类结果（通常是 "event"），
    #     mem_type 默认也不是空 —— 两个字段都有值就轮不到 ④ 的内容兜底。
    #     用 MemoryItem 构造等于在测另一条路径，永远测不到兜底。
    #   注：兜底返回的是**集合**，一句话可以同时命中多种意图
    #   （「他说不许熬夜」既是 event 也是 rule），所以断言用「包含」，
    #   不能用相等 —— 相等会把「多判了一个合理的种类」也当成失败。
    assert "rule" in mem_kinds({"content": "他说不许熬夜", "category": "", "mem_type": ""})
    assert mem_kinds({"content": "他说不许熬夜", "category": ""}) == {"rule", "event"}
    assert matches({"content": "那天我们去商场了", "category": ""}, "event")

    # ⑥b 2026-11-08 方案C 行为变更：**category 有值但不可信时不再猜内容**
    #   老实现会去猜（`category != 可信` 就兜底），于是：
    #     {"content": "生日快乐呀", "category": "misc"}  → 被判成 fact
    #   这是「拿一条 misc 记忆去拿 fact 加分」，属于乱加分 —— 正是 48% 覆盖的来源。
    #   现在明确：category 标了 misc/speech/stable_profile 就**不猜**。
    assert matches({"content": "生日快乐呀", "category": "misc"}, "fact") is False, \
        "category=misc 不该再被猜成 fact（方案C：不信内容正则）"
    assert mem_kinds({"content": "生日快乐呀", "category": "misc"}) == set()
    # 但 category 真的空时仍要兜底（上面 ⑥ 已验）
    assert matches({"content": "我生日是 10 月 25 日", "category": ""}, "fact")

    # ⑥c 方案C：long_term 只信 category，判不出就不猜
    assert mem_kinds({"content": "他说那天一起去唱歌", "category": "stable_profile",
                      "mem_type": "long_term"}) == set(), \
        "long_term + stable_profile 不该被内容正则猜成 event"
    assert mem_kinds({"content": "x", "category": "event", "mem_type": "long_term"}) == {"event"}

    # ⑥d 方案C：mem_type 最可信（情景档 = 经历）
    assert mem_kinds({"content": "随便什么", "mem_type": "episode"}) == {"event"}, \
        "情景档必须判成 event（老实现只看 category/内容，判不出）"
    assert mem_kinds({"content": "x", "mem_type": "lesson"}) == {"rule", "skill"}

    # ⑦ kind 为空 → 一律不加分
    assert matches(m_fact, None) is False
    assert matches(m_fact, "") is False

    # ⑧ apply_route_bonus：加分 + 重排，且不动原数据
    results = [(m_event, 0.90), (m_fact, 0.86)]
    info = route("我生日是什么时候")
    bumped = apply_route_bonus(results, info)
    assert bumped[0][0] is m_fact, "生日意图下，含生日的记忆要排到第一"
    assert bumped[0][1] == round(0.86 + info["bonus"], 4)
    assert results[0] == (m_event, 0.90), "原列表不许被改"

    # ⑨ 没有意图时原样返回（只换列表外壳，顺序不变）
    same = apply_route_bonus(results, route("今天好累啊"))
    assert same == results
    assert apply_route_bonus([], info) == []
    assert apply_route_bonus(None, info) == []

    # ⑩ dict 形态（生产 CLI 里传的可能就是 dict）
    #   分数故意设成「原本略输 0.01」，加分后必须翻上来 —— 这才证明 bonus 真起作用了
    dicts = [{"content": "今天天气不错", "category": "misc", "score": 0.85},
             {"content": "朋友的生日是2月13日", "category": "fact", "score": 0.84}]
    out = apply_route_bonus(dicts, route("我生日是什么时候"))
    assert out[0]["content"].startswith("朋友的生日"), f"dict 形态也要重排，实际 {[o['content'][:6] for o in out]}"
    assert dicts[0]["score"] == 0.85, "dict 不许被就地改"
    assert dicts[0]["content"] == "今天天气不错", "原顺序也不许被改"

    # ⑪ 加分不会超过上限
    assert QUERY_ROUTE_BONUS > 0
    assert route("生日")["bonus"] <= QUERY_ROUTE_BONUS

    # ⑫ 开关状态（2026-11-08 改）
    #    原来断言 `assert "query_route" in FEATURES` —— 但那个键已经删了：
    #    本模块的 apply_route_bonus 只有自检在调，生产召回链路没接它，
    #    留个开关是假承诺（关掉开关行为一点不变）。
    #    现在只断言「模块确实没接线」，接上了再把这条测试改成正面断言。
    from features import FEATURES
    assert "query_route" not in FEATURES, (
        "query_route 开关又出现了 —— 如果真接线了，请把这条测试改成"
        "'关掉开关有区别'，而不是单纯断言键存在")

    print("query_route.py selftest OK")
    print(f"  意图词 {sum(len(v) for v in INTENT_HINTS.values())} 个 / 4 类"
          f"（强词 {sum(len(v) for v in INTENT_STRONG.values())}）")
    print(f"  例：{route('我生日是什么时候')}")
    print(f"  例：{route('今天好累啊')}")


if __name__ == "__main__":
    selftest()
