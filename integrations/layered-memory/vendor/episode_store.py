# -*- coding: utf-8 -*-
"""情景档 · 存储层（2026-11-09 从 episode.py 拆出）

## 这里放什么

「段/档 ↔ 磁盘」之间的一切：

**转档**
    _stable_episode_id   由首条碎片 mem_id 派生的稳定 id
    to_episode           段 → 情景档 dict（内容太短返回 None）
    build_episodes       聚合 + 转档一步到位
    _coerce_episode      允许传段（带 mems）或情景档 dict

**落盘**
    save_episode         保存到活跃库（embedding 失败也能存）
    mark_aggregated      给碎片打 episode_id（就地改，调用方落盘）
    _episode_id_of       取碎片上已有的 episode_id
    attach_embedding     三级降级挂向量（ok / pending / failed）
    _is_usable_embedding / _default_embed
    _atomic_write_json / _file_lock / _NullLock

**健康**
    check_integrity      引用完整性（孤儿 / 漏记 / 重复引用）
    format_integrity     排成人看的一行行
    episode_stats        聚合质量统计
    decay_params         情景档专用衰减参数

**清理**
    cleanup_episodes     按设计 6.2 判定哪些该进冷存
    dedup_episodes       按「同一件事被切成多条」去重
    _is_sparse / _bucket_key / _episode_date_of / _marked_and_owned
    以及上面两个的 dry_run 版本

## 依赖

    episode_base      常量 + 工具函数
    episode_compose   内容组装（_completeness_of 用于 dedup 排序）

不依赖 segment / recall。

## 稳定性

函数体原样搬过来，一个字没改。
"""
import hashlib
import json
import math
import os
import re
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from config import LONG_TERM_ACTIVE_PATH
from config import EPISODE_ACTIVE_PER_DAY
from schema import MemoryItem
from common.locking import NullLock

# config 里的 episode 参数：用「有就读、没有就用默认」。
# 这是原文件的做法（episode.py L112-123 一带的注释解释了原因）：
#   「写死常量，config 里调了参数却没人读 → 又一个死字段」
try:
    from config import EPISODE_DECAY_RATE, EPISODE_FLOOR
except Exception:
    EPISODE_DECAY_RATE = 0.8
    EPISODE_FLOOR = 45.0

try:
    from config import EPISODE_KEEP_DAYS
except Exception:
    EPISODE_KEEP_DAYS = 90

try:
    from config import EPISODE_DEDUP_MAX_GAP_SECONDS
except Exception:
    EPISODE_DEDUP_MAX_GAP_SECONDS = 3600

try:
    from config import DEDUPLICATION_SIM_THRESHOLD as EPISODE_INJECT_DEDUP_SIM
except Exception:
    EPISODE_INJECT_DEDUP_SIM = 0.78

try:
    from config import DEDUPLICATION_SIM_THRESHOLD
except Exception:
    DEDUPLICATION_SIM_THRESHOLD = 0.78

try:
    from config import IMPRESSION_BUILD_MIN_INTENSITY
except Exception:
    IMPRESSION_BUILD_MIN_INTENSITY = 60.0

from episode_base import (
    FALLBACK_THEME, GUESS_PREFIX, LEGACY_GROUP, SPARSE,
    MIN_CONTENT_CHARS, _STRICT_TYPES,
    _attr, _content_of, _id_of, _ts_of, date_of,
    _seg_mems, _seg_get, _cosine, _embedding_of,
)
from episode_compose import (
    _completeness_of, compose_content, compose_content_detailed,
    _who_of, _has_information, _pick_informative, extract_actions,
    _fit_content,
)

# 清理参数（原在 episode.py 里）
EPISODE_CLEAN_KEEP_DAYS = 30        # 窗口：只看最近 N 天内的档（设计 6.2 的 keep_days）
EPISODE_CLEAN_KEEP_PER_THEME = 10   # 同 (会话, 主题) 在窗口内最多留几条（设计 6.2）


def _is_episode(x) -> bool:
    """是不是一条情景档（dict 或 MemoryItem 都认）。

    ★ 2026-11-09 从 episode.py 搬来。
      本来它属于「召回层」，但 store 层的 check_integrity / cleanup / dedup
      都要用它判断，而 recall 依赖 store —— 放 recall 会循环。
      它只有 5 行、零依赖，放 store 层最合适。
    """
    if isinstance(x, dict):
        return str(x.get("mem_type") or "") == "episode"
    return str(getattr(x, "mem_type", "") or "") == "episode"

def _episode_id_of(m: Any) -> Optional[str]:
    """取碎片上已有的 episode_id（空 / 空串都算没聚合过）。"""
    v = _attr(m, "episode_id", None)
    return str(v) if v else None


def _marked_and_owned(m, known_sources: dict) -> bool:
    """碎片的 episode_id 指向的档，是否真的把它记进了 source_turns。"""
    eid = _episode_id_of(m)
    if not eid:
        return False
    owned = known_sources.get(eid)
    if owned is None:
        return True            # 档不存在 → 外面会打日志，这里先放行当已聚合
    return _id_of(m) in owned


