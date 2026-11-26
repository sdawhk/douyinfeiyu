# -*- coding: utf-8 -*-
"""情景档 · 召回层（2026-11-09 从 episode.py 拆出）

## 这里放什么

「该不该想起一段往事、想起哪几段、怎么塞进 prompt」的全部逻辑：

    should_recall_episodes          这一轮该不该召回？返回 (是否, 原因)
    build_episode_inject            把一条档渲染成注入文本（防污染第③道防护）
    inject_text_of                  把多条档拼成一段注入文本（控制总长）
    dedup_recall                    双向去重：档和碎片不能同时出现（设计 5.2）
    pick_inject_episodes            挑出真正会被注入的那几条（预算内、按原顺序）
    pick_inject_episodes_detailed   同上，但告诉你跳过了谁、为什么
    recall_episodes_preview         一步到位：判定 → 去重 → 挑 → 拼注入文本
    RECALL_TRIGGERS                 触发词表

## 依赖

    episode_base      常量 + 工具
    episode_store     _is_episode（判断一条是不是档）

## 为什么要这里拆（而不是更早）

召回是**最上层**：它依赖存储层判断哪些是档，
但存储层不需要知道「召回怎么拼文本」。
放最后拆，保证依赖方向是单向的。

## 稳定性

函数体原样搬过来，一个字没改。
"""
import math
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    from config import DEDUPLICATION_SIM_THRESHOLD as EPISODE_INJECT_DEDUP_SIM
except Exception:
    EPISODE_INJECT_DEDUP_SIM = 0.78

# ── 注入预算与判定阈值（原在 episode.py 里）───────────────
# 时间性问句：问「哪一次 / 什么时候」→ 要的是那段经历，不是一条事实
RECALL_TIME_WORDS = ("什么时候", "哪次", "第一次", "那天", "后来呢")

# 注入预算（字符）。设计没给具体值，按「情景档是补充，不该挤掉长时记忆」定。
#   实测 content 平均 49 字、最长 72 字；加头部和脚注约 +40 字/条。
#   3 条约 270 字，占 RECALL_MAX_CHARS=3000 的 9%，可接受。
EPISODE_INJECT_MAX_CHARS = 420      # 一次注入情景档的总字数上限
EPISODE_INJECT_MAX_ITEMS = 3        # 一次最多几段经历（多了像流水账）

from episode_base import (
    FALLBACK_THEME, SPARSE, _attr, _content_of, _id_of, _ts_of,
    _cosine, _embedding_of,
)
from episode_store import _is_episode

# 触发词：命中任意一个 → 这一轮大概率在「回忆」
RECALL_TRIGGERS = (
    "记得", "上次", "以前", "之前", "那次", "那天",
    "回忆", "想起来", "曾经", "还记得",
)


def should_recall_episodes(query: str) -> Tuple[bool, Optional[str]]:
    """这一轮该不该召回情景档？返回 (是否召回, 原因)。

    为什么不能每轮都召：情景档 content 平均 49 字（实测 max 72）。
    每轮加 1~3 条会翻倍注入量，而绝大多数轮次根本不是在回忆。
    只在「明显在回忆」时才带 —— 触发词 / 时间性问句。

    原因取值：
        'trigger_word'   —— 命中回忆触发词
        'time_question'  —— 命中时间性问句
        None             —— 不该召回

    永远不抛；query 为 None / 空 / 非字符串都返回 (False, None)。
    """
    q = str(query or "")
    if not q:
        return False, None

    for w in RECALL_TRIGGERS:
        if w in q:
            return True, "trigger_word"

    for w in RECALL_TIME_WORDS:
        if w in q:
            return True, "time_question"

    return False, None


def dedup_recall(episodes: list, shortterms: list) -> list:
    """双向去重：情景档和碎片不能同时出现在注入里（设计 5.2，问题10）。

    ① 情景档命中 → 排除它 source_turns 里的所有碎片
    ② 碎片命中、且它所属的档也在本轮结果里 → **用档替代碎片**

    为什么必须有第②条（这条是原设计漏掉的一半）：
        问「昨晚吃什么」→ 碎片（「他说：我吃完了」「汤都喝光了」）的向量
        可能比聚合后的 content 更贴近「吃面」→ 只命中碎片、没命中档。
        没有第②条，用户拿到的还是 6 条碎片，等于情景档白做。

    返回：混合列表（其中档在前、保留下来的碎片在后，各自保持原有相对顺序）。
    入参为 None / 空都安全返回 []。
    """
    eps = [e for e in (episodes or []) if e]
    sts = [s for s in (shortterms or []) if s]

    # ① 档命中 → 排除它覆盖的碎片
    covered = set()
    for ep in eps:
        covered |= set(_attr(ep, "source_turns", []) or [])
    kept = [s for s in sts if _id_of(s) not in covered]

    # ② 碎片命中、档也在 → 用档替代碎片（在碎片原来的位置上换成档）
    ep_by_id = {_id_of(e): e for e in eps if _id_of(e)}
    out, emitted = [], set()
    for s in kept:
        ep_id = _attr(s, "episode_id", None)
        if ep_id and ep_id in ep_by_id:
            if ep_id not in emitted:
                emitted.add(ep_id)
                out.append(ep_by_id[ep_id])       # 用档替代碎片
            # 碎片本身丢弃（它的内容已经被档概括了）
        else:
            out.append(s)

    # ③ ★ 设计 5.2 漏掉的一步：本轮命中的档，即使没有碎片替身，也必须留下。
    #    设计原文结尾是 `return replaced`，而 replaced 里**只装从碎片转过来的档** ——
    #    于是「召回了档 + 碎片一条都没命中」这种最常见的情况，会把整轮档全丢掉。
    #    实测：dedup_recall([ep_1], []) → []  ← 档凭空消失
    #    这里补一条：没被碎片替身提到过的档，追加到结果里。
    for ep in eps:
        eid = _id_of(ep)
        if eid and eid in emitted:
            continue                               # 已经在第②步放过了
        if eid:
            emitted.add(eid)
        out.append(ep)
    return out


