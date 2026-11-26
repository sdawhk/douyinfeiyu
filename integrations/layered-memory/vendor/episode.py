# -*- coding: utf-8 -*-
"""情景档 episode.py —— 把多轮对话碎片聚合成「一件事」（2026-11-08）

设计依据：《情景档-详细设计.md》v3（两轮审查，16 项修复）。
本模块只依赖 L1/L2 层（config / schema），**绝不** import memory_manager /
daily_consolidation —— 那两个是 L3，反过来要调我，import 他们就会循环依赖。

对外九件事：
    theme_of(text)                    主题判定（三层兜底，永不返回空）
    should_start_new(...)             是否开新段
    aggregate_session(sid, mems)      单会话聚合
    aggregate_all(groups)             多会话聚合
    compose_content(turns, theme)     生成 content（纯规则）
    merge_short_segments(segs, n)     短段合并
    mark_aggregated(ep, mems)         给碎片打 episode_id 标记
    group_by_session(mems)            按会话分组
    save_episode(ep)                  保存（embedding 三级降级）

配套：to_episode / build_episodes / decay_params / episode_stats / selftest

────────────────────────────────────────────────────────────────────
为什么主题判定用「词表」而不是「向量相似度」——这是全模块最重要的决定
────────────────────────────────────────────────────────────────────
实测 44 条真实短期记忆，按时间间隔分成两组算余弦相似度：

    间隔 ≤2 分钟（同一件事）32 对 → 中位相似度 0.052，29/32 低于 0.15
    间隔 >10 分钟（换话题）  4 对 → 中位相似度 0.070，4/4 低于 0.15

**换话题的相似度反而更高。** 最典型的三个反例：

    「下个面，系上围裙」↔「水开了，把面下进去」         0.125  （同一件事）
    「水开了，把面下进去」↔「端了两碗，煎蛋」           0.034  （同一件事，太低）
    「自己也挑了一筷子」↔「我要改代码」                 0.044  （不同事，反而高）

也就是说：bge-m3 在这批数据上，同一件事 0.034、不同事 0.044，
**差距小于噪声**，任何阈值都分不出来（试过 0.15，两组都过不了）。

所以这里改用「主题词表 + 三层兜底」：判断依据是**语义上是不是同类事**
（都是做饭），不是**字面像不像**。词表是人维护的，但它是可解释、可审计、
可补的 —— 猜错了能一眼看出是哪层判的（known / guess / fallback）。
"""
# ★ 2026-11-09 拆分：零依赖的工具函数和常量搬到 episode_base.py
#   这里显式列出（不用 *），免得污染命名空间。
from episode_base import (
    # 函数
    _strip_quotes, date_of, _attr, _content_of, _ts_of, _id_of,
    _seg_mems, _seg_get,
    # 常量
    FALLBACK_THEME, GUESS_PREFIX, _GUESS_PREFIXES, _GUESS_TAIL,
    _GUESS_NOISE_RE, CHAT_SEG_MAX, _STRICT_TYPES, _KIND_RANK,
    ACTION_MAX_COUNT, ACTION_MIN_LEN, ACTION_MAX_LEN, _ACTION_RE,
    SPARSE, MIN_CONTENT_CHARS, _FILLER_CHARS,
    _SPEAKER_RE, _QUOTE_RE, _SYSNOISE_RE, _SYS_NOISE_SEG_RE,
    LEGACY_GROUP, _cosine, _embedding_of,
)

# ★ 2026-11-09 拆分第二步：内容组装层搬到 episode_compose.py
from episode_compose import (
    extract_actions, _has_information, _pick_informative,
    compose_content, compose_content_detailed,
    _who_of, _fit_content, _completeness_of,
)

# ★ 2026-11-09 拆分第三步：存储层搬到 episode_store.py
from episode_store import (
    _stable_episode_id, to_episode, build_episodes, save_episode,
    mark_aggregated, _episode_id_of, attach_embedding,
    _is_usable_embedding, _default_embed, _atomic_write_json,
    _file_lock, _NullLock, episode_stats, decay_params,
    check_integrity, format_integrity,
    cleanup_episodes, cleanup_episodes_dry_run,
    dedup_episodes, dedup_episodes_dry_run,
    _is_sparse, _bucket_key, _episode_date_of, _marked_and_owned,
    _coerce_episode, _is_episode,
    EPISODE_CLEAN_KEEP_DAYS, EPISODE_CLEAN_KEEP_PER_THEME,
)

# ★ 2026-11-09 拆分第四步：召回层搬到 episode_recall.py
from episode_recall import (
    should_recall_episodes, build_episode_inject, inject_text_of,
    dedup_recall, pick_inject_episodes, _pick_inject_episodes,
    pick_inject_episodes_detailed, recall_episodes_preview,
    RECALL_TRIGGERS, RECALL_TIME_WORDS,
    EPISODE_INJECT_MAX_CHARS, EPISODE_INJECT_MAX_ITEMS,
)






from common.locking import NullLock
import hashlib
import json
import math
import os
import re
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
#
# 中文 Windows 终端默认 GBK，print 中文/emoji 直接 UnicodeEncodeError 崩掉。
# 实测 link_check / test_shortterm / regression_test 在 cmd 里都这么死过。
# 放在 import 之后立刻执行，保证后面任何 print 都不会因为编码炸。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ═══════════════════════════════════════════════════════════════════
# 依赖：只 import L1/L2
# ═══════════════════════════════════════════════════════════════════
from config import LONG_TERM_ACTIVE_PATH  # noqa: E402
from schema import MemoryItem             # noqa: E402

# config.py 里 episode 那几个参数是 B2 负责加的。这里用「有就读、没有就用默认」，
# 保证本模块在 B2 改 config 之前就能跑、改之后自动跟随，不用改我。
# 反过来如果写死常量，B2 在 config 里调了参数却没人读 —— 那就是又一个「死字段」。
try:
    from config import EPISODE_DECAY_RATE, EPISODE_FLOOR      # noqa: F401
except Exception:
    EPISODE_DECAY_RATE = 0.8      # 每天掉 0.8 分
    EPISODE_FLOOR = 45.0          # 地板 45

try:
    from config import EPISODE_KEEP_DAYS
