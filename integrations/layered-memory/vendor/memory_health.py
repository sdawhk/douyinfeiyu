# -*- coding: utf-8 -*-
r"""记忆库健康模块：冲突检测 / 体检自愈 / 合并巩固（三个纯规则模块，不调模型）。

依据 memory-brain 的思路（conflict.py 66行 / health.py 117行 / consolidate.py 133行），
但按我们自己的 JSON 数据结构重写，且默认「只读 + 报告」，不自动改数据。

安全原则：
  · 三个函数都默认返回「报告」，不做写操作
  · 只有显式传入 dry_run=False 才会改数据（当前版本全部 dry_run=True）
  · 绝不碰宿主其他文件（social-v2.json 等），只读本系统自己的库
"""

import os
import re
from collections import Counter
from datetime import datetime
from typing import List, Dict, Tuple

# __UTF8_STDOUT_GUARD__ (2026-11-07)
# 中文 Windows 终端默认 GBK，print emoji 会 UnicodeEncodeError 直接崩。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 2026-11-08 能力开关（评审 派 T-摆设开关）：
#   features.py 里 dedup_containment / polarity_conflict 一直是 True，
#   但本模块之前**从来没读过它们** —— 关掉开关行为一点不变，等于假承诺。
#   现在 _is_dup 里两处判断都真正受这两个开关控制。
try:
    from features import on
except Exception:                     # features 缺失时退回「全开」，保持老行为
    def on(_name):
        return True


def _cfg(name: str, default):
    """读 config 里的参数；读不到就用默认值。

    为什么这么写：这个模块被 link_check / 一堆测试直接 import，
    任何一次 config 改动都不该让它 import 失败（前车之鉴：config 少一个键，
    整条巩固链在一个后台任务里悄悄挂掉）。
    """
    try:
        import config as _c
        return getattr(_c, name, default)
    except Exception:
        return default


def _norm(text: str) -> str:
    """归一化：去标点、空格、空白。"""
    return re.sub(r"[\s\W_]+", "", str(text or ""))


def _bigram(text: str) -> set:
    """字符二元组集合（memory-brain 的 _bigram_sim 思路）。"""
    t = _norm(text)
    if len(t) < 2:
        return {t} if t else set()
    return {t[i:i+2] for i in range(len(t) - 1)}


