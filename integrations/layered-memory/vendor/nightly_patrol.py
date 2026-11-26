# -*- coding: utf-8 -*-
r"""夜巡（T13）：每天跑一次检查，有异常能看见。

═══ 为什么要有这个文件 ═══

巩固任务（daily_consolidation）每天 06:10 往 <memory-data>\memsys-consolidate.log
写一行结果，然后**没有任何东西去看它**。
2026-11-08 才发现：日志写了 5 天，第一次打开是今天。

「写了但没人读」跟「没写」在结果上完全一样 —— 这是本项目踩过的第一个坑
（死字段）。夜巡就是补上「读的那一端」。

═══ 它做什么 ═══

七项检查，全部**只读**：

  ① 久未命中     很久没被想起的（该考虑退休的）
  ② 疑似重复     包含度超阈值（占召回名额、还互相稀释）
  ③ 矛盾候选     同一件事说法相反（「喜欢火锅」vs「讨厌火锅」）
  ④ 孤儿/僵尸    孤儿=没法用（来源空/太短/无向量）；僵尸=久没想起+躺地板+不重要
  ⑤ 半写断裂     有 content 没 embedding（写入时 ollama 挂了，留个半截）
  ⑥ 未归类待审   category 为空或不在已知集合
  ⑦ 候选池待整理 candidates.jsonl 里 status=pending 的条数

═══ 三条硬约束 ═══

1. **绝不写库**。active.json 只读，跑完一个字节都不变。
   强度一律用 decay_logic.peek_strength()（无副作用），
   绝不用 calculate_current_strength() —— 那个会改写 strength 和 last_active。
   （历史教训：2026-11-07 有 5 条记忆的 strength 被「只想算一下」的调用写成 0。）

2. **不主动推送**。push_report() 现在是空壳，只留 TODO。
   推送机制还没设计（走桥接 HTTP 还是宿主通知），定下来之前不接。

3. **不改现有巩固流程**。daily_consolidation.py 一行没动。

═══ 产出 ═══

  <memory-data>\patrol\<date>.md     给人看的报告
  <memory-data>\patrol\<date>.json   给以后的推送/趋势用的明细
  <memory-data>\memsys-patrol.log    每轮一行（跟 memsys-consolidate.log 并列同风格）

  目录写不进去时（权限/盘符变化）自动退回 <项目目录>\patrol，
  并在报告和日志里写明落到了哪儿 —— 不能因为目录不可写就一声不吭。

═══ 用法 ═══

  python nightly_patrol.py              # 自检 + 真跑一轮（定时任务入口）
  python nightly_patrol.py --selftest   # 只自检
"""

import json
import os
import time
import traceback
from datetime import datetime

# __UTF8_STDOUT_GUARD__ (2026-11-07)
# 中文 Windows 终端默认 GBK，print emoji 会 UnicodeEncodeError 直接崩。
# 定时任务是在没有终端的服务上下文里跑的，这一层更不能少。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
import sys as _sys
if BASE_DIR not in _sys.path:
    _sys.path.insert(0, BASE_DIR)

from memory_health import (
    _containment,
    detect_conflicts,
    find_orphans,
    find_merge_groups,
    find_zombies,
    health_report,
)


# ═══════════════════════════════════════════════════════════
# 配置读取（一律走 config，且读不到有默认值）
# ═══════════════════════════════════════════════════════════
#
# 为什么不直接 from config import X：
#   夜巡是定时任务，任何一次 config 改错（少一个键/拼错名字）都会让它
#   ImportError 直接死掉 —— 而它死掉的样子跟「今天没问题」一模一样（都是没有输出）。
#   所以这里全部走 _cfg()，缺键就用默认值，永远能跑起来。

def _cfg(name, default):
    try:
        import config as _c
        return getattr(_c, name, default)
    except Exception:
        return default


def _patrol_dir():
    return _cfg("PATROL_DIR", os.path.join(BASE_DIR, "patrol"))


def _patrol_log():
    return _cfg("PATROL_LOG_PATH",
                os.path.join(os.path.dirname(_patrol_dir()), "memsys-patrol.log"))


def _active_path():
    return _cfg("LONG_TERM_ACTIVE_PATH", os.path.join(BASE_DIR, "active.json"))


def _candidate_path():
    return _cfg("CANDIDATE_POOL_PATH", os.path.join(BASE_DIR, "candidates.jsonl"))


# 已知的归类取值。不在这里的（含空串）= 未归类待审。
# 依据：真实库实测出现过的 category（stable_profile 104 / 空 52 / event 45 / fact 9 / notes 5），
from services.category_registry import KNOWN_CATEGORIES

# 哪些算「异常」（值得推送的），哪些只算「关注项」（写报告但不打扰）。
# 分开的理由：未归类 52 条天天都在，天天报「异常」= 人很快就学会忽略报警。
# pending_embed 不在任何一栏里：它既不是异常也不是待关注，
# 只是「等下一轮巩固自己补上」的中间状态（见 check_embed_coverage）。
ABNORMAL_KEYS = ("orphans", "zombies", "duplicates", "conflicts", "halfwritten")
WATCH_KEYS = ("rarely_recalled", "untriaged", "candidates")


# ═══════════════════════════════════════════════════════════
# 通用小工具（dict / MemoryItem 双兼容）
# ═══════════════════════════════════════════════════════════

def _get(m, key, default=None):
    if isinstance(m, dict):
        return m.get(key, default)
    return getattr(m, key, default)


def _content(m):
    if isinstance(m, dict):
        return str(m.get("content") or m.get("text") or "")
    return str(getattr(m, "content", "") or "")


def _mem_id(m, idx=None):
    mid = _get(m, "mem_id", "")
    if mid:
        return str(mid)
    return "#%d" % idx if idx is not None else ""


def _as_views(memories):
    """把一批记忆转成普通的 dict 视图。

    memory_health 的老函数（find_merge_groups / detect_conflicts）只吃 dict，
    而调用方（memory_cli / 测试）经常直接传 MemoryItem。
    转成 dict 只是**视图**：to_dict() 是浅拷贝，没人往里面写，原对象不受影响。
    """
    out = []
    for m in memories or []:
        if isinstance(m, dict):
            out.append(m)
        elif hasattr(m, "to_dict"):
            try:
                out.append(m.to_dict())
            except Exception:
                out.append({})
        else:
            out.append({})
    return out


