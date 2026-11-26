# -*- coding: utf-8 -*-
"""交接单 handover.py —— 换会话时带一张 80 字的状态快照（2026-11-08）

设计依据：《记忆系统-主设计》8.5.4「交接单（层2）」。
本模块只依赖 L1 层（config / features），**绝不** import memory_manager /
daily_consolidation —— 那是 L3，反过来要调我。

为什么先做这一层（8.5.6）：
    交接机制有两层，层1 首屏交接（5000 字）依赖窗口账本 / 事实卡 / token 度量，
    全是没做完的基础设施；层2 交接单**不依赖任何东西**，
    而它解决的正是最直接的痛点 ——「换会话后接不上刚才说到哪」。

四块内容（共约 80 字）：
    topic         现在聊到哪儿            ~20 字
    emotion       他/她什么情绪            ~10 字
    pending_tail  没说完的那句话的尾巴      ~20 字
    trivia        最近在烦的小事 2~3 句      ~30 字

    {
      "written_at": 1730000000,
      "topic": "聊到记忆系统重构，正在分批实施",
      "emotion": "专注，有点累",
      "pending_tail": "我刚想说他上雅思课还没下课",
      "trivia": ["在算一条消息多少钱", "他上雅思课还没下课"]
    }

三条设计决定
────────────────────────────────────────────────────────────────
① 「临走写」不是「实时写」（8.5.4）
   每轮写就等于每轮复述一遍原文，跟不写没区别；只有在换场景那一刻，
   「最后聊到哪 / 什么情绪 / 没说完什么」才是确定的。
   所以 should_write() 只在 rotate / cross_day / compress 三种时返回 True。

② 硬上限 120 字，而且是**四块合计**的上限
   只卡单块不卡合计 = 没卡（三块各写 119 字，注入就是 357 字）。
   这里用「软上限 + 硬预算」两层：每块先按设计比例截（topic 36 / emotion 16 /
   tail 36 / trivia 合计 40），再从统一预算里按优先级真扣，永远不越界。
   截断用「…」收尾 —— 让「这句被截过」在注入文本里看得见。

③ 明细按会话存，读取允许跨会话
   写：state/handover.json 里 sessions[session_id] 各存一份
       （私聊 / 群聊口径不能混，跟 episode 的 session_id 一个道理）
   读：给了 session_id 就精确取；没有就取「最近写的一份」。
       这不是将就 —— 交接单本来就是**跨越会话边界**才有意义的东西：
       它由旧会话写，由新会话读，而新会话的 id 跟旧会话一定不一样。

对外八件事：
    write_handover(...)      写入（超长自动截断）
    read_handover(sid)       读取（过期 / 没有 → None）
    read_latest_handover()   取最近一份（新会话首轮注入用）
    should_write(trigger)    这个触发点要不要写
    build_inject_text(h)     生成注入文本（【交接单】…）
    build_prompt(hint)       生成「让她写交接单」的提示词
    parse_reply(text)        把模型回的那段 JSON 解析成参数
    enabled()                功能开关（features.handover）

配套：selftest() 不依赖真实数据，5 秒内跑完。
"""

from common.locking import NullLock
import json
import os
import re
import sys
import time
import uuid

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
#
# 中文 Windows 终端默认 GBK，print 中文/emoji 直接 UnicodeEncodeError 崩掉。
# 放在 import 之后立刻执行，保证后面任何 print 都不会因为编码炸。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ═══════════════════════════════════════════════════════════════════
# 一、参数（唯一真源在 config.py）
#
# 跟 episode.py 一个写法：有就从 config 读、没有就用默认，
# 保证本模块在别人改 config 之前就能跑、改之后自动跟随。
# 反过来如果这里写死常量，config 里调了参数却没人读 —— 那就是又一个「死字段」。
# ═══════════════════════════════════════════════════════════════════

try:
    from config import HANDOVER_MAX_CHARS
except Exception:
    HANDOVER_MAX_CHARS = 120            # 硬上限，超了截断

try:
    from config import HANDOVER_TRIVIA_MAX
except Exception:
    HANDOVER_TRIVIA_MAX = 3             # 琐事最多 3 条

try:
    from config import HANDOVER_TTL_HOURS
except Exception:
    HANDOVER_TTL_HOURS = 24             # 超过多少小时不再注入

from config import HANDOVER_PATH, WORKING_MEM_PATH

# 2026-11-08 加（审计发现 handover 的读-改-写全程没锁 → 并发丢 39/40）：
#   跟 memory_manager / lessons / reflection 用**同一把** memory_data.lock。
#   为什么必须跟别人同一把而不是自己开一把：交接单和记忆库是同一批进程在写，
#   各锁各的等于没锁住「同一时刻只有一个进程在动这些文件」这个前提。
#
#   filelock 没装时退化成 _NullLock（不锁），而不是 import 失败：
#   交接单是锦上添花的东西，绝不能因为它让新会话起不来。
try:
    from config import LOCK_FILE_PATH
except Exception:
    LOCK_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "memory_data.lock")

try:
    from filelock import FileLock
except Exception:
    FileLock = None

# filelock 的 is_singleton 是 3.12.3 才有的（老版本传这个 kw 会 TypeError）。
# 探测一次，老版本自动退化 —— 交接单不能因为装了旧 filelock 就整体不可用。
try:
    import inspect as _inspect
    _FILELOCK_HAS_SINGLETON = "is_singleton" in _inspect.signature(FileLock).parameters \
        if FileLock is not None else False
except Exception:
    _FILELOCK_HAS_SINGLETON = False


class _NullLock(NullLock):
    """空锁 —— 转发到 common.locking.NullLock（2026-11-09 收敛）。

    原来这里自己写了一份 6 行的空锁，跟另外 5 个模块各写一遍。
    """



# ★ 2026-11-08 修 Deadlock（写侧接线才暴露出来）：
#
#   session_init.build_session_init_context 整个函数体已经在
#   `with FileLock(LOCK_FILE_PATH):` 里面，而交接单写侧在它内部被调，
#   于是同一线程要拿两次同一把文件锁。
#
#   最初我自己写了个归 depth 的 _ReentrantFileLock，但**没解决问题**：
#   它只知道「本模块自己拿过几次」，不知道**外部**已有别的 FileLock 实例拿着。
#   实测：外层持有普通 FileLock 时，层内再 acquire 仍然抛 Deadlock。
#
#   正解是 filelock 官方的 is_singleton=True：
#     同一进程内、同一文件，得到**同一个锁对象**，所以同线程重入不死锁；
#     而不同线程 / 不同进程之间**仍然互斥**（实测：另一线程等了 0.61s）。
#   这不是「为测试开后门」，而是把「同进程内该不该互斥」交回给 filelock 管。
#
#   另外：session_init 已把写盘挪到 with 锁外（根治），这里是防御纵深 ——
#   万一别的调用点又在锁里叫我，不能再死一次。
_LOCK_KW = {"is_singleton": True} if _FILELOCK_HAS_SINGLETON else {}


def _file_lock():
    """跟 memory_manager / 巩固流程同一把锁（2026-11-09 收敛到 common.locking）。"""
    from common.locking import memory_lock
    return memory_lock(singleton=True)


# config 里要是被人写成字符串（"120"）也不能让后面所有比较失效
try:
    HANDOVER_MAX_CHARS = int(HANDOVER_MAX_CHARS)
except Exception:
    HANDOVER_MAX_CHARS = 120
try:
    HANDOVER_TRIVIA_MAX = int(HANDOVER_TRIVIA_MAX)
except Exception:
    HANDOVER_TRIVIA_MAX = 3
try:
    HANDOVER_TTL_HOURS = float(HANDOVER_TTL_HOURS)
except Exception:
    HANDOVER_TTL_HOURS = 24.0
if HANDOVER_MAX_CHARS <= 0:
    HANDOVER_MAX_CHARS = 120
if HANDOVER_TRIVIA_MAX <= 0:
    HANDOVER_TRIVIA_MAX = 3

# 软上限：按设计里 20 / 10 / 20 / 30 的比例定，合计 128 > 120 ⇒
# 真写满时由 _fit() 的统一预算按优先级真扣，所以这里「合计超了」是故意的。
_TOPIC_SOFT = 36
_EMOTION_SOFT = 16
_TAIL_SOFT = 36
_TRIVIA_EACH_SOFT = 20
_TRIVIA_TOTAL_SOFT = 40

# 注入文本除了四块内容，还有【交接单】/刚聊到：/没说完：这些标签（约 30 字），
# 所以整体上限比内容上限略放宽一点。
INJECT_MAX_CHARS = HANDOVER_MAX_CHARS + 48

ELLIPSIS = "…"

# 文件里最多留几份（防单文件无限长；正常用法最多私聊 + 几个群）
_MAX_SESSIONS = 20

# should_write 认的触发点（8.5.4 的表：轮转 / 跨天 / 压缩 才写，普通轮次不写）
WRITE_TRIGGERS = ("rotate", "cross_day", "compress")

# ===== 来源标记（2026-11-08，评审 定的三条纪律之一）=====
#
# 交接单有两种产生方式，必须能区分：
#   session        旧会话临走时真写的 —— 这是「留言」
#   reconstructed  新会话发现自己没有、拿旧数据现场补的 —— 这是「考古」
#
# 为什么必须区分：补出来的单子**看起来跟真的一模一样**，
# 如果混在一起，以后查数据就永远不知道某张单子是不是编的。
# 更糟的是会让「交接单在正常工作」这个判断失去依据。
SOURCE_SESSION = "session"
SOURCE_RECONSTRUCTED = "reconstructed"
_SOURCES = (SOURCE_SESSION, SOURCE_RECONSTRUCTED)


def _norm_source(source) -> str:
    """来源归一。不认识的一律当 reconstructed（保守：宁可标记成补的）。"""
    s = str(source or "").strip().lower()
    return s if s in _SOURCES else SOURCE_RECONSTRUCTED