def build_episode_inject(episode) -> str:
    """把一条情景档渲染成注入文本（设计 5.3，防污染第③道防护）。

    输出形如：
        【情景，我归纳的】（2026-11-07）
        11-07 19:34，做饭（8 轮）。（站起来准备晚饭）、（穿上围裙开始备菜）
        （原始对话 8 条，可追溯）

    三道防污染标注一个都不能少：
        ① 「我归纳的」 —— content 是生成的不是原话，不能让模型当成事实
        ② 原始条数     —— 让用户知道这句话背后有多少原文
        ③ 「可追溯」   —— source_turns 能回查

    非情景档（mem_type != 'episode'）一律返回 "" —— 防止普通记忆
    被贴上「我归纳的」标签（那是最严重的一类污染：把原话降级成归纳）。

    档不合法（None / 空 content）返回 ""。
    """
    if not episode:
        return ""
    if not _is_episode(episode):        # ★ 非档绝不渲染
        return ""
    content = str(_attr(episode, "content", "") or "").strip()
    if not content:
        return ""

    scene = _attr(episode, "scene", {}) or {}
    date = str(scene.get("date") or "") if isinstance(scene, dict) else ""
    n = len(_attr(episode, "source_turns", []) or [])

    # 头部：日期（拿不到就退化成「某天」，不能留空括号）
    head = f"【情景，我归纳的】（{date}）" if date else "【情景，我归纳的】"

    # 脚注：条数（拿不到就只说可追溯，不编数字）
    if n > 0:
        foot = f"（原始对话 {n} 条，可追溯）"
    else:
        foot = "（原始对话可追溯）"

    # content_source 不是 generated（比如原文引用）时别说「我归纳的」——
    # 否则把原话降级成「归纳」，反而制造错误印象。
    if str(_attr(episode, "content_source", "generated") or "generated") != "generated":
        head = f"【情景】（{date}）" if date else "【情景】"

    return f"{head}\n{content}\n{foot}"


def _pick_inject_episodes(episodes, max_chars: int = None,
                          max_items: int = None, dedup: bool = True,
                          report: Optional[list] = None) -> list:
    """挑出「真正会被注入」的那几条档（预算内、按原顺序、同批次去重）。

    单独抽出来是因为 inject_text_of 和 recall_episodes_preview 都要用同一个
    选择结果 —— 否则会出现「preview 说有 11 条、实际只注入 3 条」这种
    台账对不上文本的情况（实测踩到）。

    dedup=True 时，跟**已选中**的档相似度 >= DEDUPLICATION_SIM_THRESHOLD 的
    会被跳过（不是丢弃，跳过原因记进 report）。

    ★ 判不了就不跳：任一条没有可用向量时**照常注入**。
      理由：去重的目的是「别给两条几乎一样的」，不是「省位置」。
      没有向量就没有证据说它们像，此时跳过等于凭空气删掉一条记忆 ——
      宁可重复，不可静默丢。向量缺失会由巩固流程补算，补上后自然开始去重。

    report: 传一个 list 进来，会被 append 进被跳过档的记录
            {"mem_id","reason","too_similar_to","sim"}。
    """
    limit_c = EPISODE_INJECT_MAX_CHARS if max_chars is None else int(max_chars)
    limit_n = EPISODE_INJECT_MAX_ITEMS if max_items is None else int(max_items)

    picked, picked_vecs, used = [], [], 0
    for ep in (episodes or []):
        if not _is_episode(ep):        # 只认情景档
            continue
        if len(picked) >= limit_n:
            break
        text = build_episode_inject(ep)
        if not text:
            continue
        cost = len(text) + 1           # +1 是换行
        if used + cost > limit_c:
            break                      # 装不下就停（不截断半条）

        # ── 同批次去重
        if dedup:
            vec = _embedding_of(ep)
            if vec:
                dup_of, dup_sim = None, 0.0
                for prev, prev_vec in picked_vecs:
                    if not prev_vec:
                        continue
                    s = _cosine(vec, prev_vec)
                    if s > dup_sim:
                        dup_of, dup_sim = prev, s
                if dup_of is not None and dup_sim >= EPISODE_INJECT_DEDUP_SIM:
                    if report is not None:
                        report.append({
                            "mem_id": str(_attr(ep, "mem_id", "") or ""),
                            "reason": "too_similar",
                            "too_similar_to": str(_attr(dup_of, "mem_id", "") or ""),
                            "sim": round(dup_sim, 3),
                        })
                    continue           # 跳过，不占预算

        picked.append(ep)
        picked_vecs.append((ep, _embedding_of(ep)))
        used += cost
    return picked