except Exception:
    EPISODE_KEEP_DAYS = 90        # 90 天 ttl

# 单会话单日「期望段数」：只告警，不截断。
#
# ★ 2026-11-08：本模块内部原来叫 EPISODE_MAX_PER_DAY，现已改名。
#   为什么必须改名：那个名字暗示「硬上限」，读代码的人会以为系统会截断 ——
#   实际只 print 提示、全部保存。**一个名字骗人的常量，比没有更危险。**
#   （config 里的旧名别名也已删除，见 config.py 那边的注释。）
try:
    from config import EPISODE_DAILY_EXPECTED
except Exception:
    EPISODE_DAILY_EXPECTED = 10

try:
    from config import LOCK_FILE_PATH
except Exception:
    LOCK_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "memory_data.lock")

try:
    from filelock import FileLock
except Exception:                 # 没装 filelock 也不能让整个模块 import 失败
    FileLock = None


# ═══════════════════════════════════════════════════════════════════
# 一、主题词表（设计文档 2.2 节原文）
#
# 维护方式（设计 2.3）：
#   ① 初始：从 44 条真实数据里人工提炼
#   ② 每周：跑 episode_stats / memory_cli episode audit --low-confidence，
#           看哪些段是「临时:xxx」或「闲聊」
#   ③ 某个「临时:xxx」出现 ≥3 次 → 升级进词表
#
# 顺序有意义：命中靠前的优先。所以「做饭」放在「吃饭」前面 ——
# 「汤都喝光」这种句子两边都能命中，先判成一顿具体的饭更贴近原意。
# ═══════════════════════════════════════════════════════════════════
THEMES: Dict[str, List[str]] = {
    "做饭": ["摆碗", "下个面", "围裙", "水开", "下锅", "煎蛋", "挑了一筷子",
             "吹了吹", "泡烂", "汤都喝光", "下面条"],
    "吃饭": ["饿了", "一起吃饭", "快吃", "吃完了吗", "我吃完了", "喝光"],
    "改代码": ["改代码", "写代码", "看代码", "弄完", "搞完", "代码"],
    "睡": ["早点睡", "睡了一觉", "被子", "闭眼", "蜷", "躺", "打盹", "醒过"],
    "关心": ["心疼", "眼睛都红", "困不困", "累不累", "忙到"],
    "睡眠设置": ["睡眠模式", "自动睡眠", "路由器", "关掉", "断线"],
}




# ═══════════════════════════════════════════════════════════════════
# 二、主题判定：三层兜底（设计 2.2，问题3 的修复）
#
# 为什么必须三层：
#   词表只有七类，覆盖不全。只用前两层（词表 + 兜底闲聊）的话，
#   词表外的新话题（「我们去看电影吧」）会被判成「闲聊」，
#   而「闲聊」按规则**不是切换理由** ⇒ 它会被吞进上一段（比如做饭段）。
#   实测后果：换个话题聊 5 轮，整段还是「做饭」。
#
#   所以中间加一层「猜」：把最有信息量的 3~4 个字摘出来当临时主题，
#   kind='guess'，在 should_start_new 里属于「只要出现就切」。
#   代价是可能切太碎，但设计 2.0 明确：切碎的代价小于把两件事合成一件。
#
# ⚠️ 永远不返回空 —— 返回空会让 should_start_new 的 theme != cur_main
#    永远成立，分段逻辑直接失控。
# ═══════════════════════════════════════════════════════════════════





def _clean_for_guess(text: str) -> str:
    """把一句对话洗成「最有信息量的那几个字」。"""
    t = str(text or "")
    # ① 去掉对话壳子（他说： / 我回：）—— 冒号可有可无
    t = re.sub(r"他说\s*[:：]?|我回\s*[:：]?", "", t)
    # ② 去掉动作（圆括号）和引用（方括号 / 方头括号 / 书名号）
    t = re.sub(r"（[^）]*）", "", t)
    t = re.sub(r"\([^)]*\)", "", t)
    t = _strip_quotes(t)
    # ③ 去掉所有空白/标点/符号，只留字
    t = re.sub(r"[\s\W_]+", "", t)

    # ④ 剥前缀（最多剥 4 层：「那我们去吃火锅吧」→「吃火锅吧」）
    for _ in range(4):
        changed = False
        for p in _GUESS_PREFIXES:
            if t.startswith(p) and len(t) - len(p) >= 2:
                t = t[len(p):]
                changed = True
                break
        if not changed:
            break
    # 「去看电影」→「看电影」（剩太短就不剥，免得把「去示例城市」剥没了）
    if t.startswith("去") and len(t) > 3:
        t = t[1:]
    # ⑤ 剥结尾语气词
    t = t.rstrip(_GUESS_TAIL)
    return t




def _guess_theme(text: str) -> Optional[str]:
    """从文本里猜话题。返回 None 表示猜不出（太短 / 全是语气词 / 是工具产物）。

    实测陷阱（43 条真实数据）：
        「…冷一点，被子薄」→「2154」       用户 ID
        「…就一下下」      →「好没烫到」   纯应答
        「…不管了乖乖等我」→「不管了乖」   纯应答
    这些都不是话题。它们本该落到 fallback，让分段逻辑按「不切」处理。
    """
    t = _clean_for_guess(text)
    if len(t) < 3:
        return None
    if _GUESS_NOISE_RE.search(t):
        return None
    return t[:4]


def theme_of(text: str) -> Tuple[str, str]:
    """返回 (主题名, 主题类型)。

    类型：
        'known'    —— 命中词表（可解释、可信）
        'guess'    —— 词表外，按字面猜的临时主题（出现在新话题上）
        'fallback' —— 猜不出，兜底「闲聊」

    保证：永远不返回 ('', '')。

    为什么在查词表**之前**先挡掉引用消息：
        「他说：[引用 assistant：看地图]去哪里集合；我回：图书馆门口」
        要问的是「为什么看着屏幕笑」，但被引用的那半句里有个「贴了一下脸」
        —— 属于同一话题。实测这句整晚的段落中间被硬生生劈成两段。
        引用是上下文，不是这一轮说的话；先剥掉再判主题，判的才是新内容。
    """
    t = str(text or "")

    # 第①层：查词表（先剥掉引用，只判这一轮真正说的话）
    for name, words in THEMES.items():
        for w in words:
            if w in _strip_quotes(t):
                return name, "known"

    # 第②层：猜（去掉对话壳子，取最有信息量的片段）
    guess = _guess_theme(t)
    if guess:
        return f"{GUESS_PREFIX}{guess}", "guess"

    # 第③层：兜底
    return FALLBACK_THEME, "fallback"