def _stable_episode_id(session_id: str, first_mem_id: str,
                       first_ts: float = 0.0) -> str:
    """由「首条碎片 mem_id」派生的稳定 id。

    ⚠️ 这个函数修过三次，每次都是「种子里包含了会变的东西」：

      第 1 次：seed 里放 int(time.time())        ← 墙钟，每次重跑都不同
             实测：45 条碎片带 11 个 episode_id，active.json 里 0 个档，
                   11 个引用全是孤儿。碎片被当成「已聚合」永远跳过，
                   3 天后短期层到期清空 —— 那段对话彻底没了。

      第 2 次：兜底写成 first_ts or time.time()  ← 缺时间戳时又回到墙钟
             修主路径时自己引入的新分支。而缺时间戳是可达的：
             老数据 / 跨版本迁移 / 手工写入 / 迁移脚本漏字段，
             _ts_of() 一律返回 0.0。
             修法：缺就用 0，ep_0_ab12 难看但对同一批碎片恒等。

      第 3 次：seed 里放 f"{session_id}|{first_mem_id}"  ← session_id 会变
             老数据补字段 / 分组口径调整都能让它变。
             实测：同一批碎片早期无 session_id 归 'legacy' → ep_..._8d8c；
                   后来补上 → 'private:<owner-id>' → ep_..._8417。
                   两轮都落库 → 碎片打 8d8c 的标，而 8d8c 的 source_turns
                   停在第一轮的 4 条（看着像「漏记」）。
                   夜巡的 episode_integrity 数出「11 条打标 vs 4 条
                   source_turns」才暴露。

    教训：**id 的种子只能包含「分配后永不改变」的东西。**
          目前已知满足的只有 mem_id 本身。
          session_id 变过、时间戳缺过、墙钟永远在变。

    所以：seed 只用 first_mem_id。
    session_id 参数保留只为向后兼容签名，不参与计算 —— 别再用它，第四次就是这么来的。

    形状仍跟设计一致：ep_<首条 create_time>_<4 位 hex>。
    时间戳部分仅用于「按时间排序/人眼可读」，缺时间戳时用 0。
    """
    seed = str(first_mem_id or "").encode("utf-8")
    h = hashlib.sha1(seed).hexdigest()[:4]
    ts = int(first_ts) if first_ts else 0
    return f"ep_{ts}_{h}"


