# -*- coding: utf-8 -*-
"""反思机制 reflection.py —— 从「做过的事」提炼「我的理解」（T17，2026-11-08）

## 它解决什么

    输入：某天的 5 条情景/事件记忆
      「他说我做饭好吃」
      「他说我烫到手了要小心」
      「他说我今天很温柔」

    输出：1 条反思
      「做饭的时候，他说：小心烫。对方留意到了这个细节。」

## 和 lessons 的分工（这是两份不同的东西，别合成一个）

    lessons    从「看到/听到的东西」提炼「做事准则」  → 面向未来，能照着做
    reflection 从「做过的事」提炼「我的理解」          → 面向自我，是「我想通了什么」

    例：同一天同一批记忆
      lessons    → 「删除与权限：删东西要先问他同意」
      reflection → 「干活的时候，一旦发现是没问就动手…下次先想一步再动手。」

## 为什么用规则，不用模型

跟 lessons.py 同一个原因，且是**实测确认**的：
GET http://127.0.0.1:11434/api/tags 返回的 capabilities 只有 ["embedding"] ——
本机 ollama 只有 bge-m3 嵌入模型，没有对话模型。
所谓「让模型回顾今天我学到了什么」在这里会直接抛异常。

所以反思这样拼（**三段式**，每一段都可审计）：

    ① 场景   —— 这一天主要是什么事（主题词表判定）
    ② 亮点   —— 那天情绪最强的那一件事，**原文摘句**，一个字不改
    ③ 理解   —— 从检测到的信号里挑一句固定的自省话
                （他关心我 / 他夸我 / 有约定 / 栽了跟头 / 平常的一天）

    ② 是原文，①③ 是归纳 —— 所以 content_source 标 generated，
    content_confidence 标 medium，任何时候都能顺着 source_mems 回原文核对。

## 为什么本模块不 import lessons

两个原因：
  ① 项目硬约定：新模块只 import L1/L2（config / schema），防止循环依赖；
  ② lessons 是「按主题」聚合，reflection 是「按天」聚合 + 情绪/自省判断，
     两者共享的只有几行主题词表。共用模块会让任何一个改动同时踩两个功能，
     而它们的失效方式不一样（lessons 漏提炼 = 少条经验；reflection 误提炼 =
     编造出一段没发生过的自我理解 —— 后者贵得多）。

## 三条硬规则

    ① 只写不读     —— 这一阶段反思**不参与召回**，先攒数据观察质量
    ② 料不够就不反思 —— 那天 event/episode 类记忆 < REFLECT_MIN_MEMS 条就返回 None
    ③ 不改原文     —— 摘出来的那一句是原文切片，不润色、不补写

## 字段（复用现有 schema，不新增死字段）

    mem_type           = "reflection"
    category           = "reflect"
    source_turns       = 那天支撑反思的原文 mem_id（复用 episode 字段）
    content_source     = "generated"
    content_confidence = "medium"
    scene              = {"date": "2026-11-07", "mems": 14, "signals": [...], "emotion": "positive"}

## 用法

    python reflection.py                  # 自检（跟不传参数一样）
    python reflection.py run              # 看今天的（料不够会明说）
    python reflection.py run 2026-11-07   # 看指定日期
    python reflection.py run --save       # 跑完写库（每天最多 1 条）

    from reflection import should_reflect, gather_day_memories, extract_reflection, save_reflection
    day = gather_day_memories(mems)               # 筛出今天的 event 类记忆
    if should_reflect(day):
        r = extract_reflection(day)               # 提炼
        save_reflection(r)                        # 写库
"""

from common.locking import NullLock
import hashlib
import json
import os
import re
import sys
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
#
# 中文 Windows 终端默认 GBK，print 中文/emoji 直接 UnicodeEncodeError 崩掉。
# 必须在任何输出前设置编码。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ═══════════════════════════════════════════════════════════════════
# 依赖：只 import L1/L2（config / schema）
# ═══════════════════════════════════════════════════════════════════
from config import (                      # noqa: E402
    LONG_TERM_ACTIVE_PATH,
    SHORT_TERM_PATH,
    LOCK_FILE_PATH,
    REFLECT_MIN_MEMS,
    REFLECT_MAX_CHARS,
    REFLECT_MAX_PER_DAY,
)
from schema import MemoryItem, classify_importance   # noqa: E402

try:
    from filelock import FileLock
except Exception:
    FileLock = None


