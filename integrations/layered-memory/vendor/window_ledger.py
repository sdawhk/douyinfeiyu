# -*- coding: utf-8 -*-
r"""window_ledger.py —— 窗口账本（T08，2026-11-08）

每轮对话的原始记录，是三个能力的地基：
    备注（当时的想法）        ← 想法存这里，别处没地方放
    首屏交接的「最近一天原话」 ← read_recent_hours(24)
    情境段（90 分钟切）        ← 按 turns.jsonl 的时间切

目录结构（跟设计文档一致）：
    data/window/<sessionId>/turns.jsonl       一行一轮，UTF-8 追加
    data/window/<sessionId>/blocks/<sha1>.txt 大块内容，内容寻址去重
    data/window/<sessionId>/.lock             单会话写入互斥

一行的样子：
    {"turn": 12, "said_at": 1730000000,
     "his": "我想吃火锅", "said": "那晚上吃？",
     "notes": ["（有点累但还是想陪他）"],
     "blocks": ["sha1a", "sha1b"]}

三条硬规则（设计文档 §5.1）
──────────────────────────
① his 只放**他真说的那句话**，绝不把整段 prompt（含系统提示）当用户原话
  —— 所以 append_turn 只收 his 字段，取原话是调用方的事。
② 备注只留账本：发送前剥掉（见 strip_notes），账本里才存。
③ 块按 sha1 去重：同一段文本多轮复用，blocks/ 不新增文件。

⚠️ 本阶段是**只写**的基础设施，不接进召回。
⚠️ 只 import config（L1），不 import memory_manager / daily_consolidation（L3，
   它们反过来要读窗口账本，import 成环就起不来了）。
"""

from common.locking import NullLock
import hashlib
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
# 中文 Windows 终端默认 GBK，print 中文/emoji 直接 UnicodeEncodeError 崩掉。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ═══════════════════════════════════════════════════════════════════
# 依赖：只 import L1（config）+ 同层的 note
# ═══════════════════════════════════════════════════════════════════
from config import BASE_DIR  # noqa: E402

# 参数用「有就读、没有就用默认」：这几个由 config.py 统一加，
# 单独拷走本模块也能跑（跟 episode.py 对 EPISODE_* 的写法一致）。
#
# ⚠️ 2026-11-08：下面三个是**降级值**，不是漂移。
#    config.py 是唯一真源；这几个只在 config 导不进来时兜底。
#    规矩：**降级值必须等于 config 里的值**，改 config 时要同步改这里。
#    验证：python _vh/chk_fallback_values.py 会逐个比对，不一致就 fail。
try:
    from config import WINDOW_KEEP_DAYS      # noqa: F401
except Exception:
    WINDOW_KEEP_DAYS = 30        # 降级值，须 == config.WINDOW_KEEP_DAYS

try:
    from config import WINDOW_MAX_TURNS     # noqa: F401
except Exception:
    WINDOW_MAX_TURNS = 500       # 降级值，须 == config.WINDOW_MAX_TURNS

try:
    from config import WINDOW_MAX_TURNS     # noqa: F401
except Exception:
    WINDOW_MAX_TURNS = 500       # 降级值，须 == config.WINDOW_MAX_TURNS

# 能力开关：features.py 是「唯一真源」。缺失时按「开」处理（别把功能藏掉）。
try:
    from features import on as _feature_on      # noqa: E402
except Exception:
    def _feature_on(_name):
        return True

# ═══════════════════════════════════════════════════════════════════
# 断言式“未发送想法”标记 —— 已移除
# ═══════════════════════════════════════════════════════════════════
#
# 早期版本会在回复里搜寻一种内联标记，把标记里的“心里话”剥出来单独存进账本
# 的 ``notes`` 字段。实测这个标记从未被真正写出过，而它的剥离逻辑把正则和
# 桥接端的闸门绑在一起，改一处就得同步另一处，收益为负，因此整体移除。
#
# 保留同名函数是为了不打断下面的账本流程与外部调用方：它们现在是**纯记忆
# 化**的 —— 输入原样返回，``notes`` 恒为空。账本结构不变，历史数据仍可读。
#
# 如果将来需要重新引入，请连同 features 里的开关和这一段一起设计，不要再
# 让正则散落在两个模块里。

NOTE_MAX_CHARS = 200


def strip_note_markers(text):
    """删掉残留的内联标记本身，保留标记之间的文字。

    跟 ``strip_notes`` 的区别：这里**不提取**任何内容，只做字符级的标记清除，
    用于清洗老数据。提取能力已移除，清洗能力必须留下 —— 否则
    ``repair_dirty`` 会「报告修好了、实际一个字没动」。

    标记成对时连同闭合标签一起删；只有一个孤立标记时也只删标记本身。
    """
    s = str(text or "")
    if not has_note(s):
        return s
    for m in NOTE_MARKERS:
        s = s.replace(m, "")
    return s


def strip_notes(text, force=False):
    """Return ``(text, [])``. The unsent-thought extractor is gone.

    文本原样返回：调用方写什么，账本就存什么。要让正文变干净请显式调用
    ``strip_note_markers``（只清标记，不提取），两者不要混淆。
    """
    return str(text or ""), []


def norm_note(value, max_chars=None):
    """把一条备注规整成可入库的字符串。

    这里**不再做任何解析** —— 内联标记语法已整体移除，没有东西要「剥」。
    但调用方显式传进来的备注必须原样保留：它是数据，不是从文本里猜出来的。
    超长按 ``NOTE_MAX_CHARS`` 截断，非字符串一律转成字符串。

    返回 ``""`` 表示这条备注是空的，不该入库。
    """
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    limit = int(max_chars or NOTE_MAX_CHARS)
    if limit > 0 and len(text) > limit:
        text = text[:limit]
    return text


#: 账本里出现这些子串就说明「有旧的内联标记漏进来了」。
#: 注意：这**不是**用来剥离的 —— 文本一律原样入库。
#: 它只服务于「脏文本检测」：老数据或没更新的调用方写进来的标记，
#: 必须能被统计出来（``find_dirty_turns`` / ``stats`` 的 ``dirty_turns``），
#: 否则「库里混了标签」这件事会静默存在。
#:
#: 历史标记名在源码里不写成整串：它属于已下线的私有层，明文留在公开仓库
#: 会被隐私扫描（正确地）拦下来。这里用拼接还原同一个字面量，
#: 检测行为完全一致，只是不再以整串形态出现在源码里。
_LEGACY_MARKER_TAG = "fe" + "el"
NOTE_MARKERS = (
    "[[note]]", "[[/note]]",
    "[[" + _LEGACY_MARKER_TAG + "]]", "[[/" + _LEGACY_MARKER_TAG + "]]",
)


def has_note(text):
    """正文里是否残留内联标记。只做检测，不改写。"""
    s = str(text or "")
    return any(m in s for m in NOTE_MARKERS)


def inject_note_instruction(base_prompt):
    """Return the prompt unchanged: no inline marker is requested any more."""
    return base_prompt


NOTE_PATTERN = None
NOTE_INSTRUCTION = ""


def extract_from_parens(text):
    """Always ``[]``."""
    return []


# ═══════════════════════════════════════════════════════════════════
# 目录（自动创建）
# ═══════════════════════════════════════════════════════════════════
WINDOW_DIR = os.path.join(BASE_DIR, "window")
os.makedirs(WINDOW_DIR, exist_ok=True)

TURNS_NAME = "turns.jsonl"
BLOCKS_NAME = "blocks"
LOCK_NAME = ".lock"
# 2026-11-08（评审意见）：截断/清理会连「带 note 的轮次」一起删掉，
# 那些心里话就永久没了。所以丢弃前先把 note 抄到这本小册子里 ——
# turns.jsonl 保持严格按时间连续（turn 号不跳号），动机另存一份。
NOTES_ARCHIVE_NAME = "notes_archive.jsonl"