# ═══════════════════════════════════════════════════════════════════
# 三、小工具：兼容 MemoryItem / dict 两种输入
#
# 为什么两种都吃：selftest 和 memory_cli 会直接传 dict（从 JSON 读出来没转对象），
# 生产链路传的是 MemoryItem。写死一种就会在另一条路上 AttributeError。
# ═══════════════════════════════════════════════════════════════════











# ── 兼容垫片：给老 schema 补上 episode 相关字段的类级默认值 ──
# 为什么需要：MemoryItem.from_dict 的逻辑是「遍历 dict 的键，hasattr 为真才 setattr」。
# 字段不在 __init__ 里 ⇒ hasattr 为 False ⇒ 从磁盘读回来时 episode_id 被丢掉。
# 这正是今天踩过的「死字段」坑：内存里打了标，落盘再读就没了，
# 于是第二天同一批碎片被重复聚合。
# B2 会把字段正式加进 schema.__init__；在那之前，这里补一层类级默认，
# 让 hasattr 为真、标记能过一遍磁盘。幂等，不覆盖任何已有定义。
def _ensure_schema_fields() -> List[str]:
    patched = []
    for f, d in (("episode_id", None), ("episode_at", None), ("session_id", None),
                 ("content_source", "original"), ("content_confidence", "high"),
                 ("scene", None), ("source_turns", None)):
        if getattr(MemoryItem, f, "missing") == "missing":
            setattr(MemoryItem, f, d)
            patched.append(f)
    return patched


_SCHEMA_PATCHED = _ensure_schema_fields()




# ═══════════════════════════════════════════════════════════════════
# 四、分段判据（设计 2.1）
# ═══════════════════════════════════════════════════════════════════

# 阈值一律从 config 读，读不到才用这里的默认值。
# 为什么不留写死的常量：B2 在 config.py 里定义了 EPISODE_GAP_CUT_SECONDS /
# EPISODE_MAX_TURNS / EPISODE_MIN_TURNS / EPISODE_MAX_CHARS 四个参数，
# 如果本模块不用它们，那就是四个「死字段」—— 改了没人读，等于没有。
try:
    from config import EPISODE_GAP_CUT_SECONDS as GAP_LIMIT
except Exception:
    GAP_LIMIT = 600      # 时间断层阈值（秒）。> 600s 必切

try:
    from config import EPISODE_MAX_TURNS as ANY_SEG_MAX
except Exception:
    ANY_SEG_MAX = 20     # 任意段最多 20 条

try:
    from config import EPISODE_MIN_TURNS as MIN_SEG_TURNS
except Exception:
    MIN_SEG_TURNS = 2    # 少于 2 条不成档


# ── 主题亲和：同一件事的分法 ──
# 设计 2.0 的原话是「煮饭」和「晚饭」算同一件，因为「一顿饭是一个场景」。
# 落到词表上，「做饭」和「吃饭」是两个主题名，但它们描述的是同一段场景：
#   19:34 我饿了，等你一起吃饭   → 吃饭
#   19:44 好，那我摆碗           → 做饭
#   19:47 我也挑了一筷子         → 做饭
# 不做亲和的话，这一顿饭从开口就被切成两段（实测：做饭那 6 条被劈成 5+1）。
# 同理「睡 / 关心 / 睡眠设置」是一段睡前长聊：
#   「从被子里探出头」→ 睡，「眼睛都红了，心疼你」→ 关心，「哪个睡眠模式」→ 睡眠设置
# 实测这一段被切成 3 段，读完像三件事，其实是同一晚。
#
#    做饭→改代码 该切就切，否则吃完了聊天会被吞进做饭段。
THEME_FAMILY: List[set] = [
    {"做饭", "吃饭"},
    {"睡", "关心", "睡眠设置"},
]


def same_family(a: Optional[str], b: Optional[str]) -> bool:
    """两个主题是不是「同一个场景的不同侧面」。"""
    if not a or not b or a == b:
        return False
    for fam in THEME_FAMILY:
        if a in fam and b in fam:
            return True
    return False


def should_start_new(cur, cur_main, new_mem, gap, theme, kind,
                     session_id=None) -> Tuple[bool, str]:
    """返回 (是否开新段, 原因)。

    判据按顺序（先判的优先，命中就返回）：

        0. 首条 → 不算切（只是初始化）
        1. 跨自然日 → 必切
        2. 时间断层 > 600s → 必切
        3. 主题不同 → 看 kind：
              guess         → 必切（它本身就是新话题）
              fallback      → 当前段落有真主题时不切（闲聊不足以当切换理由）
              同族主题(亲和) → 不切（做饭/吃饭、睡/关心/睡眠设置 是同一场景）
              其它           → 切
        4. 同主题（含同族）→ 不切，但「闲聊」满 10 条 / 任意段满 20 条要切

    为什么第 3 条对 fallback 特殊处理：
        「他说：好呀；我回：嗯嗯」这种没有主题词的应答，如果也当切点，
        做饭那一段会被切成一堆 1 条的碎片。粒度原则：宁合不切 ——
        合成一件的代价是细节混了一点，切太碎的代价是召回时全是碎片。

    为什么还要同族亲和（THEME_FAMILY）：
        「我饿了，等你一起吃饭」→吃饭、「那我摆碗」→做饭，
        本来就是同一顿饭的两个侧面。不亲和的话它从第一句就被劈开。

    为什么「闲聊」段有上限：
        fallback 不切，意味着一整晚的闲聊会被吞成一段，永远不断。
        给个 10 条上限，保证它迟早断开。
    """
    # ── 0. 首条：不叫「切」，叫开始
    if not cur:
        return False, "首条"

    # ── 1. 跨自然日 → 必切（问题4）
    if date_of(cur[-1]) != date_of(new_mem):
        return True, "跨天必切"

    # ── 2. 时间断层 → 必切
    try:
        gap = float(gap or 0)
    except (TypeError, ValueError):
        gap = 0.0
    if gap > GAP_LIMIT:
        return True, f"时间断层 {int(gap)}s"

    # ── 3. 主题不同
    if theme != cur_main:
        if kind == "guess":
            return True, f"新话题（猜）{theme}"
        # 兜底「闲聊」：当前已经有真主题时，闲聊不足以为切换理由
        if theme == FALLBACK_THEME and cur_main != FALLBACK_THEME:
            return False, "兜底不足以为切换理由"
        # 同族主题（做饭↔吃饭、睡↔关心↔睡眠设置）：一顿饭 / 一晚睡前聊，不切
        if kind == "known" and same_family(cur_main, theme):
            reason = f"同族主题 {cur_main}~{theme}"
        else:
            return True, f"{cur_main}→{theme}"
    else:
        reason = f"同主题 {theme}"

    # ── 4. 延续，但有长度上限
    n = len(cur)
    if cur_main == FALLBACK_THEME and n >= CHAT_SEG_MAX:
        return True, f"闲聊段满{CHAT_SEG_MAX}条"
    if n >= ANY_SEG_MAX:
        return True, f"段满{ANY_SEG_MAX}条"
    return False, reason


