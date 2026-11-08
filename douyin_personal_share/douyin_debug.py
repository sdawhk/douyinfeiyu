"""Opt-in, read-only DOM snapshots for selector work.

Enabled only when ``DOUYIN_DEBUG_DOM_SNAPSHOT=1``. Snapshots never change page
state; they just copy already-rendered HTML to ``state/debug-dom/`` and keep at
most the newest :data:`KEEP` files so the directory cannot grow without bound.
"""

from __future__ import annotations

import json
import os
import time as time_module
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEBUG_DIR = ROOT / "state" / "debug-dom"
DEBUG_ENV = "DOUYIN_DEBUG_DOM_SNAPSHOT"
KEEP = 10
MAX_BODY_CHARS = 4_000_000


def enabled() -> bool:
    return os.environ.get(DEBUG_ENV, "").strip() == "1"


def _prune() -> None:
    try:
        files = sorted(
            (path for path in DEBUG_DIR.iterdir() if path.is_file()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return
    for stale in files[KEEP:]:
        try:
            stale.unlink()
        except OSError:
            pass


_sequence = 0


def _target(prefix: str, extension: str) -> Path:
    global _sequence
    _sequence += 1
    stamp = time_module.strftime("%Y%m%d-%H%M%S")
    suffix = f"-{int(time_module.time() * 1000) % 1000:03d}-{_sequence:03d}"
    return DEBUG_DIR / f"{prefix}-{stamp}{suffix}.{extension}"


def save(prefix: str, body: str, meta: dict | None = None) -> str:
    """Write one HTML snapshot and return its path, or '' when disabled/failed."""
    if not enabled():
        return ""
    try:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        path = _target(prefix, "html")
        header = "<!-- meta: " + json.dumps(meta or {}, ensure_ascii=False) + " -->\n"
        path.write_text(header + str(body or "")[:MAX_BODY_CHARS], encoding="utf-8")
        _prune()
        return str(path)
    except OSError:
        return ""


def save_json(prefix: str, data, meta: dict | None = None) -> str:
    """Write one sanitized JSON snapshot (e.g. parsed comments), or '' when disabled."""
    if not enabled():
        return ""
    try:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        path = _target(prefix, "json")
        payload = {"meta": meta or {}, "data": data}
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        _prune()
        return str(path)
    except (OSError, TypeError, ValueError):
        return ""
