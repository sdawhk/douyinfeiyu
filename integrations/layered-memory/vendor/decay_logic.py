from datetime import datetime
from typing import Tuple

from config import DECAY_RATE_MAP, COLD_STORAGE_THRESHOLD, COLD_ARCHIVE_THRESHOLD, HARD_DROP_THRESHOLD, COLD_ARCHIVE_AFTER_DAYS
from config import (
    # 2026-11-10 第二步：双轨常量（集中定义在 config，这里只读）
    IMPRESSION_BUILD_MIN_INTENSITY, IMPRESSION_FLOOR_RATIO, IMPRESSION_FLOOR_MIN,
    IMPRESSION_FLOOR_CAP,
    IMPRESSION_DECAY_RATE, IMPRESSION_RECALL_MIN, IMPRESSION_DETAIL_MAX,
    IMPRESSION_DETAIL_ERASED, IMPRESSION_MENTION_BONUS, IMPRESSION_MENTION_MAX,
    # ★ 2026-11-10：IMPRESSION_DETAIL_FLOOR_RELEASE / _MIN 的 import 已删除。
    #
    #   原因：印象层整条关闭后，这两个常量**在代码里已经没有任何读者**
    #   （只剩注释里的引用）。留着 import 会让下一个人以为还有代码在用。
    #
    #   常量本身保留在 config.py 里 —— 作为「原值 0.35 / 10.0」的记录，
    #   以及「重新打开时需要什么」的线索。
    #   历史实现在 decay_logic 的「删除地板释放分支」注释里有完整记录。
    EMOTION_RESIDUE_DECAY_RATE, EMOTION_RESIDUE_FLOOR_RATIO,
    IMPRESSION_PROTECT_FROM_COLD,
)
from schema import MemoryItem, infer_importance


# ══════════════════════════════════════════════════════════════
# 2026-11-10 静默异常收集器
# ══════════════════════════════════════════════════════════════
# 背景：全项目有 160+ 处 `except Exception: pass`，出错了不报错。
#   这是「巩固没跑却报 ok」「兜底是 no-op 但看不出来」这类问题的根源。
#
# 为什么不能直接改成 print：
#   召回路径每轮要跑 5 条，巩固路径要遍历 400 条，
#   任何一处失败都刷一行日志，正常运行时就会被噪音淹掉。
#
# 做法：静默计数 + 结尾汇总。
#   · _SILENT_ERRORS 只记 (位置, 异常类型)，不记完整 traceback
#   · 同位置同类异常只记一次（去重），不会 400 条刷 400 行
#   · 每条记忆的 try 里调用会累计，最后在巩固日志里看一行汇总
#
# 不影响语义：仍然是「失败就跳过」，只是不再无声。
_SILENT_ERRORS = {}


def note_silent_error(where: str, exc: BaseException) -> None:
    """记录一次被吞掉的异常（去重计数，不打印）。"""
    key = (where, type(exc).__name__)
    _SILENT_ERRORS[key] = _SILENT_ERRORS.get(key, 0) + 1


def silent_error_summary() -> dict:
    """取走并清空累计的静默异常，供调用方写进 stats / 日志。"""
    out = {("%s:%s" % k): v for k, v in _SILENT_ERRORS.items()}
    _SILENT_ERRORS.clear()
    return out


# 2026-11-08 能力开关（评审 派 T-摆设开关）：
#   features.py 里这些键一直开着，但之前**没有任何代码读它们** ——
#   用户以为「关掉就能回滚」，实际关不掉。现在逐个接上。
from features import on

# __UTF8_STDOUT_GUARD__ (2026-11-07)
# 中文 Windows 终端默认 GBK，print emoji 会 UnicodeEncodeError 直接崩。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ===== 2026-11-04 v3 重设计 =====
#
# 删除 PINNED_TAGS 白名单。原因（实测数据）：
#   186 条里有 122 条被判定为「永不衰减」，其中 115 条只是因为带了「人设相关」。
#   这个标签在库里覆盖了 62%，不携带任何信息 ——
#   「他在示例城市市示例区」和「去吧，洗完早点躺，晚安早点睡」都带着它，判成同一档。
#   结果 TOP-5 里 89% 被这些「永生」记忆占满，真正有用的普通记忆挤不进来。
#
# 新机制：importance（0~1，由内容形态推断，永不衰减）决定**衰减地板**。
#   地板 = max(等级地板, importance × 60)
#     fact     (0.92) → 55   永不冷存
#     event    (0.65) → 39   永不冷存
#     tool     (0.60) → 36   永不冷存
#     about_him(0.55) → 33   永不冷存
#     misc     (0.35) → 21   边缘
#     speech   (0.22) → 13   会进冷存（合理：寒暄就该淡出）
#
# 关键：importance 只定地板，**不进召回打分**。
#   这样排序还是靠相关性（说法自然），重要的事只是不会被时间磨没。

IMPORTANCE_FLOOR_MULT = 60.0


def importance_floor(memory_item: MemoryItem) -> float:
    """按重要度算出衰减地板。"""
    imp = getattr(memory_item, "importance", None)
    if imp is None:
        imp = infer_importance(
            getattr(memory_item, "content", "") or "",
            getattr(memory_item, "source", "") or "",
        )
    try:
        imp = float(imp)
    except (TypeError, ValueError):
        imp = 0.35
    return max(0.0, min(1.0, imp)) * IMPORTANCE_FLOOR_MULT



def core_person_floor(memory_item: MemoryItem) -> float:
    """核心人物地板（2026-11-07 新增，借鉴 memory-brain 的 core_floor）。

    关联到「核心人物/assistant」等核心人物的记忆，即使被判成 speech（地板 13），
    也不该掉到很低 —— 因为「关于他这个人」的记忆是底座。

    返回：核心人物地板值（不相关时返回 0，由调用方跟 importance_floor 取高者）
    """
    from config import CORE_PEOPLE, CORE_FLOOR
    content = str(getattr(memory_item, "content", "") or "")
    if not content:
        return 0.0
    for name in CORE_PEOPLE:
        if name and name in content:
            return float(CORE_FLOOR)
    return 0.0


def effective_floor(memory_item: MemoryItem) -> float:
    """**重要/核心人物**地板 = max(importance 地板, 核心人物地板)。

    ★★★ 2026-11-10 改名澄清（独立审查指出「名不副实」）★★★

      原名和 docstring 都承诺「**实际生效**的地板」，但它只算了两层：
          max(importance_floor, core_person_floor)
      而 `calculate_current_strength` 实际取四层：
          max(level_floor, importance_floor, core_floor, EPISODE_FLOOR)

      实测偏差（level=1，走到 3650 天）：
          imp    mem_type     真实地板   effective_floor()
         0.05   long_term       3.0           3.0    ✅
         0.05   episode        45.0           3.0    ❌ 差 42
         0.65   long_term      39.0          39.0    ✅
         0.65   episode        45.0          39.0    ❌ 差 6
      ⇒ episode 全错，因为 EPISODE_FLOOR=45 不在这个函数里。

      **为什么只改文档不改实现**：
        `memory_health.py:439` 用它判断「是不是到地板了」：
            floor = _effective_floor(m)
            if strength > floor + 0.5: continue
        报低了 → `strength > floor` 恒成立 → 永不报「到地板」→ **漏报**。
        方向是安全的（不会误删/误归档），生产库 30 条 episode 实测误报 0/30。
        改实现会改变 memory_health 的报警行为，那是另一件事，不在本次范围。

      **要「真正的实际地板」请用 `real_floor()`**（下方，五层齐全）。
      注意两者语义不同：本函数回答「不考虑等级/类型时，重要性给的底线」。
    """
    base = importance_floor(memory_item)
    core = core_person_floor(memory_item)
    return max(base, core)