def to_episode(seg, session_id: Optional[str] = None) -> Optional[dict]:
    """段 → 情景档 dict。内容太短（覆盖不到什么）时返回 None（设计 7.3）。"""
    mems = _seg_mems(seg)
    if not mems:
        return None

    sid = session_id or _seg_get(seg, "session_id") or "legacy"
    theme = _seg_get(seg, "theme") or FALLBACK_THEME
    kind = _seg_get(seg, "kind") or "fallback"

    content, content_source = compose_content_detailed(mems, theme)
    if not content or len(content) < 10:
        return None

    first_ts = _ts_of(mems[0])
    last_ts = _ts_of(mems[-1])
    dur_min = int(round(max(0.0, last_ts - first_ts) / 60.0))
    src_ids = [_id_of(m) for m in mems if _id_of(m)]

    # importance 取成员最大值，不取平均：
    #   一段里只要有一轮是高重要度（比如「他说他不舒服」），
    #   整件事就该按那个重要度活着，不该被 5 条晚安稀释掉。
    try:
        importance = max(float(_attr(m, "importance", 0.65)) for m in mems)
    except (TypeError, ValueError):
        importance = 0.65

    # ★ 2026-11-12 新增：情景档自己的 category。
    #
    #   为什么必须显式写，不能让下游用 classify_importance 去猜：
    #     compose_content 生成的正文长这样 ——「11-07 18:31，睡（2 轮）。（…）」
    #     开头的日期时间是**元数据**，不是内容。DATE_PATTERNS 里
    #     r"\d{1,2}[:：点]\d{1,2}" 会命中「18:31」→ 整条判成 date(0.92)，
    #     于是 125 条情景档全部拿到最高重要度，永远不掉出保护线。
    #   实测：修复前 484 条里 155 条被判 date，其中 125 条是情景档。
    #
    #   判类别前先剥掉时间前缀，让分类器看到的是真正的内容。
    _body = re.sub(r"^\d{1,2}-\d{1,2}\s+\d{1,2}[:：]\d{1,2}\s*[，,]?\s*", "",
                   str(content or ""))
    try:
        from schema import classify_importance as _cls
        _cat, _ = _cls(_body, "episode")
    except Exception:
        _cat = "event"
    # 情景档天然是「某天发生的事」，但**只有判不出类别时**才兜底成 event。
    #
    #   为什么不能把 speech/misc 也改成 event（第一版写错了）：
    #     实测「闲聊（2 轮）」被兜底成 event —— 但它是闲聊，不是事件。
    #     如果把闲聊也标成 event，它就拿到了事件档的保留待遇，
    #     跟「闲聊不该长期留着」的设计直接冲突。
    #   只有 empty（空内容）和 tool（工具知识误入）才兜底：
    #     情景档正文里出现工具词，说明是分类器被词带偏，不是真的工具说明。
    if _cat in ("empty", "tool"):
        _cat = "event"

    # ★ 2026-11-13：情景档自己的 kind + recallable。
    #
    #   为什么必须在这里补：打标只加在了 memory_manager 的两条写入路径
    #   （add_shortterm_ex / add_working_memory），**漏了 to_episode**。
    #   实测后果：11-13 00:55 回填之后新建的 30 条档 kind 全空 →
    #   召回时权重按 1.0 处理 → 「临时:xxx」这类闲聊不会被降权，
    #   正好压住了最该压的那批。
    #
    #   ⚠️ 必须复用上面**剥过时间前缀的 _body**，不能用原始 content：
    #      否则会出现 category 判成 misc、kind 判成 date 这种错位——
    #      比没有标签更糟（下游会按互斥的两套结论各走一遍）。
    #
    #   ★★ 2026-11-13 实测修正：**正文太短时不能用分类器判 kind。**
    #      剥掉时间前缀后正文长这样：「做饭（2 轮）。（把面下进去）」
    #      实测 classify_kind 对它的判定是「闲聊」——因为没有任何可依据的词。
    #      但 theme 明明是「做饭」。
    #
    #      所以 episode 的 kind 以 **theme** 为准（那是 episode.py 三层判断的产物），
    #      分类器只在主题认不出时兜底：
    #        fallback（闲聊）或临时:xxx        → 闲聊
    try:
        from schema import classify_kind as _ckind, classify_for_gate as _cgate
        _gate = _cgate(_body, "episode")
        _recallable = _gate.get("recallable", "yes")
        # 测试/元讨论优先用分类器的结论（这两类判据是明确的，不依赖主题）
        if _gate.get("category") in ("test", "meta"):
            _kind = _ckind(_body, "episode", None)
        elif kind == "known":
            _kind = "事件"
        else:
            # fallback（闲聊）或 guess（临时:xxx）：内容太薄，归闲聊
            _kind = "闲聊"
    except Exception:
        _kind = ""
        _recallable = "yes"

    try:
        from schema import infer_emotion_intensity as _infer_ei
        _emo_i = float(_infer_ei(content, "episode") or 0.0)
    except Exception:
        _emo_i = 0.0
    _imp_s = _emo_i if _emo_i >= float(IMPRESSION_BUILD_MIN_INTENSITY) else 0.0

    now = time.time()
    ep = {
        # ★ 这里绝不能传 first_ts or now —— 那会把「缺时间戳」替换成墙钟，
        #   让 id 每次重跑都变（孤儿引用的根因）。缺就传 0，让 id 保持恒定。
        #
        # ★★ 2026-11-08 二修：**id 里不能含 session_id。**
        #   实测事故：同一批 62 条碎片，早期没 session_id → 归到 'legacy' 组，
        #   算出 ep_1794108139_8d8c；后来碎片补上了 session_id
        #   → 归到 'private:<owner-id>'，同样的内容算出 ep_1794108139_8417。
        #   结果：碎片身上还挂着 8d8c 的标，而库里只有 8417 —— 11 条变孤儿，
        #   而且 8d8c 那条档的 source_turns 只记了当时那 4 条，看着像「漏记」。
        #   session_id 是会变的（老数据补字段、分组口径调整），
        #   拿它进 id = 让 id 跟着变 = 前面修了两次的「id 不稳定」又回来一遍。
        #   改用**首条碎片的 mem_id** 做种子：mem_id 分配后永不改变，
        #   而且「同一段的首条」天然是这段的身份 —— 足够区分，又不会漂。
        "mem_id": _stable_episode_id(sid, src_ids[0] if src_ids else "", first_ts),
        "mem_type": "episode",
        "session_id": sid,

        "content": content,
        # ── 防污染三件套（问题13）
        # content_source 现在如实反映「内容是怎么来的」：
        #   generated = 从动作拼的 / extracted = 摘的原话 / sparse = 没摘到东西
        # 之前写死 generated，导致 41% 的空档也标成 generated ——
        # 下游（去重/召回/注入）没法区分「有内容」和「只有时间戳」。
        "content_source": content_source,
        "content_confidence": "medium",     # 规则拼接 + 动作原文引用
        "source_turns": src_ids,

        "scene": {
            "when": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(first_ts or now)),
            "date": time.strftime("%Y-%m-%d", time.localtime(first_ts or now)),
            "duration_min": dur_min,
            "turn_count": len(mems),
            "theme": theme,
            "theme_kind": kind,
            "who": _who_of(mems),
        },

        # ★ 2026-11-13 改（方案 E）：初始强度不再写死 100，按 importance 给。
        #
        #   原来写死 100.0，导致：
        #     · 判成 misc（importance 0.35）的闲聊档，一出生就是满强度 100
        #     · 加上 EPISODE_FLOOR=45 地板 + decay_slowdown 被 mention 顶到 4.0
        #     · 这些档永远掉不下来，天天占着召回名额
        #   实测（2026-11-13）：147 条档里 23 条 strength ≥99.9，
        #     而全库占比只有 3.1% —— 档的强度明显偏高。
        #
        #   新公式 base = 100 × (0.4 + 0.6 × importance)：
        #     importance 0.35（misc/闲聊）→ 61 分
        #     importance 0.65（event）    → 79 分
        #     importance 0.92（fact）     → 95 分
        #
        #   衰减速度（0.8/天，按 slowdown 2.0 折算约 0.4/天）：
        #     61 → 45 地板约 40 天，79 → 45 约 85 天，95 → 45 约 125 天
        #   即「闲聊档两个多月自然淡出，事实档留四个月」，符合设计意图，
        #   也不会出现「上周的事完全想不起来」（那是几天就掉到底才会有的问题）。
        #
        #   ⚠️ 只影响**新建**的档。已存在的 147 条保持原强度不动。
        "strength": round(100.0 * (0.4 + 0.6 * float(importance or 0.65)), 1),
        "importance": importance,
        "emotion_intensity": _emo_i,
        "event_intensity": _emo_i,
        "current_intensity": _emo_i,
        "impression_strength": _imp_s,
        # 2026-11-12：显式写类别，不让下游拿带时间前缀的正文去猜（见上方说明）
        "category": _cat,
        "type_tagged_by": "rule",
        # 2026-11-13：分类标签（与 memory_manager 的写入路径一致）
        "kind": _kind,
        "recallable": _recallable,
        "consolidation_level": 2,
        "decay_slowdown": 1.0,
        "mention_count": 0,
        "mention_history": [],
        "later_thought": [],

        "create_time": first_ts or now,
        "last_active": last_ts or now,
        "last_mentioned_at": last_ts or now,
        "embedding": [],
        "embed_status": "pending",
        "ttl": int(EPISODE_KEEP_DAYS * 86400),
        "tags": ["情景", theme],
    }
    return ep