# ═══════════════════════════════════════════════════════════════════
# 一、什么算「那天发生过的事」
#
# 判据两层（顺序不能反）：
#   ① 已经标好的：mem_type == "episode"（情景档）或 category == "event"
#   ② 没标的：用 schema.classify_importance 现场判一次 —— 真实库里
#      **大部分事件记忆的 category 是空串**（桥接自动写入的没填 category），
#      只认 ① 的话 2026-11-07 那天 14 条事件会一条都捞不出来。
#
# 为什么不把 commitment / date 也算「事」：
#   那些是「约定」，反思该想的是「我做了什么、我怎么想的」，
#   把约定算进来会让反思变成对账。
# ═══════════════════════════════════════════════════════════════════
EVENT_CATEGORIES = ("event", "episode")


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        v = obj.get(name, default)
    else:
        v = getattr(obj, name, default)
    return default if v is None else v


def _content_of(m: Any) -> str:
    return str(_attr(m, "content", "") or "")


def _id_of(m: Any) -> str:
    return str(_attr(m, "mem_id", "") or "")


def _ts_of(m: Any) -> float:
    for f in ("create_time", "last_active", "last_mentioned_at"):
        try:
            v = float(_attr(m, f, 0) or 0)
        except (TypeError, ValueError):
            v = 0.0
        if v > 0:
            return v
    return 0.0


def date_of(m: Any) -> str:
    """这条记忆属于哪个自然日（本地时区）。"""
    ts = _ts_of(m)
    if ts <= 0:
        return ""
    try:
        return time.strftime("%Y-%m-%d", time.localtime(ts))
    except (ValueError, OSError):
        return ""


def today_str() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def is_event_like(m: Any) -> bool:
    """这条算不算「那天发生过的事」。"""
    content = _content_of(m).strip()
    if not content:
        return False
    if str(_attr(m, "mem_type", "") or "") == "episode":
        return True
    cat = str(_attr(m, "category", "") or "").strip().lower()
    if cat in EVENT_CATEGORIES:
        return True
    if cat:                       # 已经明确标成别的类（fact / notes / speech…）就尊重它
        return False
    try:
        guessed = classify_importance(content, str(_attr(m, "source", "") or ""))[0]
    except Exception:
        return False
    return guessed == "event"


# ═══════════════════════════════════════════════════════════════════
# 二、取某天的记忆
# ═══════════════════════════════════════════════════════════════════


def _load_memories(path: str) -> List[MemoryItem]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    out = []
    for d in (data.get("memories") or []):
        try:
            out.append(MemoryItem.from_dict(d))
        except Exception:
            continue
    return out


def gather_day_memories(memories: Optional[Iterable[Any]] = None,
                        date: Optional[str] = None,
                        include_shortterm: bool = True) -> List[Any]:
    """取某天的 event / episode 类记忆。

    参数（几种调用方式都支持）：
        gather_day_memories()                    → 今天，从磁盘读
        gather_day_memories(mems)                → 今天，从给的那批里筛
        gather_day_memories(mems, "2026-11-07")  → 指定日期

    磁盘口径 = active.json + shortterm.json：
      短期层里也有「今天发生过什么」，只读长期库会把今天读成空的
      （老事件在长期库，上线后新事件先进短期层，两边都要看）。
    """
    day = date or today_str()
    pool: List[Any] = []
    if memories is None:
        pool.extend(_load_memories(LONG_TERM_ACTIVE_PATH))
        if include_shortterm:
            pool.extend(_load_memories(SHORT_TERM_PATH))
    else:
        pool.extend(list(memories))

    picked = []
    for m in pool:
        if date_of(m) != day:
            continue
        if not is_event_like(m):
            continue
        picked.append(m)
    picked.sort(key=_ts_of)
    return picked


def should_reflect(date_or_memories: Any = None,
                   memories: Optional[Iterable[Any]] = None,
                   date: Optional[str] = None) -> bool:
    """今天够不够料做反思（>= REFLECT_MIN_MEMS 条 event 类记忆）。

    三种调用方式：
        should_reflect(day_list)        # 已经筛好的那批（验收脚本这么调）
        should_reflect(date="2026-11-07")
        should_reflect()                # 今天
    """
    # 第一个位置参数既可能是「那批记忆」也可能是「日期字符串」，按类型分
    if isinstance(date_or_memories, (list, tuple, set)):
        mems = list(date_or_memories)
    elif isinstance(date_or_memories, str):
        date = date_or_memories
        mems = gather_day_memories(memories, date)
    elif date_or_memories is None:
        mems = gather_day_memories(memories, date)
    else:                                    # 生成器 / 其它可迭代
        mems = [m for m in date_or_memories]
    usable = [m for m in mems if is_event_like(m) and _content_of(m).strip()]
    return len(usable) >= int(REFLECT_MIN_MEMS)