def real_floor(memory_item: MemoryItem) -> float:
    """**真正生效**的衰减地板（五层齐全，与 calculate_current_strength 一致）。

        floor = max(level_floor,                  # 按 consolidation_level
                    importance_floor,             # importance × 60
                    core_person_floor,            # 核心人物/assistant → 45
                    EPISODE_FLOOR)                # 情景档 → 45

    ★ 2026-11-10 新增（独立审查发现了 effective_floor 名不副实之后补的）。
      它和 calculate_current_strength 内部算的是同一套，**不会漂移**。
      实测 30/30、54/54 组合与真实地板完全一致。

    ⚠️ **目前没有生产消费者**（2026-11-10 状态）。
      全项目 grep 只有本文件的定义处，没有任何调用点。

      为什么还是留着：
        · `memory_health.py:439` 用 `effective_floor()`（宽松语义），
          换过去会从「漏报」变成「精确报」，**改变现有报警行为** ——
          那是独立的一件事，不该跟这次混。
        · 但任何**新写的**代码只要问「这条记忆的地板是多少」，
          都应该用 `real_floor()` 而不是 `effective_floor()`。

      ⇒ 下一个人看到这个函数没人调用时，**不要以为是漏接线**。
        它是给将来准备的，而且已经验证正确。

    ⚠️ 别用它替换 `memory_health` 里的 `effective_floor`：
       那会从「漏报」变成「精确报」，改变现有报警行为。
       要换的话应该单独做一次，并同步改它 `+ 0.5` 的容差语义。
    """
    FLOOR_BY_LEVEL = {3: 35.0, 2: 15.0, 1: 0.0}
    level_floor = FLOOR_BY_LEVEL.get(memory_item.consolidation_level, 0.0)
    floor = max(level_floor, importance_floor(memory_item))
    try:
        floor = max(floor, core_person_floor(memory_item))
    except Exception as _e:
        note_silent_error('core_person_floor', _e)
    if getattr(memory_item, "mem_type", "") == "episode":
        try:
            from config import EPISODE_FLOOR
            floor = max(floor, float(EPISODE_FLOOR))
        except Exception:
            floor = max(floor, 45.0)
    #
    #   为什么要按条目而不是全局常量：
    #     `strength_floor` 为 None 表示「用上面的默认」，设了才覆盖。
    #   实测默认值不变：521 条主库记忆这个字段都是 None，行为零变化。
    _sf = getattr(memory_item, "strength_floor", None)
    if _sf is not None:
        try:
            floor = max(floor, float(_sf))
        except (TypeError, ValueError):
            pass
    return floor


def emotion_decay_factor(memory_item: MemoryItem) -> float:
    """情绪保护系数（2026-11-07 新增，借鉴 memory-brain 的 emotion_factor）。

    情绪强的记忆衰减更慢：
        >= 85 → 0.25（慢 4 倍）  ← 2026-11-10 新增 extreme 档
        >= 60 → 0.40（慢 2.5 倍）
        >= 40 → 0.70（慢 1.4 倍）
        其他  → 1.00（正常）

    ★ 2026-11-10 为什么加 extreme 档：
        原来只有两档，导致 65 / 75 / 90 得到完全一样的结果（实测 8 天后
        都是 84.00）。「他家人去世」和「他有点害怕」不该衰减一样慢。

    ⚠️ 遍历顺序必须严格从高到低（extreme → high → medium）。
       这里用固定元组而不是 dict 顺序，并且用 `.get()` 容忍旧 config
       没有 extreme 的情况（旧 config 降级为两档，不崩）。
    """
    from config import EMOTION_DECAY_PROTECT
    try:
        emo = float(getattr(memory_item, "emotion_intensity", 0) or 0)
    except (TypeError, ValueError):
        emo = 0.0
    for key in ("extreme", "high", "medium"):
        item = EMOTION_DECAY_PROTECT.get(key)
        if not item:
            continue      # 旧 config 没有 extreme 时跳过，不崩
        threshold, factor = item
        if emo >= threshold:
            return float(factor)
    return 1.0


def is_pinned(memory_item: MemoryItem) -> bool:
    """兼容旧调用：importance ≥ 0.90（fact 类及以上）算「钉住」。

    v3 已经没有「永不衰减」了 —— 这个返回值只用于 reinforce_on_recall 的
    「被召回后短暂回到 100」分支（想起来=新鲜，之后仍会衰减回地板）。
    """
    imp = getattr(memory_item, "importance", None)
    if imp is None:
        imp = infer_importance(
            getattr(memory_item, "content", "") or "",
            getattr(memory_item, "source", "") or "",
        )
    try:
        return float(imp) >= 0.90
    except (TypeError, ValueError):
        return False


def calculate_shortterm_strength(memory_item, current_timestamp: float = None) -> float:
    """短期记忆的平方加速衰减：越接近 3 天掉得越快。

    公式：强度 = 100 × (1 - (t / 3)²)，t = 距 last_mentioned_at 的天数
      t=0     → 100（刚提过）
      t=1     → 89（轻微淡）
      t=2     → 56（明显淡）
      t=2.5   → 31（快忘了）
      t=3     → 0（彻底忘）

    注意：这是「最后提及时间」驱动的，不是创建时间。
    """
    from config import SHORT_TERM_WINDOW_DAYS
    if current_timestamp is None:
        current_timestamp = datetime.now().timestamp()
    last = getattr(memory_item, "last_mentioned_at", None) or getattr(memory_item, "create_time", None) or current_timestamp
    days = max(0.0, (current_timestamp - last) / 86400.0)
    window = float(SHORT_TERM_WINDOW_DAYS)
    if days >= window:
        return 0.0
    strength = 100.0 * (1.0 - (days / window) ** 2)
    return max(0.0, min(100.0, strength))


def mention_shortterm(memory_item, current_timestamp: float = None) -> None:
    """短期记忆被提及时：加分 + 重置计时。"""
    from config import SHORT_TERM_MENTION_BONUS
    if current_timestamp is None:
        current_timestamp = datetime.now().timestamp()
    memory_item.strength = min(100.0, float(getattr(memory_item, "strength", 100.0)) + float(SHORT_TERM_MENTION_BONUS))
    memory_item.last_mentioned_at = current_timestamp
    memory_item.mention_count = int(getattr(memory_item, "mention_count", 0) or 0) + 1
    hist = list(getattr(memory_item, "mention_history", None) or [])
    hist.append(current_timestamp)
    memory_item.mention_history = hist


