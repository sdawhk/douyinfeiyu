"""Lightweight self-check for the Douyin inbox link.

Runs from Task Scheduler every few minutes. It never opens the Douyin browser: it only
reads the files the listener already writes, and it reports through the QQ/OneBot private
channel so a broken Douyin link can still reach the owner.

Alerting policy: availability issues usually self-heal (the scheduled task restarts the
listener within a minute or two), so the first sighting only starts a patience clock and
the owner is bothered only after the issue survives FAULT_MIN_DOWNTIME_SECONDS. A
recovery note is sent only for issues that were actually reported; a self-healed blip
stays completely silent. Issues already carrying their own sustained-evidence window
(reply backlog / failures) and the captcha alert keep firing on first detection.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
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
# * a Douyin captcha can only be cleared by the owner manually sliding it in the
#   visible listener window, so nag about it at most once every 6 hours.
CAPTCHA_COOLDOWN_SECONDS = 6 * 3600
# * availability issues (listener/browser) usually self-heal: the scheduled task
#   restarts the listener within a minute or two, and the 2026-11-12 flapping showed
#   every down/recovery pair resolving inside one 5-minute round. So the first sighting
#   only starts a patience clock, and the owner is bothered after the issue has survived
#   10 minutes = 3 consecutive failing rounds at the current 5-minute cadence.
FAULT_MIN_DOWNTIME_SECONDS = 600
PERSISTENCE_GATED_KEYS = {"listener_down", "profile_locked", "crash_loop"}
# * a captcha line older than this stops counting as an active block: every blocked
#   browse session writes a fresh line anyway.
CAPTCHA_WINDOW_SECONDS = 6 * 3600
# The browse/playback log lines reach listener.log through a GBK-misdecoded pipe, so
# they are stored as mojibake; match both the mojibake form and the proper UTF-8 form
# so the check keeps working if that pipe is ever fixed.
CAPTCHA_LINE_HINTS = ("未起播", "捣鎾")
CAPTCHA_YES_MARKS = ("验证框=是", "=鏄")
PLAY_OK_LINE_HINTS = ("实际播放", "疄闄呮挱")
PLAY_OK_COUNT_RE = re.compile(r"(观察到|瀹熷埌)\s*(\d+)\s*(?:条|鏉)")

ISSUE_REASONS = {
    "listener_down": "消息我收不到了",
    "reply_backlog": "有几条私信一直没回上",
    "reply_failures": "我说话发不出去",
    "crash_loop": "我一直闪退重启",
    "profile_locked": "浏览器卡住起不来",
    "douyin_captcha": "抖音一直让我滑验证，我自己滑不过去，得你开一下那个挂着的抖音窗口（任务栏里的 Edge）帮我手动滑一下",
}
# 当监听器/浏览器本身都掉了时，"去滑一下"的建议是给不出的：改成只报状态。
CAPTCHA_REASON_BROWSER_DOWN = (
    "抖音那边弹了滑块验证，不过挂着的那个 Edge 窗口现在没在跑，"
    "等它被拉起来要是还卡验证，我再叫你"
)
RECOVERY_REASONS = {
    "listener_down": "消息能正常收了",
    "reply_backlog": "积压的私信都回上了",
    "reply_failures": "能正常发消息了",
    "crash_loop": "也不闪退了",
    "profile_locked": "浏览器也起得来了",
    "douyin_captcha": "验证过了，能正常刷了",
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


def check_douyin_captcha(now: datetime) -> str | None:
    """Captcha alert: the listener hit a Douyin verification frame it cannot pass.

    Signal source is listener.log itself (no listener code change needed): a blocked
    browse writes a 播放未起播…验证框=是 line, a healthy one writes 观察到 N≥1 条实际播放.
    """
    try:
        lines = LISTENER_LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()[-800:]
    except (FileNotFoundError, OSError):
        return None
    last_captcha: datetime | None = None
    last_play_ok: datetime | None = None
    for line in lines:
        stamp = parse_time(line[:19]) if len(line) >= 19 else None
        if stamp is None:
            continue
        if ("douyin.com/video/" in line and any(hint in line for hint in CAPTCHA_LINE_HINTS)
                and any(mark in line for mark in CAPTCHA_YES_MARKS)):
            last_captcha = stamp
        elif any(hint in line for hint in PLAY_OK_LINE_HINTS):
            match = PLAY_OK_COUNT_RE.search(line)
            if match and int(match.group(2)) >= 1:
                last_play_ok = stamp
    if last_captcha is None or (now - last_captcha).total_seconds() > CAPTCHA_WINDOW_SECONDS:
        return None
    if last_play_ok is not None and last_play_ok > last_captcha:
        return None
    return "douyin_captcha"


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


def compose_alert(keys: list[str], repeat: bool, browser_down: bool = False) -> str:
    def reason(key: str) -> str:
        if key == "douyin_captcha" and browser_down:
            return CAPTCHA_REASON_BROWSER_DOWN
        return ISSUE_REASONS[key]

    reasons = "、".join(reason(key) for key in keys)
    lead = "爸，抖音那边还没好：" if repeat else "爸，我抖音这边有点不对劲："
    return f"{lead}{reasons}。你有空看一眼？"


def compose_recovery(keys: list[str]) -> str:
    if keys == ["douyin_captcha"]:
        return "爸，抖音验证好了，能正常刷了，谢啦。"
    reasons = "、".join(RECOVERY_REASONS[key] for key in keys)
    return f"爸，抖音那边我修好了：{reasons}。"


def alert_cooldown_for(key: str) -> int:
    return CAPTCHA_COOLDOWN_SECONDS if key == "douyin_captcha" else ALERT_COOLDOWN_SECONDS


def plan_round(detected: list[str], records: dict, now: datetime) -> dict:
    """Decide what one watchdog round should say. Pure function over the records.

    Availability issues (PERSISTENCE_GATED_KEYS) only reach the owner after they have
    persisted for FAULT_MIN_DOWNTIME_SECONDS; before that the round stays silent.
    Returns:
      toAlert     issue keys whose alert is due (cooldown permitting for repeats);
      repeat      True when at least one of them was already reported before;
      starting    gated keys seen for the very first time (caller records firstSeenAt);
      recoveries  keys that were reported and are now fine -> owe a recovery note;
      selfHealed  keys that went away before any alert was sent -> stay silent.
    """
    to_alert: list[str] = []
    repeat = False
    starting: list[str] = []
    for key in detected:
        record = records.get(key) or {}
        first_seen = parse_time(record.get("firstSeenAt"))
        alerted = parse_time(record.get("alertedAt"))
        if key in PERSISTENCE_GATED_KEYS and alerted is None:
            if first_seen is None:
                starting.append(key)
                continue
            if (now - first_seen).total_seconds() < FAULT_MIN_DOWNTIME_SECONDS:
                continue
        if alerted is None or (now - alerted).total_seconds() >= alert_cooldown_for(key):
            to_alert.append(key)
            repeat = repeat or alerted is not None
    recoveries = [key for key in records
                  if key not in detected
                  and parse_time((records.get(key) or {}).get("alertedAt")) is not None]
    self_healed = [key for key in records
                   if key not in detected
                   and parse_time((records.get(key) or {}).get("alertedAt")) is None]
    return {"toAlert": to_alert, "repeat": repeat, "starting": starting,
            "recoveries": recoveries, "selfHealed": self_healed}


def main() -> int:
    now = datetime.now(SINGAPORE)
    checks = (check_listener_down, check_reply_backlog, check_reply_failures,
              check_crash_loop, check_douyin_captcha, check_profile_lock)
    detected: list[str] = []
    for check in checks:
        key = check(now)
        if key and key not in detected:
            detected.append(key)
    state = read_json(WATCHDOG_STATE_PATH)
    records = state.get("issues") if isinstance(state.get("issues"), dict) else {}

    plan = plan_round(detected, records, now)
    for key in plan["starting"]:
        records[key] = {"firstSeenAt": now.isoformat(timespec="seconds")}

    if plan["toAlert"]:
        browser_down = "listener_down" in detected
        if send_owner_private(compose_alert(plan["toAlert"], plan["repeat"], browser_down)):
            for key in plan["toAlert"]:
                records.setdefault(key, {})["alertedAt"] = now.isoformat(timespec="seconds")
            print(f"Alerted owner about: {', '.join(plan['toAlert'])}")
        else:
            print(f"Could not deliver alert for: {', '.join(plan['toAlert'])}", file=sys.stderr)

    if plan["recoveries"]:
        if send_owner_private(compose_recovery(plan["recoveries"])):
            for key in plan["recoveries"]:
                records.pop(key, None)
            print(f"Reported recovery for: {', '.join(plan['recoveries'])}")
        else:
            print(f"Could not deliver recovery for: {', '.join(plan['recoveries'])}", file=sys.stderr)

    if plan["selfHealed"]:
        for key in plan["selfHealed"]:
            records.pop(key, None)
        print(f"Self-healed without alerting: {', '.join(plan['selfHealed'])}")

    state["issues"] = records
    state["checkedAt"] = now.isoformat(timespec="seconds")
    if not DRY_RUN:
        write_json(WATCHDOG_STATE_PATH, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