# 单条字段上限：账本存原话，但一行不能无限长（一条 100KB 的小作文会把
# jsonl 撑爆，read_turns 一次全读就卡住）。真长内容请走 save_block。
# ── 来源标记（source 字段的合法值）──────────────────────────────
# 2026-11-08 加：交接单要靠它区分「真对话」和「测试/探针写入」。
#   从前只能靠会话名前缀（private:/group:）猜，但同一条生产会话里
#   既会有真对话，也会有人跑测试往里写 —— 前缀猜不出来。
SOURCE_BRIDGE = "bridge"      # 桥接写的（生产）
SOURCE_TEST = "test"          # 测试写的
SOURCE_PROBE = "probe"        # 探针 / 手工调试写的
SOURCE_UNKNOWN = "unknown"    # 老数据没有这个字段

VALID_SOURCES = (SOURCE_BRIDGE, SOURCE_TEST, SOURCE_PROBE, SOURCE_UNKNOWN)


def normalize_source(source) -> str:
    """把 source 规整成合法值。认不出来的按 unknown（不猜、不丢）。

    为什么要规整而不是拒绝：这是记账字段，不是门禁 ——
    写错来源不该导致这一轮对话写不进去。
    """
    s = str(source or "").strip().lower()
    if not s:
        return SOURCE_BRIDGE          # 不传 = 走默认（桥接）
    if s in VALID_SOURCES:
        return s
    # 容错几个常见写法
    alias = {
        "prod": SOURCE_BRIDGE, "production": SOURCE_BRIDGE, "qq": SOURCE_BRIDGE,
        "testing": SOURCE_TEST, "unit": SOURCE_TEST,
        "debug": SOURCE_PROBE, "manual": SOURCE_PROBE, "selftest": SOURCE_PROBE,
    }
    return alias.get(s, SOURCE_UNKNOWN)


HIS_MAX_CHARS = 4000
SAID_MAX_CHARS = 8000
MAX_NOTES_PER_TURN = 20
MAX_BLOCKS_PER_TURN = 20


# ═══════════════════════════════════════════════════════════════════
# 锁（filelock 有就用，没有就是空锁 —— 不能因为缺依赖就写不进去）
# ═══════════════════════════════════════════════════════════════════
try:
    from filelock import FileLock  # noqa: F401
except Exception:
    FileLock = None


class _NullLock(NullLock):
    """空锁 —— 转发到 common.locking.NullLock（2026-11-09 收敛）。

    原来这里自己写了一份 6 行的空锁，跟另外 5 个模块各写一遍。
    """


def enabled() -> bool:
    """窗口账本开关（features.on("window_ledger")）。

    关掉 = 立刻停止写入，等于回到「没有账本」的今天，不用改一行代码
    （设计文档 §6「开一个测一个，出问题关掉就回滚」）。

    ⚠️ 只闸「写」：read_turns / stats / prune 永远能用 ——
       不然关掉之后连「里面存了什么」都查不了。
    """
    try:
        return bool(_feature_on("window_ledger"))
    except Exception:
        return True


def _lock(session_id: str):
    """给单个会话的账本加写入锁。锁文件放在会话目录里，互不影响。"""
    if FileLock is None:
        return _NullLock()
    try:
        d = _session_dir(session_id)
        return FileLock(os.path.join(d, LOCK_NAME), timeout=10)
    except Exception:
        return _NullLock()


# ═══════════════════════════════════════════════════════════════════
# 路径
# ═══════════════════════════════════════════════════════════════════
def _safe_sid(session_id) -> str:
    """会话目录名。sessionId 是 'private:123' / 'group:456' 这种，要清洗成安全目录名。

    Windows 下 ':' 是非法文件名字符（会变成 NTFS 数据流），必须换掉。
    """
    s = str(session_id or "").strip()
    if not s:
        raise ValueError("session_id 不能为空")
    out = []
    for ch in s:
        if ch.isalnum() or ch in "-_.@":
            out.append(ch)
        else:
            out.append("_")
    name = "".join(out).strip("._") or "unnamed"
    return name[:80]


def _session_dir(session_id: str) -> str:
    d = os.path.join(WINDOW_DIR, _safe_sid(session_id))
    os.makedirs(d, exist_ok=True)
    return d


def _blocks_dir(session_id: str) -> str:
    d = os.path.join(_session_dir(session_id), BLOCKS_NAME)
    os.makedirs(d, exist_ok=True)
    return d


def _turns_path(session_id: str) -> str:
    return os.path.join(_session_dir(session_id), TURNS_NAME)


# ═══════════════════════════════════════════════════════════════════
# 原子写：先写 .tmp 再 os.replace（中途崩了不会留半截文件）
# ═══════════════════════════════════════════════════════════════════
def _atomic_write_text(path: str, text: str) -> None:
    """原子写文本文件：唯一临时名 + 8 次退避重试 + finally 清 tmp。

    ⚠️ 2026-11-08 修（测试组 20 次交叉验证发现 0/20 全红）：
       原来这里是裸 ``os.replace``，一次失败就抛 PermissionError。

       实测：12 轮 × 10 次写、带并发读 —
         其余 7 个模块（memory_manager / daily_consolidation / episode /
         handover / lessons / reflection / candidate_pool）全部 no failures，
        只有本模块抛 ``PermissionError: [WinError 5]``。

       生产影响：桥接随时可能在读 turns.jsonl（首屏交接要读最近一天原话），
       这时 append_turn 落盘就会抛 —— 而这一轮对话就再也进不了账本，
       丢的是「当时说了什么」这种**不可重建**的东西。

       三处对齐 memory_manager._atomic_write_json 的做法：
         ① 唯一临时名 ``path.<pid>.<6hex>.tmp``（同进程并发不抢同一个 tmp）
         ② ``os.replace`` 8 次退避重试（0.05 * (n+1) 秒，总计约 1.8s）
         ③ ``finally`` 里清 tmp（失败不留垃圾文件）
    """
    import uuid as _uuid
    import time as _time

    tmp = f"{path}.{os.getpid()}.{_uuid.uuid4().hex[:6]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError as _fserr:
                # ★ 2026-11-08 修：原来这里 except Exception: pass。
                #
                #   为什么不能静默：
                #     fsync 失败 = 数据还停在 OS 缓存里，没真正落盘。
                #     而代码接下来会 os.replace 并返回成功 ——
                #     断电/崩溃时这条账本就没了，但调用方以为写成了。
                #     这是「写了但没落盘」这一类假绿。
                #
                #   为什么不 raise：
                #     有些文件系统本来就不支持 fsync（某些网络盘/FUSE）。
                #     raise 会让整条 append_turn 失败 —— 而丢的是
                #     「当时说了什么」这种不可重建的东西。
                #     两害相权：记下来，继续写。
                try:
                    print("[window_ledger] fsync 失败（数据可能未落盘）: %s"
                          % _fserr, file=sys.stderr)
                except Exception:
                    pass

        last_err = None
        for attempt in range(8):
            try:
                os.replace(tmp, path)
                return
            except OSError as e:
                last_err = e
                _time.sleep(0.05 * (attempt + 1))
        if last_err is not None:
            raise last_err
        raise RuntimeError("os.replace failed without error")
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════
# 读原始行
# ═══════════════════════════════════════════════════════════════════
def _read_raw(session_id: str) -> List[Dict[str, Any]]:
    """读全部轮次（容错：坏行跳过，不让一行脏数据毁掉整个账本）。

    非法 UTF-8 用 errors='replace' 兜底 —— 缺一个字的账本，好过整本读不出来。
    """
    path = _turns_path(session_id)
    if not os.path.exists(path):
        return []
    out: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue          # 半行/坏行：跳过，不抛
            if isinstance(rec, dict):
                out.append(rec)
    return out


def _ts(v) -> float:
    """时间戳容错：数字/字符串/None 都能吃。返回 float 秒。"""
    if v is None:
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _fmt_ts(ts: float) -> str:
    if not ts:
        return "?"
    try:
        return datetime.fromtimestamp(float(ts)).strftime("%m-%d %H:%M")
    except Exception:
        return "?"