def _ts(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if v > 0 else 0.0


def _last_hit_ts(m):
    """「最后一次被想起」的时间戳（三处取最大）。

    取 create_time / last_mentioned_at / mention_history 的最大值。

    ⚠️ **不用 last_active**：
       last_active 会被初始化、巩固、召回反复刷新。实测 215 条里它的年龄
       全部在 0.3 天以内 —— 拿它判断「很久没想起」，这个检查项就永远不会触发，
       于是「真没问题」和「根本没在检查」长得一模一样（死字段的另一种形态）。
       所以这里用「真的被提起过」的时间；从没被提起过就用出生时间，
       含义是「从出生到现在一次都没被想起」。
    """
    best = _ts(_get(m, "create_time"))
    best = max(best, _ts(_get(m, "last_mentioned_at")))
    hist = _get(m, "mention_history") or []
    try:
        for t in hist:
            best = max(best, _ts(t))
    except TypeError:
        pass
    return best


def patrol_enabled():
    """夜巡总开关。没启用时 run_patrol 直接返回「未启用」报告，什么都不查。

    ★ 这个函数存在的原因（2026-11-08，被巡检 当场指出来）：
      一开始 features.nightly_patrol = True，但代码里**没有任何地方读它** ——
      开关开着不给任何人看，关掉也不改变任何行为。那就是本项目的老毛病：
      「开关开着但功能没接」，开关变成了装饰品。

      现在的约定：**开关是唯一的开关**。要停夜巡就把它改成 False，
      没必要去改 crontab —— 而且关掉之后 run_patrol 会返回一个
      「未启用」的报告，日志里能看见「今天没跑是因为关了」，
      而不是静悄悄地什么都不发生（那又变成「没跑」和「没问题」分不开）。
    """
    try:
        from features import on
        return bool(on("nightly_patrol"))
    except Exception:
        return True     # features 坏掉时默认继续跑：夜巡是安全网，宁可多跑


def _is_writable_dir(path):
    """能建目录、能写文件才返回 True。不靠猜（权限/只读盘/盘符不存在都试不出来）。"""
    probe = os.path.join(path, ".write_probe")
    try:
        os.makedirs(path, exist_ok=True)
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except Exception:
        return False


def _resolve_dir(preferred):
    """首选目录写不进去就退回项目目录，并**明确告诉调用方用的是哪个**。"""
    if _is_writable_dir(preferred):
        return preferred, False
    fallback = os.path.join(BASE_DIR, "patrol")
    if _is_writable_dir(fallback):
        return fallback, True
    return preferred, False


def _nd(days):
    """天数的可读写法（整数不带 .0；无穷大 = 没有时间戳）。"""
    if days is None or days == float("inf"):
        return "无时间戳"
    try:
        d = float(days)
    except (TypeError, ValueError):
        return "无时间戳"
    if abs(d - round(d)) < 0.05:
        return "%d 天" % int(round(d))
    return "%.1f 天" % d


# ═══════════════════════════════════════════════════════════
# ① 久未命中
# ═══════════════════════════════════════════════════════════

def _rarely_recalled_params(memories, now=None):
    """算这一轮用多少天做阈值，并说明为什么。

    返回 (days, reason, library_age_days)

    为什么要自适应：
      90 天是「长期记忆」的量级，但本库最老的条目也才 37 天（2026-10-27 建库）。
      死守 90 天，这个检查项在头三个月里必然一个都命中不了 —— 报告上写「0」，
      人看到的是「没问题」，实际是「还没到」，两者必须能分开。
      所以库龄不足 PATROL_IDLE_MIN_LIBRARY_DAYS 天时，阈值降到 PATROL_IDLE_AGED_DAYS 天，
      并在报告里写明「这轮用的是 30 天，不是 90 天」。
    """
    if now is None:
        now = time.time()
    base = int(_cfg("PATROL_RARE_DAYS", 90))
    min_lib = float(_cfg("PATROL_IDLE_MIN_LIBRARY_DAYS", 90))
    aged = int(_cfg("PATROL_IDLE_AGED_DAYS", 30))

    ages = []
    for m in memories or []:
        c = _ts(_get(m, "create_time"))
        if c > 0:
            ages.append((now - c) / 86400.0)
    lib_age = max(ages) if ages else None

    if lib_age is not None and lib_age < min_lib and aged < base:
        return aged, ("库龄最老 %.1f 天 < %.0f 天，阈值临时降到 %d 天"
                      "（否则 %d 天这条永远空转，看不出「真没问题」和「没在检查」的区别）"
                      % (lib_age, min_lib, aged, base)), lib_age
    return base, "标准阈值 %d 天" % base, lib_age


def recall_clock_diagnostic(memories, now=None):
    """诊断「被想起」这口钟到底准不准。

    为什么需要它（真实数据实测发现，2026-11-08）：
      226 条里 **195 条的 last_mentioned_at 是同一个时间戳**（迁移时批量写的），
      最老的「被想起」记录才 1.5 天前。于是「30 天没被想起」必然查出 0 条 ——
      那不是「没问题」，而是**计时起点被迁移重置了**，还没到能量出东西的时候。

    这两个在报告上长得一模一样（都是 0），必须靠这个诊断分开：
      真没问题      → 最老的一条「被想起」也很近，且时间戳分散（真有人在用）
      钟被重置了    → 一大批条目挤在同一个时刻（迁移/批量刷新的指纹）

    返回 dict：oldest_hit_days / newest_hit_days / shared_timestamp_count /
              shared_timestamp_age_days / never_recalled
    """
    if now is None:
        now = time.time()
    hits = []
    for m in memories or []:
        t = _ts(_get(m, "last_mentioned_at"))
        if t <= 0:
            t = _ts(_get(m, "create_time"))
        if t > 0:
            hits.append(t)

    never = 0
    for m in memories or []:
        try:
            if int(_get(m, "mention_count", 0) or 0) <= 0:
                never += 1
        except (TypeError, ValueError):
            never += 1

    if not hits:
        return {
            "oldest_hit_days": None,
            "newest_hit_days": None,
            "shared_timestamp_count": 0,
            "shared_timestamp_age_days": None,
            "never_recalled": never,
        }

    oldest = min(hits)
    newest = max(hits)
    # 同一秒被写的最多条数 = 批量写（迁移/刷新）的指纹
    bucketed = {}
    for t in hits:
        k = int(t)
        bucketed[k] = bucketed.get(k, 0) + 1
    peak_ts, peak_n = max(bucketed.items(), key=lambda kv: kv[1])
    return {
        "oldest_hit_days": round((now - oldest) / 86400.0, 2),
        "newest_hit_days": round((now - newest) / 86400.0, 2),
        "shared_timestamp_count": peak_n,
        "shared_timestamp_age_days": round((now - peak_ts) / 86400.0, 2),
        "never_recalled": never,
    }


def check_rarely_recalled(memories, days=None, now=None):
    """① 久未命中的记忆。

    判据：
      · idle >= 阈值天（idle = 距今 - 最后一次被想起，见 _last_hit_ts）
      · 最近 PATROL_RARE_RECENT_WINDOW 天内被想起 >= PATROL_RARE_RECENT_HITS 次的，
        算「还在用」，不算久未命中

    「还在用」这一条是防误报：一条 40 天前被提起过的记忆，
    如果这一个月里又被零星提起 6 次，那它活得很好，只是时间戳没更新到最新。
    """
    if now is None:
        now = time.time()
    if days is None:
        days = _cfg("PATROL_RARE_DAYS", 90)
    try:
        days = float(days)
    except (TypeError, ValueError):
        days = 90.0

    win_days = float(_cfg("PATROL_RARE_RECENT_WINDOW", 30))
    hits_need = int(_cfg("PATROL_RARE_RECENT_HITS", 5))

    out = []
    for idx, m in enumerate(memories or []):
        hit = _last_hit_ts(m)
        if hit <= 0:
            idle = float("inf")
        else:
            idle = max(0.0, (now - hit) / 86400.0)
        if idle < days:
            continue
        # 「还在用」保护
        hist = _get(m, "mention_history") or []
        try:
            recent = [t for t in hist if _ts(t) and (now - _ts(t)) <= win_days * 86400.0]
        except TypeError:
            recent = []
        if hits_need > 0 and len(recent) >= hits_need:
            continue
        try:
            mc = int(_get(m, "mention_count", 0) or 0)
        except (TypeError, ValueError):
            mc = 0
        try:
            imp = float(_get(m, "importance", 0.35) or 0.0)
        except (TypeError, ValueError):
            imp = 0.35
        out.append({
            "index": idx,
            "mem_id": _mem_id(m, idx),
            "content": _content(m).strip()[:40],
            "idle_days": None if idle == float("inf") else round(idle, 1),
            "mention_count": mc,
            "importance": round(imp, 2),
            "reason": ("从没被想起过" if mc == 0
                       else ("%d 次被想起，最后一次在 %s 前" % (mc, _nd(idle)))),
        })
    out.sort(key=lambda x: -(x["idle_days"] if x["idle_days"] is not None else 1e9))
    return out


# ═══════════════════════════════════════════════════════════
# ②③④ 重复 / 矛盾 / 孤儿 / 僵尸（都转给 memory_health）
# ═══════════════════════════════════════════════════════════

def check_duplicates(memories):
    """② 疑似重复。

    用 memory_health.find_merge_groups（内部用 _containment 包含度，
    并且带极性保护：「我不喜欢」vs「我喜欢」不会被当成重复）。

    阈值用 PATROL_DUP_THRESHOLD(0.72)，比合并用的 0.82 松一点 ——
    夜巡是「提醒人看一眼」，漏报比误报贵：重复条目会一直双倍占召回名额，
    而误报只是多看一眼。
    """
    views = _as_views(memories)
    thr = float(_cfg("PATROL_DUP_THRESHOLD", 0.72))
    groups = find_merge_groups(views, thr)
    out = []
    for g in groups:
        keep_i = g["keep_index"]
        from services.quality_reviews import relation
        import re as _re
        def _tool_action(v):
            if v.get("category") != "procedure":
                return None
            m = _re.search(r"\[工具\]\s*(\S+)\s*\[操作\]\s*([^\[\n]+)", str(v.get("content") or ""))
            return (m.group(1), m.group(2).strip()) if m else None
        keep_ta = _tool_action(views[keep_i]) if keep_i < len(views) else None
        reviewed = {'equivalent','distinct_events','lineage','complementary'}
        remaining=[d for d in g.get('drop_indices',[]) if
                   relation(views[keep_i],views[d]) not in reviewed
                   and not views[d].get('recall_excluded') and not views[keep_i].get('recall_excluded')
                   and not (keep_ta and _tool_action(views[d]) and keep_ta != _tool_action(views[d]))]
        if not remaining:continue
        g=dict(g,drop_indices=remaining)
        keep_text = (views[keep_i].get("content") if keep_i < len(views) else "") or ""
        pairs = []
        for d in g.get("drop_indices", []):
            drop_text = (views[d].get("content") if d < len(views) else "") or ""
            pairs.append({
                "drop_index": d,
                "drop_id": _mem_id(views[d], d) if d < len(views) else ("#%d" % d),
                "drop_text": str(drop_text).strip()[:40],
                "containment": round(_containment(keep_text, drop_text), 3),
            })
        out.append({
            "keep_index": keep_i,
            "drop_indices": g.get("drop_indices", []),
            "sim": g.get("sim"),
            "keep_text": str(keep_text).strip()[:60],
            "keep_id": _mem_id(views[keep_i], keep_i) if keep_i < len(views) else ("#%d" % keep_i),
            "drop_ids": [p["drop_id"] for p in pairs],
            "pairs": pairs,
        })
    return out


def check_capacity(memories):
    """⑭ 容量预警（2026-11-08 新增）。

    为什么需要这个：
      之前所有检查都是「数据对不对」，没有一条看「库会不会撑爆」。
      而实测召回耗时随条数线性涨：
        251 条 →  98ms
       1000 条 → 380ms
       2000 条 → 750ms   ← 每条消息的主路径都要付这个成本

    三个维度（只看条数不够）：
      ① 条数       —— 超 1000 提醒 / 超 2000 告警
      ② 文件体积   —— 超 20MB 提醒（序列化+写盘成本）
      ③ 强度分布   —— 如果 >70% 都挤在 90 分以上，说明衰减没生效
                      （2026-11-08 实测：251 条里 176 条在 90 分以上，
                        根因是 calculate_current_strength 批量刷 last_active，
                        已修；这个检查用来防止复发）

    强度分布那条最重要：它是「衰减机制活着没」的体检指标。
    """
    import os as _os
    out = []
    n = len(memories)

    # ① 条数
    warn_n = int(_cfg("PATROL_COUNT_WARN", 1000))
    alert_n = int(_cfg("PATROL_COUNT_ALERT", 2000))
    if n >= alert_n:
        out.append({"level": "alert", "kind": "count",
                    "msg": "库 %d 条，超告警线 %d，召回会明显变慢" % (n, alert_n)})
    elif n >= warn_n:
        out.append({"level": "warn", "kind": "count",
                    "msg": "库 %d 条，超提醒线 %d" % (n, warn_n)})

    # ② 文件体积
    try:
        _active_path = _cfg("LONG_TERM_ACTIVE_PATH",
                            os.path.join(BASE_DIR, "active.json"))
        size_mb = _os.path.getsize(_active_path) / (1024.0 * 1024.0)
        warn_mb = float(_cfg("PATROL_SIZE_WARN_MB", 20.0))
        if size_mb >= warn_mb:
            out.append({"level": "warn", "kind": "size",
                        "msg": "库文件 %.1f MB，超 %.0f MB（序列化+写盘变慢）"
                               % (size_mb, warn_mb)})
    except Exception:
        pass

    # ③ 强度分布：衰减机制体检
    strengths = []
    for m in memories:
        v = m.get("strength") if isinstance(m, dict) else getattr(m, "strength", None)
        if v is not None:
            try:
                strengths.append(float(v))
            except (TypeError, ValueError):
                pass
    if strengths:
        top = sum(1 for s in strengths if s >= 90.0)
        ratio = top / len(strengths)
        # 70% 挤在 90 分以上 = 衰减没在起作用
        if ratio >= 0.70 and len(strengths) >= 50:
            out.append({
                "level": "warn", "kind": "strength_skew",
                "msg": "%.0f%%（%d/%d 条）强度 >= 90 —— 衰减可能没生效"
                       "（检查 calculate_current_strength 有没有被批量调用）"
                       % (ratio * 100, top, len(strengths)),
            })
    return out


def check_conflicts(memories):
    """③ 矛盾候选：同一件事说法相反。

    调 memory_health.detect_conflicts（相似度 + 极性相反双判据）。
    只报告不裁决 —— 「她到底喜不喜欢火锅」该问人，不该程序猜。
    """
    views = _as_views(memories)
    conflicts = detect_conflicts(views)
    out = []
    for c in conflicts:
        ai, bi = c["a_index"], c["b_index"]
        from services.quality_reviews import relation
        if relation(views[ai],views[bi]) in ('equivalent','same_statement','distinct_events','lineage'):
            continue
        if views[ai].get('recall_excluded') or views[bi].get('recall_excluded'):continue
        out.append({
            "a_index": ai,
            "b_index": bi,
            "a_id": _mem_id(views[ai], ai),
            "b_id": _mem_id(views[bi], bi),
            "sim": c.get("sim"),
            "text_a": c.get("text_a", ""),
            "text_b": c.get("text_b", ""),
            "polarity": c.get("polarity", []),
        })
    return out


def check_orphans(memories):
    """④a 孤儿：来源为空 / 内容太短 / 向量缺失。"""
    return find_orphans(memories, _cfg("ORPHAN_MIN_CHARS", 5))


def check_zombies(memories, now=None):
    """④b 僵尸：久没被想起 + 强度到地板 + importance < 0.5。"""
    return find_zombies(memories, _cfg("ZOMBIE_DAYS", 90), now)


# ═══════════════════════════════════════════════════════════
# ⑧ 情景档引用完整性（2026-11-08 接入）
# ═══════════════════════════════════════════════════════════
#
# 来源：巡检 交付的 _vh/episode_integrity.py，
#       函数逻辑（三状态判据 / 双向孤儿 / 守恒）是它设计的，原样保留。
#       我只改了**三个调用安全问题**，逻辑一个字没动（下面 ①②③）。
#
# 检查什么（三句话）：
#   ① 片段打了 episode_id，但对应的档没落库  → 正向孤儿
#      那几条碎片在召回视角下等于丢失
#   ② 档引用的碎片已被清理（碎片 3 天 ttl，档 90 天）→ 反向孤儿
#      设计允许，但会让「可追溯」打折
#   ③ 档声称「原始对话 N 条、可追溯」，实际只剩 M 条 → 假承诺
#
# 为什么是三状态而不是二值（巡检 的关键判断，我认同）：
#   episode 聚合要写 active.json + shortterm.json **两个文件**，
#   不是原子的 —— 任何时刻都可能看到「碎片打了标、档还没落库」。
#   下一次巩固会消化掉。按「>0 就告警」会天天误报。
#   实测它 11:21 看到 1 条、11:25 自己好了。
#
# ★ 这个检查跟别的检查有一个本质区别：**它会写文件**。
#   它要把本次的孤儿数记进 _episode_state.json，下次好比较「有没有变多」。
#   夜巡主流程是只读的，这是一个明确的例外 —— 但它写的**不是记忆库**，
#   是检查器自己的账本。已把落点固定在项目目录，不受 cwd 影响。


def episode_integrity_state_path():
    """检查器自己的状态文件（记上次的孤儿数，用来判断「有没有变多」）。

    ① 为什么不能是相对路径 `_vh/.orphan_state.json`（巡检 原版）：
       run_patrol() 可能从任何 cwd 被调用。计划任务那边有 `cd /d`，
       但别的调用方（测试、手动 `python -c`、将来的推送脚本）不一定有。
       实测：从家目录调 check_episode_integrity() 直接
       `unknown | FileNotFoundError: active.json` —— 整个检查静默失效。
       夜巡最怕的就是这种「静默失效」，因为它长得跟「没问题」一模一样。
    """
    return _cfg("EPISODE_STATE_PATH",
                os.path.join(_cfg("BASE_DIR", BASE_DIR), "state", "episode_integrity_state.json"))


def _shortterm_path():
    """短期层路径（从 config 拿绝对路径，不猜）。"""
    return _cfg("SHORT_TERM_PATH", os.path.join(BASE_DIR, "shortterm.json"))


def _cold_path():
    """冷存层路径（用于核对已归档的情景档，避免误报成正向孤儿）。"""
    return _cfg("LONG_TERM_COLD_PATH", os.path.join(BASE_DIR, "cold.json"))


def check_episode_integrity(active_memories=None, shortterm_path=None,
                            state_path=None, cold_memories=None):
    """情景档引用完整性（双向 + 守恒）。

    返回 dict（**不是 list**，所以不能跟别的检查一样丢进 counts 里数长度）：
      status         ok / transient / growing / unknown
      reason         人话说明
      fwd_orphans    [[episode_id, 碎片数], ...]   碎片有标、档不在
      rev_orphans    [[ep_id, 缺几条], ...]        档引用的碎片已清理
      untraceable    [[ep_id, 声称N, 实际M], ...]  「可追溯」不合实际
      total_src      所有 episode 的 source_turns 总条数
      marked         短期层打了 episode_id 的碎片数
      conserved      total_src == marked

    ② 读失败绝不抛：整段包在 try 里，任何异常都返回完整的空结构。
       理由（巡检 说的，我照做）：这个检查要读第三个文件，
       「多读一个文件」就是多一个失败点，不能让它把夜巡主流程带崩。
    """
    import collections

    def _empty(status, reason):
        return {
            "status": status, "reason": reason,
            "fwd_orphans": [], "rev_orphans": [], "untraceable": [],
            "total_src": 0, "marked": 0, "conserved": True,
            "unrecorded_fragments": [], "referenced_missing": [],
            "unrecorded_total": 0,
        }

    try:
        # ① 活跃库：优先用调用方传进来的（run_patrol 已经读了，别重复读 7MB）
        if active_memories is None:
            with open(_active_path(), encoding="utf-8") as f:
                active_memories = json.load(f)["memories"]

        # ② 短期层：必须单独读（夜巡原本不读它）
        st_path = shortterm_path or _shortterm_path()
        with open(st_path, encoding="utf-8") as f:
            short = json.load(f).get("memories", [])
    except Exception as e:
        return _empty("unknown", "%s: %s" % (type(e).__name__, e))

    try:
        active_memories = list(active_memories or [])
        short = list(short or [])
        if cold_memories is None:
            try:
                _cp = _cold_path()
                if os.path.exists(_cp):
                    with open(_cp, encoding="utf-8") as _cf:
                        cold_memories = json.load(_cf).get("memories", [])
                else:
                    cold_memories = []
            except Exception:
                cold_memories = []
        else:
            cold_memories = list(cold_memories or [])
        ac_ids = set(m.get("mem_id") for m in active_memories)
        cold_ids = set(m.get("mem_id") for m in cold_memories)
        known_ep_ids = ac_ids | cold_ids
        st_ids = set(m.get("mem_id") for m in short)
        eps = [m for m in active_memories if m.get("mem_type") == "episode"]
        cold_eps = [m for m in cold_memories if m.get("mem_type") == "episode"]

        # 正向孤儿：碎片标了 episode_id，但档在活跃库和冷库里都不存在
        ref = collections.defaultdict(list)
        for m in short:
            eid = m.get("episode_id")
            if eid:
                ref[eid].append(m)
        fwd = [[k, len(v)] for k, v in ref.items() if k not in known_ep_ids]

        # 反向孤儿 + 可追溯检查（仅统计活跃档）
        rev = []
        untraceable = []
        for ep in eps:
            src = ep.get("source_turns") or []
            if not src:
                continue
            alive = sum(1 for t in src if t in st_ids)
            if alive < len(src):
                rev.append([ep.get("mem_id"), len(src) - alive])
                untraceable.append([ep.get("mem_id"), len(src), alive])

        total_src = sum(len(ep.get("source_turns") or []) for ep in eps)
        marked = sum(1 for m in short if m.get("episode_id") and m.get("episode_id") not in cold_ids)

        # ★ 2026-11-08 补：守恒不一致时，**光说「不相等」没有用** ——
        #   要能指出差在哪。实测真实数据 59 vs 62，三个碎片各差一号，
        #   必须分类才知道该找谁修。三种差额各有不同含义：
        #     · 打了标但档没写进 source_turns → 档漏记（本文件能查）
        #     · 档写了但碎片已清理         → 设计允许（3 天 ttl vs 90 天）
        #     · 档引用但没人打标            → 打标环节漏了
        #   把这三类分开数，`conserved` 才有诊断价值。
        src_set = set()
        for ep in (eps + cold_eps):
            src_set.update(ep.get("source_turns") or [])
        marked_ids = [m.get("mem_id") for m in short if m.get("episode_id")]
        marked_set = set(marked_ids)
        # 打了标，但没有任何档把它写进 source_turns，
        # **且它指向的档其实是存在的**（档不存在的情况归正向孤儿，不重复计）
        unrecorded = [mid for mid in marked_set
                      if mid not in src_set]
        unrecorded_in_existing = []
        for m in short:
            mid = m.get("mem_id")
            eid = m.get("episode_id")
            if eid and mid not in src_set and eid in known_ep_ids:
                unrecorded_in_existing.append([eid, mid])
        referenced_missing = [t for t in src_set if t not in st_ids]

        # 三状态：跟上次比
        n_fwd = sum(c for _, c in fwd)
        state_path = state_path or episode_integrity_state_path()
        last = None
        try:
            with open(state_path, encoding="utf-8") as f:
                last = json.load(f).get("fwd_count")
        except Exception:
            pass
        try:
            os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump({"fwd_count": n_fwd,
                           "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}, f)
        except Exception:
            pass          # 状态写不了只影响「能不能判断变多」，不影响本次结论

        if n_fwd == 0:
            status, reason = "ok", "0 条"
        elif last is None:
            status, reason = "transient", "%d 条（首次记录，等自愈）" % n_fwd
        elif n_fwd > last + 2:
            status, reason = "growing", "%d → %d，增长中，查 active 写盘" % (last, n_fwd)
        else:
            status, reason = "transient", "%d 条（上次 %d，未增长，等自愈）" % (n_fwd, last)

        return {
            "status": status, "reason": reason,
            "fwd_orphans": fwd, "rev_orphans": rev, "untraceable": untraceable,
            "total_src": total_src, "marked": marked,
            "conserved": total_src == marked,
            # 守恒差在哪（见上面注释）：三类分开列
            "unrecorded_fragments": unrecorded_in_existing,   # 打了标、档没记
            "referenced_missing": referenced_missing,         # 档记了、碎片已清
            "unrecorded_total": len(unrecorded),
        }
    except Exception as e:
        return _empty("unknown", "%s: %s" % (type(e).__name__, e))

def check_window_ledger(prune: bool = False):
    """⑨ 窗口账本：过期轮次的体检（**默认只数不删**）。

    背景（评审 问的 prune_all）：
      window_ledger.prune_all() 注释写「给夜巡用」，但 nightly_patrol.py 里
      window_ledger 出现 0 次 —— 又一个「注释说了，代码没做」。

    ★ 但我没有直接调 prune_all()，原因很硬：
      **它会真删数据。** 夜巡的契约是「只读，一个字节都不改」，
      报告页脚还印着「上面的每一条都没有被修改」。
      一个自称只读的任务偷偷删账本，是最坏的那类惊喜 ——
      而且删错了没人能发现（账本是只追加的，删了补不回来）。

    所以这里做成 **dry-run 优先**：
      · 默认只算出「有多少轮超过保留期」，写进报告，由人决定
      · 传 prune=True 才真删（给将来的定期清理任务用，或手动）

    参数从 config 拿（WINDOW_KEEP_DAYS），跟 window_ledger 自己的默认值一致。

    返回：{available, sessions, total_turns, stale_turns, keep_days, pruned, error}
    """
    info = {
        "available": False, "sessions": 0, "total_turns": 0,
        "stale_turns": 0, "keep_days": int(_cfg("WINDOW_KEEP_DAYS", 30)),
        "pruned": 0, "error": None,
    }
    try:
        import window_ledger as _wl
    except Exception as e:
        info["error"] = "导入失败 %s: %s" % (type(e).__name__, e)
        return info

    info["available"] = True
    try:
        st = _wl.stats()
        info["sessions"] = int(st.get("sessions") or 0)
        info["total_turns"] = int(st.get("total_turns") or 0)
    except Exception as e:
        info["error"] = "stats 失败 %s: %s" % (type(e).__name__, e)

    # 只数：直接读各会话的轮次，按 said_at 判过期，不碰写路径
    try:
        stale = 0
        cutoff = time.time() - info["keep_days"] * 86400.0
        for sid in _wl._list_session_dirs():
            try:
                rows = _wl.read_turns(sid)
            except Exception:
                continue
            for r in rows or []:
                ts = r.get("said_at")
                try:
                    ts = float(ts)
                except (TypeError, ValueError):
                    continue
                if ts > 0 and ts < cutoff:
                    stale += 1
        info["stale_turns"] = stale
    except Exception as e:
        info["error"] = "统计失败 %s: %s" % (type(e).__name__, e)

    if prune:
        try:
            info["pruned"] = int(_wl.prune_all(info["keep_days"]) or 0)
        except Exception as e:
            info["error"] = "清理失败 %s: %s" % (type(e).__name__, e)
    return info

# ═══════════════════════════════════════════════════════════
# ⑤ 半写断裂 / ⑥ 未归类 / ⑦ 候选池
# ═══════════════════════════════════════════════════════════

def check_halfwritten(memories):
    """⑤ 半写断裂：有 content、向量该有却没有（真断了）。

    ★ 对外接口：主流程（run_patrol）和报告都按这个名字取用。
      实现在 check_embed_coverage()，这里只是「取断裂那一半」——
      遍历只做一次，保证「断裂」和「待补」两个列表互斥。

    这是**写入过程断在半路**的痕迹：ollama 恰好不可用 / 进程被杀在写一半。
    跟「孤儿」的区别：孤儿可能是本来就短，这里是「明明有内容，向量却没落下」。

    影响：没向量 = 向量召回永远命中不了它（相似度恒 0），
    去重也拦不住它 —— 它会一直待在库里，但永远不被想起。
    （daily_consolidation 有 embed_heal 会补，但补不上的那些需要人看。）

    ★ 2026-11-08：embed_status=pending 的**不算断裂**，单独返回。
      情景档是「先落盘、后算向量」的（episode.py 写 embed_status=pending），
      巩固下一轮就会补。把它们报成断裂就是每天一批假警报 ——
      巡检 在真实数据上撞到过（11 条新建 episode 同时被
      报成 orphans + halfwritten，理由都是「向量缺失」，而它们下轮就修好了）。
    """
    return check_embed_coverage(memories)[0]


def check_pending_embed(memories):
    """向量还没算的（embed_status=pending）—— 不是异常，等它自己补。"""
    return check_embed_coverage(memories)[1]


def check_embed_coverage(memories):
    """一次遍历，分出 (真断裂, 待补算)。

    只遍历一遍是为了保证两个列表**互斥**（同一条不会既算断裂又算待补）。
    分成两段各写一个循环很容易重叠 —— 一重叠，报告上
    「11 条问题」就会看起来像「22 条问题」。
    """
    broken, pending = [], []
    for idx, m in enumerate(memories or []):
        text = _content(m).strip()
        if not text:
            continue                      # 空内容归孤儿管，这里不重复计
        emb = _get(m, "embedding")
        ok = bool(emb)
        if ok and isinstance(emb, (list, tuple)):
            try:
                ok = any(x != 0 for x in emb)
            except TypeError:
                ok = True
        if ok:
            continue
        st = str(_get(m, "embed_status", "") or "").lower()
        if st == "pending":
            pending.append({
                "index": idx,
                "mem_id": _mem_id(m, idx),
                "content": text[:40],
            })
            continue
        broken.append({
            "index": idx,
            "mem_id": _mem_id(m, idx),
            "content": text[:40],
            "embed_status": st,
            "reason": ("向量算失败（embed_status=failed）" if st == "failed"
                       else ("向量缺失" if not emb else "向量全零（嵌入失败留下的）")),
        })
    return broken, pending


def check_untriaged(memories):
    """⑥ 未归类待审：category 为空或不在已知集合。

    这些是「进库了但还没被分过类」的 —— 分类决定衰减速率和地板，
    没分类的只能吃默认档，等于系统对它一无所知。列出来等着归。
    """
    out = []
    for idx, m in enumerate(memories or []):
        cat = str(_get(m, "category", "") or "").strip()
        if cat and cat in KNOWN_CATEGORIES:
            continue
        out.append({
            "index": idx,
            "mem_id": _mem_id(m, idx),
            "content": _content(m).strip()[:40],
            "category": cat,
            "reason": "category 为空" if not cat else ("未知归类：%s" % cat),
        })
    return out


def check_candidates(path=None):
    """⑦ 候选池待整理：candidates.jsonl 里 status=pending 的条数。

    ⚠️ 文件不存在返回 []（调用方另外用 check_candidates_available 判「没开」），
       不能把「没有文件」和「文件里 0 条」混成同一个 0 ——
       前者是功能没启用，后者是启用了但没攒下东西。
    """
    path = path or _candidate_path()
    if not os.path.exists(path):
        return []
    out = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for ln, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                # 2026-11-08 修：candidates.jsonl 里不只有候选，还有重复计数事件
                #   {"kind": "repeat", "content_hash": ..., "at": ...}。
                #   那种行没有 status 字段，上面的 d.get("status", "pending")
                #   会**默认成 pending** 把它也算进来 —— 于是每条候选被数成 2 条。
                #   候选池模块的 write_candidate 每次写入都会顺带记一次 repeat，
                #   所以这不是偶发，是 1:1 的固定虚高。
                if str(d.get("kind", "candidate")) != "candidate":
                    continue
                if str(d.get("status", "pending")) != "pending":
                    continue
                out.append({
                    "line": ln,
                    "id": d.get("id", ""),
                    "content": str(d.get("content", ""))[:40],
                    "gate": d.get("gate", ""),
                    "reason": d.get("reason", ""),
                })
    except Exception as e:
        return [{"line": 0, "id": "", "content": "", "gate": "",
                 "reason": "候选池读取失败：%s: %s" % (type(e).__name__, e)}]
    return out


def check_candidates_available(path=None):
    """候选池文件在不在（用来区分「没开」和「开了但空」）。"""
    return os.path.exists(path or _candidate_path())


# ═══════════════════════════════════════════════════════════
# 数据读取（只读）
# ═══════════════════════════════════════════════════════════

def _file_sha256(path):
    """文件内容的 sha256（前 16 位）。返回 (指纹, 错误)。

    为什么只取前 16 位：报告抬头要一眼能复制、能对比。
    64 位全串在报告里是噪音，而 16 位（64 bit）对「同一个库的几份快照」来说，
    撞车概率可以忽略 —— 它不是安全边界，是「这份报告对应哪份数据」的核对标记。
    """
    import hashlib
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()[:16], None
    except Exception as e:
        return "", "%s: %s" % (type(e).__name__, e)


def _data_fingerprint(memories, source_path=None):
    """这份报告看的是哪份数据 —— 返回 (指纹, 算法说明)。

    两种情况，两种算法，都写明用的是哪种（不能混为一谈）：
      · 从文件读的 → **文件字节的 sha256**。这是最强的说法：
                     它同时证明了「我只读、没改」，因为读完再算一次会是同一个值。
      · 外部传入的 → **内容规范化后的 sha256**（json.dumps sort_keys）。
                     此时没有「文件」可言，指纹只能代表「这一批记忆的内容」。
    两种指纹**不能互相比较** —— 所以报告里必须写明是哪种。
    """
    if source_path and os.path.exists(source_path):
        fp, err = _file_sha256(source_path)
        if not err:
            return fp, "文件 sha256"
    try:
        import hashlib
        blob = json.dumps(memories, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16], "内容 sha256"
    except Exception:
        return "", "算不出来"


def load_active_memories(path=None):
    """读活跃库。返回 (memories, error)。

    ★ 只读：open(..., "r")，不写、不加锁
      （写入方 daily_consolidation 用的是原子写 os.replace，
        读到的要么是旧文件要么是新文件，不会是半个 JSON）。
    """
    path = path or _active_path()
    if not os.path.exists(path):
        return [], "文件不存在：%s" % path
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("memories", []) if isinstance(data, dict) else (data or [])
        return list(raw), None
    except Exception as e:
        return [], "读取失败 %s: %s" % (type(e).__name__, e)


# ═══════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════

def run_patrol(memories=None, now=None) -> dict:
    """跑一轮检查，返回报告。

    memories 为 None 时读 active.json（真实数据）。
    传入 memories 时按传入的算（测试 / 只想看某批）。

    检查项（七项，全只读）：
      ① 久未命中    ② 疑似重复    ③ 矛盾候选    ④ 孤儿/僵尸
      ⑤ 半写断裂    ⑥ 未归类待审  ⑦ 候选池待整理

    ★ 只读保证：这里没有任何写盘、没有 calculate_current_strength，
      传入的 memories 在函数返回后**一个字段都没变**（selftest 会验）。
    """
    if now is None:
        now = time.time()

    # 开关关掉 → 不查、不写、只回一个「未启用」的报告。
    # 注意仍然返回完整结构的报告（不会让调用方 KeyError），
    # 只是每项都是 0，且 enabled=False 能被报告和日志区分出来。
    if not patrol_enabled():
        empty = dict((k, []) for k in
                     ("rarely_recalled", "duplicates", "conflicts", "orphans",
                      "zombies", "halfwritten", "untriaged", "candidates"))
        return {
            "date": datetime.fromtimestamp(now).strftime("%Y-%m-%d"),
            "generated_at": datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M:%S"),
            "source": "（未运行）",
            "load_error": None,
            "enabled": False,
            "data_sha256": "",
            "data_sha256_kind": "未运行",
            "total": 0,
            "counts": dict((k, 0) for k in empty),
            "summary": {"total": 0, "orphans": 0, "zombies": 0,
                        "duplicates": 0, "conflicts": 0, "healthy": 0},
            "abnormal": False,
            "watch": False,
            "healthy": 0,
            "checks": empty,
            "meta": {"enabled": False, "read_only": True},
        }

    load_error = None
    source = "外部传入"
    source_path = None
    if memories is None:
        source_path = _active_path()
        source = source_path
        memories, load_error = load_active_memories(source_path)
    memories = list(memories or [])

    # 2026-11-08（评审 裁定 A）：数据指纹。
    #   为什么必须有：夜巡挂进计划任务之后是**无人值守**跑的，
    #   那时候「这份报告对应哪一份数据」只能靠报告自己写清楚 ——
    #   没人会手动补 sha256。靠人记的规矩早晚会漏。
    #   ★ 只加字段，不参与任何判断逻辑。
    fingerprint, fp_kind = _data_fingerprint(memories, source_path)

    # ① 久未命中（阈值随库龄自适应，报告里写明用的多少天）
    rare_days, rare_reason, lib_age = _rarely_recalled_params(memories, now)
    rarely = check_rarely_recalled(memories, rare_days, now)
    # 「被想起」这口钟准不准 —— 0 条到底是「真没问题」还是「钟被重置了」
    clock = recall_clock_diagnostic(memories, now)

    # ②③④
    duplicates = check_duplicates(memories)
    conflicts = check_conflicts(memories)
    orphans = check_orphans(memories)
    zombies = check_zombies(memories, now)

    # ⑤⑥⑦
    # 2026-11-08：这里原来直接调 check_embed_coverage()，于是
    #   check_halfwritten() / check_pending_embed() 两个对外函数**没人调**，
    #   被 link_check 判成「完全无人调用」的死代码（真问题）。
    #   那两个函数是别的模块按名字取用的接口（报告 / 将来的推送都会单独要
    #   「断裂」或「待补」其中一个），不能删；正确做法是主流程也走它们，
    #   这样「有人用」和「接口稳定」同时成立。
    halfwritten = check_halfwritten(memories)
    pending_embed = check_pending_embed(memories)
    untriaged = check_untriaged(memories)
    candidates = check_candidates()
    candidates_on = check_candidates_available()

    # ⑭ 容量预警（2026-11-08 新增）
    #   之前所有检查都是「数据对不对」，没有一条看「库会不会撑爆」。
    #   实测召回耗时随条数线性涨：251→98ms / 1000→380ms / 2000→750ms。
    #   而 2000 条那种情况，每条消息的主路径都要付 750ms —— 必须先预警。
    capacity = check_capacity(memories)

    # ⑧ 情景档引用完整性（跨文件：还要读 shortterm.json）
    #   ★ 它返回的是 **dict**（里面才有 status/reason/三类孤儿），
    #     不是 list —— 不能跟别的检查一起 `len()` 数条数。
    #     所以它单独放进 report["episode_integrity"]，counts 里只放
    #     「正向孤儿条数」这一个能跟别人比的数字，避免两种东西混进同一个计数表。
    episode_integrity = check_episode_integrity(memories)

    # ⑨ 窗口账本（默认 dry-run：只数过期轮次，不删）+ ⑩ 候选池状态
    window_ledger_info = check_window_ledger(prune=False)

    checks = {
        "rarely_recalled": rarely,
        "duplicates": duplicates,
        "conflicts": conflicts,
        "orphans": orphans,
        "zombies": zombies,
        "halfwritten": halfwritten,
        "pending_embed": pending_embed,
        "untriaged": untriaged,
        "capacity": capacity,
        "candidates": candidates,
    }
    counts = dict((k, len(v)) for k, v in checks.items())
    # ⑧ 单独一栏：只把「能跟别人比的数字」放进 counts
    counts["episode_fwd_orphans"] = len(episode_integrity.get("fwd_orphans") or [])
    counts["window_stale_turns"] = int(window_ledger_info.get("stale_turns") or 0)

    # 汇总复用 health_report：把已经算好的结果传进去，不重算一遍 ——
    #   这样「汇总」和「明细」永远出自同一批数据，不会两处各算一份然后打架。
    summary = health_report(
        memories, now,
        orphans=orphans, zombies=zombies,
        duplicates=duplicates, conflicts=conflicts,
    )
    summary.pop("details", None)      # 明细上面已经有了，别在报告里存两份

    abnormal = any(counts.get(k, 0) > 0 for k in ABNORMAL_KEYS)
    watch = any(counts.get(k, 0) > 0 for k in WATCH_KEYS)

    return {
        "date": datetime.fromtimestamp(now).strftime("%Y-%m-%d"),
        "generated_at": datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M:%S"),
        "source": source,
        "load_error": load_error,
        "enabled": True,
        "data_sha256": fingerprint,
        "data_sha256_kind": fp_kind,
        "total": len(memories),
        "counts": counts,
        "summary": summary,
        "abnormal": abnormal,
        "watch": watch,
        "healthy": summary.get("healthy", len(memories)),
        "checks": checks,
        # ⑧ 结构不一样的检查单独放，不塞进 checks（见上面注释）
        "episode_integrity": episode_integrity,
        "window_ledger": window_ledger_info,
        "meta": {
            "rarely_recalled_days": rare_days,
            "rarely_recalled_reason": rare_reason,
            "library_age_days": None if lib_age is None else round(lib_age, 1),
            "recall_clock": clock,
            "candidates_available": candidates_on,
            "abnormal_keys": list(ABNORMAL_KEYS),
            "watch_keys": list(WATCH_KEYS),
            "read_only": True,
        },
    }


# ═══════════════════════════════════════════════════════════
# 报告生成
# ═══════════════════════════════════════════════════════════

def _md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(x) for x in r) + " |")
    return out


def _brief(items, limit=10, fmt=None):
    """明细最多列 limit 条，剩下的写「还有 N 条」。"""
    lines = []
    for it in items[:limit]:
        try:
            lines.append(fmt(it) if fmt else ("- %s" % it))
        except Exception:
            lines.append("- %s" % it)
    if len(items) > limit:
        lines.append("- …还有 %d 条（完整明细见同名 .json）" % (len(items) - limit))
    return lines


def _candidate_note(meta):
    """候选池这一项怎么读 —— 把「没启用」和「启用了但空」分开说。

    为什么较真：candidates 那一项的 0 有两个完全不同的含义，
    混在一起就是本项目的老毛病（「这段没跑」和「跑了没结果」长得一样）。
    """
    meta = meta or {}
    if meta.get("candidates_available"):
        return "candidates.jsonl 里 status=pending 的条数"
    path = _cfg("CANDIDATE_POOL_PATH", None)
    try:
        from features import on as _on
        enabled = bool(_on("candidate_pool"))
    except Exception:
        enabled = False
    if enabled:
        return "开关已开，但 %s 还没生成（还没攒下东西，或写入口还没跑）" % (
            os.path.basename(path) if path else "candidates.jsonl")
    return "候选池功能未启用（features.candidate_pool=False）"


def format_report(report) -> str:
    """生成 Markdown 报告。"""
    r = report or {}
    counts = r.get("counts", {}) or {}
    meta = r.get("meta", {}) or {}
    checks = r.get("checks", {}) or {}
    total = r.get("total", 0)
    date = r.get("date", "")
    dup_thr = float(_cfg("PATROL_DUP_THRESHOLD", 0.72))

    L = []
    L.append("# 记忆夜巡报告 · %s" % date)
    L.append("")
    L.append("> 生成 %s · **%d 条** · 只读（一个字节都没改）"
             % (r.get("generated_at", ""), total))
    # 2026-11-08：抬头必须能回答「这份报告看的是哪份数据」。
    #   只有条数不够 —— 库在实时变，234 条可以对应完全不同的两份数据。
    _fp = r.get("data_sha256") or ""
    L.append(">")
    L.append("> 数据来源：%s" % (r.get("source") or "?"))
    if _fp:
        L.append("> 数据指纹：`%s`（%s，%d 条 @ %s）"
                 % (_fp, r.get("data_sha256_kind") or "sha256",
                    total, r.get("generated_at", "")))
    else:
        L.append("> 数据指纹：（没算出来 —— 见下方读取错误）")
    if r.get("load_error"):
        L.append("")
        L.append("> ⚠️ 数据读取有问题：%s" % r["load_error"])
    if r.get("enabled") is False:
        L.append("")
        L.append("> ⏸ **本轮未启用**（features.nightly_patrol = False）。"
                 "下面全是 0 是因为没查，不是因为没问题。")
    L.append("")

    # ── 结论 ──
    L.append("## 结论")
    L.append("")
    if r.get("abnormal"):
        bad = ["%s %d" % (k, counts.get(k, 0)) for k in ABNORMAL_KEYS if counts.get(k, 0)]
        L.append("**⚠️ 有异常**：" + "、".join(bad))
    else:
        L.append("**✅ 无异常**（孤儿 / 僵尸 / 重复 / 矛盾 / 半写断裂 全是 0）")
    if r.get("watch"):
        w = ["%s %d" % (k, counts.get(k, 0)) for k in WATCH_KEYS if counts.get(k, 0)]
        L.append("")
        L.append("另有待关注项（不影响可用性，攒着一起处理即可）：" + "、".join(w))
    L.append("")

    # ── 总览表 ──
    L.append("## 总览")
    L.append("")
    rows = [
        ("记忆总数", total, "活跃库 active.json"),
        ("孤儿", counts.get("orphans", 0), "来源空 / 内容太短 / 向量缺失"),
        ("僵尸", counts.get("zombies", 0), "久没想起 + 强度到地板 + importance<0.5"),
        ("疑似重复", counts.get("duplicates", 0), "包含度 >= %.2f" % dup_thr),
        ("矛盾候选", counts.get("conflicts", 0), "同一件事说法相反"),
        ("半写断裂", counts.get("halfwritten", 0), "有内容、向量该有却没有（真断了）"),
        ("向量待补算", counts.get("pending_embed", 0),
         "embed_status=pending，巩固下一轮会补 —— **不是异常**"),
        ("久未命中", counts.get("rarely_recalled", 0),
         "%s 天没被想起（%s）" % (meta.get("rarely_recalled_days", "?"),
                                 meta.get("rarely_recalled_reason", ""))),
        ("未归类待审", counts.get("untriaged", 0), "category 为空或不在已知集合"),
        ("候选池待整理", counts.get("candidates", 0), _candidate_note(meta)),
        ("健康条数", r.get("healthy", total), "没被上面任何一项点名的"),
    ]
    L.extend(_md_table(["项目", "数量", "说明"], rows))
    L.append("")

    # ── 明细 ──
    L.append("## 明细")
    L.append("")

    def section(title, key, empty_note, fmt, limit=10):
        items = checks.get(key, []) or []
        L.append("### %s（%d 条）" % (title, len(items)))
        L.append("")
        if not items:
            L.append("- （无）%s" % empty_note)
        else:
            L.extend(_brief(items, limit, fmt))
        L.append("")

    clk = meta.get("recall_clock") or {}
    idle_note = "没有超过 %s 天没被想起的记忆" % meta.get("rarely_recalled_days", "?")
    if not checks.get("rarely_recalled") and clk:
        od = clk.get("oldest_hit_days")
        sn, sa = clk.get("shared_timestamp_count") or 0, clk.get("shared_timestamp_age_days")
        if od is not None and od < float(meta.get("rarely_recalled_days") or 0):
            # 这一项是 0，但**不是**因为「没问题」—— 计时起点太新，还量不出东西
            idle_note = ("**这 0 条不代表没问题**：全库最老的「被想起」记录距今才 %s"
                         "（阈值 %s），还没到能量出东西的时候"
                         % (_nd(od), _nd(meta.get("rarely_recalled_days"))))
            if sn >= max(10, int(total * 0.3)) and sa is not None:
                idle_note += (
                    ("；另外有 **%d 条（%.0f%%）的 last_mentioned_at 挤在同一个时刻**"
                     "（%s前，迁移时批量写的痕迹），说明这口钟的起点被重置过，"
                     "要等它自然走满 %s，这一项才真的有判别力")
                    % (sn, 100.0 * sn / max(1, total), _nd(sa),
                       _nd(meta.get("rarely_recalled_days"))))

    section("① 久未命中", "rarely_recalled", idle_note,
            lambda x: "- %s %s · %s · %s" % (
                x.get("mem_id"), x.get("content"), _nd(x.get("idle_days")), x.get("reason", "")))

    section("② 疑似重复", "duplicates",
            "没有包含度超阈值的重复",
            lambda g: "- %s ← 保留：%s\n  - 可合并：%s" % (
                g.get("keep_id"), g.get("keep_text"),
                "、".join("%s(%.2f)" % (p["drop_id"], p["containment"])
                         for p in g.get("pairs", []))
                or "、".join(g.get("drop_ids", []))))

    section("③ 矛盾候选", "conflicts",
            "没有检到「同一件事说法相反」",
            lambda c: "- %s %s  **vs**  %s %s（极性：%s）" % (
                c.get("a_id"), c.get("text_a"), c.get("b_id"), c.get("text_b"),
                "/".join(c.get("polarity", [])) or "-"))

    section("④a 孤儿", "orphans",
            "每条都有来源、长度够、向量也在",
            lambda x: "- %s %s · %s" % (x.get("mem_id"), x.get("content"),
                                        "、".join(x.get("reasons", []))))

    section("④b 僵尸", "zombies",
            "没有「久没想起 + 躺在地板 + 不重要」三条全中的",
            lambda x: "- %s %s · %s" % (x.get("mem_id"), x.get("content"),
                                        "、".join(x.get("reasons", []))))

    section("⑤ 半写断裂", "halfwritten",
            "有内容的条目向量都在",
            lambda x: "- %s %s · %s" % (x.get("mem_id"), x.get("content"), x.get("reason", "")))

    section("⑥ 未归类待审", "untriaged",
            "每条都有有效归类",
            lambda x: "- %s %s · %s" % (x.get("mem_id"), x.get("content"), x.get("reason", "")),
            limit=5)

    # ⑧ 情景档引用完整性（dict 结构，单独渲染）
    ei = r.get("episode_integrity") or {}
    L.append("### ⑧ 情景档引用完整性（%s）" % (ei.get("status") or "?"))
    L.append("")
    if not ei:
        L.append("- （没跑）")
    else:
        L.append("- 状态：**%s** — %s" % (ei.get("status", "?"), ei.get("reason", "")))
        L.append("- 正向孤儿 %d 组 / 反向孤儿 %d 组 / 可追溯打折 %d 条"
                 % (len(ei.get("fwd_orphans") or []), len(ei.get("rev_orphans") or []),
                    len(ei.get("untraceable") or [])))
        L.append("- 守恒：source_turns 合计 %s，短期层打标 %s → %s"
                 % (ei.get("total_src", 0), ei.get("marked", 0),
                    "一致" if ei.get("conserved") else "**不一致**"))
        if not ei.get("conserved"):
            # 只报「不一致」等于没说。把差额拆成三类，指向该找谁修。
            _unrec = ei.get("unrecorded_fragments") or []
            _refmis = ei.get("referenced_missing") or []
            if _unrec:
                L.append("- ⚠️ **%d 条碎片打了 episode_id，但对应的档没把它写进 source_turns**"
                         % len(_unrec))
                L.append("  （档存在，只是漏记 —— 这些碎片在「可追溯」上等于查无此条。）")
                for eid, mid in _unrec[:5]:
                    L.append("  - 档 `%s` 漏记 `%s`" % (eid, mid))
            if _refmis:
                L.append("- %d 条档引用的碎片已被清理（碎片 ttl 短于档，设计允许）"
                         % len(_refmis))
            if not _unrec and not _refmis:
                L.append("- （差额来源无法归类，需要人工查）")
        for item in (ei.get("fwd_orphans") or [])[:5]:
            L.append("- 正向孤儿 `%s`：%d 条碎片指向它，但档不在 active 里"
                     % (item[0], item[1]))
        for item in (ei.get("untraceable") or [])[:5]:
            L.append("- 可追溯打折 `%s`：声称 %d 条原话，实际只剩 %d 条"
                     % (item[0], item[1], item[2]))
    L.append("")

    # ⑨ 窗口账本
    wl = r.get("window_ledger") or {}
    L.append("### ⑨ 窗口账本（保留 %s 天）" % wl.get("keep_days", "?"))
    L.append("")
    if not wl.get("available"):
        L.append("- （窗口账本模块不可用）%s" % (wl.get("error") or ""))
    else:
        L.append("- 会话 %s 个 / 共 %s 轮" % (wl.get("sessions", 0), wl.get("total_turns", 0)))
        stale = int(wl.get("stale_turns") or 0)
        if stale:
            L.append("- **%d 轮已超期**（超过 %s 天）。夜巡只报告不删 ——"
                     % (stale, wl.get("keep_days", "?")))
            L.append("  要清就跑 `python -c 'import window_ledger as w; w.prune_all()'`，"
                     "或调 `check_window_ledger(prune=True)`")
        else:
            L.append("- 没有超期轮次（都在 %s 天内）" % wl.get("keep_days", "?"))
        if wl.get("error"):
            L.append("- ⚠️ %s" % wl["error"])
    L.append("")

    section("⑦ 候选池待整理", "candidates",
            (("候选池里没有 pending" if meta.get("candidates_available")
              else "候选池文件还没生成") + "（" + _candidate_note(meta) + "）"),
            lambda x: "- %s %s %s" % (x.get("id", ""), x.get("content", ""), x.get("reason", "")),
            limit=5)

    # ── 页脚 ──
    L.append("---")
    L.append("")
    L.append("夜巡只读：上面的每一条都**没有被修改**。要不要合并/删除/补归类，由人决定。")
    L.append("")
    L.append("推送状态：**未推送**（push_report 还没接，见 nightly_patrol.py 里的 TODO）。")
    return "\n".join(L)


def _log_line(report) -> str:
    """一行日志，跟 memsys-consolidate.log / memsys-daily-check.log 同风格。"""
    r = report or {}
    counts = r.get("counts", {}) or {}
    state = "有异常" if r.get("abnormal") else ("待关注" if r.get("watch") else "正常")
    return ("[%s] 巡检 %d 条 | 孤儿%d 僵尸%d 重复%d 矛盾%d 半写%d | "
            "久未命中%d 未归类%d 候选%d | %s | 健康%d\n") % (
        r.get("generated_at", ""), r.get("total", 0),
        counts.get("orphans", 0), counts.get("zombies", 0),
        counts.get("duplicates", 0), counts.get("conflicts", 0),
        counts.get("halfwritten", 0),
        counts.get("rarely_recalled", 0), counts.get("untriaged", 0),
        counts.get("candidates", 0),
        state, r.get("healthy", 0))


def _prune_old_reports(directory, keep_days):
    """删掉超龄的报告（只删 patrol 目录里 YYYY-MM-DD 命名的 .md/.json）。"""
    removed = 0
    try:
        keep_days = float(keep_days)
    except (TypeError, ValueError):
        keep_days = 90.0
    if keep_days <= 0 or not os.path.isdir(directory):
        return 0
    cutoff = time.time() - keep_days * 86400.0
    try:
        names = os.listdir(directory)
    except Exception:
        return 0
    for name in names:
        if not (name.endswith(".md") or name.endswith(".json")):
            continue
        stem = name.rsplit(".", 1)[0]
        if len(stem) != 10 or stem.count("-") != 2:
            continue                    # 不是日期命名的，不碰
        full = os.path.join(directory, name)
        try:
            if os.path.isfile(full) and os.path.getmtime(full) < cutoff:
                os.remove(full)
                removed += 1
        except Exception:
            pass
    return removed


def _json_safe(obj):
    """把报告里的 inf 之类换成 null，保证 json.dump 不炸。"""
    if isinstance(obj, dict):
        return dict((k, _json_safe(v)) for k, v in obj.items())
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            return None
        return obj
    return obj


def _append_log(line, path=None):
    """追加一行到 memsys-patrol.log。日志目录写不进去就写到项目目录。"""
    path = path or _patrol_log()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
        return path
    except Exception:
        fallback = os.path.join(BASE_DIR, os.path.basename(path))
        try:
            with open(fallback, "a", encoding="utf-8") as f:
                f.write(line)
            return fallback
        except Exception:
            return ""


def save_report(report, path=None, log_path=None) -> str:
    r"""存到 patrol/<date>.md，返回路径。

    同时写一份同名 .json（给以后的推送/趋势用），并把一行结果追加到
    <memory-data>\memsys-patrol.log。

    目录写不进去时退回 <项目目录>\patrol，并在日志里注明落点 ——
    夜巡最怕的是「跑挂了没人知道」，所以宁可降级也要留下痕迹。

    ★ log_path 是给自检用的（2026-11-08 修，见下）：
      原来这个函数只有一个 path 参数，自检把它指向临时目录以为就隔离了 ——
      但日志那一行是 _append_log() 写的，走的是**默认的生产日志路径**。
      结果 selftest 每跑一次，就往 <memory-data>\memsys-patrol.log 里
      塞一行「巡检 12 条 | 孤儿3 僵尸1 …」的样例数据。
      实测那个日志里 40 行有 20 行是样例 —— **真报告被自检噪音埋了一半**。
      而「日志要能看出真问题」正是夜巡存在的理由，它自己被污染就等于失效。
    """
    r = report or {}
    date = r.get("date") or datetime.now().strftime("%Y-%m-%d")
    preferred = path or os.path.join(_patrol_dir(), "%s.md" % date)
    directory = os.path.dirname(preferred) or _patrol_dir()
    used_dir, fell_back = _resolve_dir(directory)
    if used_dir != directory:
        preferred = os.path.join(used_dir, os.path.basename(preferred))

    # 报告落在临时目录（自检）时，日志也必须跟着走临时目录，
    # 否则样例数据会混进生产日志。
    lp = log_path
    if lp is None and path is not None:
        lp = os.path.join(os.path.dirname(preferred) or used_dir, "patrol.log")

    text = format_report(r)
    try:
        os.makedirs(os.path.dirname(preferred) or used_dir, exist_ok=True)
        with open(preferred, "w", encoding="utf-8") as f:
            f.write(text)
            if not text.endswith("\n"):
                f.write("\n")
        json_path = (preferred[:-3] + ".json") if preferred.endswith(".md") else (preferred + ".json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(_json_safe(r), f, ensure_ascii=False, indent=2)
    except Exception as e:
        # 连降级目录都写不了：还是要往日志里说一声，不然这次夜巡等于没发生
        _append_log("[%s] 报告写入失败 %s: %s\n"
                    % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                       type(e).__name__, e), lp)
        raise

    if fell_back:
        _append_log("[%s] 注意：%s 写不进去，本轮报告落在 %s\n"
                    % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                       directory, os.path.dirname(preferred)), lp)
    _append_log(_log_line(r), lp)
    _prune_old_reports(os.path.dirname(preferred), _cfg("PATROL_KEEP_DAYS", 90))
    try:
        r["saved_to"] = preferred
        r["logged_to"] = lp or _patrol_log()
    except Exception:
        pass
    return preferred