# ═══════════════════════════════════════════════════════════════════
# 五、段 / 情景档的数据形状
#
# 段（Segment）是中间产物，不是落盘对象：它拿着活的 MemoryItem 列表。
# 用 dict 子类而不是 dataclass —— 理由：
#   ① 后面拼 episode dict 时直接取字段，不用写一大堆转换
#   ② 调用方两种写法都能用：seg["mems"]（验收脚本这么写）和 seg.mems（设计文档这么写）
#   ③ 落盘前 to_episode() 会把 mems 摘掉，绝不让 MemoryItem 进 JSON
# ═══════════════════════════════════════════════════════════════════

class Segment(dict):
    """段：{mems, theme, kind, session_id}，同时支持 seg['x'] 和 seg.x。"""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as e:
            raise AttributeError(name) from e


def _make_seg(mems: List[Any], theme: Optional[str], kind: Optional[str],
              session_id: Optional[str] = None) -> Segment:
    return Segment(mems=list(mems),
                   theme=theme or FALLBACK_THEME,
                   kind=kind or "fallback",
                   session_id=session_id)






# ═══════════════════════════════════════════════════════════════════
# 六、短段合并（设计 2.4，问题12 的落地）
# ═══════════════════════════════════════════════════════════════════



def _seg_date(seg: Any) -> str:
    """取一段所属的自然日（YYYY-MM-DD）。

    优先用段对象里存的 date；没有就取段首碎片的 create_time。
    返回 "" 表示**合法地判不出**（空段 / 没有 create_time），调用方跳过跨天检查。

    ⚠️ 2026-11-08 两版教训（会话F 验收）：
       第一版调不存在的 ``_mem_get`` → NameError 被 ``except Exception`` 吞掉 → 永远 ""；
       第二版传入裸 list → ``getattr(seg, "mems", [])`` 拿到 [] → 也是 ""。
       两次都是「兜底吞掉编程错误」，都导致跨天守卫静默失效。

       现在的原则：**传错类型是调用方 bug，要么炸、要么在日志里留痕，
       绝不能静默变成「判不出」**。而「空段 / 没时间戳」才是合法的判不出。
    """
    if isinstance(seg, (list, tuple, set)):
        if _STRICT_TYPES:
            raise TypeError(
                "_seg_date 要段对象（dict 或 Segment），不要传裸 %s；"
                "裸容器没有 .mems 属性，静默返回 '' 会让跨天守卫失效。实际值: %r"
                % (type(seg).__name__, seg[:2] if len(seg) > 2 else seg))
        return ""

    # 段对象自带 date → 直接用
    d = _seg_get(seg, "date")
    if d:
        return str(d)

    mems = _seg_mems(seg)
    if not mems:
        return ""          # 合法：空段

    # 取最早的 create_time（不用 min(key=...)，避免 key 函数里再出错）
    ts = None
    for m in mems:
        v = _seg_get(m, "create_time")
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        # 注意：0 是合法时间戳（1970-01-01），不能用 ``if not v`` 判假
        if ts is None or v < ts:
            ts = v
    if ts is None:
        return ""          # 合法：段里没有可用时间戳

    import time as _t
    return _t.strftime("%Y-%m-%d", _t.localtime(ts))


def merge_short_segments(segments: list, min_turns: int = MIN_SEG_TURNS) -> list:
    """少于 min_turns 条的段，并入**下一段**。

    为什么并下一段而不是上一段：
        段是按时间顺序生成的，一条孤零零的碎片（比如「他说：好」）
        在时间上更接近**后面**那件事的开场白，并进去更自然；
        并上一段会让上一段的尾巴挂着一句莫名其妙的话。

    并入后主题取**本段**的（保留下游段的归属判断），
    本段没有主题时取下一段的。
    """
    segs = list(segments or [])
    if min_turns <= 1 or len(segs) <= 1:
        return segs

    merged: List[Any] = []
    skip_next = False
    for i, seg in enumerate(segs):
        if skip_next:
            skip_next = False
            continue
        cur_mems = _seg_mems(seg)
        if len(cur_mems) < min_turns and i + 1 < len(segs):
            nxt = segs[i + 1]
            nxt_mems = _seg_mems(nxt)

            # 2026-11-08 修（问题 7.1，巡检 + 设计-契约 独立发现）：
            #   「跨天必切」在 should_start_new 里切出了两段，
            #   但这里无条件下标合并又把它们合回一段 —— 判据被自己吃掉了。
            #   实测：23:59 + 00:01 → 得 1 段，而设计要求 2 段。
            #
            #   修法：两段的自然日不同就不合并。
            #   为什么必须挡住：scene.date 取段首那一天的日期，
            #   一旦跨天合并，scene.date 就不可信了（约定 I7 被破坏）。
            if _seg_date(seg) and _seg_date(nxt) and _seg_date(seg) != _seg_date(nxt):
                merged.append(seg)          # 跨天，不并，各自独立成段
                continue

            theme = _seg_get(seg, "theme") or _seg_get(nxt, "theme")
            kind = _seg_get(seg, "kind") or _seg_get(nxt, "kind")
            sid = _seg_get(seg, "session_id") or _seg_get(nxt, "session_id")
            merged.append(_make_seg(cur_mems + nxt_mems, theme, kind, sid))
            skip_next = True
        else:
            merged.append(seg)
    return merged