# ═══════════════════════════════════════════════════════════════════
# 三、信号检测：这一天里发生了什么「值得想一想」的事
#
# 全是词表。每条信号都对应一句固定的自省话（见 INSIGHTS），
# 这样「检测到什么 → 说什么」是可以对账的，不是随口生成。
# ═══════════════════════════════════════════════════════════════════

SIGNAL_WORDS: Dict[str, Tuple[str, ...]] = {
    # 他在照顾我 / 提醒我
    "cared": ("小心", "注意点", "别烫", "烫到", "别累", "早点睡", "听话",
              "心疼", "困不困", "累不累", "慢点", "别急"),
    # 他夸我 / 认可我
    #   2026-11-08 实测：原来收了「乖」，结果「他说：乖乖」「乖乖缩回去」全命中 ——
    #   前者是他叫我，后者是副词，都不是「他夸我」。改成只收明确的夸奖词。
    "praised": ("好吃", "真棒", "厉害", "温柔", "可爱", "做得不错",
                "夸", "好看", "真乖", "好乖"),
    # 有约定 / 答应他的事
    "promised": ("答应", "说定", "约好", "承诺", "保证"),
    # 我栽了跟头 / 想通了
    #   实测去掉两处假阳性：
    #     「错了」——「那我说错了」是在纠正一句话，不是教训；
    #     「以后」——「00:30 以后」是时间后缀（lessons 那边靠正则守卫，
    #       这边是子串匹配，守卫不了，索性不要这个词）。
    "learned": ("发现", "原来", "才知道", "才发现", "教训", "走不通", "别再"),
    # 我们一起做了什么
    "together": ("一起", "我们", "陪我", "牵着", "挨着", "靠着"),
}

# 检测到信号之后说哪句话。
# 刻意写得**克制**：规则版能看出的只是「那天的语气和主题」，
# 看不出「我为什么那样想」——所以只写到「我注意到了什么」为止，
# 不写「我终于懂了」这种它根本没有依据的话。
INSIGHTS: Dict[str, str] = {
    "cared": "这次对话里，对方主动关照了一件小事。",
    "praised": "这次反馈里有明确的肯定。",
    "promised": "有一项约定需要在下次碰面时跟进。",
    "learned": "今天栽了个跟头，下次先想一步再动手。",
    "together": "今天一起完成了一件日常小事。",
    "plain": "今天过得平平的，可我还是都收着了。",
}

# 主题词表（跟 lessons 的同名能力各维护一份，理由见文件头）
THEME_WORDS: List[Tuple[str, Tuple[str, ...]]] = [
    ("做饭", ("做饭", "下个面", "煎蛋", "水开", "围裙", "粥", "煮")),
    ("吃饭", ("吃饭", "火锅", "外卖", "汤都喝光", "吃了")),
    ("睡觉", ("睡觉", "晚安", "早点睡", "熬夜", "困", "醒")),
    ("画画", ("画图", "出图", "提示词", "生成", "lora")),
    ("说话", ("说话", "语气", "括号", "口吻")),
    ("干活", ("改代码", "写代码", "跑通", "插件", "脚本", "工具", "修", "部署")),
    ("短视频", ("短视频", "刷到", "评论", "分享卡片")),
    ("腻在一起", ("亲", "抱", "搂", "怀里", "凑过去", "贴")),
    ("出门", ("出门", "路上", "学校", "上课", "回来")),
]

# 排序优先级：关心 > 夸 > 约定 > 长进 > 陪伴
SIGNAL_ORDER = ["cared", "praised", "promised", "learned", "together"]


def detect_signals(memories: Iterable[Any]) -> List[str]:
    """返回命中的信号，按「命中条数 + 固定优先级」排序。"""
    counts: Dict[str, int] = {}
    for m in memories:
        c = _content_of(m)
        if not c:
            continue
        for sig, words in SIGNAL_WORDS.items():
            if any(w in c for w in words):
                counts[sig] = counts.get(sig, 0) + 1
    return sorted(counts,
                  key=lambda s: (-counts[s], SIGNAL_ORDER.index(s) if s in SIGNAL_ORDER else 99))