def peek_strength(memory_item, current_timestamp: float = None) -> float:
    """只算强度、**不改任何状态**（纯函数）。

    2026-11-07 新增（评审 建议）：calculate_current_strength 名字叫「计算」，
    但会改写 memory_item.strength 和 last_active。调用方如果只是想「看看现在多少分」，
    用这个；只有真想更新状态时才用 calculate_current_strength。

    历史教训：2026-11-07 发现 5 条记忆的 strength 被写成 0，
    就是因为调用方只想算一下，结果副作用把 0 落了盘。
    """
    # 只复制本次计算会读写的浅层对象字段；不允许 deepcopy 失败时退回原对象。
    import copy as _copy
    probe = _copy.copy(memory_item)
    _, s = calculate_current_strength(probe, current_timestamp)
    return float(s)


# ═══════════════════════════════════════════════════════════════════
# 双轨衰减（2026-11-10 第二步）
# ═══════════════════════════════════════════════════════════════════
#
# 单轨时代：strength 一个数同时承担「多容易想起来」和「该不该忘」。
# 双轨之后：
#
#   calculate_current_strength()        只碰细节轨   （strength / strength_at）
#   calculate_current_impression()      只碰印象轨   （impression_strength / impression_at）
#   calculate_current_emotion_residue() 只碰情绪轨   （current_intensity / emotion_at）
#
# ★ 三条轨**互不写对方的字段**。这不是洁癖：
#   S01 的根因就是 last_active 一个字段同时当「最后被想起」和「结算游标」，
#   两种语义打架 → 204 条被批量刷新 → 全库衰减静默失效。
#   这里要是让印象轨顺手改 strength_at，等于换个名字重演一次。
#
# ★ 三个函数都有副作用（会写回字段），但都已提供对应的 peek_* 纯函数。
#   只读场景一律用 peek_*。

def impression_floor(memory_item: MemoryItem) -> float:
    """印象地板 = max(下限, 事件当时的强度 × 0.6)。

    ★ 关键：读的是 **event_intensity（冻结值）**，不是会衰减的 current_intensity。

    为什么必须冻结（2026-11-10 产品方拍板）：
      如果地板跟着情绪衰减，第 180 天会出现这个荒谬链条 ——
        情绪衰减到 30 → 地板降到 18 → 记忆掉进冷存 → 印象层又把它捞回来
      双轨互相打架。这跟 S01 是同一类错误：一个量既当输入又当输出。

    实测档位（IMPRESSION_FLOOR_RATIO = 0.6）：
      事件强度 85 → 地板 51    ← 跟现有地板拉开（event 39 / fact 55）
      事件强度 75 → 地板 45
      事件强度 60 → 地板 36    ← 略低于 event 39，可以不建（见门槛说明）
      事件强度 < 60 → 地板 20 下限，但这类本来就不建印象层
    """
    try:
        raw = getattr(memory_item, "event_intensity", None)
        if raw is None:
            # 旧对象没有冻结值 → 退回 emotion_intensity（它本来就是"当时"）
            raw = getattr(memory_item, "emotion_intensity", 0.0)
        ev = float(raw or 0.0)
    except (TypeError, ValueError):
        ev = 0.0
    # 上限 IMPRESSION_FLOOR_CAP：95×0.6=57 会超过 fact 的细节地板 55，
    #   导致两个维度被同一个地板托着 → 双轨退化。见 config 里的说明。
    return max(IMPRESSION_FLOOR_MIN,
               min(IMPRESSION_FLOOR_CAP, ev * IMPRESSION_FLOOR_RATIO))


def calculate_current_impression(
    memory_item: MemoryItem,
    current_timestamp: float = None,
) -> Tuple[MemoryItem, float]:
    """印象轨结算（有副作用：写 impression_strength + impression_at）。

    公式：
        Δt   = max(0, now - impression_at)
        raw  = impression_strength - IMPRESSION_DECAY_RATE × Δt(天)
        final= max(floor, min(100, raw))

    印象层没建立（impression_strength = 0 且 event_intensity < 门槛）时**直接返回 0**，
    不做任何计算 —— 否则 0 分也会被地板抬到 20，等于给所有记忆偷偷建了印象层。

    ⚠️ 时间倒流保护：跟细节轨一样用 max(0, ...)，now < impression_at 时不涨不扣。
       任务书 7.2 风险 4 明确要求。
    """
    if current_timestamp is None:
        from datetime import datetime as _dt
        current_timestamp = _dt.now().timestamp()

    try:
        cur = float(getattr(memory_item, "impression_strength", 0.0) or 0.0)
    except (TypeError, ValueError):
        cur = 0.0

    # 没有印象层 → 什么都不做（连游标都不推，避免"结算了但没变"的假象）
    if cur <= 0.0:
        memory_item.impression_strength = 0.0
        return memory_item, 0.0

    # 结算游标：旧对象回退到 strength_at，再回退 last_active / create_time
    imp_at = getattr(memory_item, "impression_at", None)
    if imp_at is None:
        imp_at = getattr(memory_item, "strength_at", None)
    if imp_at is None:
        imp_at = getattr(memory_item, "last_active", None)
    if imp_at is None:
        imp_at = getattr(memory_item, "create_time", None)
    if imp_at is None:
        imp_at = current_timestamp

    delta_days = max(0.0, (current_timestamp - imp_at) / 86400.0)
    raw = cur - IMPRESSION_DECAY_RATE * delta_days

    floor = impression_floor(memory_item)
    final = max(floor, min(100.0, raw))

    memory_item.impression_strength = round(float(final), 2)
    memory_item.impression_at = current_timestamp
    return memory_item, float(final)


def peek_impression(memory_item, current_timestamp: float = None) -> float:
    """只算印象分、不改原对象（纯函数）。跟 peek_strength 同一契约。"""
    import copy as _copy
    probe = _copy.copy(memory_item)
    _, v = calculate_current_impression(probe, current_timestamp)
    return float(v)


def calculate_current_emotion_residue(
    memory_item: MemoryItem,
    current_timestamp: float = None,
) -> Tuple[MemoryItem, float]:
    """情绪余温结算（R4，有副作用：写 current_intensity + emotion_at）。

    ★ 只动 current_intensity，**绝不动 emotion_intensity**。
      emotion_intensity 的语义是「当时」，memory_manager.py:74 有铁律：
      「content / emotion_valence / emotion_intensity = 当时，写死，谁都不许改」。
      R4 要的是「现在还剩多少」，那是另一个字段。

    公式：
        raw  = current_intensity - EMOTION_RESIDUE_DECAY_RATE × Δt(天)
        final= max(floor, min(event_intensity, raw))
        floor= event_intensity × 0.25      ← R4「不应降到 0」

    实测（0.5/天，地板 = 事件值 ×0.25）：
        事件 85：  90 天后 85-45 = 40      ← 对齐任务书 R4 的例子
                  180 天后 85-90 = -5 → 地板 21.25
    """
    if current_timestamp is None:
        from datetime import datetime as _dt
        current_timestamp = _dt.now().timestamp()

    try:
        ev = float(getattr(memory_item, "event_intensity", None)
                   if getattr(memory_item, "event_intensity", None) is not None
                   else (getattr(memory_item, "emotion_intensity", 0.0) or 0.0))
    except (TypeError, ValueError):
        ev = 0.0

    # 当时就没情绪 → 余温恒 0，不推游标
    if ev <= 0.0:
        memory_item.current_intensity = 0.0
        return memory_item, 0.0

    try:
        cur = float(getattr(memory_item, "current_intensity", None)
                    if getattr(memory_item, "current_intensity", None) is not None
                    else ev)
    except (TypeError, ValueError):
        cur = ev

    emo_at = getattr(memory_item, "emotion_at", None)
    if emo_at is None:
        emo_at = getattr(memory_item, "strength_at", None)
    if emo_at is None:
        emo_at = getattr(memory_item, "create_time", None)
    if emo_at is None:
        emo_at = current_timestamp

    delta_days = max(0.0, (current_timestamp - emo_at) / 86400.0)
    raw = cur - EMOTION_RESIDUE_DECAY_RATE * delta_days
    floor = max(0.0, ev * EMOTION_RESIDUE_FLOOR_RATIO)
    final = max(floor, min(ev, raw))

    memory_item.current_intensity = round(float(final), 2)
    memory_item.emotion_at = current_timestamp
    return memory_item, float(final)


