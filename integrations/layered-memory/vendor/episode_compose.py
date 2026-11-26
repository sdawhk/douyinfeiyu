# -*- coding: utf-8 -*-
"""情景档 · 内容组装层（2026-11-09 从 episode.py 拆出）

## 这里放什么

把「多轮碎片」拼成「一段能读的场景描述」的全部逻辑：

    extract_actions            从一句原文里抽圆括号动作（原样返回，一个字不改）
    _has_information           一句话有没有信息量
    _pick_informative          挑一句最有信息量的原话
    compose_content            拼成场景描述（纯规则，不调模型）
    compose_content_detailed   同上，但同时告诉你「内容够不够」
    _who_of                    从原文标记推断在场的人（只认明确标记，不猜）
    _fit_content               把几段拼成 content 并截断
    _completeness_of           「这条档有多完整」的排序键

## 依赖

只依赖 episode_base（常量 + 工具函数）。不依赖 store / recall / segment。

## 稳定性

函数体原样搬过来，一个字没改。
"""
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

# CONTENT_MAX_CHARS：episode.py 里是
#     from config import EPISODE_MAX_CHARS as CONTENT_MAX_CHARS
#   （失败时兜底 500）。这里照抄同样的逻辑。
try:
    from config import EPISODE_MAX_CHARS as CONTENT_MAX_CHARS
except Exception:
    CONTENT_MAX_CHARS = 500

from episode_base import (
    ACTION_MAX_COUNT, ACTION_MIN_LEN, ACTION_MAX_LEN, _ACTION_RE,
    SPARSE, MIN_CONTENT_CHARS, _FILLER_CHARS,
    _SPEAKER_RE, _QUOTE_RE, _SYSNOISE_RE, _SYS_NOISE_SEG_RE,
    _attr, _content_of, _ts_of,
)

def extract_actions(text: str) -> List[str]:
    """从一句原文里抽圆括号动作（**原样返回，一个字都不改**）。"""
    out = []
    for act in _ACTION_RE.findall(str(text or "")):
        act = act.strip()
        if ACTION_MIN_LEN <= len(act) <= ACTION_MAX_LEN:
            out.append(act)
    return out


def _has_information(s: str) -> bool:
    """一句话有没有信息量。

    判据（都要满足）：
      · 去掉标点后长度 >= 6
      · 不是「同一个字重复」（嗯嗯嗯嗯 / 哈哈哈哈哈）
      · 不全是语气/应答字
    """
    core = re.sub(r"[\s\W_]+", "", str(s or ""))
    if len(core) < 6:
        return False
    # 同一个字重复 >= 60% 就是噪声
    if core and (max(core.count(ch) for ch in set(core)) / len(core)) >= 0.6:
        return False
    # 全是语气字 → 没信息
    meaningful = [ch for ch in core if ch not in _FILLER_CHARS]
    return len(meaningful) >= 4


def _pick_informative(turns) -> str:
    """从原文里挑一句**有信息量**的原话（已剥掉说话人和引用）。

    打分（越高越好）：
        · 长度落在 8~60 字最舒服（太短没信息，太长塞不下）
        · 有信息量（_has_information）
    取分最高的那句；全都不过关就返回 ""（调用方标 sparse，不硬摘）。
    """
    best, best_score = "", -1.0
    for t in turns or []:
        raw = _content_of(t)
        # 剥壳子：引用块 → 说话人标记 → 系统噪声
        raw = _QUOTE_RE.sub("", raw)
        raw = _SPEAKER_RE.sub("", raw)
        raw = _SYSNOISE_RE.sub("", raw)
        # 按 / 、 ； 和句末标点分段，逐句挑
        for seg in re.split(r"[/／；;]|(?<=[。！？])", raw):
            seg = seg.strip().strip("。，,、")
            if not seg or not _has_information(seg):
                continue
            if _SYS_NOISE_SEG_RE.search(seg):
                continue                             # 剩下的是系统消息，跳过
            n = len(seg)
            if 8 <= n <= 60:
                score = 1.0 - abs(n - 30) / 60.0     # 越接近 30 字越高
            elif n < 8:
                score = 0.2
            else:
                score = 0.4                          # 太长，会被截断
            if score > best_score:
                best, best_score = seg, score
    return best