def theme_of_day(memories: Iterable[Any]) -> str:
    """那天主要是什么事（命中不了就返回空串）。"""
    counts: Dict[str, int] = {}
    for m in memories:
        c = _content_of(m).lower()
        for name, words in THEME_WORDS:
            if any(w.lower() in c for w in words):
                counts[name] = counts.get(name, 0) + 1
                break                    # 一条记忆只投一票，避免一条长句占满
    if not counts:
        return ""
    return max(counts.items(), key=lambda kv: kv[1])[0]


# ═══════════════════════════════════════════════════════════════════
# 四、摘「亮点」：那天最值得记住的那一件事
#
# 优先级：情绪强度高的 > 内容长的（长的一般是完整事件）> 时间靠后的。
# 为什么用「情绪强度」而不是向量：反思要的是「哪件事让我有感觉」，
# 情绪强度是库里现成的、有语义的字段；向量在短句上分不开（同 episode.py 实测）。
# ═══════════════════════════════════════════════════════════════════

# 摘句时剥掉的壳子（日期戳）
_SHELL = [
    re.compile(r"^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?[：:\s]*"),
    re.compile(r"^\d{1,2}[/月]\d{1,2}[日号]?[：:\s]*"),
]


def _clean(text: str) -> str:
    t = str(text or "").strip()
    for pat in _SHELL:
        t = pat.sub("", t)
    return t.strip(" ，,、·-—\n")


def _clip(text: str, limit: int) -> str:
    t = str(text or "").strip()
    if len(t) <= limit:
        return t
    head = t[:limit]
    for sep in "，,、；;：:":
        idx = head.rfind(sep)
        if idx >= limit // 2:
            return head[:idx] + "…"
    return head + "…"


# 这些内容不是「那天发生的事」，是系统的噪声 —— 不参与亮点评选：
#   [拍一拍] / [图片] / [语音] / [表情] / [转发消息 …] / [引用 …] 都是桥接塞进来的占位符，
#   资讯日报是插件值班流程写的流水账。
#   2026-11-08 实测：不过滤的话，11-07 的「亮点」会选成
#   「他说：[引用 assistant：…]为什么看着屏幕笑」—— 一条带引用壳子的半截话。
_NOISE_MARKS = ("[拍一拍]", "戳了戳", "[图片]", "[语音]", "[表情]",
                "[转发消息", "[引用", "刷短视频", "资讯日报", "[文件]")

# 含有这些词的内容偏「排障/台账」，当反思的亮点不合适（它们是 lessons 的料）
_LEDGER_MARKS = ("index.js", "schemastery", "traceback", "报错", "ERR_", "日志")


def _is_noise(text: str) -> bool:
    if not text:
        return True
    return any(mark in text for mark in _NOISE_MARKS)


def pick_highlight(memories: Iterable[Any], limit: int = 60) -> Tuple[str, Any]:
    """挑出那天最值得记住的那一件事（返回 (原句, 来源记忆)）。

    三级筛选：
      ① 去掉系统噪声（占位符 / 日报流水）
      ② 优先不含排障台账词的（那些属于 lessons 的料，不是「我的理解」）
      ③ 在剩下的里面按「情绪强度 > 长度 > 时间」挑
    """
    cleaned = [(m, _clean(_content_of(m))) for m in memories]
    cleaned = [(m, c) for m, c in cleaned if c and not _is_noise(c)]
    if not cleaned:
        return "", None
    no_ledger = [(m, c) for m, c in cleaned if not any(k in c for k in _LEDGER_MARKS)]
    if no_ledger:
        cleaned = no_ledger

    best, best_rank, best_mem = "", None, None
    for m, c in cleaned:
        try:
            emo = float(_attr(m, "emotion_intensity", 0) or 0)
        except (TypeError, ValueError):
            emo = 0.0
        rank = (emo, len(c), _ts_of(m))
        if best_rank is None or rank > best_rank:
            best, best_rank, best_mem = c, rank, m
    if not best:
        return "", None
    return _clip(best, limit), best_mem


# ═══════════════════════════════════════════════════════════════════
# 五、提炼一条反思
# ═══════════════════════════════════════════════════════════════════


def _stable_reflection_id(day: str) -> str:
    """一天一条，id 由日期派生 —— 重跑覆盖，不会攒出一堆重复反思。"""
    return "refl_" + hashlib.sha1(day.encode("utf-8")).hexdigest()[:12]