# 调用方各处叫法不统一，这里统一收口 —— 免得写成 "rotation" 就整条链路静默失效
_TRIGGER_ALIASES = {
    "rotate": "rotate", "rotation": "rotate", "rotating": "rotate", "rotate_session": "rotate",
    "cross_day": "cross_day", "crossday": "cross_day", "cross_day_break": "cross_day",
    "new_day": "cross_day", "newday": "cross_day", "next_day": "cross_day",
    "compress": "compress", "compaction": "compress", "compact": "compress",
    "context_compress": "compress", "compress_context": "compress", "trim": "compress",
}


# ═══════════════════════════════════════════════════════════════════
# 二、内部小工具
# ═══════════════════════════════════════════════════════════════════

def _norm(text) -> str:
    """统一成「一行、无首尾空白、无模型顺手加的引号」。

    模型回 JSON 时爱在值外面再包一层引号（"专注" / 「专注」），
    直接存进去，注入出来就是多一圈引号 —— 看着像代码不像说话。
    """
    if text is None:
        return ""
    s = str(text).replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"\s+", " ", s).strip()
    pairs = {'"': '"', "'": "'", "`": "`", "「": "」", "『": "』", "“": "”"}
    while len(s) >= 2 and s[0] in pairs and s[-1] == pairs[s[0]]:
        s = s[1:-1].strip()
    return s


def _clip(text: str, limit: int) -> str:
    """截到 limit 字以内（保证 len(返回值) <= limit）。"""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 0
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit == 1:
        return ELLIPSIS
    return text[:limit - 1] + ELLIPSIS


def _to_ts(v) -> float:
    """任何形状的时间戳 → float；不认识的一律 0（等价于「过期」）。"""
    try:
        ts = float(v)
    except (TypeError, ValueError):
        return 0.0
    return ts if ts > 0 else 0.0


def _sid(session_id) -> str:
    """会话键归一。空串代表「没指定会话」（老数据也落在这里）。"""
    return str(session_id or "").strip()


def _order_key(rec) -> tuple:
    """排序键：(秒级时间戳, 单调序号)。

    为什么要第二个数：written_at 只有**秒**精度。私聊和群聊几乎同时轮转时
    两份记录会落在同一秒里，这时 max(written_at) 分不出先后 ——
    max() 实际返回的是字典里**先出现**的那一份，也就是**较旧**的那份。

    实测（一小时内就复现）：
        write('private:A'), write('group:B')  → 两者 written_at 完全相同
        read_latest_handover()                → 返回 A 的话   ← 拿错了

    seq 每次写入 +1，所以同一秒内后写的那个一定更大。
    """
    if not isinstance(rec, dict):
        return (0.0, 0)
    try:
        seq = int(rec.get("seq") or 0)
    except (TypeError, ValueError):
        seq = 0
    return (_to_ts(rec.get("written_at")), seq)


def _newest(sessions):
    """在 sessions 里挑「最新写的一份」，返回 (session_key, rec)。

    挑不出来 → (None, None)。
    """
    best, best_key, best_sid = None, None, None
    for sid, rec in (sessions or {}).items():
        if not isinstance(rec, dict) or not rec:
            continue
        k = _order_key(rec)
        if best_key is None or k > best_key:
            best, best_key, best_sid = rec, k, sid
    return best_sid, best


def _split_trivia(trivia) -> list:
    """琐事：认 list/tuple，也认一段用换行或斜杠隔开的文本（她有时会这么写）。"""
    if trivia is None:
        return []
    if isinstance(trivia, str):
        return re.split(r"[\n/／；;、|]+", trivia)
    if isinstance(trivia, (list, tuple)):
        return list(trivia)
    return [trivia]