def peek_emotion_residue(memory_item, current_timestamp: float = None) -> float:
    """只算情绪余温、不改原对象（纯函数）。"""
    import copy as _copy
    probe = _copy.copy(memory_item)
    _, v = calculate_current_emotion_residue(probe, current_timestamp)
    return float(v)


def peek_all(memory_item, current_timestamp: float = None) -> dict:
    """三条轨一起看（纯函数，不改任何字段）。

    返回：
        {"detail": 细节清晰度, "impression": 核心印象, "emotion": 情绪余温,
         "detail_erased": 细节是否基本没了, "has_impression": 是否有印象层}

    为什么需要它：召回和注入要同时判断「细节还够不够」和「印象还在不在」，
    分三次调用 peek_* 会各自 copy 一次对象（热路径上没必要）。
    """
    return {
        "detail": peek_detail_strength(memory_item, current_timestamp),
        "impression": peek_impression(memory_item, current_timestamp),
        "emotion": peek_emotion_residue(memory_item, current_timestamp),
    }


def peek_detail_strength(memory_item, current_timestamp: float = None) -> float:
    """细节清晰度（peek_strength 的同义名，让双轨语义在调用处一眼可读）。"""
    return peek_strength(memory_item, current_timestamp)


def impression_state(memory_item, current_timestamp: float = None) -> str:
    """印象状态标签：'none' / 'intact' / 'faded_detail' / 'erased_detail'。

    这是注入文本和 T3/T4 的唯一判据，**不要在别处再写一份阈值**。

      none         没有印象层（event_intensity 太低）
      intact       细节还清楚（detail >= IMPRESSION_DETAIL_MAX）
      faded_detail 印象在、细节淡了（detail < 30，impression >= 40）
      erased_detail 印象在、细节基本没了（detail < 20）
                     ★ 这种**绝对不许**在注入里出现原文细节
    """
    detail = peek_detail_strength(memory_item, current_timestamp)
    imp = peek_impression(memory_item, current_timestamp)
    if imp < IMPRESSION_RECALL_MIN:
        return "none"
    if detail < IMPRESSION_DETAIL_ERASED:
        return "erased_detail"
    if detail < IMPRESSION_DETAIL_MAX:
        return "faded_detail"
    return "intact"


def impression_note(memory_item, current_timestamp: float = None) -> str:
    """注入用的印象标注。没印象层时返回空串。

    ★ 这个函数是**唯一**的标注出口（T8 的核心）：
      不管这条是从正常候选来的、还是从印象补充来的，
      渲染都走这里 —— 呈现不该取决于它「怎么进的 Top-5」。
    """
    st = impression_state(memory_item, current_timestamp)
    if st == "faded_detail":
        return "（细节已淡，只记得这件事发生过）"
    if st == "erased_detail":
        return "（细节基本想不起来了，只记得有这么回事）"
    return ""