def _dominant_theme(mems: List[Any], fallback: Optional[str] = None) -> Tuple[str, str]:
    """段里最有代表性的那个主题。

    排序键：(kind 优先级, 票数降序, 首次出现的次序)
    """
    votes: Dict[str, int] = {}
    kinds: Dict[str, str] = {}
    first_seen: Dict[str, int] = {}
    for i, m in enumerate(mems):
        theme, kind = theme_of(_content_of(m))
        votes[theme] = votes.get(theme, 0) + 1
        kinds.setdefault(theme, kind)
        first_seen.setdefault(theme, i)
    if not votes:
        return (fallback or FALLBACK_THEME), "fallback"
    best = min(
        votes,
        key=lambda t: (_KIND_RANK.get(kinds.get(t, "fallback"), 2),
                       -votes[t], first_seen[t]),
    )
    return best, kinds.get(best, "fallback")


# ═══════════════════════════════════════════════════════════════════
# 七、单会话聚合（设计 2.1 主循环）
# ═══════════════════════════════════════════════════════════════════



def aggregate_session(session_id: str, mems: list,
                      known_sources: Optional[dict] = None) -> list:
    """把一个会话的短期记忆聚合成若干段（Segment 列表）。

    · 已带 episode_id 的碎片跳过 —— 防重复聚合（问题1）
    · 空内容跳过 —— 没内容没法判主题
    · 按 create_time 排序 —— 上游给的不保证有序
    · 最后做短段合并

    注意：本函数**不改**任何碎片的字段。打标记是 mark_aggregated 的事 ——
    这样调用方可以先看看分段结果，满意了再落盘。
    """
    total = len(mems or [])
    usable: List[Any] = []
    already = 0
    empty = 0
    for m in (mems or []):
        if _episode_id_of(m):
            # ★ 不能只看「有标记」就跳过（2026-11-08 修，实测死锁）
            #
            # 现场：档 ep_..._1e05 的 source_turns 只有 1 条，
            #   却有 5 条碎片带着它的标，而这 5 条的 create_time
            #   全都晚于档的 create_time —— 档生成时它们还不存在。
            # 后果是一条稳定死锁：
            #   ① 碎片有标 → 聚合跳过 → 这段永远不重新聚合
            #   ② source_turns 里没有它们 → mark_aggregated 永远不会补
            #   ③ 下一轮同样跳过 → 永远重复 ①②
            #   实测 5 次采样数值完全不变，确认是稳定态不是瞬时。
            #
            # 修法：调用方传 known_sources（档 id → 该档 source_turns 集合）时，
            #   只有「标记指向的档确实记着它」才算真已聚合；
            #   否则标记是坏的（删档时没回收 / 旧算法残留），让它重新参与聚合。
            #   不传 known_sources 就退回老行为（向后兼容，老调用方不受影响）。
            if known_sources is None or _marked_and_owned(m, known_sources):
                already += 1
                continue
        if not _content_of(m).strip():
            empty += 1
            continue
        usable.append(m)

    # 空结果必须说明原因。
    # 为什么：返回 [] 有两种完全不同的含义 ——「都聚合过了，正常」
    # 和「输入是空的 / session 传错了，出事了」。调用方（巩固流程）拿到空
    # 列表会当成「今天没活干」照常往下走，于是真出问题也没人发现。
    # 实测被巡检员指出：45 条全带 episode_id 时返回 0 段，分不清是哪一种。
    if not usable:
        print(f"[episode] {session_id}: 没有可聚合的碎片"
              f"（总计 {total} 条 / 已聚合 {already} / 空内容 {empty}）")
        return []

    usable.sort(key=_ts_of)

    segments: List[Segment] = []
    cur: List[Any] = []
    cur_main: Optional[str] = None
    cur_kind: Optional[str] = None

    for m in usable:
        gap = 0.0 if not cur else (_ts_of(m) - _ts_of(cur[-1]))
        theme, kind = theme_of(_content_of(m))
        start_new, _reason = should_start_new(
            cur, cur_main, m, gap, theme, kind, session_id)

        if start_new:
            if cur:
                segments.append(_make_seg(cur, cur_main, cur_kind, session_id))
            cur, cur_main, cur_kind = [m], theme, kind
        else:
            cur.append(m)
            if cur_main is None:
                cur_main, cur_kind = theme, kind

    if cur:
        segments.append(_make_seg(cur, cur_main, cur_kind, session_id))

    segments = merge_short_segments(segments, min_turns=MIN_SEG_TURNS)

    # 合并后再定一次标签：段是「累积第一个主题」得到的，
    # 加入同族亲和以后，一段里可能前半是「睡」后半是「睡眠设置」，
    # 挂着开场那个标签会误导 audit（也误导注入时的说明）。
    # 所以按**多数票**重定一次主题名，kind 跟着走。
    for seg in segments:
        theme, kind = _dominant_theme(_seg_mems(seg), _seg_get(seg, "theme"))
        seg["theme"], seg["kind"] = theme, kind

    # 单日段数「期望值」：只告警，不截断 —— 而且**全链路**都不截断。
    # 为什么不能截断：设计文档自己期望 45 条 → 11 段，而期望值是 10。
    # 硬截断会把第 11 段直接丢掉，而第 11 段常常正是「做饭那 8 条」被拆散的另一半，
    # 等于把设计的核心价值（一件事就是一条）砍掉。
    # 11-08 评审 裁决：EPISODE_DAILY_EXPECTED 是告警阈值，不是硬上限；
    # 巩固流程（daily_consolidation）也同步改成了不截断。
    # 所以这里必须写明「全链路不截断」，别再让下一个人去找一个不存在的截断点。
    if len(segments) > EPISODE_DAILY_EXPECTED:
        print(f"[episode] {session_id}: 今天切出 {len(segments)} 段，"
              f"超过预期 {EPISODE_DAILY_EXPECTED} 段 —— 全链路不截断，全部保存。"
              f"这句只是提示「是不是切太碎了」；段数偏多通常说明主题词表覆盖不足，"
              f"跑 memory_cli episode audit 看看。")

    return segments