def pick_inject_episodes_detailed(episodes, max_chars: int = None,
                                  max_items: int = None,
                                  dedup: bool = True):
    """跟 pick_inject_episodes 同逻辑，但**同时返回被跳过的档和原因**。

    返回 (picked, skipped)：
        picked  : 真正会被注入的档
        skipped : [{"mem_id","reason","too_similar_to","sim"}, ...]

    为什么要有这个：只返回 picked 的话，台账里「这次为什么只注入了 1 条」
    永远说不清。有了 skipped 才能写「另外 2 条因为跟 X 太像(0.81)被跳过」。
    """
    skipped: List[dict] = []
    picked = _pick_inject_episodes(episodes, max_chars, max_items,
                                   dedup=dedup, report=skipped)
    return picked, skipped


def pick_inject_episodes(episodes, max_chars: int = None,
                         max_items: int = None, dedup: bool = True) -> list:
    """公开版：挑出**真正会被注入**的那几条档（预算内、按原顺序、同批次去重）。

    2026-11-08 加：memory_cli 接召回时需要「哪些档真的注入了」来做台账
    （items 要跟 lines 对得上），不能只拿到文字自己数段落。
    内部就是 _pick_inject_episodes，保证跟 inject_text_of 用同一套选择标准。

    dedup 默认 True（去重）。要关掉请显式传 dedup=False ——
    默认开是刻意的：泛化磁铁是默认会发生的，不开就是默认踩坑。
    想看「为什么少了一条」，用 pick_inject_episodes_detailed()。
    """
    return _pick_inject_episodes(episodes, max_chars, max_items, dedup=dedup)


def inject_text_of(episodes, max_chars: int = None,
                   max_items: int = None, dedup: bool = True) -> str:
    """把多条情景档拼成一段注入文本（控制总长）。

    参数：
        episodes  : 档列表（dict / MemoryItem 都行）；非情景档会被静默跳过
        max_chars : 总字数上限，None 用 EPISODE_INJECT_MAX_CHARS
        max_items : 最多几段，None 用 EPISODE_INJECT_MAX_ITEMS

    返回：拼接好的文本；没有可用档返回 ""。

    预算策略（跟 inject_pack 一致：装不下就跳过、不截断半条）：
        逐条累加，超过 max_chars 就**停止**（不留半条残缺的经历）。
        宁可少讲一段，也不要给模型一段被砍掉结尾的记忆。
    """
    picked = _pick_inject_episodes(episodes, max_chars, max_items, dedup=dedup)
    return "\n".join(build_episode_inject(ep) for ep in picked)


def recall_episodes_preview(query: str, episodes: list,
                            shortterms: list = None) -> dict:
    """一步到位：判定该不该召 → 去重 → 挑出预算内那几条 → 拼注入文本。

    这是**编排函数**，不是新能力：它只是把上面几个串起来，
    让调用方（memory_cli / 测试）不用自己记顺序。

    返回：
        {
          "triggered": bool,
          "reason":    str | None,
          "episodes":  ★ 真正被注入的那几条（不是候选全量）,
          "text":      注入文本,
          "chars":     字符数,
        }

    ★ episodes 必须跟 text 一致 —— 否则调用方按 len(episodes) 记台账、
      跟实际注入的字数对不上（实测踩到：说有 11 条，实际只注 3 条）。

    永远不抛。
    """
    ok, reason = should_recall_episodes(query)
    if not ok:
        return {"triggered": False, "reason": reason,
                "episodes": [], "text": "", "chars": 0}

    eps = [e for e in (episodes or []) if _is_episode(e)]
    # 只保留本轮该出现的：如果给了碎片，做双向去重；没给就原样
    if shortterms:
        mixed = dedup_recall(eps, shortterms)
        chosen = [x for x in mixed if _is_episode(x)]
    else:
        chosen = eps

    # ★ 用同一个选择结果产出 episodes 和 text，保证两者一致
    picked = _pick_inject_episodes(chosen)
    text = "\n".join(build_episode_inject(ep) for ep in picked)
    return {"triggered": True, "reason": reason,
            "episodes": picked, "text": text, "chars": len(text)}