def calculate_current_strength(
    memory_item: MemoryItem,
    current_timestamp: float = None
) -> Tuple[MemoryItem, float]:
    """懒加载计算记忆当前强度（艾宾浩斯线性衰减）。

    ⚠️ 重要：这个函数**有副作用** —— 会改写 memory_item.strength 和 strength_at；
       last_active 保留为真实召回时间，由 reinforce_on_recall 更新。
       如果你只是想「算一下、看看是多少分」，**不要用它**，用 peek_strength()。
       只有确实想「更新这条记忆的强度状态」时才用它。

       历史教训（2026-11-07）：发现 5 条记忆的 strength 被写成 0.0 ——
       调用方只想算一下，结果副作用把 0 落了盘（那次是懒加载路径）。
       5 条里两条 importance=0.92（日记级），等于被判了死刑。

    - 防御性编程：当前时间早于 last_active 时，间隔天数取 0，强度不回升
    - 强度始终钳制在 0~100

    ⚠️ 2026-11-08 信任度拆分（T06）：**这里只改 strength，绝不碰 credibility。**
       两个字段管的是两件事 ——
         strength     多容易被想起来   → 会衰减（就是这个函数在算）
         credibility  是不是真的        → 不随时间变
       「他生日 2 月 13 日」三个月没提，strength 掉到 25 是合理的（一时想不起来），
       但事实没有变假，credibility 必须仍然是 1.0。
       credibility 只在「被明确推翻」时才改（冲突检测，尚未实现），
       任何衰减路径都不该写它 —— 包括本函数、reinforce_on_recall、
       以及 is_cold_storage / should_drop 里「因为快忘了就降可信度」的写法。
    """
    if current_timestamp is None:
        current_timestamp = datetime.now().timestamp()

    # v3：不再有「永不衰减」。所有记忆都走同一套衰减，只是地板不同。

    # strength_at 是 strength 的结算锚点；旧对象/旧数据回退 last_active。
    # last_active 只表示真实召回时间，不再参与周期性巩固的累计结算。
    strength_at = getattr(memory_item, "strength_at", None)
    if strength_at is None:
        strength_at = getattr(memory_item, "last_active", None)
    if strength_at is None:
        strength_at = getattr(memory_item, "create_time", None)
    if strength_at is None:
        strength_at = current_timestamp

    time_diff_seconds = current_timestamp - strength_at
    time_diff_days = max(0.0, time_diff_seconds / 86400.0)

    #   普通等级：3=2/天、2=5/天、1=8/天
    # ★ 2026-11-13：**按条目自定义衰减速率**优先于一切默认值。
    #
    #   为什么必须放最前面：
    #     只能让 `decay_rate` 字段优先。
    #
    #   为什么 None 时不生效：
    #     521 条主库记忆这个字段都是 None（from_dict 归一化后），
    #     走的还是原来的逻辑，**零行为变化**。
    _item_rate = getattr(memory_item, "decay_rate", None)
    if _item_rate is not None:
        try:
            decay_rate = max(0.0, float(_item_rate))
        except (TypeError, ValueError):
            decay_rate = DECAY_RATE_MAP.get(memory_item.consolidation_level, DECAY_RATE_MAP[2])
    else:
        decay_rate = DECAY_RATE_MAP.get(memory_item.consolidation_level, DECAY_RATE_MAP[2])

    # 2026-11-07 新增（借鉴 dsh-chain）：被想起过的东西，衰减本身变慢。
    #   slowdown 由 reinforce_on_recall 写入（1 + 0.6*log2(1+次数)，封顶 4.0）。
    #   这里除以 slowdown = 有效衰减速率降低。
    #   注意：这是「间隔重复」的数学本质 —— 不是每次补分，而是让遗忘曲线变缓。
    #   如果没有这个字段（旧数据），slowdown 默认 1.0，行为跟以前完全一样。
    _slow = float(getattr(memory_item, 'decay_slowdown', 1.0) or 1.0)
    # 2026-11-08 修「摆设开关」（评审 派）：features.py 里 half_life_boost
    #   一直是 True，但这里**从来没有判断过它** —— 关掉开关衰减照旧除以 slowdown，
    #   等于「关不掉」。现在真正受开关控制：
    #     开（默认）= 被想起越多次，忘得越慢（间隔重复的数学本质）
    #     关        = 退回「每次召回只补一次分、衰减速率不变」的老行为
    _fixed_rate = (_item_rate is not None
                   and getattr(memory_item, "decay_rate_mode", "base") == "effective")
    if _slow > 1.0 and on("half_life_boost") and not _fixed_rate:
        decay_rate = decay_rate / _slow

    # 2026-11-07 新增（借鉴 memory-brain）：情绪强的记忆衰减更慢。
    #   之前 emotion_intensity 只在召回打分里加 0.05 权重，完全不影响衰减。
    #   实测：高情绪记忆强度保持得好，是因为 importance 本来就高，不是情绪起效。
    #
    #
    #   为什么情绪只按情绪本身的强度算：
    #     而情绪是正则猜的（准确率未知）。
    #     用机器猜测去放大人的标记，猜错时会放大误差。
    #
    #   实测差异（起始 90，地板 55）：
    #     emo=0   → 117 天到地板
    #     emo=100 → 467 天到地板（多 350 天，中途最大差 21.5 分）
    #
    #   ⚠️ episode **不受这个开关影响** —— 它在下面被 0.8/天 覆盖，
    #      本来就绕过了情绪（顺序见下）。
    _emo_factor = emotion_decay_factor(memory_item)
    if _emo_factor < 1.0 and not _fixed_rate:
        decay_rate = decay_rate * _emo_factor

    # 2026-11-08 新增：情景档单独衰减速率（0.8/天，比 L3 的 2 分还慢）
    #   为什么：情景档是「事件」，30 天后提起来还该能想起来。
    #   按 L2 的 5 分/天算，17 天就淡忘了，跟 ttl=90 天矛盾。
    if getattr(memory_item, 'mem_type', '') == 'episode':
        try:
            from config import EPISODE_DECAY_RATE
            decay_rate = float(EPISODE_DECAY_RATE)
        except Exception:
            decay_rate = 0.8

    current_strength = memory_item.strength - decay_rate * time_diff_days

    # FIX-1103-FLOOR（2026-11-03）：给高等级记忆一个**衰减地板**。
    #
    #   背景：强化只能抵消约 3 天衰减，而实际召回是「每次 Top-5 / 库里有 170+ 条」，
    #   大部分记忆一周都轮不到一次召回 ⇒ 再重要的东西也会一路掉到 0 进冷存。
    #   （实测 90 天仿真：level-3 的"重要事件"掉到 6 分）
    #
    #   真人不是这样：记十几年的事，细节忘了但"有这么回事"还在。
    #   所以按巩固等级给不同的下限：
    #     等级 3（重要）  → 掉到 35 分就不再掉（还活着，随时可被想起）
    #     等级 2（一般）  → 掉到 15 分打住（快进冷存但不清零）
    #     等级 1（琐事）  → 不设下限（该忘就忘，符合设计）
    #   这样"重要的事记得牢、琐事慢慢忘"才真的成立。
    FLOOR_BY_LEVEL = {3: 35.0, 2: 15.0, 1: 0.0}
    level_floor = FLOOR_BY_LEVEL.get(memory_item.consolidation_level, 0.0)

    # ★★★ 2026-11-10 独立审查抓出的 P0 反转（必须读）★★★
    #
    #   上一版把地板释放写成 `floor = max(MIN, floor * RELEASE)`，
    #   而那时 `floor` 已经四层取过 max：
    #       max(level_floor, importance_floor)  → 39
    #       max(…, core_person_floor)            → 核心人物/assistant 45
    #       max(…, EPISODE_FLOOR)                → episode 45
    #
    #   整体乘 0.35 后实测（importance=0.65、level=2、起始 90）：
    #
    #       emo   30天    60天   180天  365天   730天
    #         0   39.00  39.00  39.00  39.00  39.00   ← 无情绪，被 39 托住
    #        90   52.50  15.00  13.65  13.65  13.65   ← 有情绪，穿到 13.65
    #
    #   **情绪越强，长期反而越低。** 「他家人住院了」一年后 13.65，
    #   「今天吃了碗面」一年后 39.00 —— 正是本改动要修的相反面。
    #   episode 更明显：无情绪 45.00 vs emo=90 的 15.75。
    #
    #   根因：释放的语义是「**细节**该淡」，但代码把
    #   那三层跟「细节清晰度」无关，它们是「这条记忆的地位」。
    #
    #   修法：**只释放 importance 层**，其余保护原样保留。
    #     released_importance = importance_floor * RELEASE
    # ★★★ 2026-11-10 深夜删除地板释放分支（独立审查 + 我复核）★★★
    #
    #   原来这里有两段「有印象层就释放地板」的逻辑：
    #     ① _imp_floor = max(MIN, imp_floor * RELEASE)     —— 释放
    #     ② floor = max(floor, _unrel * 0.5)               —— 兜底
    #
    #   两者都已删除。为什么：
    #
    #   【原因一：RELEASE = 1.0 并不是 no-op】
    #     `max(IMPRESSION_DETAIL_FLOOR_MIN, imp_floor * 1.0)` 里的 MIN = 10.0
    #     仍在生效 —— 实测（level=1，走到 3650 天）：
    #
    #         imp    imp_floor   无印象地板   有印象地板    差
    #        0.05        3.0        3.0       10.0      +7.0
    #        0.10        6.0        6.0       10.0      +4.0
    #        0.15        9.0        9.0       10.0      +1.0
    #        0.20       12.0       12.0       12.0      +0.0
    #
    #     ⇒ importance < 0.1667 时，有印象层的地板被**抬高**到 10。
    #     方向是「抬」不是「压」（所以不引入单调反转），
    #     但注释写的「设为 1.0 = 不释放」是**错的**。
    #     生产库当前最低 importance=0.22（imp_floor=13.2>10）⇒ 0 条命中，
    #     但**路径还活着**。这是「注释承诺 A，代码做 B」的典型。
    #
    #   【原因二：整条印象层已关闭，这个分支没有存在理由】
    #     · IMPRESSION_DETAIL_FLOOR_RELEASE = 1.0（不释放）
    #     · IMPRESSION_SUPPLEMENT_ENABLED   = False（兜底关）
    #     · IMPRESSION_PROTECT_FROM_COLD    = False（保护关）
    #     释放地板的目的只有一个：让 detail 掉下去，好让印象轨兜住。
    #     而兜底已关 ⇒ 释放只会让 detail 更低而没有任何补偿 ⇒ 有害无益。
    #
    #   【什么时候恢复】
    #     跟 IMPRESSION_SUPPLEMENT_ENABLED 一起（见 config 的开启条件）。
    #
    #   ⚠️ 现在的地板计算：floor = max(level_floor, importance_floor,
    #                                  core_floor, episode_floor)
    #      有印象层和无印象层**完全一致** —— 这是当前的有意行为。

    # v3：地板由「等级」和「重要度」共同决定，取高的那个
    floor = max(level_floor, importance_floor(memory_item))

    # 2026-11-08 新增（借鉴 memory-brain 的 core_floor）：
    #   关联到「核心人物/assistant」等核心人物的记忆，地板抬到 45。
    #   为什么：这类话可能被判成 speech（地板 13），但「关于他这个人」
    #   的记忆是底座，不该因为分类不准就丢掉。
    #   ★ 2026-11-10：这一层**不参与**印象层的地板释放（见上）。
    try:
        _core = core_person_floor(memory_item)
        if _core > floor:
            floor = _core
    except Exception:
        pass

    # 2026-11-08 新增：情景档单独的地板（45）
    #   为什么：等级2 的通用地板是 15，但情景档是「事件」，
    #   比琐事重要得多。而且 EPISODE_DECAY_RATE=0.8 需要配高地板，
    #   否则 100→15 只要 106 天，跟 ttl=90 天不匹配。
    #   ★ 2026-11-10：这一层同样**不参与**释放。
    if getattr(memory_item, 'mem_type', '') == 'episode':
        try:
            from config import EPISODE_FLOOR
            floor = max(floor, float(EPISODE_FLOOR))
        except Exception:
            floor = max(floor, 45.0)

    #
    #
    #
    #   实测（`is_cold_storage` / `should_drop` 的源码）：
    #     那两个函数**只读 strength 和 importance，从不读地板**。
    #     ```
    #     def is_cold_storage(m):
    #         if m.strength >= COLD_ARCHIVE_THRESHOLD: return False
    #         if m.importance >= COLD_KEEP_OUT_IMPORTANCE: return False
    #         return True
    #     ```
    #   ⇒ 「地板 55」只在 `calculate_current_strength` 里托住衰减下限，
    #     它**不参与**冷存/删除判定。
    #
    #     · importance = 0.85（>= COLD_KEEP_OUT_IMPORTANCE）→ 第 3 条挡住
    #     · strength 被地板托在 55（>= COLD_ARCHIVE_THRESHOLD 20）→ 第 2 条挡住
    #     两道闸门任意一条都够。
    #
    #   ⚠️ 为什么不「让地板真的参与冷存判定」：
    #     如果加 `if real_floor(m) >= 20: return False`，
    #     那么所有 importance >= 0.35 的记忆（地板 21）**永远进不了冷存** ——
    #     库只增不减，那比注释写错严重得多。
    #     所以这条**只改注释，不改逻辑**。
    #
    #   ★ 2026-11-10：这一层同样**不参与**印象层地板释放。

    #
    #   为什么必须加在这里：`real_floor()` 已经支持 `strength_floor`，
    #   但 `calculate_current_strength` 里这份地板是**另一份实现**（第 771 行起
    #   的 floor 链）。实测踩过：`real_floor()` 返回 70，但实际算出来的强度
    #   365 天后掉到 51 —— 因为真正决定强度的是这里的 floor，不是 real_floor()。
    #
    #   教训：同一个概念有两份实现时，只改一份等于没改。
    _sf_item = getattr(memory_item, "strength_floor", None)
    if _sf_item is not None:
        try:
            floor = max(floor, float(_sf_item))
        except (TypeError, ValueError):
            pass

    # ★★★ 2026-11-10 P0 反转的第二层修正（独立审查 + 我自己实测）★★★
    #
    #   只把「释放限定在 importance 层」还不够 —— 实测仍是反转：
    #
    #       emo   30天    60天   180天  365天  730天
    #         0   39.00  39.00  39.00  39.00  39.00   ← 无印象层，地板 39
    #        90   52.50  15.00  15.00  15.00  15.00   ← 有印象层，地板被释放到 15
    #
    #   **「有情绪」的记忆最终停 15，「没情绪」的停 39。**
    #
    #   根因不是「释放幅度太大」，而是**语义搞反了**：
    #     · 释放的初衷：让 detail 能掉下来，这样 detail 与 impression 才能拉开
    #     · 但 detail 掉得更低 ⇒ 这条记忆在正常召回里**更弱**
    #     · 而印象层是「补充通道」，不是主通道
    #     ⇒ 净效果 = 有情绪的记忆在主通道里更弱
    #
    #   人的直觉不是这样：「刻骨铭心」的东西在**任何**通道里都该更牢。
    #
    #   修法：**释放只允许降到「无印象层时的地板」的一半，且不低于等级地板。**

    # ★ 2026-11-10 深夜：原来这里还有一段「floor = max(floor, _unrel * 0.5)」
    #   的兜底逻辑，已随地板释放一起删除（印象层整条关闭，无存在理由）。
    #   详见上方「删除地板释放分支」那段注释。

    current_strength = max(floor, min(100.0, current_strength))

    # 2026-11-08 T06：只写 strength / strength_at，credibility 一个字都不动。
    #   如果哪天有人想在这里「顺手按强度降点可信度」，那是把两个维度又揉回一起了 ——
    #   快忘了 ≠ 是假的。
    memory_item.strength = round(current_strength, 2)
    memory_item.strength_at = current_timestamp

    return memory_item, current_strength