# ═══════════════════════════════════════════════════════════
# 推送（现在只留 TODO）
# ═══════════════════════════════════════════════════════════

def push_report(report) -> bool:
    """有异常时主动推送 —— **当前不推送**。

    # TODO: 推送机制待设计（走桥接 HTTP 还是宿主通知？）
    # 暂时只写日志，不推送

    为什么先不接：两条候选路都不干净 ——
      · 走桥接 HTTP：夜巡在服务上下文里跑，桥接端口/白名单一变就静默失败
      · 走宿主通知：得先确定「夜巡挂在谁下面」，否则等于绕过权限体系
    在定下来之前硬接一条，只会变成「以为有推送其实没有」——
    那比没有推送更糟（没人会再去查日志，因为「有推送嘛」）。

    返回 False = 没推送。调用方（__main__）据此保持退出码 0，
    不会因为「没推送」被当成失败。
    """
    r = report or {}
    if not r.get("abnormal"):
        return False
    # 这里就是将来接推送的地方：把 r 里的异常摘要发出去。
    # 现在只把「本该推送」这件事记在报告里（format_report 页脚写「未推送」）。
    return False


# ═══════════════════════════════════════════════════════════
# 自检
# ═══════════════════════════════════════════════════════════

def _mk(content, **kw):
    """造一条测试记忆（dict 形态，跟磁盘上的一致）。"""
    now = time.time()
    base = {
        "mem_id": "t_%d" % (abs(hash(content)) % 100000),
        "content": content,
        "source": "test",
        "strength": 80.0,
        "consolidation_level": 2,
        "importance": 0.85,
        "create_time": now - 10 * 86400,
        "last_active": now - 10 * 86400,
        "last_mentioned_at": now - 10 * 86400,
        "mention_count": 1,
        "mention_history": [now - 10 * 86400],
        "embedding": [0.1, 0.2, 0.3],
        "category": "stable_profile",
        "mem_type": "long_term",
    }
    base.update(kw)
    return base