def _bigram_sim(a: str, b: str) -> float:
    """字符二元组 Jaccard 相似度 0~1。"""
    ba, bb = _bigram(a), _bigram(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / len(ba | bb)


def _containment(a: str, b: str) -> float:
    """包含度：交集 / 较小者。短句被长句完全包含时 = 1.0。

    2026-11-07 新增（借鉴 memory-brain）：
      Jaccard 会低估「短句被长句包含」的重复。
      例：「喜欢吃火锅」vs「我喜欢吃火锅」
        Jaccard = 4/5 = 0.80   （可能过不了 0.78 阈值，漏判）
        包含度  = 4/4 = 1.00   （明确是重复）
      记忆去重应该用包含度：短的那条确实是长的子集。
    """
    ba, bb = _bigram(a), _bigram(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / min(len(ba), len(bb))


def _is_dup(a: str, b: str, thr: float = 0.82) -> bool:
    """判断两条是否「该合并的重复」（不是矛盾）。

    两道关：
      ① 包含度 >= thr（短句被长句包含）
      ② 极性不相反（「我不喜欢」vs「我喜欢」虽然包含，但语义相反，不能合并）

    2026-11-08 修「摆设开关」（评审 派）：
      这两道关分别对应 features 里的 dedup_containment / polarity_conflict，
      但之前**代码里从来没查过这两个开关** —— 关掉也照旧走包含度 + 极性。
      现在真正受控：
        dedup_containment  关 → 退回老的纯 Jaccard（会漏判「短句被长句包含」）
        polarity_conflict  关 → 不做极性保护（「我不喜欢」会被判成「我喜欢」的重复）
    """
    # ① 相似度判据：包含度（新）vs Jaccard（老）
    if on("dedup_containment"):
        sim = _containment(a, b)
    else:
        sim = _bigram_sim(a, b)
    if sim < thr:
        return False
    # ② 极性保护（可关）
    if on("polarity_conflict") and is_contradiction(a, b):
        return False
    return True


# ============ ① 冲突检测 ============
# 2026-11-07 修：原判据只看相似度（>=0.75），实测误判 4/7 ——
#   · 「我喜欢吃火锅」vs 同一句   → 相似度 1.0 → 误判成「冲突」（其实是重复）
#   · 「我喜欢吃火锅」vs「我讨厌吃火锅」→ 相似度仅 0.25 → 真冲突反而漏掉
#   · 「他会游泳」vs「他不会游泳」    → 相似度 0.40 → 漏掉
#   根本问题：短句的二字组相似度天然偏低，用高阈值会把真冲突全卡掉。
#
# 参照 memory-brain (CC BY-NC-SA 4.0) 的 conflict.py 判据：
#   相似度 >= 0.45（低阈值，只要求「说的是同一件事」）
#   且 极性相反（喜欢/讨厌、会/不会、同意/不同意…）才算冲突。
#
# 这样「重复」不会被当成「冲突」，「真矛盾」也不会被漏掉。
# 2026-11-10 重写（实测驱动）：
#   旧表 22 对里有 ("会","不会") / ("是","不是") / ("在","不在") 这种单字词，
#   会到处误命中 ——「我会记住你」也含「会」→ 被判成有极性 → 噪声。
#   实测 400 条真实记忆：旧表检出 3 对"冲突"，3 对全是重复不是矛盾。
#
#   新表原则：
#     · 全部 ≥2 字（单字太容易误命中）
#     · 只保留「真能构成同一件事对立说法」的
ANTONYM_PAIRS = (
    # ── 喜好 ──
    ("喜欢", "讨厌"), ("喜欢", "不喜欢"), ("爱吃", "不爱吃"),
    ("爱吃", "讨厌吃"), ("想吃", "不想吃"), ("想看", "不想看"),
    # ── 能力 ──
    ("擅长", "不擅长"), ("会做", "不会做"), ("能做到", "做不到"),
    # ── 意愿 ──
    ("同意", "不同意"), ("支持", "反对"), ("愿意", "不愿意"),
    ("接受", "不接受"), ("允许", "不允许"), ("想", "不想"),
    ("要去", "不去"), ("要来", "不来"),
    # ── 经历 ──
    ("吃过", "没吃过"), ("去过", "没去过"), ("见过", "没见过"),
    # ── 状态 ──
    ("害怕", "不怕"), ("开", "关"), ("醒着", "睡着"),
    ("在睡", "醒着"), ("有空", "没空"), ("在忙", "闲着"),
    # ── 频率 ──
    ("经常", "从不"), ("总是", "从不"), ("天天", "从不"),
    # ── 情绪 ──
    ("开心", "不开心"), ("高兴", "不高兴"), ("难过", "不难过"),
    ("生气", "不生气"), ("累", "不累"), ("困", "不困"),
    # ── 关系 ──
    ("喜欢他", "讨厌他"), ("和好", "吵架"),
)
CONFLICT_MIN_SIM = 0.45   # 「说的是同一件事」的最低相似度（低阈值，靠极性兜底）


def _polarity(text: str) -> set:
    """返回文本里出现的正/反词集合。"""
    t = _norm(text)
    hits = set()
    for pos, neg in ANTONYM_PAIRS:
        if pos in t:
            hits.add(pos)
        if neg in t:
            hits.add(neg)
    return hits


def is_contradiction(a: str, b: str, sim: float = None) -> bool:
    """判断两条是否「真矛盾」：说的是同一件事 + 极性相反。

    2026-11-07 二修：极性相反时降低相似度门槛。
    2026-11-10 三修（实测「累 vs 不累」失败）：
      单字对立词（累/不累）在短句里本身就会互相包含，
      bigram 相似度极低（"我很累" vs "我不累" 只有 "我" 一个共享 → 0.2 附近）。
      修法：短句（两边都 ≤ 8 字）时放宽到 sim >= 0.10；
            长句保持 0.20（避免长文里偶然命中）。
    """
    if sim is None:
        sim = _bigram_sim(a, b)
    # 先看极性：没有任何对立极性 → 不可能是矛盾
    pa, pb = _polarity(a), _polarity(b)
    has_opposite = False
    for pos, neg in ANTONYM_PAIRS:
        if (pos in pa and neg in pb) or (neg in pa and pos in pb):
            has_opposite = True
            break
    if not has_opposite:
        return False
    # 有对立极性：短句门槛更低
    short = (len(_norm(a)) <= 8 and len(_norm(b)) <= 8)
    if short:
        # 2026-11-10 三修：短句用「共享字符」兜底。
        #   "我很累" vs "我不累" 的 bigram_sim = 0.0
        #   （只共享「我」一个字，凑不成二字组）
        #   但这两句明明是同一件事的对立说法。
        na, nb = _norm(a), _norm(b)
        shared = len(set(na) & set(nb))
        denom = max(1, min(len(na), len(nb)))
        char_sim = shared / denom
        return char_sim >= 0.30 or sim >= 0.10
    return sim >= 0.20


def detect_conflicts(memories: List[dict], sim_threshold: float = None) -> List[dict]:
    """检测「真矛盾」的记忆对（同一件事，说法相反）。

    2026-11-07 改：从「只看相似度」改成「相似度 + 极性相反」。
      · 重复内容（相似度高、极性相同）→ 不算冲突，交给 find_merge_groups 去合并
      · 真矛盾（喜欢 vs 讨厌）        → 才算冲突

    返回：[{a_index, b_index, sim, text_a, text_b, polarity}]
    """
    thr = CONFLICT_MIN_SIM if sim_threshold is None else sim_threshold
    conflicts = []
    n = len(memories)
    for i in range(n):
        for j in range(i + 1, n):
            a = memories[i].get("content") or memories[i].get("text") or ""
            b = memories[j].get("content") or memories[j].get("text") or ""
            if not a or not b:
                continue
            # 长度差太大就不比（长文 vs 短语不可能是同一事实）
            if abs(len(a) - len(b)) > max(len(a), len(b)) * 0.5:
                continue
            sim = _bigram_sim(a, b)
            # 2026-11-07 三修：删掉这里的前置 sim < thr 门槛。
            #   原来是「先过相似度，再看极性」，但短句真矛盾（喜欢vs讨厌）相似度只有 0.25，
            #   全被这个前置门槛挡死了。现在改成「极性优先」——由 is_contradiction 内部
            #   自己判「有对立极性 + sim>=0.20」。
            if not is_contradiction(a, b, sim):
                continue
            # 2026-11-10 修：原来用 sorted(pa ^ pb)（对称差）——
            #   两边都含对立两个词时对称差为空 → 报告里 polarity=[]，
            #   看不出「凭什么判它冲突」。
            #   改成记录「实际命中的对立对」，一眼能看出是哪对词打架。
            pa, pb = _polarity(a), _polarity(b)
            hit_pairs = []
            for pos, neg in ANTONYM_PAIRS:
                if (pos in pa and neg in pb) or (neg in pa and pos in pb):
                    hit_pairs.append(f"{pos}/{neg}")
            conflicts.append({
                "a_index": i, "b_index": j, "sim": round(sim, 3),
                "text_a": a[:60], "text_b": b[:60],
                "polarity": hit_pairs,
            })
    return conflicts


# ============ ①b 孤儿 / 僵尸（2026-11-08 新增）============
#
# 为什么单独拎出来（而不是塞进 health_check）：
#   health_check 回答的是「这条数据**格式**有没有坏」（空内容/无向量/字段缺失），
#   这里回答的是「这条记忆**还有没有用」—— 是语义问题，不是格式问题。
#   两件事混在一个 dict 里，看报告的人分不清「修一下 bug」和「考虑删掉」。
#
# ★ 纯只读：两个 find_* 都不改任何字段，也不落盘。
#   强度一律用 decay_logic.peek_strength()（无副作用），
#   绝不用 calculate_current_strength() —— 那个会改写 strength 和 last_active，
#   在「体检」里调用等于检查一次就把数据改了。


def _content_of(m) -> str:
    """取内容。同时兼容 dict 和 MemoryItem（旧函数就两种都吃）。"""
    if isinstance(m, dict):
        return str(m.get("content") or m.get("text") or "")
    return str(getattr(m, "content", "") or "")


def _get(m, key: str, default=None):
    """统一取字段：dict 走 get，对象走 getattr。"""
    if isinstance(m, dict):
        return m.get(key, default)
    return getattr(m, key, default)


def _has_valid_embedding(m) -> bool:
    """向量是否真的可用。

    注意**全零向量等于没有**：ollama 挂掉时接口可能返回全零，
    这种向量参与相似度算出来恒 0，等于这条记忆永远召不回、也去不了重。
    光判 bool(embedding) 会把「1024 个 0」当成健康。
    """
    emb = _get(m, "embedding")
    if not emb:
        return False
    if isinstance(emb, (list, tuple)):
        if len(emb) == 0:
            return False
        try:
            return any(x != 0 for x in emb)
        except TypeError:
            return True
    return True


def _age_days(m, key: str, now: float) -> float:
    """某个时间字段距今多少天。字段缺失返回无穷大（= 非常老，会被判成久未命中）。

    为什么缺失要算「很老」而不是「很新」：
      缺时间戳意味着这条记录来路不明，宁可被列出来看一眼，
      也不要因为它「看起来新」而永远躲过巡检。
    """
    ts = _get(m, key)
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        return float("inf")
    if ts <= 0:
        return float("inf")
    return max(0.0, (now - ts) / 86400.0)


def _as_item(m):
    """把 dict 兜底转成 MemoryItem（decay_logic 只认对象，不认 dict）。

    ⚠️ 必须转：decay_logic 里到处是 memory_item.xxx 的属性访问，
       喂它一个 dict 会直接 AttributeError（被我下面的 except 吞掉，
       结果是「静默退回原始 strength」——僵尸判定就永远算不对）。
       实测踩过：dict 直接传进去，strength 退回 21.0、地板退回 18.0，
       本该判成僵尸的一条被判成健康。

    返回的是**新建对象**，改它不影响调用方的 dict —— 体检绝不能有副作用。
    """
    if isinstance(m, dict):
        try:
            from schema import MemoryItem
            return MemoryItem.from_dict(m)
        except Exception:
            return m
    return m


def _peek_strength(m, now: float) -> float:
    """只算强度、不改状态。拿不到 decay_logic 就退回读原始 strength。"""
    try:
        from decay_logic import peek_strength
        return float(peek_strength(_as_item(m), now))
    except Exception:
        try:
            return float(_get(m, "strength", 0.0) or 0.0)
        except (TypeError, ValueError):
            return 0.0


def _effective_floor(m) -> float:
    """实际生效的衰减地板（importance 地板 / 核心人物地板 / 类别地板取高者）。"""
    item = _as_item(m)
    try:
        from decay_logic import effective_floor
        return float(effective_floor(item))
    except Exception:
        try:
            imp = float(_get(m, "importance", None) or 0.0)
        except (TypeError, ValueError):
            imp = 0.0
        if imp <= 0:
            try:
                from schema import infer_importance
                imp = float(infer_importance(_content_of(m), str(_get(m, "source", "") or "")))
            except Exception:
                imp = 0.35
        return max(0.0, min(1.0, imp)) * 60.0


def find_orphans(memories: List[dict], min_chars: int = None) -> List[dict]:
    """找「孤儿」：来源为空 / 内容太短 / 向量缺失。

    孤儿 = 有这条记录，但它**没法用**：
      · content < min_chars（默认 config.ORPHAN_MIN_CHARS=5）
        —— 「嗯」「好」「哈哈」这种留着占位置，召回时还会挤掉真记忆
      · source 为空 —— 不知道哪来的，没法溯源，也没法按来源调权重
      · embedding 缺失/全零 —— 向量召回永远命中不了它（等于只有半个身子在库里）

    返回：[{index, mem_id, content, chars, reasons}]
    """
    if min_chars is None:
        min_chars = _cfg("ORPHAN_MIN_CHARS", 5)
    try:
        min_chars = int(min_chars)
    except (TypeError, ValueError):
        min_chars = 5

    out = []
    for idx, m in enumerate(memories):
        content = _content_of(m)
        text = content.strip()
        reasons = []
        if not text:
            reasons.append("内容为空")
        elif len(text) < min_chars:
            reasons.append("内容过短(%d<%d)" % (len(text), min_chars))
        src = str(_get(m, "source", "") or "").strip()
        if not src:
            reasons.append("来源为空")
        if not _has_valid_embedding(m):
            # ★ 2026-11-08：「还没算」不算孤儿。
            #   情景档是写盘后再算向量的（embed_status=pending），巩固下一轮会补。
            #   把它报成「向量缺失」是假警报 —— 巡检 在真实数据上
            #   撞到过：11 条新建 episode 同时出现在 orphans 和 halfwritten 里，
            #   理由都是「向量缺失」，而它们下一轮巩固就被修好了。
            #
            #   注意：pending 只免掉**向量**这一条理由；如果它同时来源为空/
            #   内容太短，那照样是孤儿 —— 不能因为 pending 就整条豁免。
            st = str(_get(m, "embed_status", "") or "").lower()
            if st == "pending":
                pass
            elif st == "failed":
                reasons.append("向量算失败（embed_status=failed）")
            else:
                reasons.append("向量缺失")
        if reasons:
            out.append({
                "index": idx,
                "mem_id": _get(m, "mem_id", ""),
                "content": text[:40],
                "chars": len(text),
                "reasons": reasons,
            })
    return out


def find_zombies(memories: List[dict], days: int = None, now: float = None) -> List[dict]:
    """找「僵尸」：90 天没被想起 + 强度已到地板 + importance < 0.5。

    三个条件**同时**成立才算：

      ① 90 天没被想起
         「被想起」的时间取 last_mentioned_at（真的被提及），拿不到才退到 last_active。
         ⚠️ 不能直接用 last_active：initialize / 巩固 / 召回都会刷新它，
            实测 215 条里 last_active 全部在 0.3 天以内 —— 用它判断的话
            永远不会有「久未想起」，这个检查项就废了（死字段的另一种形态）。
      ② 强度已经躺在地板上
         不是「强度低」，而是「已经降到它自己的地板了」：
         再等下去也不会更低，说明该衰减的早就衰减完了。
         这条把「刚创建所以还低」和「放置久了所以低」区分开 ——
         前者降到地板需要时间，后者本来就在那儿。
      ③ importance < 0.5
         重要度低。importance 是永不衰减的那一维，
         它低说明这条内容本身就不值得长期保留。
         （fact 0.92 / event 0.65 这类永远进不了僵尸名单，这是故意的）

    返回：[{index, mem_id, content, idle_days, strength, floor, importance, reasons}]
    """
    if days is None:
        days = _cfg("ZOMBIE_DAYS", 90)
    try:
        days = float(days)
    except (TypeError, ValueError):
        days = 90.0
    if now is None:
        now = datetime.now().timestamp()

    INF = float("inf")
    out = []
    for idx, m in enumerate(memories):
        # ① 久未想起（优先用「真的被提起」的时间）
        idle = _age_days(m, "last_mentioned_at", now)
        if not (idle < INF):
            idle = _age_days(m, "last_active", now)
            if not (idle < INF):
                idle = _age_days(m, "create_time", now)
        if idle < days:
            continue
        # ③ importance < 0.5
        try:
            imp = float(_get(m, "importance", 0.35) or 0.0)
        except (TypeError, ValueError):
            imp = 0.35
        if imp >= 0.5:
            continue
        # ② 强度到地板
        strength = _peek_strength(m, now)
        floor = _effective_floor(m)
        if strength > floor + 0.5:      # 允许 0.5 分浮点误差
            continue
        out.append({
            "index": idx,
            "mem_id": _get(m, "mem_id", ""),
            "content": _content_of(m).strip()[:40],
            "idle_days": round(idle, 1) if idle < INF else None,
            "strength": round(strength, 2),
            "floor": round(floor, 2),
            "importance": round(imp, 2),
            "reasons": [
                "%d 天没想起（%s 天）" % (days, round(idle, 1) if idle < INF else "无时间戳"),
                "强度 %s 已到地板 %s" % (round(strength, 1), round(floor, 1)),
                "importance=%s < 0.5" % round(imp, 2),
            ],
        })
    return out


def _pick_ids(memories: List[dict], indices) -> List[str]:
    """把下标翻译成 mem_id（报告里给 id 比给下标有用）。"""
    out = []
    for i in indices:
        try:
            out.append(str(_get(memories[i], "mem_id", "") or ("#%d" % i)))
        except Exception:
            out.append("#%d" % i)
    return out


def health_report(memories: List[dict], now: float = None,
                  orphans=None, zombies=None, duplicates=None, conflicts=None) -> Dict:
    """汇总体检：{total, orphans, zombies, duplicates, conflicts, healthy}

    跟 health_check 的分工：
      · health_check  ← 「格式有没有坏」（字段级，逐条）
      · health_report ← 「记忆库整体什么状态」（数量级，可读的一张表）

    返回里除了要求的那六个键，还多带 details（明细），
    方便夜巡直接拿去写报告 —— 不然调用方只能拿到一堆数字。

    orphans / zombies / duplicates / conflicts 可以**传进来**：
    调用方（夜巡）自己已经算过一遍，再算一遍既慢又可能因为参数不同
    （比如夜巡用了更松的重复阈值）得出两套互相打架的数字。
    传 None 才现算。
    """
    if now is None:
        now = datetime.now().timestamp()
    total = len(memories)
    if orphans is None:
        orphans = find_orphans(memories)
    if zombies is None:
        zombies = find_zombies(memories, now=now)
    if duplicates is None:
        duplicates = find_merge_groups(memories, _cfg("PATROL_DUP_THRESHOLD", 0.72))
    if conflicts is None:
        conflicts = detect_conflicts(memories)

    # 有问题的那几条（去重：同一条既孤儿又僵尸只算一次）
    bad = set()
    bad.update(x["index"] for x in orphans)
    bad.update(x["index"] for x in zombies)
    for g in duplicates:
        bad.add(g["keep_index"])
        bad.update(g["drop_indices"])
    for c in conflicts:
        bad.add(c["a_index"])
        bad.add(c["b_index"])

    return {
        "total": total,
        "orphans": len(orphans),
        "zombies": len(zombies),
        "duplicates": len(duplicates),
        "conflicts": len(conflicts),
        "healthy": max(0, total - len(bad)),
        "details": {
            "orphans": orphans,
            "zombies": zombies,
            "duplicates": [
                {
                    "keep_id": _get(memories[g["keep_index"]], "mem_id", ""),
                    "drop_ids": _pick_ids(memories, g["drop_indices"]),
                    "sim": g.get("sim"),
                    "keep_text": g.get("keep_text", ""),
                }
                for g in duplicates
            ],
            "conflicts": [
                {
                    "a_id": _get(memories[c["a_index"]], "mem_id", ""),
                    "b_id": _get(memories[c["b_index"]], "mem_id", ""),
                    "sim": c.get("sim"),
                    "text_a": c.get("text_a", ""),
                    "text_b": c.get("text_b", ""),
                }
                for c in conflicts
            ],
        },
    }


# ============ ② 体检自愈 ============
def health_check(memories: List[dict]) -> Dict:
    """体检：空内容、无 embedding、字段缺失、重复 mem_id、强度越界。

    返回健康报告，不修改数据。
    """
    report = {
        "total": len(memories),
        "empty_content": [],
        "no_embedding": [],
        "missing_fields": [],
        "dup_mem_id": [],
        "strength_out_of_range": [],
        "duplicate_content": [],
    }
    seen_ids = set()
    seen_norm = {}
    for idx, m in enumerate(memories):
        # 空内容
        content = m.get("content") or m.get("text") or ""
        if not str(content).strip():
            report["empty_content"].append(idx)
            continue
        # 无 embedding
        emb = m.get("embedding")
        if not emb or (isinstance(emb, list) and len(emb) == 0):
            report["no_embedding"].append(idx)
        # 字段缺失（关键字段）
        for key in ("mem_id", "strength", "importance"):
            if key not in m:
                report["missing_fields"].append((idx, key))
        # 重复 mem_id
        mid = m.get("mem_id")
        if mid:
            if mid in seen_ids:
                report["dup_mem_id"].append(mid)
            seen_ids.add(mid)
        # 强度越界
        st = m.get("strength")
        if st is not None:
            try:
                if not (0 <= float(st) <= 100):
                    report["strength_out_of_range"].append(idx)
            except (TypeError, ValueError):
                report["strength_out_of_range"].append(idx)
        # 重复内容（完全同文）
        n = _norm(content)
        if n and n in seen_norm:
            report["duplicate_content"].append((seen_norm[n], idx))
        elif n:
            seen_norm[n] = idx
    return report


# ============ ③ 合并巩固 ============
def find_merge_groups(memories: List[dict], sim_threshold: float = 0.82) -> List[dict]:
    """找可合并的重复记忆组（相似度高的，保留最全/最新的一条）。

    返回：[{keep_index, drop_indices, sim, keep_text}]
    不自动合并，只报告。
    """
    groups = []
    n = len(memories)
    used = set()
    for i in range(n):
        if i in used:
            continue
        a = memories[i].get("content") or memories[i].get("text") or ""
        if not a:
            continue
        similar = []
        for j in range(i + 1, n):
            if j in used:
                continue
            b = memories[j].get("content") or memories[j].get("text") or ""
            if not b:
                continue
            if abs(len(a) - len(b)) > max(len(a), len(b)) * 0.5:
                continue
            # 2026-11-07 改：用「包含度 + 极性保护」，不用纯 Jaccard。
            #   Jaccard 会漏掉「短句被长句包含」的重复（0.80 vs 1.00）；
            #   而单纯用包含度又会把「我不喜欢」vs「我喜欢」误判成重复，
            #   所以 _is_dup 内部还挡了一道极性。
            if _is_dup(a, b, sim_threshold):
                similar.append(j)
        if similar:
            # 保留哪条：内容更长的（更全）
            group = [i] + similar
            keep = max(group, key=lambda x: len(memories[x].get("content") or memories[x].get("text") or ""))
            drops = [x for x in group if x != keep]
            groups.append({
                "keep_index": keep,
                "drop_indices": drops,
                "sim": round(max(_containment(a, memories[d].get("content") or memories[d].get("text") or "") for d in similar), 3),
                "keep_text": (memories[keep].get("content") or memories[keep].get("text") or "")[:60],
            })
            for x in group:
                used.add(x)
    return groups


if __name__ == "__main__":
    # 自检：造几条测试数据跑一遍
    demo = [
        {"mem_id": "m1", "content": "朋友的生日是 2 月 13 日", "strength": 80, "importance": 0.92, "embedding": [1.0] * 10},
        {"mem_id": "m2", "content": "朋友的生日是2月13日", "strength": 70, "importance": 0.92, "embedding": [1.0] * 10},
        {"mem_id": "m3", "content": "我喜欢吃火锅", "strength": 50, "importance": 0.55, "embedding": [1.0] * 10},
        {"mem_id": "m4", "content": "", "strength": 30, "importance": 0.35},
    ]
    print("冲突检测:", detect_conflicts(demo))
    print("体检:", health_check(demo))
    print("合并组:", find_merge_groups(demo))