# ── 2026-11-07 冷存重新定位（与 评审 对齐）──────────────
#
# 实测发现：COLD_STORAGE_THRESHOLD=20 实际上**永远不会触发**。
#   因为 importance 地板（importance × 60）几乎都高于 20：
#     speech 0.22 → 地板 13.2  ← 唯一能掉进冷存的
#     misc   0.35 → 地板 21.0  ← 差 1 分就进不来
#     about_him 0.55 → 33.0 / tool 0.60 → 36.0 / event 0.65 → 39.0
#     fact/commitment/date 0.92 → 55.2
#   真实库 210 条里，只有 11 条（都是 speech）有可能进冷存，其余 199 条永远进不了。
#
# 所以把冷存从「忘了的记忆」重新定位成「历史档案」：
#   活跃库：会衰减、会召回、会强化        ← 记忆
#   冷存：  不衰减、不召回、只归档        ← 档案（能翻，但不能自动想起）
#
# 为什么保留低分记忆而不是删：
#   ① 删是单向的 —— speech 判定会有误判（今天已见三次分类误判），
#      「我不喜欢吃西瓜」这种 6 字短句完全符合 speech 特征但其实是重要偏好，
#      删了就永远没了。保留成本只是「文件大一点」，删的成本是「永久丢失」。
#   ② 「她说过的」本身是自我档案 —— 换模型后是口吻样本库。
#   ③ 成本几乎为零 —— 不进召回、不占性能。
COLD_DROP_IMPORTANCE = 0.20      # 低于此：真噪音，删
COLD_KEEP_OUT_IMPORTANCE = 0.85  # 高于此：靠地板保住，不许进冷存


def is_empty_content(memory_item: MemoryItem) -> bool:
    """内容为空 = bug，不是记忆（单独判断，不掺 importance）。

    评审 指出：用 importance 去判断「有没有内容」是维度错了。
    """
    return not (getattr(memory_item, "content", "") or "").strip()


def _has_impression(memory_item: MemoryItem) -> bool:
    """这条记忆有没有印象层（印象轨是否生效）。

    ★ 这是「印象保护」的唯一判据，is_cold_storage / should_drop 共用。
      阈值用 > 0 而不是 IMPRESSION_RECALL_MIN：
      印象刚从 90 掉到 45 时仍算有印象层（该保护），
      只有真的没有印象层（0）才不保护。
    """
    try:
        return float(getattr(memory_item, "impression_strength", 0.0) or 0.0) > 0.0
    except (TypeError, ValueError):
        return False