def extract_reflection(memories: Iterable[Any], date: Optional[str] = None) -> Optional[dict]:
    """提炼一条反思（规则版）。料不够返回 None。

    返回：
      {"content": "...",
       "source_mems": [...],
       "date": "2026-11-08",
       "mem_id": "refl_xxxxxxxx",
       "topic": "做饭",
       "why": "...",                                    # 可审计：为什么这么说
       "confidence": "medium",
       "scene": {"date": ..., "mems": N, "signals": [...], "emotion": "positive"}}
    """
    mems = [m for m in (memories or []) if is_event_like(m) and _content_of(m).strip()]
    if len(mems) < int(REFLECT_MIN_MEMS):
        return None

    day = date or date_of(mems[-1]) or today_str()
    mems.sort(key=_ts_of)

    signals = detect_signals(mems)
    topic = theme_of_day(mems)
    highlight, src_mem = pick_highlight(mems)

    # 情绪：那天最强烈的那个极性
    emos = []
    for m in mems:
        try:
            emos.append((float(_attr(m, "emotion_intensity", 0) or 0),
                         str(_attr(m, "emotion_valence", "neutral") or "neutral")))
        except (TypeError, ValueError):
            continue
    emotion = max(emos)[1] if emos else "neutral"

    # ── 三段式：场景 → 亮点 → 理解
    text = (topic + "的时候，" if topic else "今天，")
    if highlight:
        text += highlight
        if not text.endswith(("。", "！", "？", "…", "~")):
            text += "。"
    insight_key = signals[0] if signals else "plain"
    text += INSIGHTS.get(insight_key, INSIGHTS["plain"])
    text = _clip(text, int(REFLECT_MAX_CHARS))

    source_ids = [i for i in (_id_of(m) for m in mems) if i]
    src_ts = float(_ts_of(src_mem)) if src_mem is not None else 0.0
    return {
        "content": text,
        "source_mems": source_ids,
        "date": day,
        "mem_id": _stable_reflection_id(day),
        "topic": topic,
        "why": ("那天 %d 条事件；信号 %s；亮点取自 %s"
                % (len(mems), "/".join(signals) or "无",
                   (_id_of(src_mem) if src_mem is not None else "无"))),
        "confidence": "medium",
        "scene": {
            "date": day,
            "mems": len(mems),
            "signals": signals,
            "emotion": emotion,
            "theme": topic,
            "source_of_highlight": src_ts,
        },
    }


# ═══════════════════════════════════════════════════════════════════
# 六、写库（只写不读）
# ═══════════════════════════════════════════════════════════════════


def _load_json_or_empty(path: str) -> dict:
    if not os.path.exists(path):
        return {"memories": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"memories": []}
        data.setdefault("memories", [])
        return data
    except Exception as e:
        # 读坏了不能把库覆盖成空的 —— 直接抛，让调用方记 reflection_error
        raise RuntimeError("读 %s 失败: %s" % (os.path.basename(path), e))


def _atomic_write_json(path: str, data: dict) -> None:
    """原子写 —— 转发到 atomic_io.atomic_write_json（2026-11-08 收敛）。

    原来这里自己抄了一份（不能 import memory_manager，那是 L3）。
    现在逻辑在 atomic_io（只依赖标准库），不会再制造循环依赖。

    sweep=False：不顺手清陈旧 tmp（那件维护者还没定）。
    """
    from atomic_io import atomic_write_json
    atomic_write_json(path, data, sweep=False)

class _NullLock(NullLock):
    """空锁 —— 转发到 common.locking.NullLock（2026-11-09 收敛）。

    原来这里自己写了一份 6 行的空锁，跟另外 5 个模块各写一遍。
    """


def _file_lock():
    """跟 memory_manager / 巩固流程同一把锁（2026-11-09 收敛到 common.locking）。"""
    from common.locking import memory_lock
    return memory_lock()


def _attach_embedding(item: MemoryItem) -> None:
    """算向量。失败不影响写库。"""
    try:
        from ollama_embedding import get_embedding
        vec = get_embedding(item.content)
        if vec and any(float(x) != 0.0 for x in vec):
            item.embedding = list(vec)
            item.embed_status = "ok"
        else:
            item.embedding = []
            item.embed_status = "pending"
    except Exception:
        item.embedding = []
        item.embed_status = "failed"