def build_episodes(session_id: str, mems: list,
                   known_sources: Optional[dict] = None) -> List[dict]:
    """聚合 + 转情景档，一步到位（跳过内容太短的段）。

    ★ 2026-11-09 修（独立审计指出，这是 P0 级真 bug）：
      本函数原来直接调 `aggregate_session_safe(...)`，
      但那个函数定义在 `episode.py`，本文件**从未 import 过它**
      → 每次调用必然 `NameError: name 'aggregate_session_safe' is not defined`
      → 异常被 `daily_consolidation.py` 的上层 try/except 吞成 `return []`
      → 巩固流程照样报 ok:true
      → **短期碎片永远不可能被聚合成情景档**

      生产痕迹：`state/last_maintenance.json` 里长期写着
        "episodes_error": "NameError: name 'aggregate_session_safe' is not defined"

    为什么用**函数内延迟导入**而不是顶部 import：
      `episode.py:65` 已经 `from episode_store import (...)`，
      如果这里在模块顶部 `from episode import aggregate_session_safe`，
      就会形成循环导入（谁先被 import 谁就炸）。
      把 import 放进函数体内 —— 首次调用时 episode 模块已加载完毕，
      循环依赖自然打破。

      这个模式在本文件里已有先例（见 _default_embed 等处）。
    """
    from episode import aggregate_session_safe   # 延迟导入，避免循环依赖

    out = []
    for seg in aggregate_session_safe(session_id, mems, known_sources):
        ep = to_episode(seg, session_id)
        if ep:
            out.append(ep)
    return out


def mark_aggregated(episode: dict, mems: list) -> None:
    """给被聚合的短期记忆打 episode_id 标记（就地改，调用方负责落盘）。"""
    ep_id = (episode or {}).get("mem_id") if isinstance(episode, dict) else getattr(episode, "mem_id", None)
    if not ep_id:
        return
    now = time.time()
    for m in (mems or []):
        try:
            if isinstance(m, dict):
                m["episode_id"] = ep_id
                m["episode_at"] = now
            else:
                m.episode_id = ep_id
                m.episode_at = now
        except Exception as e:
            print(f"[episode] 打标记失败 {_id_of(m)}: {e}")


def _is_usable_embedding(emb) -> bool:
    """真向量才叫 ok。

    ollama_embedding.get_embedding 失败时返回的是 [0.0]*1024 而不是空列表，
    所以只判「非空」会把失败当成成功 —— 那样所有破向量都标 ok，
    补算机制永远不会跑，召回时全是零向量互相「相似」。
    这里额外判「全零 = 失败」。
    """
    if not emb:
        return False
    try:
        return any(float(x) != 0.0 for x in emb)
    except (TypeError, ValueError):
        return False


def _default_embed(text: str):
    from ollama_embedding import get_embedding   # 延迟 import：没装 requests 也能用别的功能
    return get_embedding(text)


def attach_embedding(episode: dict, embedding_func=None) -> dict:
    """三级降级：成功→ok / 返回空→pending / 异常→failed。就地改并返回。"""
    func = embedding_func or _default_embed
    try:
        emb = func(episode.get("content", ""))
        if _is_usable_embedding(emb):
            episode["embedding"] = list(emb)
            episode["embed_status"] = "ok"
        else:
            episode["embedding"] = []
            episode["embed_status"] = "pending"
    except Exception as e:
        episode["embedding"] = []
        episode["embed_status"] = "failed"
        print(f"[episode] embedding 失败（不影响保存）: {type(e).__name__}: {e}")
    return episode