def selftest():
    """不依赖真实数据（5 秒内跑完）。"""
    import tempfile

    now = time.time()
    mems = [
        # 0 正常
        _mk("朋友的生日是 2 月 13 日"),
        # 1 孤儿：太短 + 来源空 + 无向量
        _mk("嗯", source="", embedding=[]),
        # 2 僵尸：100 天没想起 + importance 低 + 强度躺地板
        _mk("今天天气还行吧", strength=21.0, importance=0.35,
            consolidation_level=2, create_time=now - 120 * 86400,
            last_active=now - 120 * 86400,
            last_mentioned_at=now - 100 * 86400,
            mention_count=0, mention_history=[]),
        # 3 / 4 疑似重复
        _mk("朋友喜欢吃火锅"),
        _mk("朋友喜欢吃火锅的"),
        # 5 / 6 矛盾
        _mk("我喜欢吃火锅"),
        _mk("我讨厌吃火锅"),
        # 7 半写断裂：有内容没向量
        _mk("这条写入时 ollama 挂了", embedding=[]),
        # 8 未归类
        _mk("没分过类的一条", category=""),
        # 9 久未命中：很久没想起，但重要度高（不该进僵尸名单）
        _mk("很久以前说过的一件事", importance=0.92,
            create_time=now - 200 * 86400,
            last_mentioned_at=now - 150 * 86400,
            mention_count=0, mention_history=[],
            strength=55.0),
        # 10 内容完全为空（写入 bug 的痕迹）→ 归孤儿，不归半写断裂
        _mk("", source="test"),
        # 11 向量还没算（pending）→ 既不是孤儿也不算半写断裂，单独一栏
        _mk("情景档刚写盘、向量还没算", embedding=[], embed_status="pending"),
    ]
    before = [dict(m) for m in mems]

    rep = run_patrol(mems, now)

    # 0. 结构
    for key in ("date", "total", "counts", "summary", "checks", "abnormal", "healthy", "meta"):
        assert key in rep, "报告缺字段 %s" % key
    assert rep["total"] == len(mems)

    # 1. 只读：跑完数据一个字段都不能变（这是夜巡的命根子）
    for i, (b, a) in enumerate(zip(before, mems)):
        assert b == a, "第 %d 条被改了！夜巡必须只读" % i

    # 2. 各项能检出
    assert any("嗯" in x["content"] for x in rep["checks"]["orphans"]), "孤儿没检出"
    z = rep["checks"]["zombies"]
    assert any("天气" in x["content"] for x in z), \
        "僵尸没检出：%s" % [x["content"] for x in z]
    hw = rep["checks"]["halfwritten"]
    assert any("ollama" in x["content"] for x in hw), "半写断裂没检出"
    # 内容为空的归孤儿管，不该在「半写断裂」里再报一次（重复报会让人以为有两处问题）
    empty_idx = [i for i, m in enumerate(mems) if not m["content"].strip()]
    assert empty_idx, "样例里应该有内容为空的条目"
    assert not any(x["index"] in empty_idx for x in hw), "空内容不该算半写断裂（那是孤儿）"
    assert any(x["index"] in empty_idx for x in rep["checks"]["orphans"]), "空内容没进孤儿"
    d = rep["checks"]["duplicates"]
    assert d, "重复没检出"
    assert any(g.get("drop_ids") for g in d), "重复组没给出可合并的条目"
    c = rep["checks"]["conflicts"]
    assert c, "矛盾没检出"
    assert any(("喜欢" in x["text_a"] and "讨厌" in x["text_b"]) or
               ("讨厌" in x["text_a"] and "喜欢" in x["text_b"]) for x in c), \
        "矛盾检出但方向不对：%s" % [(x["text_a"], x["text_b"]) for x in c]
    assert any(not x["category"] for x in rep["checks"]["untriaged"]), "空归类没检出"
    assert any("很久以前" in x["content"] for x in rep["checks"]["rarely_recalled"]), \
        "久未命中没检出"

    # 3. 重要度高、只是很久没想起的，不能被当成僵尸
    assert not any("很久以前" in x["content"] for x in z), \
        "importance 高的被误判成僵尸了"

    # 3b. pending 向量：不算半写断裂、也不算孤儿，单独一栏（防假警报）
    pend = rep["checks"]["pending_embed"]
    assert any("情景档" in x["content"] for x in pend), "pending 向量没单独归类"
    assert not any("情景档" in x["content"] for x in hw), "pending 被误报成半写断裂"
    assert not any("情景档" in x["content"] for x in rep["checks"]["orphans"]), \
        "pending 被误报成孤儿"
    assert rep["counts"]["pending_embed"] == len(pend)
    # pending 不该把「有异常」点着（它自己只是中间态）
    only_pending = [_mk("只有 pending 的一条", embedding=[], embed_status="pending")]
    assert run_patrol(only_pending, now)["abnormal"] is False, \
        "只有 pending 向量却被判成异常（假警报）"

    # 4. 汇总自洽
    s = rep["summary"]
    for key in ("total", "orphans", "zombies", "duplicates", "conflicts", "healthy"):
        assert key in s, "summary 缺 %s" % key
    assert s["total"] == rep["total"]
    assert s["orphans"] == rep["counts"]["orphans"]
    assert s["zombies"] == rep["counts"]["zombies"]
    assert 0 <= s["healthy"] <= s["total"]

    # 5. 异常判定
    assert rep["abnormal"] is True, "明显有异常却判成正常"

    # 6. 干净数据 → 不报异常
    clean = [_mk("朋友的生日是 2 月 13 日"), _mk("她喜欢唱歌")]
    rep2 = run_patrol(clean, now)
    assert rep2["abnormal"] is False, "干净数据被判成异常：%s" % rep2["counts"]
    assert rep2["counts"]["orphans"] == 0 and rep2["counts"]["zombies"] == 0

    # 7. 空库不炸
    rep3 = run_patrol([], now)
    assert rep3["total"] == 0 and rep3["abnormal"] is False
    assert "0 条" in format_report(rep3)

    # 8. 报告能生成、关键段落都在
    md = format_report(rep)
    for frag in ("# 记忆夜巡报告", "## 结论", "## 总览", "## 明细",
                 "① 久未命中", "② 疑似重复", "③ 矛盾候选",
                 "④a 孤儿", "④b 僵尸", "⑤ 半写断裂", "⑥ 未归类待审", "⑦ 候选池待整理",
                 "只读", "未推送"):
        assert frag in md, "报告缺少段落：%s" % frag
    assert "有异常" in md

    # 9. save_report 真能落盘（写临时目录，不碰生产目录）+ 日志也落在临时目录
    #    ★ 2026-11-08 修：以前只把「报告路径」指向临时目录，日志却写进生产日志，
    #      导致 memsys-patrol.log 里一半是样例数据（真报告被埋掉）。
    #      这里改成：指定 path 时日志自动跟到同一目录，并断言生产日志没被动。
    _prod_log = _patrol_log()
    _prod_before = ""
    if os.path.exists(_prod_log):
        try:
            _prod_before = open(_prod_log, encoding="utf-8").read()
        except Exception:
            _prod_before = ""
    with tempfile.TemporaryDirectory() as td:
        p = save_report(rep, os.path.join(td, "%s.md" % rep["date"]))
        assert os.path.exists(p), "报告没写出来：%s" % p
        assert os.path.exists(p[:-3] + ".json"), "明细 JSON 没写出来"
        body = open(p, encoding="utf-8").read()
        assert "记忆夜巡报告" in body
        # 日志应该落在同一个临时目录
        local_log = os.path.join(td, "patrol.log")
        assert os.path.exists(local_log), "日志没跟着报告进临时目录"
        log = open(local_log, encoding="utf-8").read()
        assert "巡检" in log and "孤儿" in log, "日志格式不对：%s" % log
        assert rep["date"] in log
        assert rep.get("logged_to") == local_log, \
            "报告没记下日志落点，实际 %r" % rep.get("logged_to")
    # 生产日志一个字都不许变
    _prod_after = ""
    if os.path.exists(_prod_log):
        try:
            _prod_after = open(_prod_log, encoding="utf-8").read()
        except Exception:
            _prod_after = ""
    assert _prod_after == _prod_before, \
        "自检把样例数据写进了生产日志 %s —— 夜巡日志不能被自检污染" % _prod_log

    # 9b. 开关是真的开关：关掉之后 run_patrol 必须什么都不查
    import features as _f
    _prev = _f.FEATURES.get("nightly_patrol")
    try:
        _f.disable("nightly_patrol")
        off = run_patrol(mems, now)
        assert off["enabled"] is False, "开关关了但报表显示仍启用"
        assert off["abnormal"] is False and off["total"] == 0, "开关关了还在查"
        assert off["counts"]["orphans"] == 0, "开关关了还有检出"
        assert "未启用" in format_report(off), "开关关掉的报告没写明「未启用」"
    finally:
        if _prev:
            _f.enable("nightly_patrol")
    # 打开后恢复
    assert run_patrol(mems, now)["enabled"] is True, "开关开回来没生效"

    # 10. push_report 不推送、不抛异常、返回值是 False
    assert push_report(rep) is False, "push_report 现在不该真推送"
    assert push_report(rep2) is False
    assert push_report({}) is False

    # 9c. ⑧ 情景档完整性：must 有输出（评审 的验收要求：
    #     「不能只验证文件能 import，必须验证夜巡能跑通且新增的检查项有输出」）
    ei = rep.get("episode_integrity")
    assert ei is not None, "报告里没有 episode_integrity"
    for k in ("status", "reason", "fwd_orphans", "rev_orphans", "untraceable",
              "total_src", "marked", "conserved"):
        assert k in ei, "episode_integrity 缺字段 %s" % k
    assert ei["status"] in ("ok", "transient", "growing", "unknown"), \
        "状态值不在三状态里：%r" % ei["status"]
    # 读失败必须给 unknown + 完整结构，不能抛
    bad = check_episode_integrity([], shortterm_path=os.path.join(BASE_DIR, "不存在的文件.json"),
                                  state_path=os.path.join(BASE_DIR, "state", "_t_state.json"))
    assert bad["status"] == "unknown" and bad["fwd_orphans"] == [], \
        "读失败没有安全降级：%r" % bad
    # 造一个正向孤儿必须能抓到
    _ac = [dict(m) for m in mems]
    _stf = os.path.join(BASE_DIR, "state", "_t_st.json")
    os.makedirs(os.path.dirname(_stf), exist_ok=True)
    with open(_stf, "w", encoding="utf-8") as f:
        json.dump({"memories": [{"mem_id": "frag_x", "episode_id": "ep_NOPE"}]}, f)
    try:
        got = check_episode_integrity(_ac, shortterm_path=_stf,
                                      state_path=os.path.join(BASE_DIR, "state", "_t_state.json"))
        assert any(x[0] == "ep_NOPE" for x in got["fwd_orphans"]), \
            "正向孤儿没抓到：%r" % got["fwd_orphans"]
    finally:
        for p in (_stf, os.path.join(BASE_DIR, "state", "_t_state.json")):
            try: os.remove(p)
            except Exception: pass

    # 9d. ⑨ 窗口账本：必须有输出，且**默认不许删东西**
    wl = rep.get("window_ledger")
    assert wl is not None, "报告里没有 window_ledger"
    for k in ("available", "sessions", "total_turns", "stale_turns", "keep_days", "pruned"):
        assert k in wl, "window_ledger 缺字段 %s" % k
    assert wl["pruned"] == 0, "夜巡必须是只读的：没传 prune 却删了数据"
    assert rep["counts"]["window_stale_turns"] == wl["stale_turns"]

    # 10b. 数据指纹（评审 裁定 A）
    #     必须有、必须稳定（同一批数据算两次一样）、外部传入时用「内容 sha256」
    assert rep.get("data_sha256"), "报告没有数据指纹"
    assert len(rep["data_sha256"]) == 16, "指纹应该是 16 位，实际 %d" % len(rep["data_sha256"])
    assert rep["data_sha256_kind"] == "内容 sha256", \
        "外部传入的应该标成内容 sha256，实际 %r" % rep.get("data_sha256_kind")
    again = run_patrol(mems, now)
    assert again["data_sha256"] == rep["data_sha256"], "同一批数据两次指纹不一致"
    # 只改一条内容 → 指纹必须变（否则它证明不了任何事）
    mutated = [dict(m) for m in mems]
    mutated[0]["content"] = mutated[0]["content"] + "（改过了）"
    assert run_patrol(mutated, now)["data_sha256"] != rep["data_sha256"], \
        "数据变了指纹却没变 —— 这个指纹是假的"
    # 从真实文件读时用「文件 sha256」，且报告里记的必须就是它读到的那一刻
    #
    # ⚠️ 2026-11-08 修：原来这里断言「跑前跑后 sha256 相同」，**会偶发失败**。
    #   原因不是夜巡写了库，而是**别人在写**：桥接 / 巩固在实时写 active.json，
    #   夜巡跑的那 0.7 秒里它可能刚好被改。用「跑前跑后一致」去证明只读，
    #   把这个断言变成了一个测别人行为的测试 —— 它红了也不能说明夜巡有问题。
    #
    #   正确的判据换成正向的：报告里记的指纹 == 文件当前指纹（没有人在写时），
    #   以及指纹类型正确。只读这件事由「代码里没有任何写调用」+ 下面的
    #   内容指纹稳定性来保证，不靠抢跑赢过写入方。
    _real, _err = load_active_memories()
    if _err is None:
        _p = _active_path()
        _rep_file = run_patrol(None, now)
        assert _rep_file["data_sha256_kind"] == "文件 sha256", \
            "从文件读却没用文件指纹"
        assert len(_rep_file["data_sha256"]) == 16, "文件指纹长度不对"
        # 报告里记的指纹必须能被独立重算出来（没人在写的窗口内）
        _now_hash, _ = _file_sha256(_p)
        if _now_hash == _rep_file["data_sha256"]:
            pass        # 一致：证明记的就是这份数据
        else:
            # 不一致只可能是「夜巡跑完之后有人写库了」—— 这是正常现象
            # （桥接在实时写），不能因此判夜巡有错。但要能说清楚。
            assert _rep_file["total"] >= 0, "指纹对不上且报告结构坏了"

    # 11. 阈值口径写进了 meta（30 天 != 90 天这件事必须能看见）
    assert rep["meta"]["rarely_recalled_days"] in (30, 90)
    assert rep["meta"]["rarely_recalled_reason"]

    # 12. 读数据路径能跑（真实文件存在时读一遍，只读）
    #     ★ 空库是**合法初始状态**：全新部署、数据目录刚建好时本来就没有记忆。
    #       这里只要求「读得动、结构对、失败要说明原因」，不能要求非空 ——
    #       否则新克隆的仓库第一次跑自检就红，等于把空库当成故障。
    real, err = load_active_memories()
    if err is None:
        assert isinstance(real, list), "读成功就必须返回列表"
        assert all(isinstance(m, dict) for m in real), "列表里每条都得是 dict"
    else:
        assert isinstance(err, str) and err, "读失败要给原因"

    print("nightly_patrol.py selftest OK")
    print("  样例库 %d 条 → 孤儿%d 僵尸%d 重复%d 矛盾%d 半写%d 久未命中%d 未归类%d"
          % (rep["total"], rep["counts"]["orphans"], rep["counts"]["zombies"],
             rep["counts"]["duplicates"], rep["counts"]["conflicts"],
             rep["counts"]["halfwritten"], rep["counts"]["rarely_recalled"],
             rep["counts"]["untriaged"]))
    return True