def _archive_importance(memory_item: MemoryItem) -> float:
    """读取归档策略用的重要性；脏值回退到普通级，不阻断巡检。"""
    imp = getattr(memory_item, "importance", None)
    if imp is None:
        try:
            imp = infer_importance(
                getattr(memory_item, "content", "") or "",
                getattr(memory_item, "source", "") or "",
            )
        except Exception:
            imp = 0.35
    try:
        return float(imp)
    except (TypeError, ValueError):
        return 0.35


def inactive_days(memory_item: MemoryItem, current_timestamp: float = None) -> float:
    """距最后一次真实召回/提及的天数；未来时间按 0 处理。"""
    if current_timestamp is None:
        current_timestamp = datetime.now().timestamp()
    last = getattr(memory_item, "last_recalled_at", None)
    if last is None:
        last = getattr(memory_item, "last_active", None)
    if last is None:
        last = getattr(memory_item, "create_time", None)
    try:
        return max(0.0, (float(current_timestamp) - float(last)) / 86400.0)
    except (TypeError, ValueError):
        return 0.0


RECALL_SLEEP_THRESHOLD = 0.2   # recall_weight 低于它就切 on_demand
RECALL_WEIGHT_STEP = 0.85      # 每次实际采用后乘这个因子


def mark_recall_used(memory_item: MemoryItem, current_timestamp: float = None) -> MemoryItem:
    """回复实际采用了这条记忆：累计采用次数，并降低主动召回权重。

    ★ 与「召回」严格区分：只有真实使用才调用这里。
      否则又会变成「系统检索自己把记忆压下去」，跟旧的自动续命同源。
    """
    if current_timestamp is None:
        current_timestamp = datetime.now().timestamp()
    try:
        memory_item.recall_count = int(getattr(memory_item, "recall_count", 0) or 0) + 1
    except (TypeError, ValueError):
        memory_item.recall_count = 1
    try:
        weight = float(getattr(memory_item, "recall_weight", 1.0) or 0.0)
    except (TypeError, ValueError):
        weight = 1.0
    weight = max(0.0, weight) * RECALL_WEIGHT_STEP
    memory_item.recall_weight = round(weight, 4)
    if weight < RECALL_SLEEP_THRESHOLD:
        memory_item.recall_mode = "on_demand"
    memory_item.last_recalled_at = float(current_timestamp)
    return memory_item


def is_permanent_memory(memory_item: MemoryItem) -> bool:
    """必须保留的永久记忆：不进冷库、不被当噪音删。

    这是「保留权」，与「是否主动召回」无关。
    """
    return bool(getattr(memory_item, "permanent_memory", False))


def _live_business_window(item, now=None):
    from services.evidence_semantics import timestamp
    try:
        start = timestamp(getattr(item, "effective_from", None))
        end = timestamp(getattr(item, "effective_to", None))
    except ValueError:
        return False
    if start is None and end is None:
        return False
    now = datetime.now().timestamp() if now is None else now
    if end is not None:
        return now < end
    return now < start + float(COLD_ARCHIVE_AFTER_DAYS) * 86400


def should_archive(memory_item: MemoryItem, current_timestamp: float = None) -> bool:
    """是否不再具备活跃库资格，与强度地板完全解耦。

    普通记忆连续 COLD_ARCHIVE_AFTER_DAYS 天未被召回才归档；刚被召回的
    低强度记忆不会仅因低强度被归档。importance >= 0.85 是显式活跃保护。
    永久记忆永远不归档。
    """
    if _live_business_window(memory_item, current_timestamp):
        return False
    if is_empty_content(memory_item):
        return False
    if is_permanent_memory(memory_item):
        return False
    if IMPRESSION_PROTECT_FROM_COLD and _has_impression(memory_item):
        return False
    if _archive_importance(memory_item) >= COLD_KEEP_OUT_IMPORTANCE:
        return False
    return inactive_days(memory_item, current_timestamp) >= float(COLD_ARCHIVE_AFTER_DAYS)


def is_cold_storage(memory_item: MemoryItem, current_timestamp: float = None) -> bool:
    """兼容旧名称；新代码优先使用语义更明确的 should_archive()。

    2026-11-10 归档重设计：判定依据从「强度 < 20」改为「连续未召回 >= 180 天」，
    与强度地板完全解耦。importance >= 0.85 仍是显式活跃保护。
    """
    return should_archive(memory_item, current_timestamp)


def should_drop(memory_item: MemoryItem) -> bool:
    """是否该彻底删掉（而不是进档案）。

    只有两种情况：
      ① 内容为空（bug）
      ② 强度已低于阈值 且 importance < 0.20（真噪音）
    其余一律保留 —— 见文件头「为什么保留」。
    """
    if is_empty_content(memory_item):
        return True
    if _live_business_window(memory_item) or is_permanent_memory(memory_item):
        return False
    if memory_item.strength >= HARD_DROP_THRESHOLD:
        return False
    # ★ 2026-11-10 第二步：有印象层的**绝不删**。
    #   同 is_cold_storage 的理由：细节地板被释放后 detail 会掉到 20 以下，
    #   若这条同时 importance < 0.20，原来的规则会把它当噪音删掉 ——
    #   而它是「他家人住院那次」这类该记一辈子的事。
    if IMPRESSION_PROTECT_FROM_COLD and _has_impression(memory_item):
        return False
    imp = getattr(memory_item, "importance", None)
    if imp is None:
        try:
            imp = infer_importance(
                getattr(memory_item, "content", "") or "",
                getattr(memory_item, "source", "") or "",
            )
        except Exception:
            imp = 0.35
    try:
        imp = float(imp)
    except (TypeError, ValueError):
        imp = 0.35
    return imp < COLD_DROP_IMPORTANCE