def _to_memory_item(refl: dict) -> MemoryItem:
    """反思 dict → MemoryItem（字段全部复用现有 schema）。"""
    content = str(refl.get("content") or "").strip()
    day = str(refl.get("date") or today_str())
    item = MemoryItem(
        content,
        mem_type="reflection",
        category="reflect",
        tags=["反思", day],
        importance=0.72,          # 地板 43：跟经验同档，不会被时间磨没
        strength=100.0,
        consolidation_level=3,    # 2 分/天
        source="reflection_extract",
        ttl=365 * 86400,
    )
    item.mem_id = str(refl.get("mem_id") or _stable_reflection_id(day))
    item.source_turns = list(refl.get("source_mems") or [])
    item.content_source = "generated"
    item.content_confidence = str(refl.get("confidence") or "medium")
    item.scene = dict(refl.get("scene") or {})
    item.embed_status = "pending"
    # 把「那天的事」锚在那天最后一件事的时间上，而不是写库时刻 ——
    # 否则 30 天后回看，所有反思都显示成「今天写的」。
    ts = float((refl.get("scene") or {}).get("source_of_highlight") or 0.0)
    if ts > 0:
        item.create_time = ts
        item.last_active = ts
        item.last_mentioned_at = ts
    return item


def _row_date(row: dict) -> str:
    """从落盘行里取「这条反思是哪天的」（tags 里的日期优先）。"""
    for tag in (row.get("tags") or []):
        if isinstance(tag, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", tag):
            return tag
    scene = row.get("scene") or {}
    if isinstance(scene, dict) and scene.get("date"):
        return str(scene.get("date"))
    return ""


def build_reflection_item(reflection: dict, existing_rows: Iterable[dict],
                           embed: bool = True) -> Optional[MemoryItem]:
    """算出「这次该不该新写这条反思」；该写返回 MemoryItem，否则 None。

    **纯内存、不碰磁盘、不加锁**。理由同 lessons.build_lesson_items：
      每日巩固流程已经持有 memory_data.lock，在里面调 save_reflection 会二次加锁
      → filelock 抛 RuntimeError: Deadlock（episode.save_episode 踩过这个坑）。
      巩固流程用本函数拿 item，自己 append、最后统一写盘。

    三条纪律（都在这里）：
      ① 那天已有反思 → None（一天一条，重跑覆盖不了也不追加）
      ② 每天上限 REFLECT_MAX_PER_DAY
      ③ 空内容 → None
    """
    if not isinstance(reflection, dict) or not str(reflection.get("content") or "").strip():
        return None
    day = str(reflection.get("date") or today_str())
    mid = str(reflection.get("mem_id") or _stable_reflection_id(day))

    existing = [m for m in (existing_rows or [])
                if isinstance(m, dict) and str(m.get("mem_type") or "") == "reflection"]
    for m in existing:
        if str(m.get("mem_id") or "") == mid or _row_date(m) == day:
            return None                      # 那天已有
    used_today = sum(1 for m in existing if _row_date(m) == day)
    if int(REFLECT_MAX_PER_DAY) > 0 and used_today >= int(REFLECT_MAX_PER_DAY):
        return None

    refl = dict(reflection)
    refl["mem_id"] = mid
    refl["date"] = day
    item = _to_memory_item(refl)
    if embed:
        _attach_embedding(item)
    return item


def save_reflection(reflection: dict, path: Optional[str] = None) -> str:
    """存进 active.json（mem_type='reflection'，category='reflect'）。返回 mem_id。

    三条纪律：
      ① 一天最多 REFLECT_MAX_PER_DAY 条
      ② 幂等 —— 那天已经有反思就不再写（返回已有的 id）
      ③ 只写不读 —— 写进去之后没有任何召回代码读它
    """
    if not isinstance(reflection, dict) or not str(reflection.get("content") or "").strip():
        return ""
    day = str(reflection.get("date") or today_str())
    mid = str(reflection.get("mem_id") or _stable_reflection_id(day))
    refl = dict(reflection)
    refl["mem_id"] = mid

    target = path or LONG_TERM_ACTIVE_PATH
    with _file_lock():
        data = _load_json_or_empty(target)
        mems = data.get("memories") or []
        item = build_reflection_item(refl, mems)
        if item is None:
            # 那天已有 → 返回已有的 id（幂等）；撞到上限 → 返回空串
            for m in mems:
                if not isinstance(m, dict) or str(m.get("mem_type") or "") != "reflection":
                    continue
                if str(m.get("mem_id") or "") == mid or _row_date(m) == day:
                    return str(m.get("mem_id") or mid)
            return ""
        mems.append(item.to_dict())
        data["memories"] = mems
        _atomic_write_json(target, data)
    return mid


# ═══════════════════════════════════════════════════════════════════
# 七、一步到位（给 daily_consolidation 用的入口）
# ═══════════════════════════════════════════════════════════════════


def run_for_day(date: Optional[str] = None,
                memories: Optional[Iterable[Any]] = None,
                save: bool = True) -> dict:
    """跑某一天的反思。返回统计（键**全部预置**，便于区分「没跑」和「跑了没货」）。

    ★ 三态约定（跟 daily_consolidation._new_stats 一致）：
        值 = 0    → 跑了，没东西处理（正常）
        键不出现   → 这段代码没跑到（问题）
    """
    stats = {
        "date": date or today_str(),
        "day_mems": 0,      # 那天的 event/episode 条数
        "reflected": 0,     # 提炼成功 0/1
        "saved": 0,         # 真正写库的条数
        "reflection_id": "",
        "reason": "",       # 没提炼时说明原因
    }
    mems = gather_day_memories(memories, date)
    stats["day_mems"] = len(mems)
    if not should_reflect(mems):
        stats["reason"] = ("那天只有 %d 条 event 类记忆，少于 %d 条，不反思"
                           % (len(mems), REFLECT_MIN_MEMS))
        return stats
    refl = extract_reflection(mems, date)
    if not refl:
        stats["reason"] = "提炼返回空（料不够或内容太短）"
        return stats
    stats["reflected"] = 1
    stats["reflection_id"] = refl.get("mem_id") or ""
    stats["reason"] = refl.get("why") or ""
    if save:
        mid = save_reflection(refl)
        stats["saved"] = 1 if mid else 0
        if mid:
            stats["reflection_id"] = mid
    return stats


# ═══════════════════════════════════════════════════════════════════
# 八、命令行入口
# ═══════════════════════════════════════════════════════════════════


def _cli(argv: List[str]) -> int:
    if "selftest" in argv or not ({"run", "--save"} & set(argv)):
        selftest()
        return 0

    date = next((a for a in argv if re.match(r"^\d{4}-\d{2}-\d{2}$", a)), None)
    mems = gather_day_memories(None, date)
    day = date or today_str()
    print("%s 的 event 类记忆 %d 条（门槛 %d）" % (day, len(mems), REFLECT_MIN_MEMS))
    if not should_reflect(mems):
        print("料不够，不反思")
        return 0
    refl = extract_reflection(mems, date)
    if not refl:
        print("提炼不出（内容太短）")
        return 0
    print("反思[%s]：%s" % (refl["date"], refl["content"]))
    print("  依据 %d 条 | %s" % (len(refl["source_mems"]), refl["why"]))
    if "--save" in argv:
        mid = save_reflection(refl)
        print("写库: %s" % (mid or "（那天已有，未重复写）"))
    return 0


# ═══════════════════════════════════════════════════════════════════
# 九、自检（不依赖真实数据、不联网）
# ═══════════════════════════════════════════════════════════════════


def _mk(content: str, ts: float, **kw) -> MemoryItem:
    m = MemoryItem(content, mem_type="long_term", **kw)
    m.create_time = ts
    m.last_active = ts
    m.last_mentioned_at = ts
    return m


def selftest() -> None:
    base_ts = time.mktime(time.strptime("2026-11-07 19:44:00", "%Y-%m-%d %H:%M:%S"))
    day = "2026-11-07"

    # ── ① 事件判定：他说/我回 = 事件；纯事实不算
    assert is_event_like(_mk("他说：好吃吗；我回：（点头）好吃", base_ts)) is True
    assert is_event_like(_mk("朋友的生日是2月13日", base_ts)) is False, "事实不该算「那天发生的事」"
    assert is_event_like(_mk("", base_ts)) is False
    ep = _mk("那天一起做了饭", base_ts)
    ep.mem_type = "episode"
    assert is_event_like(ep) is True, "情景档一律算事件"

    # ── ② gather：按自然日筛
    ms = [
        _mk("他说：好吃；我回：（笑）", base_ts),
        _mk("他说：小心烫；我回：知道啦", base_ts + 60),
        _mk("他说：今天很温柔；我回：（脸红）", base_ts + 120),
        _mk("他说：好吃；我回：（笑）", base_ts + 86400),      # 第二天，不该进
        _mk("朋友的生日是2月13日", base_ts + 30),               # 事实，不该进
    ]
    got = gather_day_memories(ms, day)
    assert len(got) == 3, "那天应有 3 条事件，实际 %d" % len(got)
    assert all(date_of(m) == day for m in got)

    # ── ③ should_reflect：>= 3 条才反思
    assert should_reflect(got) is True
    assert should_reflect(got[:2]) is False, "只有 2 条不该反思"
    assert should_reflect([]) is False
    # 也支持直接传日期字符串
    assert should_reflect(day, memories=ms) is True
    assert should_reflect("2026-01-01", memories=ms) is False

    # ── ④ 信号检测
    sig = detect_signals(got)
    assert "cared" in sig, "「小心烫」应命中 cared，实际 %s" % sig
    assert "praised" in sig, "「很温柔」应命中 praised，实际 %s" % sig
    assert detect_signals([_mk("他说：嗯", base_ts)]) == [], "没信号时应为空"

    # ── ⑤ 提炼：三段式，亮点是原文，理解来自信号
    refl = extract_reflection(got, day)
    assert refl is not None
    for f in ("content", "source_mems", "date", "mem_id", "topic", "why", "scene"):
        assert f in refl, "反思缺字段 %s" % f
    assert refl["date"] == day
    assert len(refl["content"]) <= REFLECT_MAX_CHARS, "反思超出字数上限"
    assert len(refl["source_mems"]) == 3, refl["source_mems"]
    # 亮点必须是原文里出现过的那句（不许编）
    raw = "".join(_content_of(m) for m in got)
    parts = [p for p in re.split(r"[。，：]", refl["content"]) if len(p) >= 6]
    assert any(p in raw for p in parts), "反思里的句子必须能在原文里找到: %s" % refl["content"]
    assert refl["content"].endswith("。"), "反思要是一句完整的话"

    # 料不够 → None
    assert extract_reflection(got[:2], day) is None, "只有 2 条应返回 None"

    # ── ⑥ 写库：临时文件；幂等 + 每天最多 1 条
    import tempfile
    tmpdir = tempfile.mkdtemp(prefix="refl_selftest_")
    try:
        tmp_path = os.path.join(tmpdir, "active.json")
        mid = save_reflection(refl, path=tmp_path)
        assert mid == refl["mem_id"], "返回值应是 mem_id"
        rows = _load_json_or_empty(tmp_path)["memories"]
        assert len(rows) == 1
        row = rows[0]
        assert row["mem_type"] == "reflection" and row["category"] == "reflect"
        assert row["content_source"] == "generated"
        assert row["source_turns"] == refl["source_mems"]
        assert day in (row.get("tags") or []), "日期要进 tags（按天去重要用）"
        # 落盘再读回来，字段不能被 from_dict 丢掉（死字段坑）
        back = MemoryItem.from_dict(json.loads(json.dumps(row)))
        assert back.mem_type == "reflection" and back.source_turns == refl["source_mems"]
        assert back.scene.get("date") == day

        # 幂等：同一天再存一次 → 不新增
        mid2 = save_reflection(refl, path=tmp_path)
        assert mid2 == mid
        assert len(_load_json_or_empty(tmp_path)["memories"]) == 1, "同一天不该写第二条"

        # 换一天可以再写一条
        refl2 = dict(refl)
        refl2["date"] = "2026-11-08"
        refl2["mem_id"] = "refl_other"
        refl2["content"] = "今天，他说：晚安。这次对话里，对方主动关照了一件小事。"
        refl2["scene"] = dict(refl["scene"])
        refl2["scene"]["date"] = "2026-11-08"
        n_before = len(_load_json_or_empty(tmp_path)["memories"])
        save_reflection(refl2, path=tmp_path)
        n_after = len(_load_json_or_empty(tmp_path)["memories"])
        assert n_after == n_before + 1, "另一天应该能再写一条"

        # 空反思不写
        assert save_reflection({}, path=tmp_path) == ""
    finally:
        try:
            for fn in os.listdir(tmpdir):
                os.remove(os.path.join(tmpdir, fn))
            os.rmdir(tmpdir)
        except Exception:
            pass

    # ── ⑦ run_for_day：三态键齐全（没跑 / 跑了没货 必须能分开）
    stats = run_for_day(day, memories=ms, save=False)
    for k in ("date", "day_mems", "reflected", "saved", "reflection_id", "reason"):
        assert k in stats, "统计缺键 %s（三态约定：键必须在，值才能是 0）" % k
    assert stats["day_mems"] == 3 and stats["reflected"] == 1
    empty = run_for_day("2020-01-01", memories=ms, save=False)
    assert empty["day_mems"] == 0 and empty["reflected"] == 0 and empty["reason"], \
        "没料时 reason 必须说明原因"

    print("reflection.py selftest OK")
    print("  门槛 %d 条 | 上限 %d 字 | 每天 %d 条 | 信号 %d 类 | 主题 %d 类"
          % (REFLECT_MIN_MEMS, REFLECT_MAX_CHARS, REFLECT_MAX_PER_DAY,
             len(SIGNAL_WORDS), len(THEME_WORDS)))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(_cli(sys.argv[1:]))
    selftest()
