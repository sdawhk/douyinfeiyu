# -*- coding: utf-8 -*-
"""产物账本：记录工具产出的文件路径，脱离短期层衰减。

为什么需要独立账本：
  短期层的衰减窗口是 3 天（SHORT_TERM_WINDOW_DAYS），
  而「上次下载的视频在哪」可能在 30 天后才被问到。
  需求明确要求：产物路径要有长期保存或可重新定位方式，
  不能只依赖短期池。

为什么用 jsonl 而不是 json：
  · 追加写，不需要读全量再写回 —— 并发时不会互相覆盖
  · 一行坏了不影响其它行
  · 可以直接用文本工具查看

为什么不去重成 json 字典：
  · 会丢失「同一路径被多次下载」的历史
  · 读全量再写回在并发下会丢数据
  改为：写入时按 operation_id 查重（只扫尾部 200 行）。

保留策略：
  · 最多 5000 条，超过后把最早的 1000 条挪到 artifacts.1.jsonl
  · 不做时间删除 —— 产物路径越久越有用
"""
import os
import sys
import json
import time

from common.locking import state_lock
from config import BASE_DIR
LEDGER_DIR = os.path.join(BASE_DIR, "state")
LEDGER_PATH = os.path.join(LEDGER_DIR, "artifacts.jsonl")
ROTATE_PATH = os.path.join(LEDGER_DIR, "artifacts.1.jsonl")
MAX_LINES = 5000
DEDUP_SCAN = 200


def _ensure_dir():
    try:
        os.makedirs(LEDGER_DIR, exist_ok=True)
    except Exception:
        pass


def record(*, operation_id, tool, artifact, action="", status="succeeded",
           result="", session_id="", at=None):
    """记一条产物。返回 True=新写入 / False=已存在或无效。

    参数：
      operation_id  稳定唯一 ID（同一次操作重放不会写两条）
      tool          工具名
      artifact      产物路径或标识（必填，空则不记）
      action        人能理解的操作
      status        succeeded / pending / failed
      result        简短结果
      session_id    所属会话
      at            时间戳（默认 now）

    只记 succeeded 且有 artifact 的条目 —— failed/pending 没有产物可记。
    """
    if not artifact or not str(artifact).strip():
        return False
    if str(status) != "succeeded":
        return False
    _ensure_dir()

    with state_lock("artifacts"):
        op = str(operation_id or "").strip()
        # 去重：扫尾部 N 行，同 operation_id 已存在就不写
        if op:
            try:
                if os.path.exists(LEDGER_PATH):
                    with open(LEDGER_PATH, "r", encoding="utf-8") as f:
                        tail = f.readlines()[-DEDUP_SCAN:]
                    for line in tail:
                        try:
                            if json.loads(line).get("operation_id") == op:
                                return False
                        except Exception:
                            continue
            except Exception:
                pass

        entry = {
            "operation_id": op,
            "tool": str(tool or ""),
            "action": str(action or ""),
            "status": "succeeded",
            "result": str(result or "")[:200],
            "artifact": str(artifact).strip()[:500],
            "session_id": str(session_id or ""),
            "at": float(at) if at else time.time(),
            "at_str": time.strftime("%Y-%m-%d %H:%M:%S",
                                    time.localtime(float(at) if at else time.time())),
        }
        try:
            with open(LEDGER_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            print("[artifact_ledger] 写入失败: %s" % e, file=sys.stderr)
            return False
        _maybe_rotate()
        return True


def _maybe_rotate():
    """超过 MAX_LINES 就轮转，保留最近的。"""
    try:
        if not os.path.exists(LEDGER_PATH):
            return
        with open(LEDGER_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) <= MAX_LINES:
            return
        keep = lines[-MAX_LINES:]
        old = lines[:-MAX_LINES]
        with open(ROTATE_PATH, "a", encoding="utf-8") as f:
            f.writelines(old)
        temp = LEDGER_PATH + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            f.writelines(keep)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, LEDGER_PATH)
    except Exception:
        pass


def query(*, tool=None, contains=None, since=None, limit=20):
    """查产物。返回 list[dict]，按时间倒序。

      tool      只查某个工具
      contains  路径片段
      since     只要这个时间之后的（epoch 秒）
      limit     最多返回几条
    """
    if not os.path.exists(LEDGER_PATH):
        return []
    out = []
    try:
        with open(LEDGER_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if tool and e.get("tool") != tool:
                    continue
                if contains and contains not in str(e.get("artifact") or ""):
                    continue
                if since and float(e.get("at") or 0) < float(since):
                    continue
                out.append(e)
    except Exception:
        return []
    out.sort(key=lambda x: -float(x.get("at") or 0))
    return out[:limit]


def latest(limit=5):
    return query(limit=limit)


def stats():
    """账本概况。"""
    if not os.path.exists(LEDGER_PATH):
        return {"entries": 0, "path": LEDGER_PATH}
    n = 0
    try:
        with open(LEDGER_PATH, "r", encoding="utf-8") as f:
            n = sum(1 for line in f if line.strip())
    except Exception:
        pass
    return {"entries": n, "path": LEDGER_PATH,
            "size_kb": round(os.path.getsize(LEDGER_PATH) / 1024, 1)}