def _atomic_write_json(path: str, data: dict) -> None:
    """原子写 —— 转发到 atomic_io.atomic_write_json（2026-11-08 收敛）。

    原来这里自己抄了一份（因为不能 import memory_manager，那是 L3）。
    「不能 import 那个模块」不等于「必须复制那段代码」—— atomic_io 只依赖标准库，
    任何层级都能安全 import，不会再制造循环依赖。

    sweep=False：不顺手清陈旧 tmp（那件维护者还没定，只有 memory_manager 开着）。
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


def _coerce_episode(episode):
    """允许传段（带 mems）或情景档 dict —— 传段时自动转成情景档。"""
    if isinstance(episode, dict) and "mems" in episode and "mem_type" not in episode:
        return to_episode(episode)
    return dict(episode) if isinstance(episode, dict) else None


def save_episode(episode: dict, embedding_func=None, path: Optional[str] = None) -> dict:
    """保存情景档到活跃库。embedding 失败也能存。

    embedding 三级降级（设计 7.1）：
        拿到真向量       → embed_status='ok'
        返回空 / 零向量   → embed_status='pending'（等巩固任务补算）
        抛异常           → embed_status='failed'（照样存，召回退化成关键词命中）
    """
    ep = _coerce_episode(episode)
    if ep is None:
        return {}

    attach_embedding(ep, embedding_func)
    ep.pop("mems", None)              # 绝不把 MemoryItem 写进 JSON

    target = path or LONG_TERM_ACTIVE_PATH
    with _file_lock():
        data = {"memories": []}
        if os.path.exists(target):
            try:
                with open(target, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                print(f"[episode] 读 {os.path.basename(target)} 失败，改用空库: {e}")
                data = {"memories": []}
        mems = [m for m in data.get("memories", []) if m.get("mem_id") != ep["mem_id"]]
        mems.append(ep)
        data["memories"] = mems
        _atomic_write_json(target, data)
    return ep


def decay_params() -> Tuple[float, float]:
    """情景档专用衰减参数 (每天掉几分, 地板)。

    为什么必须单开一档（问题2）：
        原设计自相矛盾 —— 按等级2 走 5.0/天 + 地板 15，100 分 17 天见底，
        但 ttl 又写着 90 天。也就是说情景档根本活不到它该活的第 68 天。
        改成 0.8/天 + 地板 45：100→45 需要 68 天，跟 90 天 ttl 对得上。
    """
    return float(EPISODE_DECAY_RATE), float(EPISODE_FLOOR)


def episode_stats(episodes: list) -> dict:
    """聚合质量统计（memory_cli episode stats / audit 用）。"""
    eps = [e for e in (episodes or []) if isinstance(e, dict)
           and e.get("mem_type") == "episode"]
    # 过滤后的闲聊/临时琐事是 None，不是档，不能参与统计或让调用方崩。
    if not eps:
        return {"total": 0, "avg_turns": 0.0, "themes": {},
                "kinds": {}, "known_ratio": 0.0, "low_confidence_ratio": 0.0}

    themes: Dict[str, int] = {}
    kinds: Dict[str, int] = {}
    turns = 0
    for e in eps:
        scene = e.get("scene") or {}
        t = scene.get("theme") or "?"
        themes[t] = themes.get(t, 0) + 1
        k = scene.get("theme_kind") or "fallback"
        kinds[k] = kinds.get(k, 0) + 1
        turns += int(scene.get("turn_count") or 0)
    n = len(eps)
    known = kinds.get("known", 0)
    return {
        "total": n,
        "avg_turns": round(turns / n, 2),
        "themes": dict(sorted(themes.items(), key=lambda kv: -kv[1])),
        "kinds": kinds,
        "known_ratio": round(known / n, 3),
        # 低置信度 = 不是词表命中的（guess/fallback），这些是要补词的对象
        "low_confidence_ratio": round(1 - known / n, 3),
    }


def _episode_date_of(ep) -> str:
    """取档所属自然日。优先 scene.date，其次 create_time。"""
    scene = _attr(ep, "scene", {}) or {}
    if isinstance(scene, dict):
        d = str(scene.get("date") or "").strip()
        if d:
            return d
    ts = _ts_of(ep)
    return time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else ""


def _bucket_key(ep) -> tuple:
    """设计 6.2 的分桶键：(session_id, theme)。

    为什么这两个一起：私聊和群聊的「做饭」不是同一批事（设计 2.0b），
    所以会话必须进键；不同主题本来就是不同的事，不该互相挤占名额。
    """
    scene = _attr(ep, "scene", {}) or {}
    theme = scene.get("theme") if isinstance(scene, dict) else None
    if theme and str(theme).startswith(GUESS_PREFIX):
        theme = FALLBACK_THEME
    sid = _attr(ep, "session_id", None)
    return (str(sid) if sid else LEGACY_GROUP, str(theme) if theme else "?")


def cleanup_episodes(episodes, keep_days: int = EPISODE_CLEAN_KEEP_DAYS,
                     keep_per_theme: int = EPISODE_CLEAN_KEEP_PER_THEME,
                     now: float = None, apply: bool = False,
                     keep_per_day: int = EPISODE_ACTIVE_PER_DAY, retention_days: int = EPISODE_KEEP_DAYS) -> dict:
    """按设计 6.2 判定「哪些情景档该进冷存」。

    返回 dict（**不是**设计里的 to_cold 列表 —— 原因见下）：
        {
          "total":         输入的档数,
          "in_window":     落在 keep_days 窗口内、参与分桶的档数,
          "buckets":       {"session|theme": 条数}（按条数降序）,
          "would_move":    应进冷存的档列表,
          "over_threshold":超过 keep_per_theme 的桶数,
          "applied":       True = 真的从列表里移出了,
          "policy":        "report_only" | "applied",
          "keep_days", "keep_per_theme": 本次生效的参数,
        }

    **为什么返回值从设计的 list 改成 dict**：
        list 只能回答「删谁」，回答不了「为什么删」「一共几个桶」
        「最大桶多大」。而这次判断的关键恰恰是「最大桶才 5 条、阈值 10，
        所以一条都不该删」—— 这个事实在裸 list 里表达不出来。

    **为什么默认 apply=False**：
        删除不可逆；而设计 6.2 和 6.3 目前自相矛盾（见上方注释）。
        矛盾裁决前任何自动删除都可能删掉真实经历。
        要真删必须显式传 apply=True —— 让「真删」成为一个需要写出来的动作。

    ⚠️ 本函数**不碰任何文件**。"进冷存" 在这里等于「从传入列表里移除
       并返回」，写 cold.json 还是丢弃由调用方决定
       （episode 是 L2，不直接写存储）。
    """
    eps = [e for e in (episodes or []) if _is_episode(e)]
    total = len(eps)
    if now is None:
        now = time.time()

    keep_days = int(keep_days) if keep_days is not None else 0
    keep_per_theme = int(keep_per_theme) if keep_per_theme is not None else 0

    # ── 窗口过滤（补上设计代码里被忽略的 keep_days）
    #    keep_days <= 0 表示不限窗口（= 设计原文的字面行为）
    if keep_days > 0:
        cut = now - keep_days * 86400
        in_window = [e for e in eps if _ts_of(e) >= cut]
    else:
        in_window = list(eps)

    # ── 分桶 O(n)
    buckets: Dict[tuple, List[Any]] = {}
    for ep in in_window:
        buckets.setdefault(_bucket_key(ep), []).append(ep)

    would_move: List[Any] = []
    over = 0
    bucket_sizes: Dict[str, int] = {}
    for key, group in buckets.items():
        bucket_sizes[f"{key[0]}|{key[1]}"] = len(group)
        if len(group) <= keep_per_theme:
            continue
        over += 1
        # 桶内优先保留重要、近期被召回的档；其余完整转冷存。
        group.sort(key=lambda e: (float(_attr(e, "importance", 0) or 0),
                                  float(_attr(e, "last_recalled_at", 0) or 0),
                                  float(_attr(e, "strength", 0) or 0), _ts_of(e)), reverse=True)
        would_move.extend(group[keep_per_theme:])

    # Bound the active archive even when every guessed theme is unique.
    # Keep valuable records first; all removed records must be archived by the caller.
    daily = {}
    for ep in eps:
        daily.setdefault((_attr(ep, "session_id", ""), _episode_date_of(ep)), []).append(ep)
    if keep_per_day > 0:
        for group in daily.values():
            group.sort(key=lambda e: (float(_attr(e, "importance", 0) or 0),
                                     float(_attr(e, "last_recalled_at", 0) or 0),
                                     float(_attr(e, "strength", 0) or 0),
                                     int(_attr(e, "chunk_priority", 5) or 5), _ts_of(e)), reverse=True)
            would_move.extend(group[int(keep_per_day):])
    if retention_days > 0:
        would_move.extend(e for e in eps if _ts_of(e) < now - retention_days * 86400)
    unique = {id(e): e for e in would_move}
    would_move = [e for e in unique.values() if not _attr(e, "permanent_memory", False)]

    applied = False
    if apply and would_move:
        move_ids = {id(e) for e in would_move}
        episodes[:] = [e for e in episodes if id(e) not in move_ids]
        applied = True

    return {
        "total": total,
        "in_window": len(in_window),
        "buckets": dict(sorted(bucket_sizes.items(), key=lambda kv: -kv[1])),
        "would_move": would_move,
        "over_threshold": over,
        "applied": applied,
        "policy": "applied" if applied else "report_only",
        "keep_days": keep_days,
        "keep_per_theme": keep_per_theme,
        "keep_per_day": keep_per_day,
        "retention_days": retention_days,
    }


def cleanup_episodes_dry_run(episodes, keep_days: int = EPISODE_CLEAN_KEEP_DAYS,
                             keep_per_theme: int = EPISODE_CLEAN_KEEP_PER_THEME,
                             now: float = None) -> dict:
    """只算不动的版本。等于 cleanup_episodes(..., apply=False)。

    单独开一个名字，是为了让调用方在代码里**一眼看出**这是只读的 ——
    名字即保证。要真删得显式写 cleanup_episodes(..., apply=True)。
    """
    return cleanup_episodes(episodes, keep_days=keep_days,
                            keep_per_theme=keep_per_theme, now=now, apply=False)


def _is_sparse(ep) -> bool:
    """这条档是不是「没摘到内容」（content_source == 'sparse' 且正文太短）。

    为什么两个条件都要：
      只看 content_source 会误判老数据（改造前所有档都写死 generated）；
      只看长度会把「短但有力」的原话误判成空。
    两个都满足才算 sparse —— 保守方向，宁可让它参与判重，也不误跳过。
    """
    if str(_attr(ep, "content_source", "") or "") != SPARSE:
        return False
    body = str(_attr(ep, "content", "") or "")
    # 去掉元信息头 "MM-DD HH:MM，主题（N 轮）" 后还剩多少
    body = re.sub(r"^\d{2}-\d{2} \d{2}:\d{2}，[^（]*（\d+ 轮）\.?", "", body).strip()
    return len(body) < MIN_CONTENT_CHARS


def dedup_episodes(episodes, sim_threshold: float = None,
                   max_gap: int = None, now: float = None,
                   apply: bool = False) -> dict:
    """按「同一件事被切成多条」去重（不是按主题条数限流）。

    参数：
        episodes      : 档列表（dict / MemoryItem 都行）；非情景档自动忽略
        sim_threshold : 相似度阈值，None 用 config.DEDUPLICATION_SIM_THRESHOLD
        max_gap       : 时间差上限（秒），None 用 EPISODE_DEDUP_MAX_GAP_SECONDS
        now           : 当前时间（测试用）
        apply         : False（默认）只算不改；True 才真的从列表里移除

    返回 dict（**不是裸列表**，理由同 cleanup_episodes）：
        {
          "total":        输入的档数,
          "compared":     实际比较过的对数（0 就是「没得比/没向量」）,
          "would_move":   应删的档列表,
          "kept":         保留下来的档列表（apply 后就是新的 episodes）,
          "pairs":        [{"drop","keep","sim","gap_sec","reason"}...],
          "skipped_novec": 因为没有向量而没参与比较的档数,
          "applied":      True = 真的从 episodes 里移除了,
          "policy":       "report_only" | "applied",
          "sim_threshold", "max_gap": 本次生效的参数,
        }

    ★ 没有向量的档**判不了就不删**（跟 pick_inject_episodes 同一条原则）：
      没有证据说它们重复，删掉等于凭空气丢一条记忆。
      "skipped_novec" 会如实报出这个数，不假装「都检查过了」。
    """
    if sim_threshold is None:
        sim_threshold = EPISODE_INJECT_DEDUP_SIM     # 同一个 0.78，不新开参数
    if max_gap is None:
        max_gap = EPISODE_DEDUP_MAX_GAP_SECONDS
    if now is None:
        now = time.time()
    sim_threshold = float(sim_threshold)
    max_gap = float(max_gap)

    eps = [e for e in (episodes or []) if _is_episode(e)]
    total = len(eps)

    # 按时间升序排，后面用滑动窗口比邻居（不是两两全比）
    ordered = sorted(eps, key=_ts_of)

    dropped = set()          # 已经判为「该删」的下标
    pairs: List[dict] = []
    compared = 0
    novec = 0
    sparse_n = 0

    for i, ep in enumerate(ordered):
        if i in dropped:
            continue
        # sparse 不参与判重：它没有内容，向量只编码了「时间+主题名」，
        # 跟别的 sparse 档天然高度相似（实测 0.955~0.959）——
        # 那不是重复，那是什么都没有。拿它判重会删掉真实对话。
        if _is_sparse(ep):
            sparse_n += 1
            continue
        v_i = _embedding_of(ep)
        if not v_i:
            novec += 1
            continue
        ts_i = _ts_of(ep)
        for j in range(i + 1, len(ordered)):
            if j in dropped:
                continue
            other = ordered[j]
            gap = _ts_of(other) - ts_i
            if gap > max_gap:
                break              # 时间排过序，后面只会更远
            v_j = _embedding_of(other)
            if not v_j:
                continue
            compared += 1
            sim = _cosine(v_i, v_j)
            if sim < sim_threshold:
                continue
            # 谁更完整留谁
            keep, drop = (ep, other)
            if _completeness_of(other) > _completeness_of(ep):
                keep, drop = other, ep
            drop_idx = i if drop is ep else j
            dropped.add(drop_idx)
            pairs.append({
                "drop": str(_attr(drop, "mem_id", "") or ""),
                "keep": str(_attr(keep, "mem_id", "") or ""),
                "sim": round(sim, 3),
                "gap_sec": int(gap),
                "reason": "same_event_split",
            })
            if drop is ep:
                break              # 当前这条被删了，不用再拿它比

    would_move = [ordered[k] for k in sorted(dropped)]
    kept = [e for e in eps if all(e is not m for m in would_move)]

    applied = False
    if apply and would_move:
        move_ids = {id(e) for e in would_move}
        episodes[:] = [e for e in episodes if id(e) not in move_ids]
        applied = True

    return {
        "total": total,
        "compared": compared,
        "skipped_sparse": sparse_n,
        "would_move": would_move,
        "kept": kept,
        "pairs": pairs,
        "skipped_novec": novec,
        "applied": applied,
        "policy": "applied" if applied else "report_only",
        "sim_threshold": sim_threshold,
        "max_gap": int(max_gap),
    }


def dedup_episodes_dry_run(episodes, sim_threshold: float = None,
                           max_gap: int = None, now: float = None) -> dict:
    """只算不删的版本。等于 dedup_episodes(..., apply=False)。

    跟 cleanup_episodes_dry_run 同样的理由：名字即保证。
    """
    return dedup_episodes(episodes, sim_threshold=sim_threshold,
                          max_gap=max_gap, now=now, apply=False)


def check_integrity(episodes, shortterms, archived_ids=None) -> dict:
    """检查情景档与短期碎片之间的引用完整性。

    参数：
        episodes   : 情景档列表（dict / MemoryItem 都行；非 episode 自动忽略）
        shortterms : 短期记忆列表（同上）
        archived_ids : 可选。来自归档层（冷区）的档 mem_id 集合。
                       **不传 = 全部按活跃区算**（向后兼容，老调用方行为不变）。

                       为什么要这个参数（2026-11-18）：
                         stale 原来是「活跃区 130 + 冷区 835」混成一个数 965。
                         冷区档的碎片**天生**不在短期层（3 天窗口早清掉了），
                         所以冷区的 stale 只会单边上涨、永远降不下来。
                         混报会让人误以为活跃库有 965 条坏了。
                         ⇒ 拆成 stale_active / stale_archived 分别报。

    返回：
        {
          "ok":       bool,                      # 六类问题都为 0 才 True
          "total_src": int,                      # source_turns 引用总数
          "uniq_src":  int,                      # 去重后碎片数
          "marked":    int,                      # 短期层已打标的碎片数
          "orphans":   [(ep_id, 碎片数)],        # 碎片指向不存在的档
          "missing":   [(ep_id, 缺几条)],        # 档漏记指向它的碎片
          "dup_refs":  [(mem_id, 被几条档引用)],  # 碎片被多档引用
          "stale":     [(mem_id, 档数)],         # 【兼容字段】= stale_active + stale_archived
          "stale_active":   [(mem_id, 档数)],    # 活跃区档引用的、已不在短期层的碎片
          "stale_archived": [(mem_id, 档数)],    # 归档（冷区）档引用的、已不在短期层的碎片
          "unmarked":  [(mem_id, ep_id)],        # 档记了它但碎片没打标
          "turn_mismatch": [(ep_id, 声明轮数, 实际条数)],  # scene 与 source_turns 对不上
          "id_drift":  [(ep_id, id内嵌时间, 首条碎片时间)], # id 代表过的段已经变了
        }

    ★ "unmarked" 是第四类，别漏：
      档的 source_turns 里有它，但碎片身上没有 episode_id 标记 ——
      那种碎片会被下一次聚合**再收一遍**，产生重复档。
      （mark_aggregated 在落库之后才跑，中间崩一下就会出现这种。）
    """
    eps = [e for e in (episodes or []) if _is_episode(e)]
    sts = list(shortterms or [])

    ep_by_id = {}
    for e in eps:
        mid = str(_attr(e, "mem_id", "") or "")
        if mid:
            ep_by_id[mid] = e

    st_by_id = {}
    for m in sts:
        mid = str(_attr(m, "mem_id", "") or "")
        if mid:
            st_by_id[mid] = m

    # ── 引用计数
    ref: Dict[str, List[str]] = {}          # 碎片 mem_id → 引用它的档 id 列表
    total_src = 0
    for e in eps:
        eid = str(_attr(e, "mem_id", "") or "")
        for mid in (_attr(e, "source_turns", []) or []):
            mid = str(mid)
            total_src += 1
            ref.setdefault(mid, []).append(eid)

    dup_refs = [(mid, len(owners)) for mid, owners in ref.items() if len(owners) > 1]
    dup_refs.sort(key=lambda kv: -kv[1])

    # ── stale：档引用的碎片已经不在短期层（3 天窗口清掉后属正常）
    #
    # ★ 2026-11-18 拆口径：
    #   活跃区档的碎片是「最近才从短期层滑出去的」，值得看一眼；
    #   归档（冷区）档的碎片**天生**就不在短期层，永远判不了 ——
    #   混成一个数（实测 965 = 活跃 130 + 冷区 835）只会误导。
    #   ⇒ 按「档来自活跃区还是归档区」拆成两个列表分别报。
    #   原 stale 字段保留（= 两者之和），老调用方不受影响。
    _archived = {str(x) for x in (archived_ids or ())} if archived_ids is not None else set()
    stale_active = []
    stale_archived = []
    for mid, owners in ref.items():
        if mid in st_by_id:
            continue                       # 还在短期层，不算 stale
        # 该碎片是被归档档引用的吗（任一 owner 属归档即归入 archived）
        if _archived and any(str(o) in _archived for o in owners):
            stale_archived.append((mid, len(owners)))
        else:
            stale_active.append((mid, len(owners)))
    stale = stale_active + stale_archived       # 兼容字段：保持「两者之和」

    # ── orphans：碎片标着某个档，但那个档不存在
    orphans_map: Dict[str, List[str]] = {}
    marked = 0
    for mid, m in st_by_id.items():
        eid = _attr(m, "episode_id", None)
        if not eid:
            continue
        marked += 1
        if str(eid) not in ep_by_id:
            orphans_map.setdefault(str(eid), []).append(mid)
    orphans = [(eid, len(v)) for eid, v in sorted(orphans_map.items())]

    # ── missing：档的 source_turns 漏记了「指向它」的碎片
    pointed: Dict[str, List[str]] = {}
    for mid, m in st_by_id.items():
        eid = _attr(m, "episode_id", None)
        if eid:
            pointed.setdefault(str(eid), []).append(mid)
    missing = []
    for eid, mems in pointed.items():
        e = ep_by_id.get(eid)
        if e is None:
            continue                        # 已计入 orphans
        have = {str(x) for x in (_attr(e, "source_turns", []) or [])}
        lack = [x for x in mems if x not in have]
        if lack:
            missing.append((eid, len(lack)))
    missing.sort(key=lambda kv: -kv[1])

    # ── unmarked：档记了它，但碎片身上没打标 → 下次会被重复聚合
    unmarked = []
    for mid in ref:
        m = st_by_id.get(mid)
        if m is None:
            continue                        # 已计入 stale
        if not _attr(m, "episode_id", None):
            unmarked.append((mid, ref[mid][0]))

    # ── turn_mismatch：scene.turn_count 与 len(source_turns) 对不上
    #   为什么算问题：turn_count 是「这条档覆盖了几轮原文」的自述。
    #   它跟 source_turns 不一致，说明档被改写过（source_turns 变了）
    #   但 scene 没跟着更新 —— 下游按 turn_count 做统计/展示就会错。
    #   实测踩过：修完重复引用后 source_turns 变短，turn_count 还是老值。
    turn_mismatch = []
    for e in eps:
        eid = str(_attr(e, "mem_id", "") or "")
        scene = _attr(e, "scene", {}) or {}
        if not isinstance(scene, dict) or "turn_count" not in scene:
            continue
        try:
            tc = int(scene.get("turn_count"))
        except (TypeError, ValueError):
            continue
        n = len(_attr(e, "source_turns", []) or [])
        if tc != n:
            turn_mismatch.append((eid, tc, n))

    # ── id_drift：id 内嵌的事件时刻 vs 首条碎片的 create_time
    #   为什么查这个：_stable_episode_id 的种子是「首条碎片」。
    #   段被重新切分时（主题词表变了 / 摘句改了），同一个 id 可能被复用，
    #   而 source_turns 换成新的那一小段 —— 旧碎片还挂着这个 id，却没被收录。
    #   这是「id 种子决定谁是谁」的老问题（今天已经复发过三次）。
    #   判据：id 里嵌的时间戳应该等于**当前**首条碎片的 create_time。
    #   对不上 → 这条 id 代表过的段已经变了 → 值得看一眼。
    id_drift = []
    for e in eps:
        eid = str(_attr(e, "mem_id", "") or "")
        parts = eid.split("_")
        if len(parts) < 3:
            continue
        try:
            id_ts = int(parts[1])
        except (TypeError, ValueError):
            continue
        src = _attr(e, "source_turns", []) or []
        if not src:
            continue
        first = st_by_id.get(str(src[0]))
        if first is None:
            continue                       # 首条碎片已被 3 天窗口清掉，判不了
        try:
            first_ts = int(_ts_of(first))
        except (TypeError, ValueError):
            continue
        if id_ts and first_ts and abs(id_ts - first_ts) > 2:
            id_drift.append((eid, id_ts, first_ts))

    ok = not (orphans or missing or dup_refs or unmarked
              or turn_mismatch or id_drift)
    return {
        "ok": ok,
        "total_src": total_src,
        "uniq_src": len(ref),
        "marked": marked,
        "orphans": orphans,
        "missing": missing,
        "dup_refs": dup_refs,
        "stale": stale,                       # 兼容：= stale_active + stale_archived
        "stale_active": stale_active,         # 活跃区档引用的、已不在短期层的碎片
        "stale_archived": stale_archived,     # 归档（冷区）档引用的、已不在短期层的碎片
        "unmarked": unmarked,
        "turn_mismatch": turn_mismatch,
        "id_drift": id_drift,
    }


def format_integrity(report: dict) -> str:
    """把 check_integrity 的结果排成人看的一行行（CLI / 日志用）。"""
    r = report or {}
    lines = []
    lines.append("引用完整性：%s" % ("OK" if r.get("ok") else "有问题"))
    lines.append("  source_turns 引用 %d 条（去重 %d）| 短期层已打标 %d"
                 % (r.get("total_src", 0), r.get("uniq_src", 0), r.get("marked", 0)))
    for key, label in (("orphans", "孤儿档（碎片指向不存在的档）"),
                       ("missing", "漏记（档没记全指向它的碎片）"),
                       ("dup_refs", "重复引用（碎片被多条档引用）"),
                       ("unmarked", "未打标（档记了但碎片没标记）"),
                       ("turn_mismatch", "轮数不符（turn_count ≠ source_turns）"),
                       ("id_drift", "id 漂移（id 内嵌时间 ≠ 首条碎片）")):
        items = r.get(key) or []
        lines.append("  %-28s %d" % (label, len(items)))
        for item in items[:8]:
            lines.append("      %s ×%s" % (item[0], item[1]))
        if len(items) > 8:
            lines.append("      …还有 %d 条" % (len(items) - 8))
    return "\n".join(lines)
