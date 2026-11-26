# -*- coding: utf-8 -*-
r"""pending_longterm.py —— 承诺类待巩固队列（提级方案 T3 的最小实现）。

## 它解决什么

    工作记忆满了，挤掉一条时，如果它是 commitment/date/fact 类：
      · 短期层会拒收（add_shortterm 的 classify 挡住）
      · 直接写长期库会绕过巩固打分/分级/去重（造第三个写者）
      · 所以它现在「哪都去不了」→ 防线① 让它"有日志地丢"

    这个队列是它的去处：写进 pending，等巩固时重新判定、按正常流程进长期库。

## 关键设计（防误判固化）

    写入时 classify 过一次（准确率 50-60%），但**这里只当「提示」，不当判决**。
    巩固读 pending 时，会**重新跑一次 classify_importance 验证**：
      · 两次一致（都是 commitment/date/fact）→ 按正常巩固流程打分进长期库
      · 两次不一致 → 说明第一次是误判，降级当普通内容处理
    这样写入时的误判在巩固时被纠正一次，不会固化进长期库。

## 数据格式

    state/pending_longterm.jsonl，一行一条：
    {
      "at": <写入时间戳>,
      "content": <原文>,
      "session_id": <会话>,
      "source": <来源>,
      "category_at_write": <写入时 classify 的类别>,
      "chunk_priority": <优先级>,
      "create_time": <原始 create_time>,
    }
"""

import os
import json
import time
import uuid

from filelock import FileLock

from config import BASE_DIR
PENDING_PATH = os.path.join(BASE_DIR, "state", "pending_longterm.jsonl")
LOCK_PATH = PENDING_PATH + ".lock"

# 一条待巩固记录的生命周期：available → claimed → committed。
# 只有长期库落盘后才 committed；处理中失败会释放回 available。
_CLAIMED_BY = {}

# 哪些类别会进这个队列（跟 add_shortterm 的拒收清单一致）
REJECTED_CATEGORIES = ("commitment", "date", "fact")


def _ensure_dir():
    d = os.path.dirname(PENDING_PATH)
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass


def _lock():
    _ensure_dir()
    return FileLock(LOCK_PATH)


def _new_id():
    return "pending_%d_%s" % (time.time_ns(), uuid.uuid4().hex[:8])


def _read_unlocked(limit=None):
    """读当前文件；调用方需要锁时使用，避免计数与认领状态脱节。"""
    if not os.path.exists(PENDING_PATH):
        return []
    rows = []
    with open(PENDING_PATH, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                # 坏行保留在原文件中；不能为了跳过它而丢掉其它记录。
                continue
            if isinstance(rec, dict):
                rows.append(rec)
                if limit is not None and len(rows) >= limit:
                    break
    return rows


def _rewrite_unlocked(rows):
    """在同一目录原子替换；append 与认领/确认共用同一把锁。"""
    _ensure_dir()
    tmp = "%s.%d.%s.tmp" % (PENDING_PATH, os.getpid(), uuid.uuid4().hex[:8])
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            for rec in rows:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, PENDING_PATH)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def append_pending(content, *, session_id=None, source="auto",
                   category_at_write=None, chunk_priority=5,
                   create_time=None, memory=None, reason=None,
                   operation_id=None, origin_candidate_id=None):
    """把一条被短期层拒收的内容写进待巩固队列。

    ★ 只追加，不读不判。失败静默返回 False（不能让这个影响主写入）。
    """
    if not str(content or "").strip():
        return False
    try:
        _ensure_dir()
        rec = {
            "pending_id": ("pending_" + __import__('hashlib').sha256(str(operation_id).encode()).hexdigest()[:24]) if operation_id else _new_id(),
            "operation_id": operation_id,
            "origin_candidate_id": origin_candidate_id,
            "at": time.time(),
            "content": str(content),
            "session_id": session_id,
            "source": source,
            "category_at_write": category_at_write,
            "chunk_priority": int(chunk_priority or 5),
            "create_time": time.time() if create_time is None else create_time,
            "memory": memory,
            "reason": reason,
        }
        with _lock():
            if operation_id and any(r.get('operation_id') == operation_id for r in _read_unlocked()):
                return True
            # append 不整库重写：它绝不删除巩固进程正在处理/尚未处理的记录。
            with open(PENDING_PATH, "a", encoding="utf-8") as f:
                line = json.dumps(rec, ensure_ascii=False) + "\n"
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
        return True
    except Exception:
        return False