def aggregate_session_safe(session_id: str, mems: list,
                           known_sources: Optional[dict] = None) -> list:
    """聚合失败不影响其他会话 / 不影响巩固流程（设计 7.2）。"""
    try:
        return aggregate_session(session_id, mems, known_sources)
    except Exception as e:
        print(f"[episode] 聚合失败 {session_id}: {type(e).__name__}: {e}")
        return []


# ═══════════════════════════════════════════════════════════════════
# 八、content 生成（设计 3.2 方案 A，纯规则）
#
# 防污染（问题13）：
#   content 是**生成的**，一旦写错，她可能把它当成真发生过的事。
#   所以：
#     ① content_source='generated' / content_confidence='medium' 明确标注
#     ② 动作一律从原文括号里**照抄**，不改写、不润色、不补
#     ③ source_turns 保留原文 mem_id，随时能回查
#   这三条里，② 是根本 —— 只要每个字都来自原文，拼接生硬但不会编造。
# ═══════════════════════════════════════════════════════════════════

try:
    from config import EPISODE_MAX_CHARS as CONTENT_MAX_CHARS
except Exception:
    CONTENT_MAX_CHARS = 500






# ── content 稀疏判定与「原话摘句」兜底（2026-11-08）
#
# 【问题】实测 17 条情景档里 7 条是空的（41%）：
#     「04-12 09:10，闲聊（1 轮）」   ← 全部内容就这些
#   根因是 compose_content 只抽**圆括号里的动作**，
#   而这 7 条对应的原文一个圆括号都没有，全是纯对话：
#     「他说：有空时可以核对清单；
#       我回：我看到清单已经整理完毕，没闲着」
#   ⇒ 抽不出动作 ⇒ content 只剩元信息。
#
#   没有动作描写的纯对话（闲聊/讨论/查问题）产出为 0。
#   而纯对话恰恰是信息量最大的那类 —— 等于「聊得越认真，记得越少」。
#
# 【还会毒化下游】这 7 条只剩「时间 + 主题名」，向量范数全在 25.6~26.8，
#   彼此相似度 0.955~0.959。它们相似**不是因为有重复内容，是因为都没有内容**。
#   拿去判重会误判成「同一件事被切成 4 条」，删掉真实对话；
#   拿去召回会互相挤占；「泛化磁铁」里至少一半是这么来的。
#
# 【修法】抽不到动作时，从原文摘**一句信息量最大的原话**补上：
#   ① 摘句要「有信息量」，不是「最长」（「嗯嗯嗯嗯」最长但没信息）
#   ② 摘句要标来源：用〔原话〕前缀，跟（动作描写）区分开
#   ③ 原文真的没有信息量时**不硬摘**，如实标 sparse
#
# 【为什么不硬摘】「这条档内容稀疏」是事实，要如实记录。
#   硬摘一句让 content 看起来不空，是在骗下游：
#   去重会拿它当正常档参与比较，召回会把它当有内容的档注入。
#   宁可标 sparse 让下游跳过它，也不要造假。

















# ═══════════════════════════════════════════════════════════════════
# 九、段 → 情景档（设计 1.1 字段表）
# ═══════════════════════════════════════════════════════════════════









# ═══════════════════════════════════════════════════════════════════
# 十、多会话：分组 + 全量聚合（设计 2.0b，问题6 的修复）
#
# 为什么必须隔离：
#   私聊里聊「做饭」，群里也聊「做饭」→ 会聚成同一条情景档
#   → 之后私聊问「上次做饭」，可能召回群里的事 → 完全错位。
# ═══════════════════════════════════════════════════════════════════



def group_by_session(mems: list) -> dict:
    """按 session_id 分组。没有 session_id 的老数据进 'legacy' 组。"""
    groups: Dict[str, List[Any]] = {}
    for m in (mems or []):
        sid = _attr(m, "session_id", None) or LEGACY_GROUP
        groups.setdefault(str(sid), []).append(m)
    return groups


def aggregate_all(session_groups: dict,
                  known_sources: Optional[dict] = None) -> list:
    """{session_id: [mems]} → 所有情景档（dict 列表，可直接 save_episode）。

    每个会话独立聚合，一个会话炸了不影响别的（aggregate_session_safe）。

    known_sources: {档 mem_id: set(它的 source_turns)}。
      传了它，聚合才会校验「带标记的碎片是不是真的被那条档记着」——
      否则一个坏标记就能让碎片永久退出聚合（实测死锁，见 aggregate_session）。
      巩固流程应该传（它有全库视野）；单次脚本可以不传。
    """
    all_episodes: List[dict] = []
    for sid, mems in (session_groups or {}).items():
        all_episodes.extend(build_episodes(sid, mems, known_sources))
    return all_episodes


# ═══════════════════════════════════════════════════════════════════
# 十一、打标记（设计 2.5，问题1）
#
# 结论：标记，不删除。
#   删除 → source_turns 指向的原文没了，不能回溯，而且不可逆
#   不标记 → 3 天内碎片还会被召回，跟情景档重复
#   标记 → 既能回溯，又能去重
# 存储成本：50 条/天 × 300 字 ≈ 15KB/天，3 天窗口稳定在 ~45KB，可忽略。
# ═══════════════════════════════════════════════════════════════════



# ═══════════════════════════════════════════════════════════════════
# 十二、保存（设计 7.1，问题11）
#
# 核心：embedding 算不出来也必须存。
#   情景档的价值是「那天发生了什么」，向量只是召回加速器。
#   ollama 挂了就把 embed_status 标成 failed，巩固任务里的 embed_healed 会补。
# ═══════════════════════════════════════════════════════════════════

















# ═══════════════════════════════════════════════════════════════════
# 十三、生命周期参数 / 统计（给 decay_logic 和 memory_cli 用）
# ═══════════════════════════════════════════════════════════════════