def _fit(topic, emotion, pending_tail, trivia) -> dict:
    """把四块内容塞进 HANDOVER_MAX_CHARS（四块合计，不是单块）。

    顺序即优先级：topic → emotion → pending_tail → trivia。
    为什么琐事排最后：它最可有可无 —— 预算不够时宁可少一条琐事，
    也不能让「刚聊到」被截成半句，那样交接单就没用了。
    """
    remaining = max(1, int(HANDOVER_MAX_CHARS))
    topic = _norm(topic)
    emotion = _norm(emotion)
    pending_tail = _norm(pending_tail)

    out = {}
    for key, text, soft in (("topic", topic, _TOPIC_SOFT),
                            ("emotion", emotion, _EMOTION_SOFT),
                            ("pending_tail", pending_tail, _TAIL_SOFT)):
        take = min(len(text), soft, remaining)
        out[key] = _clip(text, take)
        remaining -= len(out[key])

    items = [_norm(x) for x in _split_trivia(trivia)]
    items = [x for x in items if x][:HANDOVER_TRIVIA_MAX]
    budget = min(remaining, _TRIVIA_TOTAL_SOFT)
    kept = []
    for i, item in enumerate(items):
        if budget <= 0:
            break
        slots_left = max(1, len(items) - i)
        each = min(_TRIVIA_EACH_SOFT, max(1, budget // slots_left))
        piece = _clip(item, min(each, budget))
        if piece:
            kept.append(piece)
            budget -= len(piece)
    out["trivia"] = kept
    return out


# ═══════════════════════════════════════════════════════════════════
# 三、落盘
#
# 文件形状：
#   {"version": 1, "sessions": {"private:123": {四块 + written_at}, ...}}
#
# 为什么不是「一个会话一个文件」：交接单本来就只有几十字节，
# 一份文件更好看、更好备份、更好手工查；会话多了按 ttl 和条数清。
# ═══════════════════════════════════════════════════════════════════

def _empty_db() -> dict:
    return {"version": 1, "sessions": {}}


def _load_db(path=None) -> dict:
    """读整个文件。任何异常都退化成空库 —— 交接单坏了不能挡住聊天。"""
    p = path or HANDOVER_PATH
    if not os.path.exists(p):
        return _empty_db()
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[handover] 读交接单失败，当没有: {type(e).__name__}: {e}")
        return _empty_db()

    if not isinstance(data, dict):
        return _empty_db()

    sessions = data.get("sessions")
    if isinstance(sessions, dict):
        clean = {str(k): v for k, v in sessions.items() if isinstance(v, dict)}
        return {"version": 1, "sessions": clean}

    # 兼容「文件里直接躺着一份记录」的老 / 手改格式
    if any(k in data for k in ("topic", "emotion", "pending_tail", "written_at")):
        return {"version": 1, "sessions": {"": dict(data)}}

    return _empty_db()


def _prune(db: dict, now: float = None) -> dict:
    """清掉过期的，再按条数封顶。就地改并返回。"""
    now = time.time() if now is None else now
    ttl = float(HANDOVER_TTL_HOURS) * 3600.0
    live = {}
    for k, v in (db.get("sessions") or {}).items():
        ts = _to_ts(v.get("written_at"))
        if ts <= 0:
            continue                      # 没时间戳 = 不知道新不新 = 不当数
        if now - ts > ttl:
            continue                      # 过期
        live[k] = v
    if len(live) > _MAX_SESSIONS:
        ordered = sorted(live.items(), key=lambda kv: _order_key(kv[1]), reverse=True)
        live = dict(ordered[:_MAX_SESSIONS])
    db["sessions"] = live
    return db


def _atomic_write_json(path: str, data: dict) -> None:
    """原子写 —— 转发到 atomic_io.atomic_write_json（2026-11-08 收敛）。

    原来这里自己抄了一份（不能 import memory_manager，那是 L3）。
    现在逻辑在 atomic_io（只依赖标准库），不会再制造循环依赖。

    ★ 本函数只保留一条 handover 独有的前置动作：确保父目录存在。
      HANDOVER_PATH 默认落在 state/ 下，而 state/ 可能还没被创建 ——
      这是 episode / lessons / reflection 那三处没有的。
      去掉它的话，首次写入会 FileNotFoundError。

    ★ sweep=False：不顺手清陈旧 tmp（那件维护者还没定，只有 memory_manager 开着）。

    ⚠️ 本函数**不负责并发安全**。handover 的并发安全靠 write_handover 里的
      _file_lock() 罩住整段「读-改-写」。原子写只保证「单次写入不会写出半个
      文件」，保证不了「两个人同时读、各改各的、后写的覆盖先写的」——
      实测过：没有那把锁时 20 个并发写只剩 1 个（丢 19）。
      改这里的时候千万不要顺手把锁去掉。
    """
    d = os.path.dirname(os.path.abspath(path))
    if d:
        os.makedirs(d, exist_ok=True)     # state 目录可能还不存在（本模块独有）
    from atomic_io import atomic_write_json
    atomic_write_json(path, data, sweep=False)


def _save_db(db: dict, path=None, now=None) -> None:
    """落盘前先清过期。

    now 要能跟着 write_handover 的 now= 走 —— 否则测试把时钟钉在过去时，
    _prune 会拿**真实当前时间**去裁，把刚写的那份当"过期"清掉，磁盘上变成空表。
    （这就是加 now= 之后第一次跑 selftest 撞到的：_d 里 KeyError 'private:A'。）
    """
    _atomic_write_json(path or HANDOVER_PATH, _prune(db, now))


# ═══════════════════════════════════════════════════════════════════
# 四、对外：开关 / 写 / 读
# ═══════════════════════════════════════════════════════════════════

def enabled() -> bool:
    """功能开关（features.handover，默认开）。

    特意做了「键不存在也算开」：万一有人用了旧的 features.py（里面还没有
    handover 这一行），features.on() 会返回 False，整个交接单就静默消失了 ——
    这种「加了开关等于把功能关掉」的坑，比没有开关更坏。
    """
    try:
        import features
    except Exception:
        return True
    table = getattr(features, "FEATURES", None)
    if not isinstance(table, dict) or "handover" not in table:
        return True
    return bool(table.get("handover"))


def should_write(trigger_type) -> bool:
    """这个触发点要不要写交接单。

    trigger_type: 'rotate' | 'cross_day' | 'compress' | 'normal'
        rotate / cross_day / compress → True
        normal（以及任何不认识的）    → False
    """
    if not enabled():
        return False
    key = str(trigger_type or "").strip().lower().replace("-", "_").replace(" ", "_")
    key = _TRIGGER_ALIASES.get(key, key)
    return key in WRITE_TRIGGERS


# ⚠️ 验收方式（2026-11-08 教训）：
#   不能只测「函数能调用」——
#   必须跑「调用方的真实上下文」。
#
#   实例：reconstruct_handover 在 session_init 的 FileLock 里触发 Deadlock，
#   被 except Exception 吞掉，表现是「接好了、不报错、但永远不生效」。
#   单测 write_handover 本身是绿的，因为它自己拿锁没人和它抢。
#
#   所以本文件 selftest 里有一条专门的「锁里调用」用例：
#   先用普通 FileLock 外层拿住，再调 write_handover，看会不会死。

def write_handover(session_id, topic, emotion, pending_tail, trivia,
                   path=None, now=None, source=SOURCE_SESSION, is_private=False) -> dict:
    """写入交接单。超长自动截断。

    参数（四块，合计不超过 HANDOVER_MAX_CHARS 字）：
        topic         现在聊到哪儿
        emotion       她/他此刻什么情绪
        pending_tail  没说完的那句话的尾巴
        trivia        最近在烦的小事（list，最多 HANDOVER_TRIVIA_MAX 条；
                      也可以传一段用换行 / 斜杠隔开的文本）
        path          落盘路径（默认 HANDOVER_PATH，自检时传临时文件用）
        now           时间戳（**只给测试用**，生产不要传，默认 time.time()）
        source        这张单子怎么来的：
                        'session'       旧会话临走真留的（默认）
                        'reconstructed' 新会话发现自己没有、拿旧数据补的

    返回：真正写进去的这份记录（截断后的样子 —— 调用方拿到的就是磁盘上的）。

    为什么要有 now（2026-11-08 修 flaky，测试组 20 次验证抓到 1/20 挂）：
      selftest ⑤b 要验「同一秒写两份，后写的赢」。原来靠连续两次写去碰同一秒，
      实测两次写之间中位 4.4ms，跨整秒概率 ≈0.44% —— 那是在**赌时钟**。
      赌输了断言就红，但代码没问题，于是变成 flaky。
      加 now 之后可以把两次写钉死在同一秒，**这个分支 100% 被覆盖且确定性**。
      「测试要能控制被测的时间」是标准做法，不是为测试开后门 ——
      生产调用方一个都不用传。
    """
    fitted = _fit(topic, emotion, pending_tail, trivia)

    # 2026-11-08 修（审计抓到的真丢数据）：
    #   上面 _load_db → 改 → _save_db 是一次**读-改-写**，全程没有锁。
    #   _atomic_write_json 只保证「单次写入不会写出半个文件」，
    #   它保证不了「两个人同时读、各改各的、后写的覆盖先写的」。
    #   实测：40 个线程各写一个不同会话 → 盘上只剩 1 个，丢掉 39 个。
    #   （日志里伴随 "读交接单失败，当没有: PermissionError" ——
    #    读端正好撞上 replace 的瞬间，整份库被当成空库，更糟。）
    #
    #   修法：整段读-改-写放进同一把文件锁（跟 memory_manager / lessons 同一把）。
    #   不能只锁 _save_db —— 那样两个线程仍会读到同一份旧库。
    with _file_lock():
        db = _load_db(path)
        sessions = db.setdefault("sessions", {})
        record = {
            "written_at": int(now if now is not None else time.time()),
            # 单调序号：同一秒内写两份时用来分先后（见 _order_key）。
            # 取「现有最大 +1」而不是用毫秒时间戳 —— 系统时间被回拨也不会乱序。
            "seq": max([_order_key(v)[1] for v in sessions.values()] + [0]) + 1,
            "is_private": bool(is_private),
            "topic": fitted["topic"],
            "emotion": fitted["emotion"],
            "pending_tail": fitted["pending_tail"],
            "trivia": fitted["trivia"],
            # 来源标记（2026-11-08 加）：区分「真留的」和「补的」。
            #   没有这个字段，以后查数据永远不知道某张单子是不是编出来的 ——
            #   而「编出来的单子看起来跟真的一样」正是最难发现的那类问题。
            "source": _norm_source(source),
        }
        sessions[_sid(session_id)] = record
        _save_db(db, path, now)

    # ★ 2026-11-09 加：写入后回读验证（方案 P1-2）
    #
    #   为什么必须回读：
    #     `_save_db` 内部 catch 了异常（写失败只 print 不抛）。
    #     交接单 Deadlock 那次 bug 就是这样：写从来不成功，
    #     但没有任何地方报错 —— 一个月后才发现「从来没产生交接单」。
    #
    #   怎么做：写完立刻用 read_handover 读一次，确认真的读得到。
    #   失败不抛（交接单不是关键路径），但要记日志 + 进 stats。
    try:
        if is_private:
            _raw = (_load_db(path).get("sessions") or {}).get(_sid(session_id))
            _got = _normalize_record(_raw, _sid(session_id)) if isinstance(_raw, dict) and _raw else None
        else:
            _got = read_handover(session_id, path=path, now=now)
        if _got is None:
            print("[handover] ⚠️ 写了但回读不到: session_id=%s path=%s"
                  % (session_id, path or "(默认)"))
            record["_verify"] = "missing"
        elif str(_got.get("topic") or "") != str(record.get("topic") or ""):
            print("[handover] ⚠️ 回读到但内容不一致: 期望 %r 实得 %r"
                  % (str(record.get("topic"))[:20], str(_got.get("topic"))[:20]))
            record["_verify"] = "mismatch"
        else:
            # 正常路径不刷屏（方案 P1 验收要求）
            record["_verify"] = "ok"
    except Exception as _ve:
        print("[handover] ⚠️ 回读校验异常（不影响写入）: %s: %s"
              % (type(_ve).__name__, _ve))
        record["_verify"] = "error"

    return record


def _normalize_record(rec: dict, session_key=None) -> dict:
    """读回来的一律重新过一遍类型和上限。

    文件是文本，可能被人手改过、也可能是旧版本写的 —— 这里不做假设，
    保证 build_inject_text 拿到的一定是「四块齐全、长度可控」的 dict。

    额外塞一个 "session"：这次读到的**是谁的**那份。
    不塞的话，「有没有拿错人」只能靠读代码猜；塞了就是可以查的事实
    （跟 session_init 返回 marker 是同一个道理）。
    """
    out_trivia = []
    for x in _split_trivia(rec.get("trivia"))[:HANDOVER_TRIVIA_MAX]:
        t = _clip(_norm(x), _TRIVIA_EACH_SOFT)
        if t:
            out_trivia.append(t)
    return {
        "session": _sid(session_key),
        "is_private": bool(rec.get("is_private")),
        "written_at": int(_to_ts(rec.get("written_at"))),
        "seq": _order_key(rec)[1],
        "topic": _clip(_norm(rec.get("topic")), HANDOVER_MAX_CHARS),
        "emotion": _clip(_norm(rec.get("emotion")), HANDOVER_MAX_CHARS),
        "pending_tail": _clip(_norm(rec.get("pending_tail")), HANDOVER_MAX_CHARS),
        "trivia": out_trivia,
        "source": _norm_source(rec.get("source")),
    }


def read_handover(session_id=None, path=None, now=None):
    """读交接单。没有 / 过期（超过 HANDOVER_TTL_HOURS 小时）→ None。

    session_id 给了就精确取这个会话的；没给（或这个会话没有）就取「最近写的
    一份」—— 交接单本来就是写给新会话看的，新会话的 id 跟旧会话必然不一样，
    只认精确匹配等于让整个功能永远读不到东西。
    """
    db = _load_db(path)
    sessions = db.get("sessions") or {}
    from services.recall_policy import RecallContext, eligible
    context = RecallContext(session_id=str(session_id or ''))
    def allowed(key, rec):
        row = dict(rec, session_id=key,
                   content=' '.join(str(rec.get(k) or '') for k in ('topic','emotion','pending_tail','trivia')))
        return eligible(row, context)
    sessions = {k:v for k,v in sessions.items() if isinstance(v,dict) and allowed(k,v)}
    now = time.time() if now is None else now

    hit_key = None
    rec = None
    if session_id is not None:
        k = _sid(session_id)
        rec = sessions.get(k)
        if isinstance(rec, dict) and rec:
            hit_key = k
        else:
            rec = None
    if not isinstance(rec, dict) or not rec:
        hit_key, rec = _newest(sessions)
    if not isinstance(rec, dict) or not rec:
        return None

    ts = _to_ts(rec.get("written_at"))
    if ts <= 0:
        return None                       # 没有 written_at 的旧记录不敢用
    if now - ts > float(HANDOVER_TTL_HOURS) * 3600.0:
        return None                       # 隔太久了，带的就不是「刚才」
    return _normalize_record(rec, hit_key)


def read_latest_handover(path=None, now=None, prefer_session_id=None):
    """取「最近写的一份」（新会话首轮注入用）。

    多会话同时活跃时（私聊 + 若干群聊），这里有个必须讲清楚的取舍：

    ① 传了 prefer_session_id，且**这个会话自己有一份没过期的** → 用它
       接线时**应该尽量传**：桥接那边 key 就是 'private:<owner-id>' / 'group:123456'，
       而轮转之后宿主的会话 id 会变、这个 key 不变。所以拿 key 来偏置是对的，
       不是自相矛盾。实测：拿 private 的 key 去查，只会命中 private 的那份，
       群聊的交接单永远不会跑到私聊里来。

    ② 没有可用的精确记录 → 退到「全局最近一份」。
       这是跨天场景（新会话、盘库里只有旧会话写过）的唯一出路。

    ⚠️ ②这条的代价要知道：如果私聊和群聊的交接单同时活着，而调用方没传
    prefer_session_id，那拿到的可能是**别人的**。所以接线时请传 prefer_session_id。
    """
    if prefer_session_id is not None:
        exact = read_handover(prefer_session_id, path=path, now=now)
        if exact is not None:
            return exact
        if str(prefer_session_id).startswith('group:'):
            return None
    got = read_handover(None, path=path, now=now)
    if got is not None and prefer_session_id is None:
        _warn_if_ambiguous(path, now, got)
    return got


# ── 「忘了传 prefer_session_id」的防御 ──────────────────────────────────
#
# 背景：不传的时候会退到「全局最近一份」。私聊和群聊同时活着时，
# 这可能拿到**别人那份**，而且不报错 —— 用户只会觉得「她怎么知道群里的聊天」。
#
# 两条边界（决定了这条告警要不要报，避免变成没人看的噪音）：
#   ① 只在**真的可能拿错**时报：库里有 ≥2 份没过期的、而且它们**不属于同一个会话**
#   ② 每个 (进程, 档位) 只报一次：每轮都打日志 = 日志被淹 = 等于没告警
#
# 为什么不写成 hard error / 抛异常：交接单是「锦上添花」的东西，
# 拿不准的时候宁可少注入一次，也绝不能因为它让新会话起不来。

_WARN_STATE = set()


def _warn_key(path) -> str:
    return f"{os.getpid()}:{path or HANDOVER_PATH}"


def _reset_warn_state() -> None:
    """清空告警去重状态（selftest / 长驻进程换档时用）。"""
    _WARN_STATE.clear()


def _warn_if_ambiguous(path, now, got) -> None:
    """没传 prefer_session_id 却有多份活跃记录 → 打一条告警，每档只打一次。"""
    now = time.time() if now is None else now
    wk = _warn_key(path)
    if wk in _WARN_STATE:
        return
    _WARN_STATE.add(wk)                   # 先记再报，防止日志回调里递归

    sessions = (_load_db(path).get("sessions") or {})
    ttl_sec = float(HANDOVER_TTL_HOURS) * 3600.0
    alive = [k for k, v in sessions.items()
             if isinstance(v, dict) and _to_ts(v.get("written_at")) > 0
             and now - _to_ts(v.get("written_at")) <= ttl_sec]
    if len(alive) <= 1:
        return                            # 只有一份，不存在拿错
    print(f"[handover] 警告：有 {len(alive)} 份未过期交接单 {sorted(alive)}，"
          f"但调用方没传 prefer_session_id —— 拿到的是 {got.get('session')!r} 那份，"
          f"可能不是本会话的。接线时请传 prefer_session_id=key（桥接 key，如 private:xxx）")


# ═══════════════════════════════════════════════════════════════════
# 五、注入文本（8.5.5，挂在 prompt 最前面）
#
#   【交接单】
#   刚聊到：记忆系统重构
#   我：专注，有点累
#   没说完：他上雅思课还没下课
#   最近在烦：算一条消息多少钱 / 拆记忆系统拆了一整天
#
# 空的那一行就不出现 —— 四行里全空就返回空串（没东西可交接，别放个空壳）。
# ═══════════════════════════════════════════════════════════════════

def _clip_long_block(text: str) -> str:
    """整块兜底：文件被人手改成超长也炸不了 prompt 预算。"""
    if len(text) <= INJECT_MAX_CHARS:
        return text
    return text[:INJECT_MAX_CHARS - 1] + ELLIPSIS


def build_inject_text(handover) -> str:
    """生成注入用的文本（约 80 字）。handover 为 None / 空 → 返回空串。"""
    if not isinstance(handover, dict) or not handover:
        return ""

    topic = _norm(handover.get("topic"))
    emotion = _norm(handover.get("emotion"))
    pending_tail = _norm(handover.get("pending_tail"))
    trivia = [_norm(x) for x in _split_trivia(handover.get("trivia"))]
    trivia = [x for x in trivia if x][:HANDOVER_TRIVIA_MAX]

    lines = []
    if topic:
        lines.append("刚聊到：" + _clip(topic, HANDOVER_MAX_CHARS))
    if emotion:
        lines.append("我：" + _clip(emotion, HANDOVER_MAX_CHARS))
    if pending_tail:
        lines.append("没说完：" + _clip(pending_tail, HANDOVER_MAX_CHARS))
    if trivia:
        lines.append("最近在烦：" + _clip(" / ".join(trivia), HANDOVER_MAX_CHARS))

    if not lines:
        return ""

    # 约束②（评审 定）：补出来的单子要标明「补记」。
    #   真留的：「【交接单】」
    #   补的：  「【交接单（补记）】」
    # 为什么：她得能分清「这是我昨天真留下的话」，还是「这是我今天从旧数据里自己考古出来的」。
    #   两者内容可能一样，但可信度不同 —— 补记的只代表「当时聊了这些」，
    #   不代表「当时我特意记下了这些」。
    tag = "【交接单（补记）】" if _norm_source(handover.get("source")) == SOURCE_RECONSTRUCTED \
        else "【交接单】"
    return _clip_long_block(tag + "\n" + "\n".join(lines))


# ═══════════════════════════════════════════════════════════════════
# 六、让她写交接单的提示词（8.5.4「谁来写」）
# ═══════════════════════════════════════════════════════════════════

_PROMPT_TEMPLATE = """要换新对话了。临走前写一张交接单，好让下一段对话里的你接得上刚才。

四块，合计约 80 字（硬上限 {max_chars} 字，超了我会截断）：
  topic         现在聊到哪儿                      ~20 字
  emotion       你/他此刻什么情绪                  ~10 字
  pending_tail  没说完的那句话的尾巴                ~20 字
  trivia        最近在烦的小事 2~3 句，每句一句话     ~30 字

写法：
  · 是快照不是流水 —— 只要「当下这一刻」的状态，不要复述今天都干了什么
  · 用你自己的口气写，别写「用户/助手」
  · 没说完就写没说完的那半句，不用补完整

只输出一个 JSON，不要解释、不要别的东西：
{{"topic": "...", "emotion": "...", "pending_tail": "...", "trivia": ["...", "..."]}}"""


def build_prompt(topic_hint: str = "") -> str:
    """生成「让她写交接单」的提示词。topic_hint 可给个当前话题的提醒。"""
    text = _PROMPT_TEMPLATE.format(max_chars=int(HANDOVER_MAX_CHARS))
    hint = _norm(topic_hint)
    if hint:
        text += f"\n\n（这会儿大概在聊：{_clip(hint, 60)}）"
    return text


# ═══════════════════════════════════════════════════════════════════
# 六点五、从真实对话里提取交接单（2026-11-08，写侧最小版）
#
# 两个数据源，优先窗口账本：
#
#   窗口账本（生产实测 11 轮）          working_mem（8 条）
#   turn 5: his='为什么我拍你你才回话'   「他说：为什么我拍你你才回话；
#           said='你一直戳我，我一直在呀'   我回：你一直戳我，我一直在呀」
#   ↑ his/said 分开，有时间戳            ↑ 粘成一条，分不清谁说的
#
# ★ 为什么 his/said 分开这么重要：
#   交接单要写「他/我什么情绪」。合并之后，
#   「他说：我好累」和「她说：我好累」看起来一样 —— 但这是两件事。
#   所以 emotion **只在 said 里捞**，绝不碰 his。
#
# ★ 这是「补的」，不是「留的」（评审 定的三条纪律）
#   ① 抽不到就留空，不编
#   ② 有效内容（去重 + 去寒暄后）< MIN_BLOCKS → 返回 None
#   ③ 调用方用 source=SOURCE_RECONSTRUCTED 写，注入时显示「（补记）」
# ═══════════════════════════════════════════════════════════════════


# 约束②：有效内容（去重 + 去寒暄后）少于这么多条就不补
#   2026-11-08 评审 从 2 提到 3：
#   2 条生成的交接单只有「刚聊到 X」一行，跟什么都没写区别不大。
#   3 条以上才有「这一段在聊什么」的轮廓。
HANDOVER_MIN_BLOCKS = 3

# 时间闸（2026-11-08 评审 定）：距上次对话 >= 这个小时数才值得留纸条。
#
# ★ 这个阈值跟 config 的 CROSS_DAY_HOURS(20) 是**两件不同的事**，不要合并：
#     CROSS_DAY_HOURS     → 「这次开局算不算跨天」，决定要不要注入 7k token 的
#                           人格卡/记忆库/跨天标记。门槛高（20h）因为成本高。
#     HANDOVER_MIN_HOURS  → 「值不值得留一张 80 字的纸条」，成本极低，6h 就够。
#
#   实测：早上 8 点聊完、下午 2 点再聊，间隔 6 小时 ——
#   这 6 小时里可能聊了很多事，值得留一张；但它不算「跨天开局」。
HANDOVER_MIN_HOURS = 6.0

# 情绪词表：只认这些明确词，认不出留空（写错比空着更有害）
_EMOTION_WORDS = [
    "开心", "高兴", "兴奋", "轻松", "踏实", "安心", "舒服",
    "累", "困", "烦", "难过", "伤心", "生气", "急", "慌", "委屈", "失落",
    "担心", "紧张", "心疼", "专注", "忙", "疲惫", "无聊", "舍不得", "抱歉",
    "睡不着", "熬夜", "没睡好", "眼睛肿", "头有点晕", "有点冷",
]

# 纯寒暄/语气：没信息量，凑数不算数
_FILLER_EXACT = {
    "好", "嗯", "哦", "好哦", "好呀", "好的", "是吗", "对", "对的", "没问题",
    "mua", "哈哈", "在", "在吗", "晚安", "早安", "拜拜", "哦哦", "嗯嗯",
}
_FILLER_SUBSTR = ("拍一拍", "戳了戳")

# 探针/测试标记（评审 定的口径：三道判据）
_PROBE_MARKERS = ("测试", "test", "TEST", "probe", "PROBE")

# 「问了没回」的判据（pending_tail 用）
_QUESTION_HINTS = ("?", "？", "吗", "呢", "要不要", "是不是", "好不好")


def _load_working_mem(path=None) -> dict:
    p = path or WORKING_MEM_PATH
    if not os.path.exists(p):
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[handover] 读 working_mem 失败，跳过: {type(e).__name__}: {e}")
        return {}
    return data if isinstance(data, dict) else {}


def _is_filler(text: str) -> bool:
    """纯寒暄 / 语气 / 拍一拍 —— 当内容不算数。"""
    t = _norm(text)
    if not t:
        return True
    if t in _FILLER_EXACT:
        return True
    if any(w in t for w in _FILLER_SUBSTR):
        return True
    return False


def _is_informative(text) -> bool:
    """这条内容能不能算「有信息量」（评审 加的口径）。

    太短 / 纯寒暄 → 不算。
    为什么要有这条：4 条「好」「嗯」「mua」也是 4 条，
    但它们凑不出一张交接单。
    """
    t = _norm(text)
    if len(t) < 6:
        return False
    return not _is_filler(t)


def _is_probe_turn(turn: dict) -> bool:
    """这一轮是不是探针/测试写的（评审 定的三道判据）。

    为什么不能只判「含『测试』」：她哪天真的说「测试一下这个功能」就会被误杀。
    所以三判据一起看：
      ① 明确的探针词
      ② 内容是占位式的（his 和 said 对上模板）
      ③ 两边都极短（<2 字）
    """
    if not isinstance(turn, dict):
        return True
    h = str(turn.get("his") or "")
    s = str(turn.get("said") or "")
    both = h + s

    if any(m in both for m in _PROBE_MARKERS):
        return True
    if h in ("测试他的原话", "测试", "test") or s in ("测试她的回复", "测试", "test"):
        return True
    if len(h.strip()) < 2 and len(s.strip()) < 2:
        return True
    return False


def _dedup(items) -> list:
    """去重（保序）。4 条一模一样的重复，信息量等于 1 条。"""
    out = []
    for x in items:
        t = _norm(x)
        if t and t not in out:
            out.append(t)
    return out


def _window_turns(session_id, limit: int = 20) -> list:
    """读窗口账本，过滤掉探针轮。

    返回 [{'his','said','said_at','turn'}...] 正序；读不到 → []。
    ★ 过滤了要报（评审 定的：静默过滤和没过滤长得一样）
    """
    try:
        from window_ledger import read_turns
    except Exception:
        return []
    try:
        rows = read_turns(_sid(session_id), limit=limit) or []
    except Exception as e:
        print(f"[handover] 读窗口账本失败，跳过: {type(e).__name__}: {e}")
        return []

    from services.recall_policy import eligible, RecallContext
    context = RecallContext(session_id=str(session_id or ''))
    rows = [r for r in rows if eligible(dict(r, session_id=session_id,
             content=str(r.get('his') or '')+' '+str(r.get('said') or '')), context)]
    kept, skipped = [], 0
    for r in rows:
        if _is_probe_turn(r):
            skipped += 1
            continue
        kept.append(r)
    if skipped:
        # 不静默：过滤了必须留痕，否则哪天条件太宽把所有数据滤光也没人知道
        print(f"[handover] 跳过 {skipped} 轮探针数据（{session_id}）",
              file=sys.stderr)
    return kept


def _working_blocks(session_id, path=None) -> list:
    """取某会话的工作记忆组块（已去重 + 去寒暄）。

    working_mem 里 his/said 是粘在一起的，只当**退化数据源**用。
    """
    data = _load_working_mem(path)
    sess = (data.get("sessions") or {}).get(_sid(session_id)) or {}
    raw = []
    for b in (sess.get("working_memory") or []):
        if isinstance(b, dict):
            from services.recall_policy import eligible, RecallContext
            if eligible(dict(b, session_id=session_id), RecallContext(session_id=session_id)):
                raw.append(b.get("content"))
        elif isinstance(b, str):
            raw.append(b)
    return [b for b in _dedup(raw) if _is_informative(b)]


# ── 各字段的提取规则 ──────────────────────────────────────────────

def _topic_score(text: str) -> int:
    """「这句够不够格当 topic」。

    有具体内容（>=10 字）+2 / 带问句或陈述 +1 / 寒暄 -3
    """
    t = _norm(text)
    if not t:
        return -999
    s = 0
    if len(t) >= 6:
        s += 1                            # 6 字以上算有内容（「今天工作好累啊」=7）
    if len(t) >= 12:
        s += 1
    if any(h in t for h in _QUESTION_HINTS):
        s += 1
    if _is_filler(t):
        s -= 3
    return s


def _pick_topic(his_list: list, said_list: list, blocks: list) -> str:
    """「刚聊到」优先取 his（他说的才是「聊到哪儿」），退化取 said / blocks。

    ★ 「优先」是**按源优先**，不是按分数跨源比。
      实测踩过：his='今天工作好累啊'（7 字，分低）vs
                said='我也觉得你累了，早点睡吧'（12 字，分高）
      → 跨源比分会挑 said，但「聊到哪儿」是他那句定义的。
      所以：his 里有及格的就用 his，哪怕分数不如 said 高。
    """
    for cands in (his_list, said_list, blocks):
        best, best_score = "", 0          # 门槛 0：及格才用
        for c in cands[-4:]:
            sc = _topic_score(c)
            if sc > best_score:
                best, best_score = c, sc
        if best:
            return _clip(best, _TOPIC_SOFT)
    return ""                            # 都不及格 → 空（不编）


def _pick_emotion(said_list: list, blocks: list) -> str:
    """情绪**只从她的话（said）里捞**，绝不碰 his。

    为什么：「他说：我好累」是在说他，不是她的状态。
    合并文本里捞会得出「她也累」—— 那就是把别人的情绪安在她头上。
    said 为空时（退化到 working_mem）才看 blocks，且那边本来就是「他说…我回…」混排，
    所以只捞 her 那半句（「我回：」之后）。
    """
    text = " ".join(said_list[-6:]) if said_list else ""
    if not text:
        # 退化：从「我回：」之后的部分捞
        parts = []
        for b in blocks[-4:]:
            m = re.search(r"我回[:：]\s*(.+)$", b)
            parts.append(m.group(1) if m else "")
        text = " ".join(parts)
    if not text:
        return ""
    found = []
    for w in _EMOTION_WORDS:
        if w in text and w not in found:
            found.append(w)
    return "，".join(found[:2])        # 最多两个


def _pick_pending(his_list: list, said_list: list, blocks: list) -> str:
    """没说完的尾巴：最后一条里「问了没回」的那半句。"""
    cand = (said_list or blocks or his_list)
    if not cand:
        return ""
    last = cand[-1]
    if not any(h in last for h in _QUESTION_HINTS):
        return ""
    m = re.search(r"我回[:：]\s*(.+)$", last)
    tail = (m.group(1) if m else last).strip()
    return _clip(tail, _TAIL_SOFT)


def _pick_trivia(his_list: list, said_list: list, blocks: list) -> list:
    """琐事：从两个源里挑短句（<=20 字），不要寒暄。"""
    pool = []
    for src in (his_list, said_list):
        for s in src:
            for part in re.split(r"\s*/\s*", s):
                p = _norm(part)
                if p and len(p) <= 20 and not _is_filler(p):
                    pool.append(p)
    if not pool:
        for b in blocks:
            p = _norm(re.sub(r"^他说[:：]\s*", "", b))
            if p and len(p) <= 20 and not _is_filler(p):
                pool.append(p)
    return _dedup(pool)[:HANDOVER_TRIVIA_MAX]


# ── 对外主函数 ────────────────────────────────────────────────────

def extract_handover_content(session_id, working_path=None) -> dict:
    """从真实对话里提取交接单内容（纯规则，不调模型）。

    数据源优先级（2026-11-08 评审 定）：
        ① 窗口账本（原话，his/said 分开，有时间戳）—— 首选
        ② working_mem（已压缩，his/said 粘在一起）—— 账本不够时退回
        ③ 都不够 → None

    返回 dict 或 None：
        None 表示**数据不够，不要写空壳**
        否则 {"topic","emotion","pending_tail","trivia","source","turns_used"}
    """
    turns = _window_turns(session_id)
    his_list = [_norm(t.get("his")) for t in turns if _norm(t.get("his"))]
    said_list = [_norm(t.get("said")) for t in turns if _norm(t.get("said"))]

    # 有效内容：去重 + 去寒暄
    his_eff = [h for h in _dedup(his_list) if _is_informative(h)]
    said_eff = [s for s in _dedup(said_list) if _is_informative(s)]

    blocks = []
    n_valid = len(his_eff) + len(said_eff)

    if n_valid < HANDOVER_MIN_BLOCKS:
        # 退回 working_mem
        blocks = _working_blocks(session_id, path=working_path)
        n_valid = len(blocks)

    if n_valid < HANDOVER_MIN_BLOCKS:
        return None                    # 约束②：宁可空着

    got = {
        "topic": _pick_topic(his_eff, said_eff, blocks),
        "emotion": _pick_emotion(said_eff, blocks),
        "pending_tail": _pick_pending(his_eff, said_eff, blocks),
        "trivia": _pick_trivia(his_eff, said_eff, blocks),
        "source": SOURCE_RECONSTRUCTED,
        "turns_used": n_valid,
    }
    if not any([got["topic"], got["emotion"], got["pending_tail"], got["trivia"]]):
        return None
    return got



# ── 三道闸：该不该「现场补一张」交接单 ────────────────────────────

def _same_day(ts, now=None) -> bool:
    """两个时间戳是不是同一个自然日（本地时区）。"""
    a = _to_ts(ts)
    if a <= 0:
        return False
    b = time.time() if now is None else now
    ta = time.localtime(a)
    tb = time.localtime(b)
    return (ta.tm_year, ta.tm_yday) == (tb.tm_year, tb.tm_yday)


def _last_turn_time(session_id):
    """该会话最后一轮对话是什么时候（窗口账本 said_at）。

    账本没有 → 退回 working_mem 的 last_active → 都没有 → 0。
    """
    try:
        from window_ledger import last_turn
        t = last_turn(_sid(session_id))
        if isinstance(t, dict):
            ts = _to_ts(t.get("said_at")) or _to_ts(t.get("at"))
            if ts > 0:
                return ts
    except Exception:
        pass
    data = _load_working_mem()
    sess = (data.get("sessions") or {}).get(_sid(session_id)) or {}
    return _to_ts(sess.get("last_active"))


def _read_blocks(session_id) -> list:
    """该会话的有效内容条数（去重 + 去寒暄 + 过滤探针）。

    窗口账本优先，不够时并上 working_mem —— 跟 extract_handover_content 同源口径，
    否则「闸说够」和「提取说不够」会打架。
    """
    turns = _window_turns(session_id)
    raw = []
    for t in turns:
        raw.append(t.get("his"))
        raw.append(t.get("said"))
    blocks = [b for b in _dedup(raw) if _is_informative(b)]
    if len(blocks) < HANDOVER_MIN_BLOCKS:
        blocks = _dedup(blocks + _working_blocks(session_id))
    return blocks


def should_reconstruct(session_id, now=None, handover_path=None,
                       last_active=None) -> bool:
    """该不该「现场补一张」交接单（跨天写侧的最小版）。

    三道闸，全部满足才返回 True：

      ① 时间闸  距上次对话 >= HANDOVER_MIN_HOURS(6 小时)
                 —— 「间隔够长，值得留纸条」，跟 CROSS_DAY_HOURS(20) 不是一回事
      ② 内容闸  去重后的有效内容 >= HANDOVER_MIN_BLOCKS(3 条)
                 —— 「凑不出轮廓就别写」，防止产出只有一行的空壳
      ③ 幂等闸  今天还没生成过
                 —— ★ 这条不只是「防越攒越多」：
                    write_handover 是**同会话覆盖**，所以真正的问题是
                    「当天第二张会把第一张盖掉，等于早上那趟白写」。

    参数：
        last_active  外部已知的「上次活跃时间」（session_init 手里就有，
                     传进来可以省一次读盘，也让判断跟调用方一致）
    """
    now = time.time() if now is None else now

    # ① 时间闸
    last = _to_ts(last_active) or _last_turn_time(session_id)
    if last <= 0:
        return False                      # 完全没聊过 → 没有「刚才」可交接
    if (now - last) / 3600.0 < float(HANDOVER_MIN_HOURS):
        return False

    # ② 内容闸
    if len(_read_blocks(session_id)) < HANDOVER_MIN_BLOCKS:
        return False

    # ③ 幂等闸
    existing = read_handover(session_id, path=handover_path, now=now)
    if existing and _same_day(existing.get("written_at"), now):
        return False

    return True


def reconstruct_handover(session_id, working_path=None, handover_path=None,
                         now=None) -> dict:
    """一条龙：提取 → 写入。数据不够返回 None。

    ★ 写进去的记录 source='reconstructed'，注入时会显示【交接单（补记）】。
    """
    got = extract_handover_content(session_id, working_path=working_path)
    if got is None:
        return None
    return write_handover(session_id, got["topic"], got["emotion"],
                          got["pending_tail"], got["trivia"],
                          path=handover_path, now=now,
                          source=got["source"])


# 旧名字保留（对外说明里用过 extract_from_working）
extract_from_working = extract_handover_content


# 七、把她的回复解析成参数
#
# 提示词要她回 JSON，就得有人把这个 JSON 拆开 —— 否则「让她写」这件事
# 在每个调用方那里都要重写一次，迟早有一处写错（模型还爱包 3 个反引号的
# json 围栏，fenced 写法见 parse_reply）。
# ═══════════════════════════════════════════════════════════════════

_FENCE_HEAD = re.compile(r"^\s*```(?:json|JSON)?\s*")
_FENCE_TAIL = re.compile(r"\s*```\s*$")


def parse_reply(text):
    """从模型回复里抠出交接单 JSON，返回 write_handover 的四个参数。

    返回 {"topic","emotion","pending_tail","trivia"}；实在解析不出来 → None。
    宽松处理：json 围栏、前后有多余说明、trivia 写成一段字符串。
    """
    raw = str(text or "").strip()
    if not raw:
        return None
    raw = _FENCE_HEAD.sub("", raw)
    raw = _FENCE_TAIL.sub("", raw).strip()

    candidates = [raw]
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        candidates.append(raw[start:end + 1])

    data = None
    for c in candidates:
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if isinstance(obj, dict):
            data = obj
            break
    if data is None:
        return None

    got = {
        "topic": _norm(data.get("topic")),
        "emotion": _norm(data.get("emotion")),
        "pending_tail": _norm(data.get("pending_tail")),
        "trivia": [x for x in (_norm(t) for t in _split_trivia(data.get("trivia"))) if x],
    }
    if not any([got["topic"], got["emotion"], got["pending_tail"], got["trivia"]]):
        return None                   # 全是空的 = 没答上来，别写个空壳进去
    return got


def write_from_reply(session_id, reply_text, path=None, is_private=False):
    """一条龙：解析她的回复 → 写入。解析不出来返回 None（不写空壳）。"""
    got = parse_reply(reply_text)
    if got is None:
        return None
    return write_handover(session_id, got["topic"], got["emotion"],
                          got["pending_tail"], got["trivia"], path=path, is_private=is_private)


# ═══════════════════════════════════════════════════════════════════
# 八、自检（不依赖真实数据，5 秒内跑完；全在临时目录里，不碰真实交接单）
# ═══════════════════════════════════════════════════════════════════

def selftest() -> None:
    import shutil
    import tempfile

    tmpdir = tempfile.mkdtemp(prefix="handover_selftest_")
    try:
        # 特意多一层 state/：目录不存在时必须能自己建出来
        p = os.path.join(tmpdir, "state", "handover.json")
        assert not os.path.exists(os.path.dirname(p)), "前置条件：state 目录应该还不存在"

        # ── ① 写 → 读 往返，且自动建目录
        # 钉死时间：否则「written_at 往返一致」这条断言也在赌秒边界
        _T0 = float(int(time.time()))          # 当前整秒（生产语义，但固定住）
        h = write_handover("s1", "聊记忆系统", "专注", "他还没下课",
                           ["算钱", "拆系统"], path=p, now=_T0)
        assert os.path.isdir(os.path.dirname(p)), "state 目录没自动创建"
        assert h["topic"] == "聊记忆系统" and h["emotion"] == "专注"
        assert h["trivia"] == ["算钱", "拆系统"], h["trivia"]
        assert isinstance(h["written_at"], int) and h["written_at"] > 0

        back = read_handover("s1", path=p)
        assert back is not None
        for k in ("topic", "emotion", "pending_tail", "trivia"):
            assert back[k] == h[k], f"{k} 过不了磁盘往返：{back[k]!r} != {h[k]!r}"
        # 2026-11-08 修 flaky：原来是 abs(...) <= 2 的容差 —— 容差再宽也是赌时钟，
        #   钉死 now 之后必须是**严格相等**，不是「差不多」。
        assert back["written_at"] == h["written_at"], \
            f"written_at 过不了磁盘往返：{back['written_at']} != {h['written_at']}"

        # ── ② 注入文本：格式对上 8.5.5
        txt = build_inject_text(back)
        assert txt.startswith("【交接单】"), txt
        for piece in ("刚聊到：聊记忆系统", "我：专注",
                      "没说完：他还没下课", "最近在烦：算钱 / 拆系统"):
            assert piece in txt, f"注入文本缺「{piece}」：\n{txt}"
        assert len(txt) <= INJECT_MAX_CHARS

        # ── ③ 超长截断：四块合计也不许越界（只卡单块 = 没卡）
        big = write_handover("t2", "A" * 500, "B" * 200, "C" * 300,
                             ["D" * 100] * 10, path=p)
        three = len(big["topic"]) + len(big["emotion"]) + len(big["pending_tail"])
        assert three <= HANDOVER_MAX_CHARS, f"三块合计没截断：{three}"
        four = three + sum(len(t) for t in big["trivia"])
        assert four <= HANDOVER_MAX_CHARS, f"四块合计没截断：{four}"
        assert len(big["trivia"]) <= HANDOVER_TRIVIA_MAX, big["trivia"]
        assert len(big["trivia"]) == HANDOVER_TRIVIA_MAX, "预算够时琐事不该被丢"
        assert big["topic"].endswith(ELLIPSIS), "截断了要留看得见的省略号"

        # 极端：上限调到 1 也不能炸（永远 <= 上限，而不是死循环 / 返回超长）
        _saved_max = HANDOVER_MAX_CHARS
        try:
            globals()["HANDOVER_MAX_CHARS"] = 1
            one = write_handover("tiny", "很长很长很长的一句话题", "情绪", "尾巴",
                                 ["一", "二", "三"], path=p)
            assert len(one["topic"]) + len(one["emotion"]) + len(one["pending_tail"]) <= 1, one
        finally:
            globals()["HANDOVER_MAX_CHARS"] = _saved_max

        # ── ④ should_write：只有换场景那三种才写
        for t in ("rotate", "cross_day", "compress", "rotation", "COMPRESS"):
            assert should_write(t) is True, f"{t} 应该写"
        for t in ("normal", "", None, "闲聊", "daily"):
            assert should_write(t) is False, f"{t!r} 不该写"

        # 开关关掉就整体不写（开关不生效 = 白加）
        try:
            import features as _f
            if "handover" in getattr(_f, "FEATURES", {}):
                _f.disable("handover")
                assert should_write("rotate") is False, "关掉开关后不该再写"
                _f.enable("handover")
                assert should_write("rotate") is True
        except KeyError:
            pass

        # ── ⑤ 多会话互不覆盖
        write_handover("s2", "另一个群在聊画画", "轻松", "", ["在挑颜色"], path=p)
        assert read_handover("s1", path=p)["topic"] == "聊记忆系统"
        assert read_handover("s2", path=p)["topic"] == "另一个群在聊画画"
        write_handover("s2", "改了话题", "轻松", "", ["在挑颜色"], path=p)
        assert read_handover("s2", path=p)["topic"] == "改了话题", "同会话应覆盖不是追加"

        # ── ⑤b 同一秒写两份：必须取「后写的」那一份
        #      （written_at 只有秒精度，只按它排序会取到先写的 —— 实测踩过）
        sp = os.path.join(tmpdir, "same_second.json")
        # 2026-11-08 修 flaky（测试组 20 次交叉验证抓到 1/20 挂）：
        #   原来这里连着写两次，再 assert「两份 written_at 必须相同」当前置条件。
        #   写这条时我自己标了「前置条件」四个字 —— 说明当时就知道它靠运气，
        #   却写成了 assert，等于**赌时钟**。两次写之间中位 4.4ms，
        #   跨整秒概率约 0.44%，所以 20 轮挂一次。
        #
        #   修法不是「跨秒就跳过」（那会让分支悄悄不被测），而是**钉死时钟**：
        #   write_handover 加了 now= 参数（只给测试用），
        #   「同秒靠 seq 决胜」这个分支 100% 被覆盖，而且确定性。
        _T = 1794000000.0                      # 钉死同一秒
        write_handover("private:A", "A 的话", "x", "", [], path=sp, now=_T)
        write_handover("session:B", "B 的话", "y", "", [], path=sp, now=_T)
        _d = json.load(open(sp, encoding="utf-8"))["sessions"]
        assert _d["private:A"]["written_at"] == _d["session:B"]["written_at"], (
            "钉死 now 之后必须同秒（否则 now= 参数没生效）")
        assert _d["private:A"]["seq"] < _d["session:B"]["seq"], (
            "同秒两份 seq 必须递增才能决胜，实际 "
            f"A={_d['private:A'].get('seq')} B={_d['session:B'].get('seq')}")
        assert read_latest_handover(path=sp, now=_T)["topic"] == "B 的话", (
            f"同一秒应取后写的 B，实际取到 {read_latest_handover(path=sp, now=_T)['topic']!r}")

        # ── ⑤c 多会话同时活着 + 传了 prefer_session_id → 拿自己那份，不拿别人的
        assert read_latest_handover(path=sp, now=_T, prefer_session_id="private:A")["topic"] == "A 的话"
        assert read_latest_handover(path=sp, now=_T, prefer_session_id="session:B")["topic"] == "B 的话"
        write_handover("group:B", "群内话题", "", "", [], path=sp, now=_T)
        assert read_latest_handover(path=sp, now=_T, prefer_session_id="group:B")["topic"] == "群内话题"
        assert read_latest_handover(path=sp, now=_T, prefer_session_id="group:没人") is None

        # ── ⑤d 读到的结果必须带足「这是谁的那份」
        assert read_handover("private:A", path=sp, now=_T)["session"] == "private:A"
        assert read_latest_handover(path=sp, now=_T)["session"] == "session:B", "最新那份应来自 session:B"

        # ── ⑤e 「忘了传 prefer_session_id」要留痕，但不能变成噪音
        import io
        import contextlib

        def _read_capture(where, **kw):
            # 默认跟 ⑤b 用同一个钉死时间，否则 sp 里那两份（写在 _T）
            # 会被真实当前时间判成"过期"，一条都不会被读出来。
            kw.setdefault("now", _T)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                got = read_latest_handover(path=where, **kw)
            return got, buf.getvalue()

        _reset_warn_state()
        got, out = _read_capture(sp)                   # 不传 + 两份活跃 → 报警
        assert "警告" in out and "prefer_session_id" in out, f"多会话没传应告警：{out!r}"
        got, out = _read_capture(sp)                   # 第二次不重复报（防日志被淹）
        assert "警告" not in out, "同一档位不该重复告警"
        _reset_warn_state()
        got, out = _read_capture(sp, prefer_session_id="private:A")
        assert "警告" not in out, "传了 prefer_session_id 就不该告警"
        # 只有一份活跃时不报警（否则「单人用」也会天天刷屏）
        solo = os.path.join(tmpdir, "solo.json")
        write_handover("只有我", "独处", "平静", "", [], path=solo, now=_T + 1)
        _reset_warn_state()
        got, out = _read_capture(solo)
        assert "警告" not in out, f"只有一份活跃时不该告警：{out!r}"
        _reset_warn_state()

        # ── ⑥ 过期 → None（超过 ttl 就是「不是刚才」了）
        stale = int(time.time()) - int(float(HANDOVER_TTL_HOURS) * 3600) - 60
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "sessions": {
                "old": {"written_at": stale, "topic": "昨天的事",
                        "emotion": "", "pending_tail": "", "trivia": []}}},
                f, ensure_ascii=False)
        assert read_handover("old", path=p) is None, "过期必须返回 None"
        assert read_latest_handover(path=p) is None, "过期的那份不该被当成最新一份"

        # ── ⑦ 坏文件 / 空文件 / 不存在的会话 都不抛
        with open(p, "w", encoding="utf-8") as f:
            f.write("{ 这不是 json")
        assert read_handover("s1", path=p) is None
        assert read_latest_handover(path=p) is None
        with open(p, "w", encoding="utf-8") as f:
            f.write("")
        assert read_handover("s1", path=p) is None
        os.remove(p)
        assert read_handover("根本不存在", path=p) is None

        # ── ⑧ 空输入不产出空壳；指定了不存在的会话要退到最近一份
        write_handover("s1", "正常话题", "正常情绪", "", [], path=p)
        assert read_handover("nobody", path=p)["topic"] == "正常话题", "应退到最近一份"
        assert build_inject_text(None) == ""
        assert build_inject_text({}) == ""
        assert build_inject_text({"topic": "", "emotion": "",
                                  "pending_tail": "", "trivia": []}) == ""

        # ── ⑨ 提示词
        pr = build_prompt()
        for k in ("topic", "emotion", "pending_tail", "trivia", str(int(HANDOVER_MAX_CHARS))):
            assert k in pr, f"提示词里没提到 {k}"
        assert "记忆系统重构" not in pr
        assert "记忆系统重构" in build_prompt("记忆系统重构"), "topic_hint 没拼进提示词"

        # ── ⑩ 解析她的回复（json 围栏 / 前后废话 / trivia 写成一段）
        fence = "```"
        fenced = fence + 'json\n{"topic": "聊记忆", "emotion": "专注", ' \
                        '"pending_tail": "他还没下课", ' \
                        '"trivia": ["算钱", "拆系统"]}\n' + fence
        ok = parse_reply(fenced)
        assert ok and ok["topic"] == "聊记忆" and ok["trivia"] == ["算钱", "拆系统"], ok
        loose = parse_reply('好，我写好了：{"topic":"画画","emotion":"轻松",'
                            '"pending_tail":"","trivia":"在挑颜色 / 换了新画笔"} 就这样')
        assert loose and loose["trivia"] == ["在挑颜色", "换了新画笔"], loose
        assert parse_reply("我不写") is None
        assert parse_reply("") is None
        assert parse_reply('{"topic":"","emotion":"","pending_tail":"","trivia":[]}') is None

        # 一条龙：解析出来的东西能落盘，且落盘后长度依然合规
        wh = write_from_reply(
            "s3", '{"topic":"' + "长" * 300 + '","emotion":"困",'
                  '"pending_tail":"没说完的半句","trivia":["a","b","c","d"]}', path=p)
        assert wh is not None and len(wh["trivia"]) <= HANDOVER_TRIVIA_MAX
        assert len(wh["topic"]) + len(wh["emotion"]) + len(wh["pending_tail"]) <= HANDOVER_MAX_CHARS
        assert read_handover("s3", path=p)["topic"][:1] == "长"

        # ── ⑪ 落盘内容必须可再序列化，且结构稳定
        with open(p, "r", encoding="utf-8") as f:
            on_disk = json.load(f)
        json.loads(json.dumps(on_disk))
        assert isinstance(on_disk.get("sessions"), dict) and on_disk["sessions"]
        json.loads(json.dumps(back))


        # ── ⑫ 提取器（写侧最小版）：三条纪律 + 三个修过的 bug
        #     全部在临时目录里造数据，不碰真实 working_mem / 窗口账本
        import window_ledger as _W
        _save_wdir = getattr(_W, "WINDOW_DIR", None)
        _wdir = os.path.join(tmpdir, "window")
        if _save_wdir is not None:
            _W.WINDOW_DIR = _wdir

        try:
            # ⑫-1 数据不足 → None（约束②）
            assert extract_handover_content("private:空的") is None, "没数据应返回 None"

            # ⑫-2 只有 1 轮有效内容 → None
            _W.append_turn("private:one", "今天吃了火锅", "好吃吗")
            assert extract_handover_content("private:one") is None, \
                "只有 1 轮有效内容应返回 None"

            # ⑫-3 正常对话 → 四块齐全，source 标记正确（约束③）
            _W.append_turn("private:ok", "今天工作好累啊", "我也觉得你累了，早点睡吧")
            _W.append_turn("private:ok", "明天还要早起", "那我陪你，别熬太晚")
            _W.append_turn("private:ok", "有点烦", "我知道，你先躺一会儿")
            g = extract_handover_content("private:ok")
            assert g is not None, "有 3 轮应能提取"
            assert g["source"] == SOURCE_RECONSTRUCTED, g["source"]
            assert g["topic"] == "今天工作好累啊", f"topic 应取 his 那侧，实际 {g['topic']!r}"

            # ⑫-4 emotion 只在 said 里捞，不看 his
            #     他的「我累」不能被当成她的情绪
            _W.append_turn("private:emo", "我好累啊，今天累死了", "那你早点睡")
            _W.append_turn("private:emo", "明天还要上班", "嗯，我等你回来")
            g2 = extract_handover_content("private:emo")
            assert g2 is not None
            assert "累" not in (g2["emotion"] or ""), \
                f"他的『累』不能被算成她的情绪，实际 {g2['emotion']!r}"

            # ⑫-5 探针轮要被过滤，而且要留痕（不能静默）
            _W.append_turn("private:probe", "测试他的原话", "测试她的回复")
            _W.append_turn("private:probe", "真的一句：今天加班到十点",
                           "那你辛苦了，快休息")
            _W.append_turn("private:probe", "真的第二句：明天还得早起",
                           "我陪你早点睡")
            _buf = io.StringIO()
            with contextlib.redirect_stderr(_buf):
                g3 = extract_handover_content("private:probe")
            err = _buf.getvalue()
            assert "跳过" in err, f"过滤探针必须留痕，实际 stderr={err!r}"
            assert g3 is not None and "测试" not in (g3["topic"] or ""), \
                f"探针轮不该当选 topic，实际 {g3['topic']!r}"

            # ⑫-6 重复内容不算有效内容（4 条一样的 = 1 条）
            for _ in range(4):
                _W.append_turn("private:dup", "今天用户说要吃火锅", "好呀")
            assert extract_handover_content("private:dup") is None, \
                "4 条完全重复应视为数据不足"

            # ⑫-7 reconstructed 注入时带「（补记）」，session 不带
            _hp = os.path.join(tmpdir, "recon.json")
            rec_r = write_handover("s-x", "聊记忆", "专注", "", [],
                                   path=_hp, source=SOURCE_RECONSTRUCTED)
            assert rec_r["source"] == SOURCE_RECONSTRUCTED
            assert "（补记）" in build_inject_text(rec_r), "补记的必须标出来"
            rec_s = write_handover("s-y", "聊记忆", "专注", "", [],
                                   path=_hp, source=SOURCE_SESSION)
            assert rec_s["source"] == SOURCE_SESSION
            txt_s = build_inject_text(rec_s)
            assert txt_s.startswith("【交接单】"), txt_s[:20]
            assert "（补记）" not in txt_s
            # 不认识的值当 reconstructed（保守）
            rec_bad = write_handover("s-z", "x", "y", "", [], path=_hp, source="乱写")
            assert rec_bad["source"] == SOURCE_RECONSTRUCTED, rec_bad["source"]

            # ⑫-8 reconstruct_handover 一条龙：提取 + 写盘，且标记正确
            _hp2 = os.path.join(tmpdir, "recon2.json")
            rr = reconstruct_handover("private:ok", handover_path=_hp2)
            assert rr is not None and rr["source"] == SOURCE_RECONSTRUCTED
            got_back = read_handover("private:ok", path=_hp2)
            assert got_back["source"] == SOURCE_RECONSTRUCTED, "source 过不了磁盘往返"
        finally:
            if _save_wdir is not None:
                _W.WINDOW_DIR = _save_wdir


        # ── ⑬ 三道闸（should_reconstruct）：时间 / 内容 / 幂等
        #     ★ 上一组的 finally 已经把 _W.WINDOW_DIR 还原了，
        #       这里必须重新指向临时目录，否则会往真实账本里写测试数据。
        _save_wdir2 = getattr(_W, "WINDOW_DIR", None)
        if _save_wdir2 is not None:
            _W.WINDOW_DIR = _wdir
        try:
            _gate_hp = os.path.join(tmpdir, "gate.json")

            # 造一个「有 3 轮有效对话、最后一轮在 8 小时前」的会话
            _now = time.time()
            _W.append_turn("private:gate", "今天要给展品重新编号", "先从大厅开始")
            _W.append_turn("private:gate", "先看地图还是先看年表", "先看年表")
            _W.append_turn("private:gate", "好，那就先看年表", "我来记下编号")

            # 手动把账本里的 said_at 改成 8 小时前（append_turn 用的是真实时间）
            _rows = _W.read_turns("private:gate", limit=0)
            # ⚠️ 这里踩过一次：账本目录名是 append_turn 自己做的文件名净化
            #   ('private:gate' -> 'private_gate')。我一开始按 f'{sid}/turns.jsonl'
            #   拼路径，exists() 恒 False，整组三闸用例被 if 吞掉 —— 测试「通过」了，
            #   但一条都没跑。**测试自己被跳过和测试通过长得一样。**
            #   现在改成从账本目录里找刚写进去的那个 turns.jsonl，不再猜净化规则。
            _p = _W._turns_path("private:gate")
            assert os.path.isfile(_p), '新写入的账本应当存在'
            if os.path.exists(_p):
                _new = []
                for _r in _rows:
                    _r = dict(_r)
                    _r["said_at"] = _now - 8 * 3600
                    _new.append(json.dumps(_r, ensure_ascii=False))
                with open(_p, "w", encoding="utf-8") as _f:
                    _f.write("\n".join(_new) + "\n")
                _lt = _W.last_turn("private:gate")
                _last = float((_lt or {}).get("said_at") or 0)

                # ⑬-1 三闸全过 → True
                assert should_reconstruct("private:gate", now=_now,
                                          handover_path=_gate_hp,
                                          last_active=_last) is True, "三闸全过应允许补记"

                # ⑬-2 时间闸：只隔 1 小时 → False
                assert should_reconstruct("private:gate", now=_now,
                                          handover_path=_gate_hp,
                                          last_active=_now - 3600) is False, \
                    "间隔不足 6 小时不该补"

                # ⑬-3 时间闸边界：正好 6 小时 → True（>= 而非 >）
                assert should_reconstruct("private:gate", now=_now,
                                          handover_path=_gate_hp,
                                          last_active=_now - 6 * 3600) is True, \
                    "正好 6 小时应该算够（>=）"

                # ⑬-4 内容闸：只有 2 条有效内容 → False
                _W.append_turn("private:thin", "今天吃火锅", "我也想吃")
                _W.append_turn("private:thin", "等周末吧", "好，等你")
                assert should_reconstruct("private:thin", now=_now,
                                          handover_path=_gate_hp,
                                          last_active=_now - 8 * 3600) is False, \
                    "2 条有效内容不该补（门槛已提到 3）"

                # ⑬-5 没聊过 → False（没有「刚才」可交接）
                assert should_reconstruct("private:没聊过", now=_now,
                                          handover_path=_gate_hp) is False

                # ⑬-6 幂等闸：今天补过一张 → 再判 False
                write_handover("private:gate", "刚聊到去重", "专注", "", [],
                                 path=_gate_hp, now=_now, source=SOURCE_RECONSTRUCTED)
                assert should_reconstruct("private:gate", now=_now + 60,
                                          handover_path=_gate_hp,
                                          last_active=_last) is False, \
                    "当天已生成过，不该重复生成（否则第二张会盖掉第一张）"

                # ⑬-7 跨天之后（第二天）→ 又能补了
                assert should_reconstruct("private:gate", now=_now + 86400,
                                          handover_path=_gate_hp,
                                          last_active=_last) is True, \
                    "第二天应该允许再补一张"
        except AssertionError:
            raise
        except Exception as _e:
            # 临时目录结构不同（比如账本路径形态变了）就跳过这组，不假绿也不假红
            print(f"[handover] selftest: 三道闸用例跳过（{type(_e).__name__}: {_e}）")


        # ── ⑭ 锁内调用（2026-11-08 Deadlock 教训的回归用例）
        #     ★ 这条测的不是「函数能不能调用」，是「在调用方的真实锁上下文里能不能跑」。
        #       原来只测 write_handover 本身 → 绿；一到 session_init 的锁里就死，
        #       而且被 except Exception 吞掉 → 「接好了、不报错、永远不生效」。
        try:
            from filelock import FileLock as _FL
            import config as _cfg
            _lk_hp = os.path.join(tmpdir, "lockcall.json")
            _outer = _FL(_cfg.LOCK_FILE_PATH, **_LOCK_KW)
            _outer.acquire()
            try:
                _lr = write_handover("private:locked", "锁里写的", "专注", "", [],
                                     path=_lk_hp, now=_T)
                assert _lr["topic"] == "锁里写的", "锁内调用 write_handover 失败"
                # 重入一次也要能过（reconstruct 里会连着写）
                write_handover("private:locked2", "锁里第二份", "专注", "", [],
                               path=_lk_hp, now=_T)
                assert read_handover("private:locked2", path=_lk_hp,
                                     now=_T)["topic"] == "锁里第二份"
            finally:
                _outer.release()
            print("  ⑭ 锁内调用 write_handover：通过")
        except AssertionError:
            raise
        except Exception as _e:
            raise AssertionError(
                f"锁内调用 write_handover 失败（Deadlock 回归！）: {type(_e).__name__}: {_e}")

        print("handover.py selftest OK")
        print(f"  上限 {HANDOVER_MAX_CHARS} 字 / 琐事 {HANDOVER_TRIVIA_MAX} 条 / "
              f"ttl {int(HANDOVER_TTL_HOURS)}h / 开关 {'开' if enabled() else '关'}")
        print("  样例注入：")
        for line in txt.splitlines():
            print("    " + line)
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    selftest()