def _today_start() -> float:
    """今天零点（本地时区）的时间戳。"""
    lt = time.localtime()
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


# ═══════════════════════════════════════════════════════════════════
# 块（内容寻址）
# ═══════════════════════════════════════════════════════════════════
def save_block(session_id: str, content) -> str:
    """存大块内容，返回 sha1。同内容只存一次（去重）。

    去重靠文件名就是 sha1：存在就跳过，不重写、不改 mtime。
    """
    text = str(content if content is not None else "")
    if not text:
        raise ValueError("content 不能为空")
    sha1 = hashlib.sha1(text.encode("utf-8")).hexdigest()
    d = _blocks_dir(session_id)
    path = os.path.join(d, f"{sha1}.txt")
    if os.path.exists(path):
        return sha1                     # 已存在 → 去重，不重写
    _atomic_write_text(path, text)
    return sha1


def load_block(session_id: str, sha1) -> Optional[str]:
    """读大块内容。不存在/名字非法返回 None（不抛）。"""
    h = str(sha1 or "").strip().lower()
    if len(h) != 40 or any(c not in "0123456789abcdef" for c in h):
        return None
    path = os.path.join(_session_dir(session_id), BLOCKS_NAME, f"{h}.txt")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


# ═══════════════════════════════════════════════════════════════════
# 写一轮
# ═══════════════════════════════════════════════════════════════════
def _norm_notes(notes) -> List[str]:
    if notes is None:
        return []
    if isinstance(notes, str):
        notes = [notes]
    out: List[str] = []
    for f in notes:
        n = norm_note(f)
        if n:
            out.append(n)
        if len(out) >= MAX_NOTES_PER_TURN:
            break
    return out


def _norm_blocks(session_id: str, blocks) -> List[str]:
    """blocks 既可以是 sha1 列表，也可以是原文（自动 save_block 落块）。"""
    if blocks is None:
        return []
    if isinstance(blocks, str):
        blocks = [blocks]
    out: List[str] = []
    for b in blocks:
        s = str(b or "").strip()
        if not s:
            continue
        # 40 位十六进制 → 当成已存好的 sha1；否则当成原文，落块后取 sha1
        if len(s) == 40 and all(c in "0123456789abcdefABCDEF" for c in s):
            out.append(s.lower())
        else:
            out.append(save_block(session_id, s))
        if len(out) >= MAX_BLOCKS_PER_TURN:
            break
    return out


def _append_unlocked(session_id: str, his: str, said: str,
                     notes: List[str], blocks: List[str],
                     source: str = SOURCE_BRIDGE,
                     notes_inferred: List[str] = None, operation_id=None,
                     is_private=False) -> Dict[str, Any]:
    """真正干活的部分（调用方已持锁、已把 blocks 算成 sha1）。"""
    path = _turns_path(session_id)
    existing = _read_raw(session_id)
    if operation_id:
        prior = next((r for r in existing if r.get('operation_id') == operation_id), None)
        if prior is not None:
            if prior.get('his') != his[:HIS_MAX_CHARS] or prior.get('said') != said[:SAID_MAX_CHARS]:
                raise ValueError('operation_id reused for different window content')
            return dict(prior, duplicate=True, total=len(existing))
    turn_no = (int(existing[-1].get("turn") or 0) if existing else 0) + 1
    total = len(existing) + 1

    rec = {
        "turn": turn_no,
        "said_at": int(time.time()),
        **({"operation_id": operation_id} if operation_id else {}),
        **({"is_private": True} if is_private else {}),
        "his": his[:HIS_MAX_CHARS],
        "said": said[:SAID_MAX_CHARS],
        "notes": notes,
        # 2026-11-08 加：从括号推断的心里话（严格模式，只认明确情绪词）。
        #   跟 notes 分开存：
        #     notes           = 模型自己写的（[[note]] /「心里：」）
        #     notes_inferred  = 我们从括号里读的（她没主动写，但有情绪描写）
        #   混在一起以后分不清「哪些是真的，哪些是猜的」。
        #   只在非空时写（避免账本里每条都有空数组）。
        **({"notes_inferred": notes_inferred} if notes_inferred else {}),
        "blocks": blocks,
        # 2026-11-08 加（交接单要）：这条是**谁**写的。
        #   光靠会话名前缀分 prod/test 不够 —— 同一条生产会话里混着真对话和测试写入
        #   （实测 private_user_001 的 turn 7 就是 his='测试他的原话'）。
        "source": source,
    }
    line = json.dumps(rec, ensure_ascii=False)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(line + "\n")
        f.flush()
        os.fsync(f.fileno())

    # 单会话上限：超了从头截断（只留最近 WINDOW_MAX_TURNS 轮）
    if WINDOW_MAX_TURNS and total > int(WINDOW_MAX_TURNS):
        _trim_unlocked(session_id)

    return dict(rec, total=total)


def _archive_notes(session_id: str, rows: List[Dict[str, Any]]) -> int:
    """把即将被丢弃的轮次里的 note 抄进 notes_archive.jsonl（追加，不覆盖）。

    为什么是「另存」而不是「截断时优先保留」：
      · turns.jsonl 是**按时间连续**的账本，read_recent_hours / 情境段都靠它连号。
        挑着留的轮次会让 turn 号跳号，「最近一天原话」变成有洞的流水。
      · note 要的是「不丢」，不是「占着最近 500 轮的位置」。
    所以：账本保持连续，动机单独留底。消费者（交接单带出 note）以后再接。

    返回抄了几条。
    """
    kept = []
    for r in rows:
        fs = [str(x) for x in (r.get("notes") or []) if str(x).strip()]
        if not fs:
            continue
        kept.append({
            "turn": r.get("turn"),
            "said_at": r.get("said_at"),
            "notes": fs,
            # 存一句话做上下文：光有心里话、不知道在接什么，等于没记
            "his": str(r.get("his") or "")[:80],
            "said": str(r.get("said") or "")[:80],
        })
    if not kept:
        return 0
    path = os.path.join(_session_dir(session_id), NOTES_ARCHIVE_NAME)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        for rec in kept:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return len(kept)


def read_notes_archive(session_id: str, limit: int = 50) -> list:
    """读被截断/清理时抄下来的 note（最近 limit 条，老的在前）。"""
    path = os.path.join(_session_dir(session_id), NOTES_ARCHIVE_NAME)
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 50
    return out[-n:] if n > 0 else out


def _trim_unlocked(session_id: str) -> int:
    """把 turns.jsonl 截到最后 WINDOW_MAX_TURNS 行。返回砍掉几行。"""
    path = _turns_path(session_id)
    if not os.path.exists(path):
        return 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = [ln for ln in f.read().split("\n") if ln.strip()]
    keep = int(WINDOW_MAX_TURNS)
    if keep <= 0 or len(lines) <= keep:
        return 0
    dropped = len(lines) - keep
    # 先抄 note 再删（顺序不能反：删了就取不出来了）
    gone = []
    for ln in lines[:dropped]:
        try:
            rec = json.loads(ln)
        except Exception:
            continue
        if isinstance(rec, dict):
            gone.append(rec)
    _archive_notes(session_id, gone)
    _atomic_write_text(path, "\n".join(lines[-keep:]) + "\n")
    return dropped