# ═══════════════════════════════════════════════════════════════════
# 十三·B、清理：同主题、同会话、窗口内最多保留 N 条
#
# 出处：设计 6.2（问题16 的修复 —— 避免 O(n²)）。设计原文照抄：
#
#     def cleanup_episodes(episodes, keep_days=30, keep_per_theme=10):
#         """清理：同主题、同会话、30 天内最多保留 N 条。"""
#         buckets = defaultdict(list)
#         for ep in episodes:
#             key = (ep.get('session_id'), ep.get('scene', {}).get('theme'))
#             buckets[key].append(ep)
#         to_cold = []
#         for key, group in buckets.items():
#             if len(group) <= keep_per_theme:
#                 continue
#             group.sort(key=lambda e: e.get('create_time', 0), reverse=True)
#             to_cold.extend(group[keep_per_theme:])
#         return to_cold
#
#     「复杂度：O(n log n)，900 条 = 约 9000 次操作，可接受。」
#
# ── 按原文实现时发现设计有**两处内部矛盾**，必须记下来 ──
#
# 【矛盾一】keep_days 是死参数。
#   上面这段代码里 keep_days 一次都没用到 —— 收下参数、然后无视它。
#   也就是说「30 天内」这个限定词在实现里根本不存在：
#   它会把 200 天前的老档也拿来跟今天的档一起排队挤名额。
#   本实现按注释的意图补上了窗口过滤，但这跟代码字面不同，要设计确认。
#
# 【矛盾二】6.2 和 6.3 互相打架。
#   6.3 原文：「今天做饭 → 1 条 / 明天做饭 → 1 条 / 30 天 → 30 条」
#            「判断：这是对的，不是 bug」「本来就是两个不同的事件」
#   6.2 原文：「同主题 30 天内最多保留 10 条」
#   → 6.3 说 30 天 30 条是对的，6.2 说最多 10 条。
#     严格执行 6.2 会删掉 20 条 6.3 认为正确的记录。
#
#   实测当前数据（17 条，日均 8.5 条）推演 90 天 ttl 拉满：
#     「睡」  每天 2.5 条 → 90 天内约 225 条
#     「闲聊」每天 2.5 条 → 90 天内约 225 条
#   阈值 10 意味着这两类**每天都要删掉 2~3 条当天的真实经历**。
#   那不是清理，那是持续丢弃。
#
#   ⇒ 本实现默认**不删**（apply=False）。只报告「按设计 6.2 会删什么」。
#     等 6.2/6.3 的矛盾裁决掉再放开。
#     理由：删不可逆；报错能重来，删错不能。
#
# ── 复杂度（照原文保留）──
#   分桶 O(n)，桶内排序 O(k log k)，合计 O(n log n)。
#   900 条 ≈ 9000 次操作。
# ═══════════════════════════════════════════════════════════════════











# ═══════════════════════════════════════════════════════════════════
# 十三·C、按「重复」去重（2026-11-08 裁决，取代 6.2 的条数上限）
#
# ── 为什么废掉 6.2 的「同主题 30 天内最多 10 条」──
#
# 设计 6.2 原文那条规则有两个问题，都是实测发现的：
#
# 【问题一】它跟 6.3 直接打架。
#   6.3 原文：「今天做饭 → 1 条 / 明天做饭 → 1 条 / 30 天 → 30 条」
#            「判断：这是对的，不是 bug」「本来就是两个不同的事件」
#   6.2 原文：「同主题 30 天内最多保留 10 条」
#   → 严格执行 6.2，30 天 30 条里要删掉 20 条，删的正是 6.3 说「这是对的」那些。
#
# 【问题二】在持续数据上是「每天丢弃今天」，不是「清理历史」。
#   实测（17 条，日均 8.5 条）推演 90 天 ttl 拉满：
#     「睡」  每天 2.5 条 → 90 天内约 225 条
#     「闲聊」每天 2.5 条 → 约 225 条
#   阈值 10 碰上每天 2.5 条 = **每天都要删掉 2~3 条当天的真实经历**。
#   初衷是解决「库只涨不降」，结果变成了反方向的错。
#
# ── 真正的冗余是什么 ──
#
# 实测：11-07 23:50「睡」和 11-07 23:52「睡」，相似度 0.798。
#   它们不是「两次不同的睡」，是**同一件事被分段切成了两条**
#   （23:52 那条内容里有「还没搞完呢…接着弄」—— 属于同一个深夜场景）。
#   同一批真实数据里，「18:31 睡」和「23:50 睡」相似度也是 0.798，
#   但那两条确实是两个不同时段的事。
#
#   ⇒ 光凭相似度还分不开这两类，必须再加「时间接近」：
#     同一件事被切开的碎片，时间差是秒~分钟级；
#     不同次经历的时间差是小时~天级。
#
# ── 新判据（三条同时满足才算重复）──
#
#   ① 相似度 >= DEDUPLICATION_SIM_THRESHOLD (0.78)
#   ② 时间差 < EPISODE_DEDUP_MAX_GAP_SECONDS (1 小时)
#   ③ 保留**更完整**的那条，删另一条
#
#   为什么 ② 用 1 小时：分段的时间断层阈值是 600 秒（10 分钟）。
#   能被切成两条的同一件事，通常跨过一次 10 分钟安静期；
#   一小时是它的 6 倍，留了足够余量，又不至于把「上午一次下午一次」误判成重复。
#
#   为什么 ③ 是「更完整」而不是「更早」：
#   碎片被切开时，通常一条含动作描写、一条只有应答。
#   留更完整的那条 = 保留信息量大的，丢掉信息量小的。
#   「更完整」的排序键：(source_turns 条数, content 字数)，都相同才看时间（留早的）。
#
# ── 复杂度 ──
#   按时间排序后只跟「窗口内」的邻居比较（滑动窗口），
#   平均 O(n·w)，w 是一小时内的档数（实测个位数）。
#   不是 O(n²) —— 900 条也不会爆。
# ═══════════════════════════════════════════════════════════════════

try:
    from config import EPISODE_DEDUP_MAX_GAP_SECONDS
except Exception:
    EPISODE_DEDUP_MAX_GAP_SECONDS = 3600   # 1 小时：超过这个差就不算「同一件事被切开」










