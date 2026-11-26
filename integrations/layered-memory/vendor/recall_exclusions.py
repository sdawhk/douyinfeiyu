"""Exact, auditable exclusions shared by recovery and window recall."""
import hashlib
import json
import os
import re
from functools import lru_cache


def fingerprint(text):
    normalized = re.sub(r"\s+", "", str(text or ""))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def policy_path():
    from config import BASE_DIR
    return os.path.join(BASE_DIR, "state", "recall_exclusions.json")


@lru_cache(maxsize=4)
def _read(path, mtime):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def policy():
    path = policy_path()
    try:
        return _read(path, os.stat(path).st_mtime_ns)
    except FileNotFoundError:
        return {}


def excluded_turn(turn, session_id=None):
    if turn.get("recall_excluded") is True or turn.get("recallable") in (False, "no"):
        return True
    sid = str(session_id or turn.get("_sid") or "").replace(":", "_")
    digest = fingerprint(turn.get("said", ""))
    return any(row.get("said_sha256") == digest and (not row.get("session_id") or row["session_id"].replace(":", "_") == sid)
               for row in policy().get("turns", []))


def excluded_memory(record):
    rules = policy()
    if record.get("mem_id") in rules.get("memory_ids", []):
        return True
    if fingerprint(record.get("content")) in rules.get("content_sha256", []):
        return True
    match = re.search(r"[；;]\s*我回[:：]([\s\S]*)$", str(record.get("content") or ""))
    return bool(match and excluded_turn({"said": match[1]}, record.get("session_id")))