def compose_content_detailed(turns, theme):
    """跟 compose_content 同逻辑，但**同时告诉你「内容够不够」**。

    返回 (content, source)：
        source = "generated"  —— 从动作拼出来的（有动作描写）
                 "extracted"  —— 动作抽不到，退而摘了原话
                 SPARSE       —— 什么都没抽到，content 只有元信息

    为什么要分开返回：
        下游（去重 / 召回 / 注入 / 统计）必须能区分「这条档有内容」
        和「这条档只有时间戳」。混在一起就会出现实测那个问题：
        7 条空档两两相似度 0.955~0.959 —— 相似不是因为重复，是因为都空。
    """
    turns = list(turns or [])
    if not turns:
        return "", SPARSE

    ts = _ts_of(turns[0]) or time.time()
    when = time.strftime("%m-%d %H:%M", time.localtime(ts))
    theme_str = str(theme) if theme else "一段对话"

    # ① 先抽动作（原文照抄，不改写）
    actions: List[str] = []
    for t in turns:
        for act in extract_actions(_content_of(t)):
            if act not in actions:
                actions.append(act)

    head = f"{when}，{theme_str}（{len(turns)} 轮）"
    parts = [head]

    # Keep the speakers together. A bare sentence loses whether it was a
    # user fact, a question, or the assistant's response.
    dialogue = ""
    ranked = sorted(turns, key=lambda t: float(_attr(t, "importance", 0) or 0), reverse=True)
    for turn in ranked:
        match = re.search(r"他说[:：]([\s\S]*?)[；;]\s*我回[:：]([\s\S]*)", _content_of(turn))
        if match and _has_information(match[1]) and not _SYS_NOISE_SEG_RE.search(match[1]):
            his, mine = (part.strip() for part in match.groups())
            if mine:
                dialogue = f"他说：{his[:120]}；我回：{mine[:120]}"
                break

    if actions:
        parts.append("、".join(f"（{a}）" for a in actions[:ACTION_MAX_COUNT]))
        if dialogue:
            parts.append(f"〔原话〕{dialogue}")
        return _fit_content(parts), "generated"

    if dialogue:
        parts.append(f"〔原话〕{dialogue}")
        return _fit_content(parts), "extracted"

    # ② 抽不到动作 → 退而摘一句原话（2026-11-08：修 41% 空档）
    said = _pick_informative(turns)
    if said:
        # 〔原话〕前缀是**来源标注**，跟（动作描写）视觉上区分开：
        # 括号 = 原文的动作描述；〔〕= 原文的对白摘录。
        parts.append(f"〔原话〕{said[:60]}")
        return _fit_content(parts), "extracted"

    # ③ 真的没有信息量 → 不硬摘，如实留空
    return _fit_content(parts), SPARSE


def _fit_content(parts: List[str]) -> str:
    """把几段拼成 content，并做长度截断。"""
    result = "。".join(p.rstrip("。") for p in parts if p)
    if len(result) > CONTENT_MAX_CHARS:
        # 截断按字数硬截，但别把括号截成半截 —— 能退回最后一个完整括号就退回
        cut = result[:CONTENT_MAX_CHARS]
        last = max(cut.rfind("）"), cut.rfind("）。"))
        result = cut[:last + 1] if last > CONTENT_MAX_CHARS // 2 else cut
    return result


def compose_content(turns, theme) -> str:
    """把多轮碎片拼成场景描述。纯规则，不调模型。

    产出形如：
        11-07 19:44，做饭（6 轮）。（穿上围裙开始备菜）、
        （将蔬菜放进锅里）、（端出汤碗）

    没有动作描写时退而摘原话：
        04-12 09:10，闲聊（1 轮）。〔原话〕我看到清单已经整理完毕

    真的没有信息量时只留元信息（这时 content_source = 'sparse'，见 detailed 版）：
        11-08 11:00，闲聊（2 轮）

    为什么带上「6 轮」：注入时用户要知道这句话背后有多少原文，
    轮数是最短的可信度提示（设计 5.3 要求给出条数）。

    ⚠️ 想知道这条 content 是「拼的 / 摘的 / 空的」，用 compose_content_detailed()。
       本函数只返回字符串，丢掉了 source 信息 —— 它对下游不够用。
    """
    return compose_content_detailed(turns, theme)[0]


def _who_of(mems: List[Any]) -> List[str]:
    """从原文标记推断在场的人。只认明确的说话标记，不猜。"""
    who = []
    joined = "\n".join(_content_of(m) for m in mems)
    if "他说" in joined or "用户" in joined:
        who.append("用户")
    if "我回" in joined or "我" in joined:
        who.append("我")
    return who or ["我"]


def _completeness_of(ep) -> tuple:
    """「这条档有多完整」的排序键，越大越完整。

    为什么先比 source_turns 再比 content 长度：
      source_turns 是「这条档覆盖了几轮原文」，是结构性的完整度；
      content 长度会受动作提取数量影响，更容易被格式波动干扰。
    最后用 -create_time（越早越大）做稳定兜底，保证结果可复现。
    """
    turns = _attr(ep, "source_turns", []) or []
    content = str(_attr(ep, "content", "") or "")
    ts = _ts_of(ep)
    return (len(turns), len(content), -ts)