def reinforce_on_recall(memory_item: MemoryItem, bonus: float = 5.0, current_timestamp=None) -> MemoryItem:
    """FIX-1103-REINFORCE-V2：被召回一次 = 想起来一次，强度加一点、刷新时间。

    真人记忆有「提取即强化」效应（testing effect）：
    想起来一次，这条记忆之后更难忘。

    ⚠ 2026-11-03 修正了第一版的**收支失衡**：
      第一版强化是「固定 +5 分（按等级 ×0.6/1.0/1.5）」，但衰减是每天固定扣分：
        等级1: +3.0 强化 vs -8.0/天衰减 → 净亏 5.0/天
        等级2: +5.0 强化 vs -5.0/天衰减 → 刚好打平（必须天天被想起才不亏）
      而实际召回是「几小时一次、每次只取 Top-5」，166 条里大部分一周轮不到一次
      ⇒ **等级1/2 的记忆必然一路掉到 0**，等于强化形同虚设。

      修法：强化幅度与「衰减速率」挂钩 —— 一次召回至少抵消 3~5 天的衰减：
        · 基准 = decay_rate × 4 天（等级3=8分, 等级2=20分, 等级1=32分——但这太猛）
        · 改用温和版：decay_rate × 3，且封顶 25 分
      这样「被想起一次」，等级1 能顶约 3 天、等级2 约 3 天、等级3 约 3 天，
      符合「想起来一次，能多记几天」的直觉，又不会一召回就顶满。
    """
    from config import DECAY_RATE_MAP

    now = datetime.now().timestamp() if current_timestamp is None else float(current_timestamp)

    if is_pinned(memory_item):
        # ★ 2026-11-09 修（独立审计抓出的真 bug）：原来这里直接
        #       memory_item.strength = 100.0
        #       return memory_item
        #   **跳过了后面整段「被想起」的记录**（mention_count /
        #   mention_history / decay_slowdown / last_active）。
        #
        #   实测：
        #     强化前: strength=40.0 mention_count=7 slowdown=1.0
        #     强化后: strength=100.0 mention_count=7 slowdown=1.0   ← 计数不动
        #
        #   后果比「永远满分」更严重：decay_slowdown = 1 + 0.6*log2(1+count)
        #   对**所有 importance>=0.90 的记忆永远失效** —— 而这恰好是
        #   最重要的那 67 条。它们享受不到「间隔重复」这个核心机制。
        #
        #   修法：保留「回忆起 = 回到满分」的语义（这是设计意图），
        #   但不许提前 return —— 让下面的计数/历史/slowdown 照常更新。
        #   注意 last_active 也要刷新：它表示「最后一次被想起」。
        memory_item.strength = 100.0
        memory_item.last_active = now
        memory_item.strength_at = memory_item.last_active
        # 2026-11-10 修：last_recalled_at 也该刷新 —— 它表示「最后一次真实召回」。
        #   之前这里漏了，导致分层降权/归档的「未召回天数」全卡在迁移初始值，
        #   所有记忆被判成 L0、归档的 180 天判据对召回过的记忆失效。
        memory_item.last_recalled_at = memory_item.last_active
        try:
            memory_item.mention_count = int(
                getattr(memory_item, "mention_count", 0) or 0) + 1
            _hist = list(getattr(memory_item, "mention_history", None) or [])
            _hist.append(memory_item.last_active)
            memory_item.mention_history = _hist[-20:]
        except Exception as _e:
            note_silent_error('强化历史写入', _e)
        try:
            _mc = int(getattr(memory_item, "mention_count", 0) or 0)
            if _mc > 0:
                import math as _m
                memory_item.decay_slowdown = round(
                    min(4.0, 1.0 + 0.6 * _m.log2(1.0 + _mc)), 3)
            else:
                memory_item.decay_slowdown = 1.0
        except Exception as _e:
            note_silent_error('慢化因子写入', _e)

        # ★ 2026-11-10 第二步 R5：pinned 分支**也必须**强化印象层。
        #
        #   上面这段注释记着一条教训：pinned 分支曾经提前 return，
        #   结果 importance>=0.90 的 67 条记忆享受不到间隔重复。
        #   印象层要是只在下面的非 pinned 分支加，等于把同一个 bug 重演一次 ——
        #   而这 67 条恰恰是最该「一直记得」的。
        _bump_impression(memory_item)
        return memory_item

    # 先把旧时间区间结算完，再给本次召回加分。否则 strength_at 停在旧时刻，
    # 下一次结算会把同一区间再扣一次，强化甚至能让最终强度变低。
    calculate_current_strength(memory_item, current_timestamp=now)

    level = memory_item.consolidation_level
    rate = DECAY_RATE_MAP.get(level, DECAY_RATE_MAP[2])   # 每天掉多少
    # 一次召回 = 抵消约 3 天的衰减，封顶 25 分（避免一次就顶满）
    gain = min(25.0, rate * 3.0)
    # 保留 bonus 参数的作用（调用方可微调），但不再是主依据
    gain = max(gain, bonus)

    memory_item.strength = min(100.0, round(memory_item.strength + gain, 2))
    memory_item.last_active = now
    memory_item.strength_at = now
    # 2026-11-10 修：同上，last_recalled_at 也要跟着刷新。
    memory_item.last_recalled_at = memory_item.last_active

    # 2026-11-07 新增（借鉴 dsh-chain）：被想起次数越多，衰减本身变慢。
    #   原来的「+固定分」只是把强度抬一下，下次照样按原速率往下掉。
    #   真正的「间隔重复」是：命中越多 -> 忘得越慢。
    #   公式： slowdown = 1 + 0.6*log2(1+次数)，封顶 4 倍
    #
    #   dsh-chain 实测（同为 98 天前最后接触）：
    #     被想起 0 次 -> 衰减 25.7%
    #     被想起 3 次 -> 衰减 12.6%
    #     被想起 10 次 -> 衰减 9.2%
    # 2026-11-08 修（重要）：原来这里只改 strength / last_active，
    #   **没改 mention_count** —— 而 mention_count 是「被想起次数」的唯一真源，
    #   decay_slowdown 就要读它。
    #
    #   实测后果：215 条记忆的 mention_count 全是 0、mention_history 全空，
    #   于是 decay_slowdown 恒为 1.0，「被想起的东西衰减慢」这个特性
    #   在真实环境里完全没生效（昨天的测试是手动造 mention_count=10 才验出来的）。
    #
    #   修：被召回一次 = 被想起一次，计数 +1、记时间戳。
    try:
        memory_item.mention_count = int(getattr(memory_item, "mention_count", 0) or 0) + 1
        _hist = list(getattr(memory_item, "mention_history", None) or [])
        _hist.append(memory_item.last_active)      # 用刚刷新的时间
        # 只留最近 20 次，避免历史无限增长
        memory_item.mention_history = _hist[-20:]
    except Exception:
        pass

    # 用「刚 +1 之后」的计数算 slowdown
    try:
        _mc = int(getattr(memory_item, "mention_count", 0) or 0)
        if _mc > 0:
            import math as _m
            memory_item.decay_slowdown = round(min(4.0, 1.0 + 0.6 * _m.log2(1.0 + _mc)), 3)
        else:
            memory_item.decay_slowdown = 1.0
    except Exception:
        pass

    # ★ 2026-11-10 第二步 R5：重复提起应当**同时**提升印象（不只是细节）。
    _bump_impression(memory_item)
    return memory_item


def _bump_impression(memory_item: MemoryItem, amount: float = None) -> None:
    """R5：被想起一次 → 印象也涨一点（内部辅助，失败绝不抛）。

    为什么印象要跟着涨：
      现在 mention_count 只让衰减变慢（decay_slowdown），那是「细节」的机制。
      但人反复提起一件事时，涨的不只是细节清晰度，
      更是「这件事很重要，我记得有这么回事」这层印象本身。

    ⚠️ 只对**已有印象层**的记忆加分（impression_strength > 0）。
       没有印象层的（当时情绪 <60）加 1 次也不会建层 ——
       否则「被 recall 一次」就能让任意日常记忆获得印象层，
       等于绕过 IMPRESSION_BUILD_MIN_INTENSITY 这个门槛。
    """
    try:
        cur = float(getattr(memory_item, "impression_strength", 0.0) or 0.0)
        if cur <= 0.0:
            return
        step = IMPRESSION_MENTION_BONUS if amount is None else float(amount)
        memory_item.impression_strength = round(
            min(IMPRESSION_MENTION_MAX, min(100.0, cur + step)), 2)
    except (TypeError, ValueError):
        pass
    except Exception:
        pass