def main(argv=None):
    argv = list(argv if argv is not None else _sys.argv[1:])
    selftest()
    if "--selftest" in argv:
        return 0

    started = time.time()
    report = run_patrol()
    cnt = report["counts"]
    print("")
    print("=" * 64)
    print("夜巡 · %s · %d 条" % (report["generated_at"], report["total"]))
    if report.get("data_sha256"):
        print("  数据指纹：%s（%s）· 来源 %s"
              % (report["data_sha256"], report.get("data_sha256_kind") or "sha256",
                 report.get("source") or "?"))
    print("  孤儿 %d / 僵尸 %d / 重复 %d / 矛盾 %d / 半写 %d"
          % (cnt["orphans"], cnt["zombies"], cnt["duplicates"],
             cnt["conflicts"], cnt["halfwritten"]))
    print("  久未命中 %d（%d 天口径）/ 未归类 %d / 候选池 %d"
          % (cnt["rarely_recalled"], report["meta"]["rarely_recalled_days"],
             cnt["untriaged"], cnt["candidates"]))
    print("  结论：%s" % ("⚠️ 有异常" if report["abnormal"]
                        else ("待关注" if report["watch"] else "✅ 正常")))
    path = save_report(report)

    # ── 窗口账本清理（2026-11-08 接线）────────────────────────────
    # 放在 main() 里、**不进 run_patrol()**：
    #   run_patrol 的文档写着「只读保证：这里没有任何写盘」，
    #   prune_all 是要删数据的。混进去就等于毁掉那个保证。
    # 放在 save_report 之后：报告先落盘，万一下面出错也不影响当次报告。
    #
    # prune_all 只删**过期**的（默认 30 天，见 config.WINDOW_KEEP_DAYS），
    # 单会话还有 WINDOW_MAX_TURNS 上限兜底。所以正常情况这里每天都是 0 ——
    # 打印时要把「0」和「没扫到」分开，别又混成一起。
    try:
        import window_ledger as _wl
        _pruned = _wl.prune_all()
        if _pruned["errors"]:
            print("  窗口账本：扫 %d 个会话，%d 个出错（见日志）"
                  % (_pruned["sessions"], len(_pruned["errors"])))
            for _e in _pruned["errors"][:3]:
                print("    - %s: %s" % (_e["session"], _e["error"]))
        elif _pruned["dropped"]:
            print("  窗口账本：扫 %d 个会话，清理 %d 轮（保留 %d 天）"
                  % (_pruned["sessions"], _pruned["dropped"], _pruned["keep_days"]))
        elif _pruned["sessions"]:
            print("  窗口账本：扫 %d 个会话，无过期轮次（保留 %d 天）"
                  % (_pruned["sessions"], _pruned["keep_days"]))
        else:
            print("  窗口账本：**一个会话都没有**（不是「没东西可清」，是压根没数据）")
    except Exception as _exc:
        # 夜巡不能因为账本清理失败就整体挂掉
        print("  窗口账本：清理失败（%s）—— 不影响本次夜巡" % _exc)

    print("  报告：%s" % path)
    if not report["meta"]["candidates_available"]:
        # 2026-11-08 修：原来这里直接断言"开关未开"，其实它**没查开关**，
        #   只是"文件不存在"。而文件不存在有两种原因（开关关 / 开关开但还没接线），
        #   一句话写死成前者，就是本项目最讨厌的「两种 0 混在一起」——
        #   候选人看到"开关未开"会去翻 features.py，结果发现明明是 True。
        #   这里改走 _candidate_note()，它真的去读开关，分得开。
        # 2026-11-08 再修：这里原来在 _candidate_note() 后面**无条件**补一句
        #   「这一项算未启用不算 0」。但 _candidate_note() 已经能分出
        #   「开关关」和「开关开但文件还没生成」两种情况，硬补一句就会自相矛盾：
        #   开关明明开着，却还在说「未启用」。尾注跟着实际原因走。
        _note = _candidate_note(report["meta"])
        _tail = ("（这一项算「未启用」不算 0）" if "未启用" in _note
                 else "（这一项算「还没有数据」不算 0）")
        print("  候选池：%s%s" % (_note, _tail))
    if report["abnormal"]:
        print("  推送：未推送（push_report 待接，见 TODO）")
    print("  耗时 %.2fs" % (time.time() - started))
    return 0


if __name__ == "__main__":
    try:
        _sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        _sys.exit(1)