def read_pending(limit=500):
    """只读查看待处理队列；不参与认领，也不改变文件。"""
    try:
        with _lock():
            return _read_unlocked(limit=limit)
    except (OSError, TimeoutError):
        return []


def claim_pending(limit=500, owner=None):
    """认领一批记录，返回带稳定 pending_id 的副本。

    只认领尚未被本进程认领的记录；同批可重试、幂等。真正的去重仍由
    巩固的 _find_duplicate 负责，claim 只决定「哪些记录本轮该处理」。
    """
    owner = str(owner or "consolidation")
    with _lock():
        rows = _read_unlocked()
        claimed = []
        seen_ids = set()
        changed = False
        for rec in rows:
            if not isinstance(rec, dict):
                continue
            pid = str(rec.get("pending_id") or "").strip()
            if not pid or pid in seen_ids:
                # 旧格式/重名行在认领时原地补唯一 ID，并立即落盘。
                # 之后确认只按 ID 删除，不靠位置或内容猜身份。
                pid = _new_id()
                rec["pending_id"] = pid
                changed = True
            seen_ids.add(pid)
            if pid in _CLAIMED_BY:
                continue
            if len(claimed) < limit:
                claimed.append(dict(rec))
        if changed:
            _rewrite_unlocked(rows)
        for rec in claimed:
            _CLAIMED_BY[rec["pending_id"]] = owner
        return claimed


def commit_pending(records):
    """确认长期库已落盘：仅删除本批 ID，保留其它进程的新记录。

    必须等 active.json 写成功后调用；不能拿它代替写盘事务。
    """
    ids = {str(r.get("pending_id") or "") for r in (records or [])
           if isinstance(r, dict) and r.get("pending_id")}
    if not ids:
        return True
    with _lock():
        rows = _read_unlocked()
        # claim_pending 已把旧格式/重名行补成稳定 ID；这里只按 ID 精确删除。
        keep = [r for r in rows if str(r.get("pending_id") or "") not in ids]
        _rewrite_unlocked(keep)
        for pid in ids:
            _CLAIMED_BY.pop(pid, None)
        return True


def release_pending(records):
    """处理失败：释放本批，不删除任何记录，下次巩固可重试。"""
    for rec in records or []:
        if isinstance(rec, dict) and rec.get("pending_id"):
            _CLAIMED_BY.pop(str(rec["pending_id"]), None)


def clear_pending():
    """兼容人工维护：仅在持锁且没有认领批次时清空全部。"""
    try:
        with _lock():
            if _CLAIMED_BY:
                raise RuntimeError("有正在处理的 pending 批次，不能全清")
            _rewrite_unlocked([])
        return True
    except Exception:
        return False


def count_pending():
    """队列里有多少条。"""
    return len(read_pending())


def selftest():
    """自检：用临时路径，不碰生产。"""
    import tempfile
    import shutil

    global PENDING_PATH, LOCK_PATH
    old = PENDING_PATH
    old_lock = LOCK_PATH
    tmp = tempfile.mkdtemp(prefix="pending_")
    PENDING_PATH = os.path.join(tmp, "pending.jsonl")
    LOCK_PATH = PENDING_PATH + ".lock"
    _CLAIMED_BY.clear()

    try:
        # ① 追加 + 读取
        assert append_pending("测试承诺", session_id="s1",
                              category_at_write="commitment")
        assert append_pending("测试日期", category_at_write="date")
        rows = read_pending()
        assert len(rows) == 2, "应该读到 2 条: %d" % len(rows)
        print("  ✅ ① 追加 + 读取 2 条")

        # ② 空内容拒绝
        assert append_pending("   ") is False
        print("  ✅ ② 空内容拒绝")

        # ③ 认领 → 长期库落盘后的确认；确认只删本批
        rows = claim_pending()
        assert len(rows) == 2 and all(r.get("pending_id") for r in rows)
        assert commit_pending(rows)
        assert count_pending() == 0
        print("  ✅ ③ 认领 → 确认后清空")

        # ④ 坏行容错
        with open(PENDING_PATH, "a", encoding="utf-8") as f:
            f.write('{"content": "正常"}\n')
            f.write('这不是合法 JSON\n')
            f.write('{"content": "另一条"}\n')
        rows2 = read_pending()
        assert len(rows2) == 2, "坏行应被跳过，读到 %d" % len(rows2)
        print("  ✅ ④ 坏行容错（跳过非法 JSON）")

        print("pending_longterm selftest OK")
    finally:
        PENDING_PATH = old
        LOCK_PATH = old_lock
        _CLAIMED_BY.clear()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    selftest()