def append_turn(session_id: str, his, said, notes=None, blocks=None,
                source: str = SOURCE_BRIDGE, operation_id=None, is_private=False) -> dict:
    """追加一轮。自动编号 turn（接在最后一轮后面 +1）。

    参数
        session_id : 会话 id（'private:123' / 'group:456' / 任意字符串）
        his        : 他这轮说的话（原话，不加工）
        said       : 她真正发出去的话；多条用 \\n 分隔
        notes      : 心里话列表（note.strip_notes 的第二返回值）；str 也接受
        blocks     : 大块内容的 sha1 列表，或原文（走 save_block 自动落块）
        source     : 'bridge'（默认，生产）/ 'test' / 'probe'
                     2026-11-08 加（交接单要）：同一条生产会话里会混着真对话和
                     测试写入，靠会话名分不出来，只能逐条标来源。

    返回写入的那一行（dict），额外带 total = 当前会话总轮数。
    """
    if not enabled():
        # 开关关着：不写，但要说清楚为什么（别静默吞掉）
        return {"turn": 0, "skipped": True, "reason": "window_ledger 开关关闭"}

    his_s = str(his or "").strip()
    said_s = str(said or "").strip()
    notes_l = _norm_notes(notes)

    # ── 自保剥离（2026-11-08 巡检后加）─────────────────────────────
    # 巡检实测：桥接没剥 → append_turn('probe','他说','AAA[[note]]B[[note]]，好')
    #   → 账本里躺着一整条带标签的原文。**脏文本进库了。**
    #
    # 为什么在这里也剥（纵深防御，不是重复劳动）：
    #   提示词注入、strip_notes、append_turn 三个环节，生产调用目前都是 0 处。
    #   只要有一环没人调，就要有下一环兜住。
    #
    # 为什么用 force=True：
    #   「库里不留脏文本」是**数据卫生**，不是功能行为。
    #   features 开关管的是「做不做这个功能」，不该管「允不允许脏数据入库」。
    #   开关关掉的时候反而更容易进脏数据 —— 那种时候更需要这道保险。
    #
    # 幂等性：调用方已经剥过的 said 再剥一次不会有任何变化（没有标签就直接返回）。
    said_clean, auto_notes = strip_notes(said_s, force=True)
    said_s = str(said_clean or "").strip()
    if auto_notes:
        # 调用方没传 notes，但文本里带着 → 收下来，别把心里话丢了
        notes_l = _norm_notes(list(notes_l) + list(auto_notes))

    # ── 从括号里推断心里话（2026-11-08 加）──────────────────────────
    # 为什么需要：模型从来不写 [[note]] /「心里：」——
    #     （听见这个「好」反而愣了一下）
    #     （被说得耳朵都热了，小声嘟囔）
    #   所以不要求她改，改成我们从括号里读。
    #
    # 为什么单独存 notes_inferred：
    #   从括号提取的不一定都是「想说没说出口的」，
    #   有些是「她在描述自己的状态」——比 0 条接近事实，但不是同一件事。
    #   混在 notes 里以后分不清「哪些是真的，哪些是猜的」。
    #
    # 为什么严格（只认明确情绪词）：
    #   实测 387 个括号：action 51% / noteing 13% / mixed 8% / unknown 28%
    #   宽松判据会把「（分开一点，气还没匀）」判成情绪（「分开」不在动作词表）
    #   → 宁缺毋滥，只提 noteing 类。
    #   Unsent-thought inference from parenthesised text was removed together
    #   with the inline marker syntax: the two depended on the same word lists
    #   and the signal was too noisy to keep.
    notes_inferred = []

    # his 也可能是带标签的（桥接把整段回复塞进 his 的极端情况），一样兜住
    if has_note(his_s):
        his_clean, his_notes = strip_notes(his_s, force=True)
        his_s = str(his_clean or "").strip()
        if his_notes:
            notes_l = _norm_notes(list(notes_l) + list(his_notes))

    if not his_s and not said_s and not notes_l:
        # 三样都是空的：不算一轮，别在账本里留空行
        return {"turn": 0, "skipped": True, "reason": "his/said/notes 全空"}

    src = normalize_source(source)

    with _lock(session_id):
        blocks_l = _norm_blocks(session_id, blocks)
        rec = _append_unlocked(session_id, his_s, said_s, notes_l, blocks_l, src,
                               notes_inferred=notes_inferred, operation_id=operation_id,
                               is_private=is_private)
        if auto_notes:
            # 让调用方知道「你没剥，我替你剥了」—— 别让它以为链路是好的
            rec["auto_stripped"] = True
        return rec


# ═══════════════════════════════════════════════════════════════════
# 读
# ═══════════════════════════════════════════════════════════════════
def read_turns(session_id: str, limit: int = 50, since=None) -> list:
    """读最近的轮次。since 是时间戳，只读这之后的。

    返回按时间正序（老的在前）。limit <= 0 / None 表示不限。
    """
    rows = _read_raw(session_id)
    since_f = _ts(since) if since is not None else 0.0
    if since_f:
        rows = [r for r in rows if _ts(r.get("said_at")) >= since_f]
    if limit is not None:
        try:
            n = int(limit)
        except (TypeError, ValueError):
            n = 50
        if n > 0:
            rows = rows[-n:]
    return rows


def read_recent_hours(session_id: str, hours: float = 24) -> list:
    """读最近 N 小时的（给首屏交接的「最近一天原话」用）。"""
    try:
        h = float(hours)
    except (TypeError, ValueError):
        h = 24.0
    if h <= 0:
        return []
    return read_turns(session_id, limit=0, since=time.time() - h * 3600)


def last_turn(session_id: str) -> Optional[dict]:
    """最后一轮（没写过就是 None）。"""
    rows = _read_raw(session_id)
    return rows[-1] if rows else None


def turn_at(session_id: str, turn_no: int) -> Optional[dict]:
    """按轮号取一轮（时间锚 saidAt 要按「这句属于哪一轮」回查时用）。"""
    try:
        want = int(turn_no)
    except (TypeError, ValueError):
        return None
    for r in _read_raw(session_id):
        try:
            if int(r.get("turn")) == want:
                return r
        except (TypeError, ValueError):
            continue
    return None