# ═══════════════════════════════════════════════════════════════════
# 十三·D、引用完整性自检（2026-11-08，夜巡 episode_integrity 的官方入口）
#
# 为什么这东西必须放在 episode 模块里、而不是让下游自己拼：
#   「碎片和档的对应关系」是 episode 的内部不变量。
#   下游（夜巡 / CLI / 巩固）各自拼一套判断，就会出现三套标准、三种结论。
#
# 它是怎么来的（真实事故）：
#   175 条档都在、source_turns 非空、没有孤儿 —— 所有表面指标正常。
#   只有一个数字对不上：短期层 11 条打了 ep_..._8d8c 的标，
#   而这条档的 source_turns 只记了 4 条。
#   如果没人去数那个 11 和 4，它就永远是对的。
#
#   根因：id 的 seed 含 session_id，session 补字段后同一批碎片算出第二个 id，
#   两轮都落库 → 碎片指着旧的，旧档的 source_turns 停在第一轮。
#
# 四类问题，缺一不可：
#   orphans   碎片指向的档不存在      → 那段对话永远不会再被聚合，会静默丢失
#   missing   档漏记了指向它的碎片    → source_turns 不能完整回溯，判重也会重复
#   dup_refs  同一条碎片被多条档引用  → 同一件事在库里存了两遍
#   stale     档引用的碎片已不在短期层 → 回溯断链（ttl 清理后会自然发生，属正常）
# ═══════════════════════════════════════════════════════════════════





# ═══════════════════════════════════════════════════════════════════
# 十四、自检（不依赖真实数据，5 秒内跑完）
#
# 这里同时验证「字段不是死的」：第 ⑫ 条特意把带 episode_id 的碎片
# 序列化成 JSON 再读回来，确认标记过得去磁盘 —— 这是今天踩过的坑
# （内存里打了标，重读后字段消失，第二天重复聚合）。
# ═══════════════════════════════════════════════════════════════════





# ═══════════════════════════════════════════════════════════════════
# 十五、读取侧（2026-11-08 R1）
#
# 背景：上面 19 个函数**全是写入侧**（聚合 → 转档 → 落盘 → 打标）。
#   结果 11 条档躺在 active.json 里，**永远召不回来**：
#     · 没有代码判断「这一轮该不该想起某段经历」
#     · 没有代码把档变成注入文本
#     · 没有去重（同一段经历可能被召两次，或者档和碎片同时进 prompt）
#
# 这一节补的就是「读回来」的那一半。设计 5.1 / 5.2 / 5.3。
#
# ⚠️ 这里只做**纯数据判定 + 文本渲染**，不做向量计算、不 import recall_engine。
#    理由见 2.3 红线②：召回路径是 L3 的事，硬塞进 L2 模块会把边界打穿。
#    这三个函数返回的都是「该不该 / 怎么拼」，具体召回由 memory_cli / recall_engine 做。
# ═══════════════════════════════════════════════════════════════════




# 同批次去重阈值：跟长期库去重共用同一个数，不新开参数。
#   DEDUPLICATION_SIM_THRESHOLD = 0.78（config 里注释写明：实测同义句落在 0.75~0.85）
# 为什么复用而不是调低：0.78 是「基本是同一件事」的实证阈值；
#   调低会把「11-07 做饭」和「11-07 吃饭」当重复合并 —— 那是两件事，不是重复。
try:
    from config import DEDUPLICATION_SIM_THRESHOLD as EPISODE_INJECT_DEDUP_SIM
except Exception:
    EPISODE_INJECT_DEDUP_SIM = 0.78










# ═══════════════════════════════════════════════════════════════════
# 注入侧「同批次去重」（2026-11-08，泛化磁铁）
#
# 为什么需要：实测 11 条情景档 55 对，余弦中位 0.683、最大 0.843，
#   其中 7 对已经超过 DEDUPLICATION_SIM_THRESHOLD(0.78)。
#   情景档又有个 45 分的衰减地板（decay_logic），强度永远不低，
#   配 RECALL_TOP_K=5 —— 一次召回混进 3 条高度相似的档是常态，
#
# 为什么放在「注入」而不是「召回」：
#   召回候选集是所有下游共用的（联想链、RRF 融合都会读），
#   在那里去重等于悄悄改变别人的输入。注入是最后一公里，
#   在这儿去重：影响面最小、可解释、出问题能一眼定位。
#
# 为什么复用 0.78 而不新开参数：
#   同一个概念（多像算重复）不该有两套阈值。多一个参数就多一处会漂的地方。
# ═══════════════════════════════════════════════════════════════════

def _cosine(vec1, vec2) -> float:
    """余弦相似度 0~1；长度不匹配 / 空 / 零向量一律返回 0.0。

    为什么在这里重写一遍而不 import recall_engine：
        episode 是 L2，recall_engine 是 L3 —— import 它就把依赖方向弄反了
        （recall_engine 的上游会回头 import 我，成环）。
    语义跟 recall_engine.cosine_similarity **逐条对齐**：
      长度不等 → 0；任一侧范数为 0 → 0；结果负数钳到 0。
    """
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    n1 = math.sqrt(sum(a * a for a in vec1))
    n2 = math.sqrt(sum(b * b for b in vec2))
    if n1 == 0 or n2 == 0:
        return 0.0
    return max(0.0, dot / (n1 * n2))


def _embedding_of(ep) -> list:
    """取档的向量。拿不到 / 全零 → 返回 []（表示「判不了相似度」）。"""
    vec = _attr(ep, "embedding", None)
    if not vec:
        return []
    try:
        if not any(float(x) != 0.0 for x in vec):
            return []
        return list(vec)
    except (TypeError, ValueError):
        return []












# ── 兼容入口（2026-11-09）──────────────────────────────────
# selftest 已搬到 tests/test_episode_selftest.py。
# 但很多地方习惯 `python episode.py` 做自检，所以这里保留一个转发。
if __name__ == "__main__":
    import runpy
    import os as _os
    _p = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                       "tests", "test_episode_selftest.py")
    if _os.path.exists(_p):
        runpy.run_path(_p, run_name="__main__")
    else:
        print("selftest 已搬到 tests/test_episode_selftest.py（文件不存在）")
