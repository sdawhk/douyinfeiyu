"""Lightweight self-check for the Douyin inbox link.

Runs from Task Scheduler every few minutes. It never opens the Douyin browser: it only
reads the files the listener already writes, and it reports through the QQ/OneBot private
channel so a broken Douyin link can still reach the owner. Every issue has a cooldown and
a one-shot recovery note, so a persistent fault never turns into a stream of alerts.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
INBOUND_STATE_PATH = ROOT / "inbound-state.json"
DIAGNOSTICS_PATH = ROOT / "inbound-diagnostics.jsonl"
HEARTBEAT_PATH = ROOT / "listener-heartbeat.json"
PROFILE_LOCK_PATH = ROOT / ".browser-profile.lock"
LISTENER_LOG_PATH = ROOT / "logs" / "listener.log"
WATCHDOG_STATE_PATH = ROOT / "douyin-watchdog-state.json"
BRIDGE_CONFIG_PATH = ROOT.parent / "bridge" / "config.json"
SINGAPORE = ZoneInfo("Asia/Singapore")

# Thresholds and why:
# * heartbeat is refreshed on every listener loop (idle loops run at least every second),
#   so 5 minutes tolerates one 260 s model call plus a slow browser frame.
HEARTBEAT_STALE_SECONDS = 300
# * a browse session legitimately runs up to 5 minutes without a new heartbeat, so a busy
#   listener gets 15 minutes before it counts as gone.
BUSY_HEARTBEAT_STALE_SECONDS = 900
# * one unanswered message may just be waiting for the 30 s merge window; three messages
#   still unanswered after 30 minutes means the reply chain is stuck.
BACKLOG_WINDOW_SECONDS = 1800
BACKLOG_MIN_PENDING = 3
# * three consecutive failed deliveries in half an hour is a broken chain, not a hiccup.
FAILURE_STREAK = 3
FAILURE_WINDOW_SECONDS = 1800
# * three browser restarts inside ten minutes is a crash loop.
CRASH_WINDOW_SECONDS = 600
CRASH_MIN_RESTARTS = 3
# * a lock held for over three minutes by a dead pid is a leftover, not an active launch.
LOCK_STALE_SECONDS = 180
# * one alert per issue per 30 minutes: enough to notice, quiet enough to live with.
ALERT_COOLDOWN_SECONDS = 1800

ISSUE_REASONS = {
    "listener_down": "消息我收不到了",
    "reply_backlog": "有几条私信一直没回上",
    "reply_failures": "我说话发不出去",
    "crash_loop": "我一直闪退重启",
    "profile_locked": "浏览器卡住起不来",
}
RECOVERY_REASONS = {
    "listener_down": "消息能正常收了",
    "reply_backlog": "积压的私信都回上了",
    "reply_failures": "能正常发消息了",
    "crash_loop": "也不闪退了",
    "profile_locked": "浏览器也起得来了",
}
FAILURE_OUTCOMES = {"reply_backend_failed", "send_failed", "retry_exhausted"}
DRY_RUN = "--dry-run" in sys.argv


def read_json(path: Path, default: dict | None = None):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return dict(default or {})
    return value if isinstance(value, (dict, list)) else dict(default or {})


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def parse_time(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=SINGAPORE)


def inbound_enabled() -> bool:
    config = read_json(CONFIG_PATH)
    inbound = config.get("inbound") if isinstance(config.get("inbound"), dict) else {}
    return bool(inbound.get("enabled"))


def read_diagnostics(limit: int = 400) -> list[dict]:
    try:
        lines = DIAGNOSTICS_PATH.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError):
        return []
    rows = []
    for line in lines[-limit:]:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    except AttributeError:
        return True  # not on Windows: never assume a lock is stale
    except OSError:
        return False
    if not handle:
        return False
    ctypes.windll.kernel32.CloseHandle(handle)
    return True


def check_listener_down(now: datetime) -> str | None:
    if not inbound_enabled():
        return None
    heartbeat = read_json(HEARTBEAT_PATH)
    stamp = heartbeat.get("at")
    if isinstance(stamp, (int, float)):
        age = now.timestamp() - float(stamp) / 1000.0
    else:
        try:
            age = now.timestamp() - HEARTBEAT_PATH.stat().st_mtime
        except OSError:
            age = float("inf")
    limit = BUSY_HEARTBEAT_STALE_SECONDS if heartbeat.get("busy") else HEARTBEAT_STALE_SECONDS
    return "listener_down" if age > limit else None


def check_reply_backlog(now: datetime) -> str | None:
    rows = [row for row in read_diagnostics()
            if (parse_time(row.get("at")) or now) >= now - timedelta(seconds=BACKLOG_WINDOW_SECONDS)]
    requested = sum(1 for row in rows
                    if row.get("outcome") == "reply_requested" and int(row.get("attempt", 0) or 0) == 0)
    finished = sum(1 for row in rows
                   if row.get("outcome") in {"reply_sent", "duplicate_or_empty_reply", "retry_exhausted"})
    return "reply_backlog" if requested - finished >= BACKLOG_MIN_PENDING else None


def check_reply_failures(now: datetime) -> str | None:
    recent = [row for row in read_diagnostics(60)
              if (parse_time(row.get("at")) or now) >= now - timedelta(seconds=FAILURE_WINDOW_SECONDS)]
    outcomes = [str(row.get("outcome", "")) for row in recent]
    if len(outcomes) < FAILURE_STREAK:
        return None
    tail = outcomes[-FAILURE_STREAK:]
    return "reply_failures" if all(item in FAILURE_OUTCOMES for item in tail) else None


def check_crash_loop(now: datetime) -> str | None:
    try:
        lines = LISTENER_LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-800:]
    except (FileNotFoundError, OSError):
        return None
    cutoff = now - timedelta(seconds=CRASH_WINDOW_SECONDS)
    restarts = 0
    for line in lines:
        if "restarting after" not in line:
            continue
        stamp = parse_time(line[:19]) if len(line) >= 19 else None
        if stamp is None or stamp >= cutoff:
            restarts += 1
    return "crash_loop" if restarts >= CRASH_MIN_RESTARTS else None


def check_profile_lock(now: datetime) -> str | None:
    try:
        stat = PROFILE_LOCK_PATH.stat()
    except OSError:
        return None
    payload = read_json(PROFILE_LOCK_PATH)
    try:
        pid = int(payload.get("pid", 0))
    except (TypeError, ValueError):
        pid = 0
    if not pid:
        try:
            pid = int(PROFILE_LOCK_PATH.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            pid = 0
    if pid and process_alive(pid):
        return None
    age = now.timestamp() - stat.st_mtime
    return "profile_locked" if age > LOCK_STALE_SECONDS else None


def send_owner_private(text: str) -> bool:
    if DRY_RUN:
        print(f"[dry-run] would send: {text}")
        return True
    config = read_json(BRIDGE_CONFIG_PATH)
    snowluma = config.get("snowluma") if isinstance(config.get("snowluma"), dict) else {}
    base = str(snowluma.get("httpUrl") or "http://127.0.0.1:3002").rstrip("/")
    token = str(snowluma.get("httpAccessToken") or snowluma.get("accessToken") or "")
    owner = config.get("douyinOwnerQQ") or config.get("ownerQQ")
    if not owner:
        return False
    body = json.dumps({"user_id": int(owner), "message": text, "auto_escape": False},
                      ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"{base}/send_private_msg", data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return False
    return isinstance(result, dict) and int(result.get("retcode", -1)) == 0


def compose_alert(keys: list[str], repeat: bool) -> str:
    reasons = "、".join(ISSUE_REASONS[key] for key in keys)
    lead = "爸，抖音那边还没好：" if repeat else "爸，我抖音这边有点不对劲："
    return f"{lead}{reasons}。你有空看一眼？"


def compose_recovery(keys: list[str]) -> str:
    reasons = "、".join(RECOVERY_REASONS[key] for key in keys)
    return f"爸，抖音那边我修好了：{reasons}。"


def main() -> int:
    now = datetime.now(SINGAPORE)
    checks = (check_listener_down, check_reply_backlog, check_reply_failures,
              check_crash_loop, check_profile_lock)
    detected: list[str] = []
    for check in checks:
        key = check(now)
        if key and key not in detected:
            detected.append(key)
    state = read_json(WATCHDOG_STATE_PATH)
    records = state.get("issues") if isinstance(state.get("issues"), dict) else {}

    to_alert: list[str] = []
    repeat = False
    for key in detected:
        last = parse_time((records.get(key) or {}).get("alertedAt"))
        if last is None or (now - last).total_seconds() >= ALERT_COOLDOWN_SECONDS:
            to_alert.append(key)
            repeat = repeat or last is not None
    if to_alert and send_owner_private(compose_alert(to_alert, repeat)):
        for key in to_alert:
            records[key] = {"alertedAt": now.isoformat(timespec="seconds")}
        print(f"Alerted owner about: {', '.join(to_alert)}")
    elif to_alert:
        print(f"Could not deliver alert for: {', '.join(to_alert)}", file=sys.stderr)

    recovered = [key for key in records if key not in detected]
    if recovered and send_owner_private(compose_recovery(recovered)):
        for key in recovered:
            records.pop(key, None)
        print(f"Reported recovery for: {', '.join(recovered)}")
    elif recovered:
        print(f"Could not deliver recovery for: {', '.join(recovered)}", file=sys.stderr)

    state["issues"] = records
    state["checkedAt"] = now.isoformat(timespec="seconds")
    if not DRY_RUN:
        write_json(WATCHDOG_STATE_PATH, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