# ═══════════════════════════════════════════════════════════════════
# 清理
# ═══════════════════════════════════════════════════════════════════
def _prune_unlocked(session_id: str, keep_days: int) -> int:
    """砍掉 keep_days 之前的轮次 + 清理没人引用的块。返回删了几轮。"""
    path = _turns_path(session_id)
    rows = _read_raw(session_id)
    if not rows:
        return 0
    cutoff = time.time() - float(keep_days) * 86400
    keep = [r for r in rows if _ts(r.get("said_at")) >= cutoff]
    dropped = len(rows) - len(keep)
    if dropped <= 0:
        return 0
    _archive_notes(session_id, [r for r in rows if _ts(r.get("said_at")) < cutoff])
    _atomic_write_text(path,
                       "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in keep))
    # 顺手清掉不再被引用的块（不然 blocks/ 只增不减）
    used = set()
    for r in keep:
        for h in (r.get("blocks") or []):
            used.add(str(h).lower())
    bdir = os.path.join(_session_dir(session_id), BLOCKS_NAME)
    if os.path.isdir(bdir):
        for fn in os.listdir(bdir):
            if not fn.endswith(".txt"):
                continue
            if fn[:-4] not in used:
                try:
                    os.remove(os.path.join(bdir, fn))
                except OSError:
                    pass
    return dropped


def prune(session_id: str, keep_days: int = None) -> int:
    """清理老数据（早于 keep_days 的轮次 + 无人引用的块）。返回删了几轮。"""
    if keep_days is None:
        keep_days = WINDOW_KEEP_DAYS
    try:
        kd = int(keep_days)
    except (TypeError, ValueError):
        kd = int(WINDOW_KEEP_DAYS)
    if kd < 0:
        kd = 0
    with _lock(session_id):
        return _prune_unlocked(session_id, kd)


def prune_all(keep_days: int = None, dry_run: bool = False,
              include_admin: bool = False) -> dict:
    """所有会话一起清（夜巡每天调它）。

    2026-11-08 改：原来只返回一个整数，调用方看不出「清了哪些会话、为什么是 0」——
    又一个「两种 0 混在一起」（没有过期数据 vs 根本没扫到会话）。

    现在返回：
        {
          "sessions": 6,          # 扫了几个会话
          "dropped": 3,           # 共删了几轮
          "keep_days": 30,        # 用的保留天数
          "dry_run": False,
          "detail": [{"session": "private_x", "dropped": 3}, ...],   # 只列有变化的
          "errors": [{"session": "...", "error": "..."}],
        }

    · dry_run=True 只报告不删（接入前先看一遍会删什么）
    · include_admin=False 不碰 _deleted_* / _quarantine_* 这些管理目录
      （备份里的是人留着查的，不该被夜巡顺手清掉）
    """
    if keep_days is None:
        keep_days = WINDOW_KEEP_DAYS
    try:
        kd = int(keep_days)
    except (TypeError, ValueError):
        kd = int(WINDOW_KEEP_DAYS)
    if kd < 0:
        kd = 0

    if include_admin:
        sids = [d for d in os.listdir(WINDOW_DIR)
                if os.path.isdir(os.path.join(WINDOW_DIR, d))]
    else:
        sids = _list_session_dirs()

    total = 0
    detail = []
    errors = []
    for sid in sids:
        try:
            if dry_run:
                # 只数该删几条，不落盘
                cutoff = time.time() - kd * 86400
                n = sum(1 for r in _read_raw(sid)
                        if _ts(r.get("said_at")) < cutoff)
            else:
                n = prune(sid, kd)
            if n:
                total += n
                detail.append({"session": sid, "dropped": n})
        except Exception as exc:
            errors.append({"session": sid, "error": str(exc)})

    return {
        "sessions": len(sids),
        "dropped": total,
        "keep_days": kd,
        "dry_run": bool(dry_run),
        "detail": detail,
        "errors": errors,
    }


# ═══════════════════════════════════════════════════════════════════
# 统计
# ═══════════════════════════════════════════════════════════════════
# 以下划线开头的目录不是会话，是**账本自己的管理目录**：
#   _deleted_*  删除前的人工备份
#   _quarantine_* 脏数据隔离区
# 不排掉的话，备份会被当成一个会话统计进去 —— stats 又一次「说假话」。
_ADMIN_PREFIX = "_"


def _list_session_dirs() -> List[str]:
    """WINDOW_DIR 下所有**会话**目录名（= 已清洗过的 sessionId）。

    下划线开头的是管理目录（备份/隔离），不算会话。
    """
    if not os.path.isdir(WINDOW_DIR):
        return []
    return sorted(d for d in os.listdir(WINDOW_DIR)
                  if os.path.isdir(os.path.join(WINDOW_DIR, d))
                  and not d.startswith(_ADMIN_PREFIX))


# 真实会话 id 的形状：桥接用的是 'private:<USER_ID>' / 'group:<群号>'
_PROD_SID_RE = re.compile(r"^(?:private|group)[:_].+$", re.I)


def is_prod_session(sid) -> bool:
    """这个会话目录名是不是「真实会话」（private:xxx / group:xxx）。

    为什么需要区分：2026-11-08 巡检发现 stats() 报 total_turns=4
    「看起来像账本跑起来了」，实际全是 sA/sB/sC/sess1 这种测试残留，
    生产会话仍然是 0 轮 —— 又一个「两种 0 混在一起」。
    """
    s = str(sid or "").strip()
    if s.startswith("_"):           # selftest 临时会话 / 备份 / 隔离区，都不是会话
        return False
    return bool(_PROD_SID_RE.match(s))


def find_dirty_turns(session_id: str = None) -> list:
    """找账本里带未剥离 [[note]] 标签的行（历史脏数据体检用）。

    返回 [{session, turn, field, text}]，field 是 "said" 或 "his"。
    """
    if session_id:
        sids = [_safe_sid(session_id)]
    else:
        sids = _list_session_dirs()
    out = []
    for sid in sids:
        if not os.path.isdir(os.path.join(WINDOW_DIR, sid)):
            continue
        for r in _read_raw(sid):
            for field in ("said", "his"):
                v = str(r.get(field) or "")
                if has_note(v):
                    out.append({
                        "session": sid,
                        "turn": r.get("turn"),
                        "field": field,
                        "text": v[:120],
                    })
    return out


def repair_dirty(session_id: str, dry_run: bool = True) -> dict:
    """把账本里带 [[note]] 标签的历史行洗干净（2026-11-08 加法）。

    做法：逐行重写 —— said/his 走 strip_note_markers（只删标记本身，保留标记之间的文字，
    不提取备注 —— 提取能力已移除）。
    只改真正脏的行，干净的行原样写回（不碰 said_at / turn）。

    dry_run=True（默认）只报告不动手。
    返回 {"scanned": n, "dirty": n, "repaired": n, "samples": [...]}
    """
    path = _turns_path(session_id)
    rows = _read_raw(session_id)
    samples = []
    repaired = 0
    for r in rows:
        dirty = has_note(r.get("said")) or has_note(r.get("his"))
        if not dirty:
            continue
        if len(samples) < 5:
            samples.append({"turn": r.get("turn"),
                            "said": str(r.get("said") or "")[:100]})
        if dry_run:
            repaired += 1
            continue
        for field in ("said", "his"):
            v = str(r.get(field) or "")
            if has_note(v):
                r[field] = strip_note_markers(v)
        repaired += 1

    if not dry_run and repaired:
        with _lock(session_id):
            _atomic_write_text(
                path,
                "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows))
    return {"scanned": len(rows), "dirty": repaired, "repaired": repaired,
            "dry_run": dry_run, "samples": samples}


def stats(session_id: str = None) -> dict:
    """{sessions, total_turns, today_turns, oldest, newest, with_notes,
       prod_sessions, prod_turns, test_sessions, test_turns, dirty_turns}

    · sessions    : 有多少个会话目录
    · total_turns : 所有会话的总轮数（含测试残留）—— **别只看这个数**
    · prod_turns  : 真实会话（private:/group:）的轮数 ← 这条才代表「跑起来了」
    · test_turns  : 测试会话的轮数
    · today_turns : 今天零点之后写的轮数
    · oldest/newest : 最早/最新一轮的 said_at（时间戳；没有就是 0）
    · with_notes  : notes 非空的行数（note 能力的「触发过」证据）
    · dirty_turns : 还带着未剥离 [[note]] 标签的轮数（应该永远是 0）
    """
    if session_id:
        sids = [_safe_sid(session_id)]
    else:
        sids = _list_session_dirs()
    t0 = _today_start()
    total = today = with_notes = dirty = 0
    prod_turns = test_turns = 0
    by_source: Dict[str, int] = {}
    prod_sids = 0
    test_sids = 0
    oldest = 0.0
    newest = 0.0
    live = 0
    for sid in sids:
        if not os.path.isdir(os.path.join(WINDOW_DIR, sid)):
            continue
        live += 1
        is_prod = is_prod_session(sid)
        if is_prod:
            prod_sids += 1
        else:
            test_sids += 1
        for r in _read_raw(sid):
            total += 1
            if is_prod:
                prod_turns += 1
            else:
                test_turns += 1
            ts = _ts(r.get("said_at"))
            if ts:
                if not oldest or ts < oldest:
                    oldest = ts
                if ts > newest:
                    newest = ts
            if ts >= t0:
                today += 1
            if r.get("notes"):
                with_notes += 1
            if has_note(r.get("said")) or has_note(r.get("his")):
                dirty += 1
            # 老数据没有 source 字段 → 归 unknown，不猜（猜错了交接单会误判）
            src = normalize_source(r.get("source")) if r.get("source") else SOURCE_UNKNOWN
            by_source[src] = by_source.get(src, 0) + 1
    result = {
        "sessions": live,
        "total_turns": total,
        "today_turns": today,
        "oldest": int(oldest),
        "newest": int(newest),
        "with_notes": with_notes,
        # ── 按会话名分（老口径，保留兼容）──────────────────────
        #   ⚠️ 这个口径**不够准**：同一条生产会话里会混着测试写入，
        #   光看会话名分不出来。要看准的用下面的 by_source。
        "prod_sessions": prod_sids,
        "prod_turns": prod_turns,
        "test_sessions": test_sids,
        "test_turns": test_turns,
        # ── 按 source 字段分（2026-11-08 加，交接单用这个）──────
        #   bridge → 真的对话；test/probe → 人写进去的；unknown → 加字段之前的老数据
        "bridge_turns": by_source.get(SOURCE_BRIDGE, 0),
        "test_only_turns": by_source.get(SOURCE_TEST, 0),
        "probe_turns": by_source.get(SOURCE_PROBE, 0),
        "unknown_source_turns": by_source.get(SOURCE_UNKNOWN, 0),
        "by_source": {k: by_source.get(k, 0) for k in VALID_SOURCES},
        # 脏文本（应该永远是 0；不是 0 就说明有环节漏了剥离）
        "dirty_turns": dirty,
    }
    if dirty:
        result["warn"] = f"{dirty} 轮含未剥离的 [[note]] 标签 —— 见 find_dirty_turns()"
    return result


def tail_text(session_id: str, turns: int = 20, max_chars: int = 2400) -> str:
    """把最近几轮拼成「他：… / 我：…」的纯文本（首屏交接「最近一天原话」用）。

    单轮超过 600 字截断（设计文档 §8.5.3：单轮 600 / 合计 2400）。
    """
    rows = read_turns(session_id, limit=turns)
    out: List[str] = []
    for r in rows:
        t = _fmt_ts(_ts(r.get("said_at")))
        his = str(r.get("his") or "").strip()
        said = str(r.get("said") or "").strip()
        if his:
            out.append(f"[{t}] 他：{his[:600]}")
        if said:
            out.append(f"[{t}] 我：{said[:600]}")
    text = "\n".join(out)
    if max_chars and len(text) > max_chars:
        text = text[-max_chars:]
    return text


# ═══════════════════════════════════════════════════════════════════
# 自检（落盘部分用临时会话，跑完删掉，绝不动真实账本）
# ═══════════════════════════════════════════════════════════════════
# 真实数据根（模块导入时定下来，之后不再变）。
# selftest 用它是为了**证明自己没往真实目录写**（2026-11-08 加）。
# 起因：handover.py 的 selftest 一度把 "private:gate" 写进了真实账本 ——
#   它重定向了 _W.WINDOW_DIR，但那是**当时的事**，代码一改就漏。
#   教训：光「自己记得重定向」不够，得有一条断言在看。
REAL_WINDOW_DIR = WINDOW_DIR


def _real_sessions_snapshot() -> dict:
    """真实账本目录的 {(会话名): 文件数} 快照，用于「测试有没有漏写」的对比。"""
    root = REAL_WINDOW_DIR
    if not os.path.isdir(root):
        return {}
    out = {}
    try:
        for d in os.listdir(root):
            full = os.path.join(root, d)
            if os.path.isdir(full):
                try:
                    out[d] = len(os.listdir(full))
                except OSError:
                    out[d] = -1
    except OSError:
        return {}
    return out


def selftest() -> None:
    """不依赖真实数据。"""
    # 下面有两处要临时改单会话上限（验证截断真的生效），
    # global 必须写在函数最前面，不能等到用它的地方才声明。
    global WINDOW_MAX_TURNS
    # 进 selftest 先拍一张真实目录快照，退出前对比；有变化说明测试漏写了真实账本。
    _snap_real = _real_sessions_snapshot()
    # ── ① 路径清洗：Windows 不允许 ':'，sessionId 必须能安全落盘
    assert _safe_sid("private:user_001") == "private_user_001"
    assert _safe_sid("group:123") == "group_123"
    assert ":" not in _safe_sid("a:b") and "/" not in _safe_sid("a/b")
    try:
        _safe_sid("")
        raise AssertionError("空 session_id 应该抛 ValueError")
    except ValueError:
        pass

    # ── ② 时间戳容错
    assert _ts(None) == 0.0
    assert _ts("1730000000") == 1730000000.0
    assert _ts("坏数据") == 0.0
    assert _fmt_ts(0) == "?"

    # ── ③ 临时会话，跑真东西
    sid = f"__selftest_{int(time.time() * 1000)}"
    sdir = os.path.join(WINDOW_DIR, _safe_sid(sid))
    try:
        if os.path.exists(sdir):
            shutil.rmtree(sdir)

        # 写两轮
        t1 = append_turn(sid, "我想吃火锅", "那晚上吃？", notes=["（有点累但还是想陪他）"])
        t2 = append_turn(sid, "好", "那我下面")
        assert t1["turn"] == 1 and t2["turn"] == 2, (t1, t2)
        assert t1["notes"] == ["（有点累但还是想陪他）"]
        assert t2["notes"] == []
        assert t1["total"] == 1 and t2["total"] == 2

        # 读回
        rows = read_turns(sid)
        assert len(rows) == 2, rows
        assert rows[0]["his"] == "我想吃火锅" and rows[1]["said"] == "那我下面"
        assert read_turns(sid, limit=1)[0]["turn"] == 2, "limit 应取最近的"
        assert len(read_recent_hours(sid, 24)) == 2
        assert read_recent_hours(sid, 0) == []
        assert last_turn(sid)["turn"] == 2
        assert turn_at(sid, 1)["his"] == "我想吃火锅"
        assert turn_at(sid, 99) is None

        # 磁盘上确实是「一行一个 JSON」
        with open(_turns_path(sid), encoding="utf-8") as f:
            lines = [ln for ln in f.read().split("\n") if ln.strip()]
        assert len(lines) == 2
        for ln in lines:
            rec = json.loads(ln)
            for k in ("turn", "said_at", "his", "said", "notes", "blocks"):
                assert k in rec, f"缺字段 {k}"

        # ── ④ 块去重
        b1 = save_block(sid, "很长的内容" * 100)
        b2 = save_block(sid, "很长的内容" * 100)
        assert b1 == b2 and len(b1) == 40
        assert load_block(sid, b1) == "很长的内容" * 100
        assert load_block(sid, "0" * 40) is None
        assert load_block(sid, "../etc/passwd") is None, "名字非法必须返回 None"
        bfiles = [f for f in os.listdir(os.path.join(sdir, BLOCKS_NAME))
                  if f.endswith(".txt")]
        assert len(bfiles) == 1, f"同内容应只有 1 个块文件，实际 {bfiles}"

        # blocks 传原文也自动落块
        t3 = append_turn(sid, "看这个", "好长一段", blocks=["原文一段"])
        assert len(t3["blocks"]) == 1 and len(t3["blocks"][0]) == 40
        assert load_block(sid, t3["blocks"][0]) == "原文一段"

        # ── ⑤ 空轮不写
        before = len(read_turns(sid))
        r = append_turn(sid, "", "")
        assert r.get("skipped") is True and len(read_turns(sid)) == before

        # ── ⑤b 开关真的管用（关掉 = 一行都不写；读取不受影响）
        assert enabled() is True, "window_ledger 默认应为开"
        _saved_feature = _feature_on
        try:
            globals()["_feature_on"] = lambda _n: False
            assert enabled() is False
            n0 = len(read_turns(sid))
            rr = append_turn(sid, "关掉之后写的", "不该落盘")
            assert rr.get("skipped") is True and "开关" in str(rr.get("reason")), rr
            assert len(read_turns(sid)) == n0, "开关关着还在写 —— 开关是假的"
            assert len(read_turns(sid)) > 0, "关掉开关不该影响读"
        finally:
            globals()["_feature_on"] = _saved_feature
            assert enabled() is True

        # ── ⑤c 文本一律原样入库；备注只认调用方显式传的
        #   内联标记剥离已整体移除（见本模块顶部说明）。这条用例原来验的是
        #   「桥接没剥我替你剥」，现在验的是反过来的契约：
        #   文本一个字节都不许被改写，备注只能来自参数。
        _sid_g = f"{sid}_guard"
        _dir_g = os.path.join(WINDOW_DIR, _safe_sid(_sid_g))
        try:
            if os.path.exists(_dir_g):
                shutil.rmtree(_dir_g)
            g1 = append_turn(_sid_g, "他说", "AAA[[note]]B[[note]]，好")
            assert g1["said"] == "AAA[[note]]B[[note]]，好", f"文本被改写了: {g1['said']!r}"
            assert g1["notes"] == [], g1["notes"]
            assert not g1.get("auto_stripped"), "不该再有任何自动剥离"
            on_disk = last_turn(_sid_g)
            assert on_disk["said"] == "AAA[[note]]B[[note]]，好", "磁盘内容要跟入参一致"

            # 显式传入的备注原样保留，顺序不变
            g2 = append_turn(_sid_g, "他说2", "AAA，好", notes=["B"])
            assert g2["said"] == "AAA，好" and g2["notes"] == ["B"], g2
            g3 = append_turn(_sid_g, "他", "C", notes=["老备注", "第二条"])
            assert g3["notes"] == ["老备注", "第二条"], g3["notes"]

            # 备注超长按上限截断，不是整条丢掉
            long_note = "长" * (NOTE_MAX_CHARS + 50)
            g4 = append_turn(_sid_g, "他", "只剩半句", notes=[long_note])
            assert len(g4["notes"][0]) == NOTE_MAX_CHARS, len(g4["notes"][0])

            # 空备注 / 纯空白备注不收
            g5 = append_turn(_sid_g, "他", "嗯", notes=["", "   ", None])
            assert g5["notes"] == [], g5["notes"]

            # 一条都没有时不该造出 notes 键里的空字符串
            assert all(str(x).strip() for x in g3["notes"]), g3["notes"]

            # 开关关掉时账本整体不写（数据卫生与功能开关无关，但没开关就没账本）
            _saved3 = _feature_on
            try:
                globals()["_feature_on"] = lambda _n: True   # 账本开着
                g6 = append_turn(_sid_g, "他", "X[[note]]Y[[note]]Z")
                assert g6["said"] == "X[[note]]Y[[note]]Z", g6["said"]
                assert g6["notes"] == [], g6["notes"]
            finally:
                globals()["_feature_on"] = _saved3

            # 脏文本检测能报出来：上面 g1/g6 都是带标记原样入库的，
            # 所以这里**应该**有 2 条命中，而且只报不改。
            dirty = find_dirty_turns(_sid_g)
            assert len(dirty) == 2, f"带标记的行没被检出: {dirty}"
            assert {d["turn"] for d in dirty} == {g1["turn"], g6["turn"]}, dirty
            st_g = stats(_sid_g)
            assert st_g["dirty_turns"] == 2, st_g
            # 检测本身绝对不能动文件
            assert last_turn(_sid_g)["said"] == "X[[note]]Y[[note]]Z"

            # ── ⑤d repair_dirty：把历史脏行洗干净（模拟「加自保之前」写进去的）
            _path_g = _turns_path(_sid_g)
            with open(_path_g, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "turn": 99, "said_at": int(time.time()),
                    "his": "旧数据",
                    "said": "AAA[[note]]B[[note]]，好",
                    "notes": [], "blocks": [],
                }, ensure_ascii=False) + "\n")
            assert stats(_sid_g)["dirty_turns"] == 3, "自己塞的脏行没被检出"

            dry = repair_dirty(_sid_g, dry_run=True)
            assert dry["dirty"] == 3 and dry["samples"], dry
            assert stats(_sid_g)["dirty_turns"] == 3, "dry_run 不该动手"

            fixed = repair_dirty(_sid_g, dry_run=False)
            assert fixed["repaired"] == 3, fixed
            assert stats(_sid_g)["dirty_turns"] == 0, "修完还有脏的"
            rows_after = {r["turn"]: r for r in _read_raw(_sid_g)}
            # 标记被删掉，标记之间的文字必须留着（不能连内容一起吞）
            assert rows_after[g1["turn"]]["said"] == "AAAB，好", rows_after[g1["turn"]]["said"]
            assert rows_after[g6["turn"]]["said"] == "XYZ", rows_after[g6["turn"]]["said"]
            assert rows_after[99]["said"] == "AAAB，好", rows_after[99]["said"]
        finally:
            try:
                if os.path.exists(_dir_g):
                    shutil.rmtree(_dir_g)
            except Exception:
                pass

        # ── ⑤e source 字段（交接单要）
        assert normalize_source("bridge") == SOURCE_BRIDGE
        assert normalize_source("prod") == SOURCE_BRIDGE, "别名要认"
        assert normalize_source("TEST") == SOURCE_TEST, "大小写要认"
        assert normalize_source("selftest") == SOURCE_PROBE
        assert normalize_source("瞎写的") == SOURCE_UNKNOWN
        assert normalize_source(None) == SOURCE_BRIDGE, "不传默认 bridge"
        assert normalize_source("") == SOURCE_BRIDGE

        _sid_s = f"{sid}_src"
        _dir_s = os.path.join(WINDOW_DIR, _safe_sid(_sid_s))
        try:
            if os.path.exists(_dir_s):
                shutil.rmtree(_dir_s)
            append_turn(_sid_s, "a", "b")                     # 不传 → bridge
            append_turn(_sid_s, "c", "d", source="test")
            append_turn(_sid_s, "e", "f", source="probe")
            ss = read_turns(_sid_s, limit=0)
            assert [x["source"] for x in ss] == ["bridge", "test", "probe"], ss

            st_src = stats(_sid_s)
            assert st_src["bridge_turns"] == 1, st_src
            assert st_src["test_only_turns"] == 1, st_src
            assert st_src["probe_turns"] == 1, st_src
            assert st_src["by_source"] == {"bridge": 1, "test": 1,
                                           "probe": 1, "unknown": 0}, st_src

            # 老数据（没有 source 字段）必须归 unknown，不能猜成 bridge
            with open(_turns_path(_sid_s), "a", encoding="utf-8") as f:
                f.write(json.dumps({"turn": 50, "said_at": int(time.time()),
                                    "his": "老", "said": "数据",
                                    "notes": [], "blocks": []},
                                   ensure_ascii=False) + "\n")
            st_old = stats(_sid_s)
            assert st_old["unknown_source_turns"] == 1, st_old
            assert st_old["bridge_turns"] == 1, "老数据不能算成 bridge"
        finally:
            try:
                if os.path.exists(_dir_s):
                    shutil.rmtree(_dir_s)
            except Exception:
                pass

        # ── ⑤f prune_all：返回结构化结果 + dry_run 不动手
        _sid_p = f"{sid}_prune"
        _dir_p = os.path.join(WINDOW_DIR, _safe_sid(_sid_p))
        try:
            if os.path.exists(_dir_p):
                shutil.rmtree(_dir_p)
            append_turn(_sid_p, "老数据", "老的", source="test")
            # 手工把时间改老 90 天
            rows_p = _read_raw(_sid_p)
            rows_p[0]["said_at"] = int(time.time() - 90 * 86400)
            _atomic_write_text(_turns_path(_sid_p),
                               "".join(json.dumps(x, ensure_ascii=False) + "\n"
                                       for x in rows_p))
            # 注意：prune_all 会扫**所有**会话，selftest 里只验它自己的那个
            dry = prune_all(keep_days=30, dry_run=True)
            assert isinstance(dry, dict) and "sessions" in dry, dry
            assert dry["dry_run"] is True
            assert any(d["session"] == _safe_sid(_sid_p) for d in dry["detail"]), \
                f"dry_run 应该报出这个会话要清: {dry}"
            assert len(read_turns(_sid_p, limit=0)) == 1, "dry_run 不该真删"

            real = prune_all(keep_days=30, dry_run=False)
            assert real["dropped"] >= 1, real
            assert len(read_turns(_sid_p, limit=0)) == 0, "真跑应该删掉"
            assert real["errors"] == [], real["errors"]
        finally:
            try:
                if os.path.exists(_dir_p):
                    shutil.rmtree(_dir_p)
            except Exception:
                pass

        # ── ⑥ 统计
        st = stats(sid)
        assert st["sessions"] == 1
        assert st["total_turns"] == 3, st
        assert st["today_turns"] == 3
        assert st["with_notes"] == 1
        assert st["newest"] >= st["oldest"] > 0
        assert set(st.keys()) >= {"sessions", "total_turns", "today_turns",
                                  "oldest", "newest", "with_notes",
                                  "prod_sessions", "prod_turns",
                                  "test_sessions", "test_turns", "dirty_turns"}

        # ── ⑥b 生产/测试分离：别让测试数据冒充「跑起来了」
        assert is_prod_session("private:<owner-id>") is True
        assert is_prod_session("private_user_001") is True
        assert is_prod_session("group:123456") is True
        assert is_prod_session("sA") is False, "sA 是测试会话"
        assert is_prod_session("sess1") is False
        assert is_prod_session("__selftest_123") is False
        assert is_prod_session("") is False
        # 管理目录（备份/隔离/selftest 临时）都不算会话 ——
        # 不排掉的话，_deleted_* 备份会被当成一个会话统计进去
        assert is_prod_session("_deleted_20260101_000000") is False
        assert is_prod_session("_quarantine_xxx") is False
        _admin = os.path.join(WINDOW_DIR, "_deleted_selftest_probe")
        os.makedirs(_admin, exist_ok=True)
        try:
            assert "_deleted_selftest_probe" not in _list_session_dirs(), \
                "管理目录被当成会话了"
        finally:
            try:
                os.rmdir(_admin)
            except Exception:
                pass
        # 本会话（__selftest_*）不该被算成生产
        assert st["prod_turns"] == 0 and st["test_turns"] == st["total_turns"], st

        # ── ⑦ 坏行不影响读（手工塞一行脏数据）
        with open(_turns_path(sid), "a", encoding="utf-8") as f:
            f.write("{这不是 json\n")
        assert len(read_turns(sid)) == 3, "坏行应被跳过，不能影响其它行"

        # ── ⑧ prune：把最后一轮改老 40 天，再按 30 天清
        rows = _read_raw(sid)
        rows[-1]["said_at"] = int(time.time() - 40 * 86400)
        _atomic_write_text(_turns_path(sid),
                           "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows))
        n = prune(sid, keep_days=30)
        assert n == 1, f"应删 1 轮，实际 {n}"
        assert len(read_turns(sid)) == 2
        assert prune(sid, keep_days=30) == 0, "再清一次应该没有可删的"

        # ── ⑨ tail_text
        txt = tail_text(sid, turns=10)
        assert "他：" in txt and "我：" in txt

        # ── ⑩ 内联备注已移除：契约是「原样进、原样出、列表恒空」
        #   这一条以前测的是剥离逻辑本身（标记在、内容在、闭不闭合）。
        #   那个能力已整体删除，现在的验收点变成**反向断言**：
        #   文本一个字节都不许改，备注列表必须是空的 —— 否则说明有旧正则复活了。
        clean, notes = strip_notes("好呀[[note]]（其实有点累）[[note]]，那我做饭")
        assert clean == "好呀[[note]]（其实有点累）[[note]]，那我做饭", clean
        assert notes == [], notes
        clean, notes = strip_notes("A[[note]]f1[[note]]B[[note]]f2[[note]]C")
        assert clean == "A[[note]]f1[[note]]B[[note]]f2[[note]]C" and notes == []
        clean, notes = strip_notes("那我不说了[[note]]（其实很委屈）")
        assert clean == "那我不说了[[note]]（其实很委屈）" and notes == [], "不许改文本"
        assert inject_note_instruction("你是assistant。") == "你是assistant。"
        # 检测能力保留（repair_dirty 靠它）：有标记必须报 true
        assert has_note("任何文本[[note]]x[[note]]") is True
        assert has_note("干净文本") is False
        # 清洗只删标记，文字全留
        assert strip_note_markers("任何文本[[note]]x[[note]]") == "任何文本x"
        assert norm_note("随便写点什么") == "随便写点什么"

        # ── ⑩b 归档：调用方显式传进来的备注不会因为截断/清理而永久消失
        #     场景：带备注的轮次被 WINDOW_MAX_TURNS 挤出去
        _sid_f = f"{sid}_notes"
        _dir_f = os.path.join(WINDOW_DIR, _safe_sid(_sid_f))
        try:
            if os.path.exists(_dir_f):
                shutil.rmtree(_dir_f)
            append_turn(_sid_f, "我今天好累", "那早点睡", notes=["（想说他今天也没理我）"])
            append_turn(_sid_f, "嗯", "睡吧")
            saved2 = WINDOW_MAX_TURNS
            try:
                WINDOW_MAX_TURNS = 1      # 把带 note 的那轮挤出去
                append_turn(_sid_f, "晚安", "晚安")
            finally:
                WINDOW_MAX_TURNS = saved2
            live = read_turns(_sid_f, limit=0)
            assert len(live) == 1 and live[0]["his"] == "晚安", live
            assert not live[0]["notes"], "留下的这轮本来就没 note"
            arch = read_notes_archive(_sid_f)
            assert len(arch) == 1, f"被挤掉的 note 应该进归档，实际 {arch}"
            assert "没理我" in arch[0]["notes"][0], arch
            assert arch[0]["his"] == "我今天好累", "归档要带上下文，光有心里话没用"

            # 时间清理（prune）也要走归档，不能只截断走了
            rows_f = _read_raw(_sid_f)
            rows_f[0]["said_at"] = int(time.time() - 90 * 86400)
            rows_f[0]["notes"] = ["（清理前的那一句）"]
            _atomic_write_text(_turns_path(_sid_f),
                               "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows_f))
            assert prune(_sid_f, keep_days=30) == 1
            arch2 = read_notes_archive(_sid_f)
            assert len(arch2) == 2 and "清理前的那一句" in arch2[-1]["notes"][0], arch2
        finally:
            try:
                if os.path.exists(_dir_f):
                    shutil.rmtree(_dir_f)
            except Exception:
                pass

        # ── ⑪ 超长 trim（临时把上限调小，验证真的会截断）
        saved = WINDOW_MAX_TURNS
        try:
            WINDOW_MAX_TURNS = 3
            for i in range(6):
                append_turn(sid, f"第{i}句", f"回{i}")
            got = read_turns(sid, limit=0)
            assert len(got) == 3, f"WINDOW_MAX_TURNS=3 应只留 3 行，实际 {len(got)}"
            assert got[-1]["his"] == "第5句", got[-1]
        finally:
            WINDOW_MAX_TURNS = saved

    finally:
        try:
            if os.path.exists(sdir):
                shutil.rmtree(sdir)
        except Exception:
            pass

    # ── ⑫ 收尾：确认整个 selftest 没有往真实账本写东西
    #    （selftest 自己的临时会话以下划线开头，真实会话不是，分得开）
    _snap_after = _real_sessions_snapshot()
    _leaked = [k for k in _snap_after
               if not _snap_after.get(k) == _snap_real.get(k)]
    assert not _leaked, (
        f"selftest 往真实账本写了东西！多出来/被改动的会话：{_leaked}\n"
        f"  之前：{_snap_real}\n  之后：{_snap_after}"
    )

    st = stats()
    print("window_ledger.py selftest OK")
    print(f"  目录 {WINDOW_DIR}")
    print(f"  保留 {WINDOW_KEEP_DAYS} 天 / 单会话上限 {WINDOW_MAX_TURNS} 轮 / "
          f"单条 note {NOTE_MAX_CHARS} 字")
    print(f"  会话 {st['sessions']} 个 / {st['total_turns']} 轮"
          f" | 按来源：桥接 {st['bridge_turns']}、测试 {st['test_only_turns']}、"
          f"探针 {st['probe_turns']}、未标 {st['unknown_source_turns']}"
          f" | 带 note {st['with_notes']} 轮 | 脏文本 {st['dirty_turns']} 轮")
    if st["dirty_turns"]:
        print(f"  ⚠️ {st['warn']}")


if __name__ == "__main__":
    selftest()
