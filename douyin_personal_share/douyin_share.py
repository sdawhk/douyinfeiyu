"""Manually authenticated Douyin feed reader and allowlisted DM sender."""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time as time_module
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlparse

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeout
    from playwright.sync_api import sync_playwright
except ImportError:  # Pure selection tests do not require the browser dependency.
    PlaywrightTimeout = TimeoutError
    sync_playwright = None


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
PROFILE_DIR = ROOT / "browser-profile"
STATE_PATH = ROOT / "state.json"
SHARED_INTEREST_PATH = ROOT.parent / "bridge" / "state" / "douyin-interest-memory.json"
VERIFICATION_PATH = ROOT / "recipient-verification.json"
INBOUND_STATE_PATH = ROOT / "inbound-state.json"
INBOUND_DIAGNOSTICS_PATH = ROOT / "inbound-diagnostics.jsonl"
DAILY_BROWSE_STATE_PATH = ROOT / "daily-browse-state.json"
INTERACTION_STATE_PATH = ROOT / "interaction-state.json"
PROFILE_LOCK_PATH = ROOT / ".browser-profile.lock"
LOCAL_TEMP_DIR = ROOT / "playwright-temp"
VIDEO_ANALYZER = ROOT.parent / "bridge" / "scripts" / "analyze-douyin-video.mjs"
SINGAPORE = ZoneInfo("Asia/Singapore")
DAILY_WINDOWS = (
    (time(9, 0), time(11, 30)),
    (time(11, 30), time(14, 0)),
    (time(14, 0), time(17, 0)),
    (time(17, 0), time(20, 0)),
    (time(20, 0), time(23, 0)),
)
FEED_URL = "https://www.douyin.com/jingxuan"
VIDEO_PATH = re.compile(r"^/video/(\d+)$")
USER_PATH = re.compile(r"^/user/([A-Za-z0-9_-]+)")
BLOCKED_TEXT = re.compile(r"扫码登录|验证码|安全验证|访问过于频繁|操作频繁|登录后.*继续", re.I)
VIDEO_FOLLOWUP_TEXT = re.compile(r"(?:视频|抖音|分享|刚才|刚刚).{0,24}(?:看|看到|看见|收到|打开|刷|了吗|没有)|(?:看|看到|看见|收到|打开).{0,24}(?:视频|抖音|分享|了吗|没有)")
VIDEO_CONTEXT_TTL = timedelta(minutes=15)


@dataclass(frozen=True)
class Video:
    url: str
    title: str
    author: str


def canonical_video_url(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.netloc.lower() not in {"www.douyin.com", "douyin.com"}:
        return None
    match = VIDEO_PATH.match(parsed.path)
    return f"https://www.douyin.com/video/{match.group(1)}" if match else None


def safe_share_url(url: str) -> str | None:
    parsed = urlparse(str(url).strip())
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.netloc.lower() not in {"www.douyin.com", "douyin.com", "v.douyin.com"}
            or not parsed.path or parsed.path == "/"):
        return None
    return parsed._replace(query="", fragment="").geturl()[:500]


def valid_profile_url(url: str) -> bool:
    parsed = urlparse(url)
    return (parsed.scheme == "https" and parsed.netloc.lower() in {"www.douyin.com", "douyin.com"}
            and bool(USER_PATH.fullmatch(parsed.path)))


def recipient_config(cfg: dict) -> tuple[str, str]:
    profile_url = str(cfg.get("recipient_profile_url", "")).strip()
    expected_handle = str(cfg.get("recipient_handle", "")).strip().lstrip("@")
    if not valid_profile_url(profile_url) or not expected_handle:
        raise RuntimeError("Set recipient_profile_url to the user's Douyin profile and recipient_handle to the exact visible Douyin ID.")
    return profile_url, expected_handle


def visible_handle_matches(body_text: str, expected_handle: str) -> bool:
    lines = [line.strip() for line in body_text.splitlines()]
    for index, value in enumerate(lines):
        if value in {"抖音号", "抖音ID"} and index + 1 < len(lines) and lines[index + 1] == expected_handle:
            return True
        labeled = re.fullmatch(r"(?:抖音号|抖音ID)\s*[：:]\s*(\S+)", value, re.I)
        if labeled and labeled.group(1) == expected_handle:
            return True
    return False


def daily_remaining(state: dict, today: str, daily_max: int) -> int:
    sent = int(state.get("sent_by_day", {}).get(today, 0))
    attempted = int(state.get("attempted_by_day", {}).get(today, 0))
    return max(0, daily_max - max(sent, attempted))


def prepare_browser_temp() -> Path:
    explicit = os.environ.get("DOUYIN_PLAYWRIGHT_TEMP")
    chosen = Path(explicit) if explicit else LOCAL_TEMP_DIR
    try:
        chosen.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=chosen):
            pass
    except OSError as exc:
        raise RuntimeError(f"Browser temp directory is not writable: {chosen}") from exc
    os.environ["TEMP"] = str(chosen)
    os.environ["TMP"] = str(chosen)
    return chosen


def select_videos(videos: list[Video], sent_urls: set[str], limit: int) -> list[Video]:
    if limit <= 0:
        return []
    chosen: list[Video] = []
    authors: set[str] = set()
    seen: set[str] = set()
    for video in videos:
        url = canonical_video_url(video.url)
        if not url or url in sent_urls or url in seen or not video.title.strip():
            continue
        author = video.author.strip()
        if author and author in authors:
            continue
        chosen.append(Video(url=url, title=video.title.strip(), author=author))
        seen.add(url)
        if author:
            authors.add(author)
        if len(chosen) >= limit:
            break
    return chosen


def make_message(video: Video) -> str:
    title = re.sub(r"\s+", " ", video.title).strip()[:48]
    author = re.sub(r"\s+", " ", video.author).strip()[:32]
    author_line = f"\n作者：{author}" if author else ""
    return f"这个视频分享给你：{title}{author_line}\n{video.url}"


def clean_observation(row: dict) -> dict | None:
    url = canonical_video_url(str(row.get("url", "")))
    title = re.sub(r"[\r\n\t]+", " ", str(row.get("title", ""))).strip()[:200]
    author = re.sub(r"[\r\n\t]+", " ", str(row.get("author", ""))).strip()[:80]
    try:
        seconds = max(0, min(3600, int(row.get("watched_seconds", row.get("watchedSeconds", 0)))))
    except (TypeError, ValueError):
        return None
    if not url or not title or seconds < 8:
        return None
    tag_values = row.get("tags", [])
    return {
        "url": url,
        "title": title,
        "author": author,
        "watchedSeconds": seconds,
        "observedAt": str(row.get("observed_at", row.get("observedAt", "")))[:32],
        "contentSummary": re.sub(r"[\r\n\t]+", " ", str(row.get("content_summary", row.get("contentSummary", "")))).strip()[:400],
        "transcript": re.sub(r"[\r\n\t]+", " ", str(row.get("transcript", ""))).strip()[:800],
        "tags": [re.sub(r"[\r\n\t]+", " ", str(tag)).strip()[:24] for tag in tag_values[:5]
                 if str(tag).strip()] if isinstance(tag_values, list) else [],
    }


def latest_unsent_video(observations: list[dict], excluded_urls: set[str]) -> Video | None:
    for row in reversed(observations):
        if not isinstance(row, dict):
            continue
        item = clean_observation(row)
        if item and item["url"] not in excluded_urls:
            return Video(item["url"], item["title"], item["author"])
    return None


def save_watch_history(path: Path, observations: list[dict]) -> int:
    """Atomically share a bounded, read-only watch history with both chat channels."""
    accepted = [item for item in (clean_observation(row) for row in observations) if item]
    if not accepted:
        return 0
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            state = {}
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    rows = state.get("watchedVideos", [])
    if not isinstance(rows, list):
        rows = []
    by_url = {row.get("url"): row for row in rows if isinstance(row, dict) and row.get("url")}
    for item in accepted:
        previous = by_url.get(item["url"], {})
        item["watchedSeconds"] += int(previous.get("watchedSeconds", 0) or 0)
        by_url[item["url"]] = item
    payload = {"schemaVersion": 1, "watchedVideos": list(by_url.values())[-30:]}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)
    return len(accepted)


@contextmanager
def browser_profile_lock(wait_seconds: int = 0):
    """Serialize profile users; remove only lock files whose recorded PID is confirmed dead."""
    deadline = time_module.monotonic() + max(0, wait_seconds)
    while True:
        try:
            descriptor = os.open(PROFILE_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError as exc:
            try:
                lock_text = PROFILE_LOCK_PATH.read_text(encoding="ascii").strip()
                lock_pid = int(lock_text)
            except (OSError, ValueError):
                lock_text = ""
                lock_pid = 0
            stale = False
            if lock_pid > 0:
                try:
                    os.kill(lock_pid, 0)
                except ProcessLookupError:
                    stale = True
                except OSError as exc:
                    # On Windows, os.kill(pid, 0) reports a missing PID as
                    # WinError 87 instead of raising ProcessLookupError.
                    if os.name == "nt" and getattr(exc, "winerror", None) == 87:
                        stale = True
            if stale:
                try:
                    if PROFILE_LOCK_PATH.read_text(encoding="ascii").strip() == lock_text:
                        PROFILE_LOCK_PATH.unlink(missing_ok=True)
                        continue
                except OSError:
                    continue
            if time_module.monotonic() >= deadline:
                raise RuntimeError("The Douyin browser profile is already in use (or has a stale lock). Close the other run and inspect .browser-profile.lock before retrying.") from exc
            time_module.sleep(1)
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        os.close(descriptor)
        yield
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        PROFILE_LOCK_PATH.unlink(missing_ok=True)


def extract_inbound_messages(rows: list[dict], consumed_ids: set[str], limit: int = 20) -> list[tuple[str, str]]:
    found = []
    for row in rows:
        message_id = str(row.get("id", "")).strip()
        text = str(row.get("text", "")).strip()
        if (not re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", message_id) or message_id in consumed_ids
                or not text or len(text) > 4000):
            continue
        found.append((message_id, text))
        consumed_ids.add(message_id)
        if len(found) >= limit:
            break
    return found


def extract_inbound_events(rows: list[dict], consumed_ids: set[str], limit: int = 20) -> list[dict]:
    found = []
    for row in rows:
        message_id = str(row.get("id", "")).strip()
        text = re.sub(r"[\r\n\t]+", " ", str(row.get("text", ""))).strip()[:4000]
        links = row.get("links", []) if isinstance(row.get("links"), list) else []
        links = [str(link) for link in links[:8]]
        links.extend(re.findall(r"https://(?:www\.)?(?:v\.)?douyin\.com/[^\s<>]+", text))
        video_url = next((canonical_video_url(link.rstrip(".,;，。；）》")) for link in links
                          if canonical_video_url(link.rstrip(".,;，。；）》"))), None)
        share_url = next((safe_share_url(link.rstrip(".,;，。；）》")) for link in links
                          if safe_share_url(link.rstrip(".,;，。；）》"))), None)
        aweme_ids = row.get("aweme_ids", []) if isinstance(row.get("aweme_ids"), list) else []
        if not video_url:
            item_id = next((str(value) for value in aweme_ids if re.fullmatch(r"\d{10,24}", str(value))), "")
            if item_id:
                video_url = f"https://www.douyin.com/video/{item_id}"
        video_hint = row.get("video_hint") is True
        is_video = bool(video_url or share_url or video_hint)
        card_text = re.sub(r"[\r\n\t]+", " ", str(row.get("card_text", ""))).strip()[:500]
        if not text and not is_video:
            continue
        if not text and not card_text and not video_url and not share_url:
            text = "爸分享了一条视频，但目前无法从私信卡片读取视频链接。"
        if not message_id:
            fingerprint = video_url or share_url or text or card_text
            digest = hashlib.sha256(f"{row.get('index', 0)}\0{fingerprint}".encode("utf-8")).hexdigest()[:32]
            message_id = f"dom:{row.get('index', 0)}:{digest}"
        if not re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", message_id) or message_id in consumed_ids:
            continue
        consumed_ids.add(message_id)
        found.append({"id": message_id, "text": text, "videoUrl": video_url,
                      "shareUrl": share_url, "cardText": card_text, "isVideo": is_video})
        if len(found) >= limit:
            break
    return found


def sanitize_inbound_video_context(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    video_url = canonical_video_url(str(value.get("url", ""))) or ""
    share_url = safe_share_url(str(value.get("shareUrl", ""))) or ""
    status = str(value.get("status", "unavailable"))
    if status not in {"analyzed", "partial", "no_playback", "unresolved", "unavailable"}:
        status = "unavailable"
    clean = lambda field, size: re.sub(r"[\r\n\t\x00-\x1f]+", " ", str(value.get(field, ""))).strip()[:size]
    tags = value.get("tags", [])
    return {
        "url": video_url,
        "shareUrl": share_url,
        "title": clean("title", 200),
        "author": clean("author", 100),
        "cardText": clean("cardText", 500),
        "status": status,
        "summary": clean("summary", 400),
        "transcript": clean("transcript", 1000),
        "tags": [re.sub(r"[\r\n\t\x00-\x1f]+", " ", str(tag)).strip()[:32]
                 for tag in tags[:5] if str(tag).strip()] if isinstance(tags, list) else [],
    }


def read_json(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_inbound_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def log_inbound_diagnostic(event: dict, video_context: dict | None, context_source: str,
                           outcome: str, context_source_key: str = "",
                           path: Path = INBOUND_DIAGNOSTICS_PATH) -> None:
    """Record message handling metadata without storing private message text or video content."""
    identity = str(event.get("id", ""))
    video_id = str((video_context or {}).get("url", "")).rsplit("/", 1)[-1]
    row = {
        "at": datetime.now(SINGAPORE).isoformat(timespec="seconds"),
        "messageKey": hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12] if identity else "",
        "contextSourceKey": context_source_key,
        "kind": "video" if event.get("isVideo") else "text",
        "videoIdPresent": bool(video_id),
        "videoStatus": str((video_context or {}).get("status", "none")),
        "contextSource": context_source,
        "contextAttached": bool(video_context),
        "outcome": outcome,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as exc:
        print(f"Could not write Douyin inbound diagnostics: {exc.__class__.__name__}", file=sys.stderr)


def recent_shared_video_context(state: dict, event: dict,
                                now: datetime | None = None) -> tuple[dict | None, str]:
    """Attach a recent shared-video context only to an explicit video-related follow-up."""
    now = now or datetime.now(SINGAPORE)
    pending = state.get("pending_shared_video_context")
    if not isinstance(pending, dict):
        return None, "none"
    try:
        saved_at = datetime.fromisoformat(str(pending.get("at", "")))
    except ValueError:
        state.pop("pending_shared_video_context", None)
        return None, "expired"
    if now - saved_at > VIDEO_CONTEXT_TTL or now < saved_at:
        state.pop("pending_shared_video_context", None)
        return None, "expired"
    text = str(event.get("text", ""))
    if event.get("isVideo") or not VIDEO_FOLLOWUP_TEXT.search(text):
        return None, "none"
    context = pending.get("videoContext")
    state.pop("pending_shared_video_context", None)
    return (context if isinstance(context, dict) else None), "recent_shared_video"


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Missing {CONFIG_PATH}. Copy config.example.json and edit it.")
    cfg = read_json(CONFIG_PATH, {})
    cfg.setdefault("daily_max", 5)
    cfg.setdefault("scheduled_enabled", True)
    cfg.setdefault("reply_backend", {"enabled": False})
    if not isinstance(cfg["daily_max"], int) or not 1 <= cfg["daily_max"] <= 5:
        raise RuntimeError("daily_max must be between 1 and 5")
    if not isinstance(cfg["scheduled_enabled"], bool):
        raise RuntimeError("scheduled_enabled must be true or false")
    daily = cfg.setdefault("daily_browse", {})
    daily.setdefault("enabled", False)
    daily.setdefault("time", "20:30")
    daily.setdefault("minutes", 10)
    daily.setdefault("share_to_owner", True)
    daily.setdefault("post_qzone", True)
    daily.setdefault("report_url", "http://127.0.0.1:3101/douyin/daily-report")
    daily.setdefault("token_file", (cfg.get("reply_backend") or {}).get("token_file", "../bridge/state/console-token"))
    if not isinstance(daily["enabled"], bool):
        raise RuntimeError("daily_browse.enabled must be true or false")
    if not isinstance(daily["time"], str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", daily["time"]):
        raise RuntimeError("daily_browse.time must use HH:MM (00:00-23:59)")
    if not isinstance(daily["minutes"], int) or not 1 <= daily["minutes"] <= 15:
        raise RuntimeError("daily_browse.minutes must be between 1 and 15")
    for flag in ("share_to_owner", "post_qzone"):
        if not isinstance(daily[flag], bool):
            raise RuntimeError(f"daily_browse.{flag} must be true or false")
    if not isinstance(daily["token_file"], str) or not daily["token_file"].strip():
        raise RuntimeError("daily_browse.token_file must be a path")
    endpoint = urlparse(str(daily["report_url"]))
    if endpoint.scheme != "http" or endpoint.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("daily_browse.report_url must use loopback HTTP")
    return cfg


def request_inbound_reply(cfg: dict, state: dict, sender_handle: str, message_id: str,
                          text: str, state_path: Path | None = INBOUND_STATE_PATH,
                          opener=urllib.request.urlopen, video_context: dict | None = None) -> str | None:
    """Ask the local bridge for one owner-only reply; consume IDs before network/model work."""
    backend = cfg.get("reply_backend") or {}
    if not backend.get("enabled"):
        return None
    expected = str(cfg.get("recipient_handle", "")).strip().lstrip("@")
    if not expected or str(sender_handle).strip().lstrip("@") != expected:
        return None
    identity = str(message_id).strip()
    content = str(text).strip()
    safe_video = sanitize_inbound_video_context(video_context)
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", identity) or (not content and not safe_video) or len(content) > 4000:
        return None
    seen = state.setdefault("inbound_reply_attempts", [])
    if identity in seen:
        return None
    seen.append(identity)
    if state_path:
        write_inbound_state(state_path, state)

    endpoint = str(backend.get("url", "http://127.0.0.1:3101/douyin/reply"))
    parsed = urlparse(endpoint)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("Reply backend must use loopback HTTP")
    token_path = Path(str(backend.get("token_file", "../bridge/state/console-token")))
    if not token_path.is_absolute():
        token_path = ROOT / token_path
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("Local bridge console token is empty")
    body = json.dumps({"handle": expected, "messageId": identity,
                       "text": content or "爸分享了一条抖音视频。",
                       "videoContext": safe_video}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, headers={
        "Content-Type": "application/json", "x-console-token": token,
    }, method="POST")
    try:
        with opener(request, timeout=260) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError("Local model reply failed; inbound message was consumed and will not be retried automatically") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Local model reply was malformed; inbound message was consumed and will not be retried automatically") from exc
    if not isinstance(result, dict):
        raise RuntimeError("Local model reply was malformed; inbound message was consumed and will not be retried automatically")
    if not result.get("ok") or result.get("duplicate"):
        return None
    reply_text = str(result.get("reply", "")).strip()
    return reply_text[:4000] or None


def ensure_daily_plan(state: dict, day: date, rng=random) -> list[dict]:
    plans = state.setdefault("daily_plans", {})
    key = day.isoformat()
    if key not in plans:
        slots = []
        for start, end in DAILY_WINDOWS:
            start_dt = datetime.combine(day, start, tzinfo=SINGAPORE)
            span_minutes = int((datetime.combine(day, end) - datetime.combine(day, start)).total_seconds() // 60)
            when = start_dt + timedelta(minutes=rng.randrange(span_minutes))
            slots.append({"at": when.isoformat(timespec="minutes"), "status": "pending"})
        plans[key] = slots
    return plans[key]


def claim_due_slot(state: dict, now: datetime, grace_minutes: int = 25) -> dict | None:
    now = now.astimezone(SINGAPORE)
    slots = ensure_daily_plan(state, now.date())
    for slot in slots:
        if slot["status"] != "pending":
            continue
        due_at = datetime.fromisoformat(slot["at"])
        lateness = now - due_at
        if lateness < timedelta(0):
            continue
        if lateness > timedelta(minutes=grace_minutes):
            slot["status"] = "skipped"
            continue
        slot["status"] = "attempted"
        slot["attempted_at"] = now.isoformat(timespec="seconds")
        return slot
    return None


def verify_recipient(page, cfg: dict) -> tuple[str, str]:
    profile_url, expected_handle = recipient_config(cfg)
    page.goto(profile_url, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_function(
            "handle => document.body.innerText.includes('抖音号：' + handle) || document.body.innerText.includes('抖音号: ' + handle)",
            arg=expected_handle,
            timeout=20000,
        )
    except PlaywrightTimeout as exc:
        raise RuntimeError(f"The recipient profile did not load the configured Douyin ID: {expected_handle}") from exc
    authenticated(page)
    if not valid_profile_url(page.url) or urlparse(page.url).path != urlparse(profile_url).path:
        raise RuntimeError("Recipient profile URL redirected; stopping without sending.")
    body_text = page.locator("body").inner_text(timeout=5000)
    if not visible_handle_matches(body_text, expected_handle):
        raise RuntimeError(f"Visible profile does not show the exact configured Douyin ID: {expected_handle}")
    return profile_url, expected_handle


def verification_matches(cfg: dict, marker: dict) -> bool:
    try:
        profile_url, expected_handle = recipient_config(cfg)
    except RuntimeError:
        return False
    return marker == {"recipient_profile_url": profile_url, "recipient_handle": expected_handle}


def require_recipient_verification(cfg: dict, marker: dict) -> None:
    if not verification_matches(cfg, marker):
        raise RuntimeError("Run --verify-recipient and inspect the exact profile handle before enabling sends.")


def authenticated(page) -> None:
    current = page.url.lower()
    if "login" in current or "passport" in current:
        raise RuntimeError("Not logged in. Run --login and finish login manually.")
    title = page.title()
    if BLOCKED_TEXT.search(title):
        raise RuntimeError(f"Douyin requires login or verification (page title: {title}); stopping without sending.")
    text = page.locator("body").inner_text(timeout=5000)
    if BLOCKED_TEXT.search(text):
        raise RuntimeError("Login or verification is required; stopping without sending.")


def collect_feed(page) -> list[Video]:
    open_recommend_feed(page)
    cards = page.locator('div[data-aweme-id]:not([data-aweme-id=""])')
    try:
        page.wait_for_function("document.querySelectorAll('div[data-aweme-id]:not([data-aweme-id=\"\"])').length > 0", timeout=20000)
    except PlaywrightTimeout as exc:
        raise RuntimeError("The normal recommendation feed has no readable video cards; stopping without sending.") from exc
    rows = cards.evaluate_all("""els => els.map(card => {
      const id = card.getAttribute('data-aweme-id') || '';
      const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const author = lines.find(s => s.startsWith('@')) || '';
      const authorIndex = author ? lines.indexOf(author) : lines.length;
      // Douyin recommendation cards begin with duration and popularity; caption follows.
      const title = lines.slice(Math.min(2, authorIndex), authorIndex).join(' ').trim();
      return {url: `https://www.douyin.com/video/${id}`, title, author};
    })""")
    videos = []
    for row in rows:
        url = canonical_video_url(row.get("url", ""))
        if url:
            videos.append(Video(url, row.get("title", ""), row.get("author", "").lstrip("@")))
    if not videos:
        raise RuntimeError("No recommendation cards found; feed markup may have changed.")
    unique: list[Video] = []
    urls: set[str] = set()
    for video in videos:
        if video.url not in urls:
            urls.add(video.url)
            unique.append(video)
    return unique


def open_recommend_feed(page) -> None:
    """Use the site's normal 推荐 tab instead of the default 抖音精选 tab."""
    page.goto(FEED_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)
    authenticated(page)
    recommend_tab = page.locator('a[href*="recommend=1"]').filter(has_text=re.compile(r"^\s*推荐\s*$"))
    if recommend_tab.count() != 1:
        raise RuntimeError("Could not uniquely identify Douyin's normal 推荐 tab; stopping without collecting or sending.")
    recommend_tab.click(timeout=15000)
    try:
        page.wait_for_function(
            "location.pathname === '/' && new URL(location.href).searchParams.get('recommend') === '1'",
            timeout=30000,
        )
        page.wait_for_function(
            "document.querySelectorAll('div[data-aweme-id]:not([data-aweme-id=\"\"])').length > 0",
            timeout=20000,
        )
    except PlaywrightTimeout as exc:
        raise RuntimeError("Douyin's normal 推荐 feed did not load; no fallback to 精选 was used.") from exc
    authenticated(page)


def open_recipient_chat(page, cfg: dict):
    profile_url, expected_handle = verify_recipient(page, cfg)
    profile_heading = page.get_by_role("heading").first
    profile_name = profile_heading.inner_text(timeout=5000).strip()
    if not profile_name or profile_name == "作品 0":
        raise RuntimeError("Could not identify the verified profile name before opening its chat.")
    # On the web, the profile CTA only initiates a lazy load; the conversation
    # itself must be selected from the top bar's message inbox.
    thread_names = page.locator("div.conversationConversationItemtitle:visible")
    target_threads = thread_names.filter(has_text=re.compile(rf"^{re.escape(profile_name)}$"))
    if target_threads.count() == 0:
        message_button = page.locator('div[data-e2e="something-button"]').filter(has_text="消息")
        message_button.first.click(timeout=20000, no_wait_after=True)
        page.wait_for_function(
            "name => Array.from(document.querySelectorAll('.conversationConversationItemtitle')).some(el => el.innerText.trim() === name && el.getBoundingClientRect().width > 0)",
            arg=profile_name,
            timeout=20000,
        )
        thread_names = page.locator("div.conversationConversationItemtitle")
    candidates = []
    for index in range(thread_names.count()):
        candidate = thread_names.nth(index)
        if candidate.inner_text().strip() == profile_name and candidate.is_visible():
            candidates.append(candidate)
    if len(candidates) != 1:
        raise RuntimeError(f"Inbox does not contain exactly one conversation for the verified profile ({expected_handle}).")
    candidates[0].click(no_wait_after=True)
    editor = page.locator('[contenteditable="true"]:visible').last
    editor.wait_for(state="visible", timeout=20000)
    if page.get_by_text(profile_name, exact=True).count() < 2 or urlparse(page.url).path != urlparse(profile_url).path:
        raise RuntimeError("Opened conversation does not match the verified Douyin profile.")
    return editor


def inbound_selectors(cfg: dict) -> dict:
    inbound = cfg.get("inbound") or {}
    required = ("message_selector", "message_id_attribute", "incoming_selector", "text_selector")
    if inbound.get("enabled") is not True or inbound.get("selectors_verified") is not True:
        raise RuntimeError("Inbound replies are disabled; inspect the inbox and explicitly configure verified inbound selectors first.")
    selectors = {key: str(inbound.get(key, "")).strip() for key in required}
    if not all(selectors.values()):
        raise RuntimeError("Inbound replies require message, ID, incoming-direction, and text selectors.")
    if not re.fullmatch(r"[A-Za-z_:][A-Za-z0-9_.:-]{0,127}", selectors["message_id_attribute"]):
        raise RuntimeError("Invalid message ID attribute selector setting.")
    return selectors


def read_inbound_rows(page, selectors: dict) -> list[dict]:
    rows = page.evaluate("""s => Array.from(document.querySelectorAll(s.message_selector))
      .filter(node => node.getBoundingClientRect().width > 0 && node.matches(s.incoming_selector))
      .map((node, index) => {
        // Douyin renders a shared aweme as a poster image, not an <a> or <video>.
        // Its React message payload carries the itemId and title.
        const findParsedContent = root => {
          const stack = [root], seen = new Set();
          while (stack.length) {
            const value = stack.pop();
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            if (value.parsedContent && typeof value.parsedContent === 'object') return value.parsedContent;
            for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
          }
          return null;
        };
        let parsed = null;
        const contentNode = node.querySelector('[data-e2e="msg-item-content"]');
        for (let current = contentNode; current && current !== node.parentElement && !parsed; current = current.parentElement) {
          const propsKey = Object.keys(current).find(key => key.startsWith('__reactProps$'));
          if (propsKey) parsed = findParsedContent(current[propsKey]);
        }
        const links = Array.from(node.querySelectorAll('a[href]')).map(link => link.href).slice(0, 8);
        const awemeIds = Array.from(node.querySelectorAll('[data-aweme-id]'))
          .map(el => el.getAttribute('data-aweme-id') || '').filter(Boolean).slice(0, 4);
        const itemId = String(parsed?.itemId || '');
        if (/^[0-9]{10,24}$/.test(itemId) && !awemeIds.includes(itemId)) awemeIds.push(itemId);
        const videoLink = links.some(href => {
          try {
            const url = new URL(href);
            const parts = url.pathname.split('/').filter(Boolean);
            return url.protocol === 'https:' && (
              (['www.douyin.com', 'douyin.com'].includes(url.hostname) && parts.length === 2 && parts[0] === 'video' && /^[0-9]+$/.test(parts[1])) ||
              (url.hostname === 'v.douyin.com' && parts.length > 0)
            );
          } catch { return false; }
        });
        const shareCard = Boolean(node.querySelector('.MessageItemShareAwemeawemeContainer')) || parsed?.aweType === 800;
        const videoHint = videoLink || awemeIds.length > 0 || Boolean(node.querySelector('video')) || shareCard;
        return {
          id: node.getAttribute(s.message_id_attribute) || '',
          index,
          text: (node.querySelector(s.text_selector)?.innerText || '').trim(),
          card_text: videoHint ? String(parsed?.content_title || node.innerText || '').trim().slice(0, 500) : '',
          links,
          aweme_ids: awemeIds,
          video_hint: videoHint
        };
      })""", selectors)
    for row in rows:
        text = str(row.get("text", "")).strip()
        fingerprint = str(row.get("aweme_ids", [""])[0] if row.get("aweme_ids") else "")
        if not fingerprint:
            fingerprint = next((link for link in row.get("links", [])
                                if canonical_video_url(link) or safe_share_url(link)), text)
        if not row["id"] and (text or row.get("video_hint")):
            digest = hashlib.sha256(f"{row['index']}\0{fingerprint or text or row.get('card_text', '')}".encode("utf-8")).hexdigest()[:32]
            row["id"] = f"dom:{row['index']}:{digest}"
    return rows


def inspect_inbox_shape(page) -> dict:
    """Return selector/structure hints only; never return message text or attribute values that may contain it."""
    return page.evaluate("""() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = Array.from(document.querySelectorAll('div, li, article, [role], [contenteditable]'))
        .filter(visible).slice(-180);
      const counts = {};
      const samples = [];
      for (const el of nodes) {
        const tag = el.tagName.toLowerCase();
        const e2e = el.getAttribute('data-e2e');
        const attrs = Array.from(el.attributes).map(a => a.name)
          .filter(n => n.startsWith('data-') || n === 'role' || n === 'contenteditable');
        const key = [tag, e2e ? 'data-e2e' : '', el.getAttribute('role') ? 'role' : '', el.isContentEditable ? 'editable' : ''].filter(Boolean).join(':');
        counts[key] = (counts[key] || 0) + 1;
        if (samples.length < 40 && (e2e || attrs.some(n => n.startsWith('data-')) || el.isContentEditable)) {
          samples.push({tag, classNames: String(el.className || '').toString().split(/\\s+/).slice(0, 6), dataE2ePresent: Boolean(e2e), attributes: attrs.slice(0, 12), rolePresent: Boolean(el.getAttribute('role')), editable: Boolean(el.isContentEditable)});
        }
      }
      const messageSamples = Array.from(document.querySelectorAll('[data-message-id]')).slice(-12).map(node => {
        const ancestors = [];
        for (let parent = node, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
          ancestors.push({
            tag: parent.tagName.toLowerCase(),
            classNames: String(parent.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 8),
            dataE2e: parent.getAttribute('data-e2e') || '',
            hasMessageId: parent.hasAttribute('data-message-id'),
            left: Math.round(parent.getBoundingClientRect().left),
            right: Math.round(parent.getBoundingClientRect().right)
          });
        }
        const descendants = Array.from(node.querySelectorAll('div, span')).slice(0, 12).map(child => ({
          tag: child.tagName.toLowerCase(),
          classNames: String(child.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 8),
          dataE2e: child.getAttribute('data-e2e') || '',
        }));
        return {hasMessageId: node.hasAttribute('data-message-id'), ancestors, descendants};
      });
      const chatMessageSamples = Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]')).slice(-12).map(node => {
        const ancestors = [];
        for (let parent = node, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
          ancestors.push({
            tag: parent.tagName.toLowerCase(),
            classNames: String(parent.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 8),
            dataE2e: parent.getAttribute('data-e2e') || '',
            attributeNames: Array.from(parent.attributes).map(attribute => attribute.name).slice(0, 12),
            hasMessageId: parent.hasAttribute('data-message-id'),
            left: Math.round(parent.getBoundingClientRect().left),
            right: Math.round(parent.getBoundingClientRect().right)
          });
        }
        const descendants = Array.from(node.querySelectorAll('div, span')).slice(0, 16).map(child => ({
          tag: child.tagName.toLowerCase(),
          classNames: String(child.className || '').toString().split(/\\s+/).filter(Boolean).slice(0, 8),
          dataE2e: child.getAttribute('data-e2e') || '',
          attributeNames: Array.from(child.attributes).map(attribute => attribute.name).slice(0, 10),
        }));
        return {ancestors, descendants};
      });
      return {visibleNodeCount: nodes.length, shapeCounts: counts, samples, messageSamples, chatMessageSamples};
    }""")


def send_text_in_open_chat(page, editor, message: str) -> None:
    existing = page.get_by_text(message, exact=True)
    if existing.count():
        raise RuntimeError("The exact message already appears in the conversation; refusing a duplicate send.")
    editor.fill(message)
    send_button = page.locator("svg.e2e-send-msg-btn:visible")
    if send_button.count() != 1 or send_button.get_attribute("aria-disabled") == "true":
        raise RuntimeError("Could not uniquely identify an enabled send button; stopping.")
    send_button.click()
    try:
        sent_message = page.get_by_text(message, exact=True)
        sent_message.first.wait_for(state="visible", timeout=8000)
        if sent_message.count() != 1 or editor.inner_text(timeout=3000).strip():
            raise RuntimeError("Send result is ambiguous. Inspect the conversation before retrying.")
    except PlaywrightTimeout as exc:
        raise RuntimeError("Send result is ambiguous. Inspect the conversation before retrying.") from exc


def normalize_comment_text(value: object) -> str:
    text = str(value or "")
    if not text.strip() or len(text) > 200 or any(char in text for char in "\r\n\x00"):
        raise RuntimeError("评论必须是 1–200 个字符的单行明确文案。")
    return text


def like_control_state(control: dict) -> bool | None:
    labels = " ".join(str(control.get(key, "")) for key in ("aria", "title", "e2e", "text")).lower()
    pressed = str(control.get("pressed", "")).lower()
    state = str(control.get("state", "")).lower()
    if pressed == "true" or state in {"liked", "active", "selected", "on"}:
        return True
    if pressed == "false" or state in {"unliked", "off"}:
        return False
    if any(word in labels for word in ("取消点赞", "取消喜欢", "已点赞", "已喜欢", "unlike", "liked")):
        return True
    if any(word in labels for word in ("点赞", "喜欢", "like")):
        return False
    fill = re.sub(r"\s+", "", str(control.get("fill", "")).lower())
    if fill in {"#ff2c55", "#fe2c55", "rgb(255,44,85)", "rgb(254,44,85)"}:
        return True
    if fill in {"#fff", "#ffffff", "rgb(255,255,255)"}:
        return False
    return None


def interaction_comment_key(video_url: str, comment_text: str) -> str:
    return hashlib.sha256(f"{video_url}\0{comment_text}".encode("utf-8")).hexdigest()


def _save_interaction_state(state: dict) -> None:
    INTERACTION_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = INTERACTION_STATE_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, INTERACTION_STATE_PATH)


def _visible_action_controls(page, action: str) -> list[tuple[object, dict]]:
    if action in {"like", "comment"}:
        bars = page.locator("div").evaluate_all("""els => els.map((el, rootIndex) => {
          const children = Array.from(el.children);
          if (children.length !== 4) return null;
          const actions = children.map((child, actionIndex) => {
            const control = child.querySelector('[tabindex="0"]');
            const svg = control?.querySelector('svg');
            const path = svg?.querySelector('path');
            const text = (child.innerText || '').trim();
            if (!control || !svg || !/^\\d+(?:\\.\\d+)?(?:万|w|k)?$/i.test(text)) return null;
            const style = control.getAttribute('aria-pressed') || '';
            return {rootIndex, actionIndex, info: {
              tag: control.tagName.toLowerCase(), aria: control.getAttribute('aria-label') || '',
              title: control.getAttribute('title') || '', e2e: control.getAttribute('data-e2e') || '',
              text, class: String(control.className || '').toString().slice(0, 160),
              pressed: style, state: control.getAttribute('data-state') || '',
              fill: path?.getAttribute('fill') || (path ? getComputedStyle(path).fill : '') || ''
            }};
          });
          return actions.every(Boolean) ? {rootIndex, actions} : null;
        }).filter(Boolean)""")
        if len(bars) == 1:
            action_index = 0 if action == "like" else 1
            handle = page.evaluate_handle("""actionIndex => {
              const roots = Array.from(document.querySelectorAll('div')).filter(el => {
                const children = Array.from(el.children);
                return children.length === 4 && children.every(child => {
                  const control = child.querySelector('[tabindex="0"]');
                  return control?.querySelector('svg')
                    && /^\\d+(?:\\.\\d+)?(?:万|w|k)?$/i.test((child.innerText || '').trim());
                });
              });
              return roots.length === 1 ? roots[0].children[actionIndex].querySelector('[tabindex="0"]') : null;
            }""", action_index)
            control = handle.as_element()
            if control is None:
                return []
            info = control.evaluate("""el => ({tag: el.tagName.toLowerCase(), aria: el.getAttribute('aria-label') || '',
              title: el.getAttribute('title') || '', e2e: el.getAttribute('data-e2e') || '',
              text: (el.innerText || '').trim(), class: String(el.className || '').toString().slice(0, 160),
              pressed: el.getAttribute('aria-pressed') || '', state: el.getAttribute('data-state') || '',
              fill: el.querySelector('svg path')?.getAttribute('fill') || (el.querySelector('svg path') ? getComputedStyle(el.querySelector('svg path')).fill : '') || ''})""")
            return [(control, info)]

    if action == "submit":
        wrappers = page.locator('div[class*="comment-input-inner-container"]')
        if wrappers.count() == 1:
            handle = page.evaluate_handle("""() => {
              const wrappers=Array.from(document.querySelectorAll('div[class*="comment-input-inner-container"]'));
              if (wrappers.length!==1) return null;
              const buttons=Array.from(wrappers[0].querySelectorAll('div[class*="commentInput-right-ct"] span'))
                .filter(el=>Array.from(el.querySelectorAll('svg path')).some(path=>
                  ['#fe2c55','rgb(254,44,85)','rgb(255,44,85)'].includes((path.getAttribute('fill')||getComputedStyle(path).fill).replace(/\\s+/g,'').toLowerCase())));
              return buttons.length===1 ? buttons[0] : null;
            }""")
            control = handle.as_element()
            if control is None:
                return []
            info = control.evaluate("""el => ({tag:el.tagName.toLowerCase(),aria:el.getAttribute('aria-label')||'',
              title:el.getAttribute('title')||'',e2e:el.getAttribute('data-e2e')||'',
              text:(el.innerText||'').trim(),class:String(el.className||'').toString().slice(0,140),
              fill:el.querySelector('svg path')?.getAttribute('fill')||''})""")
            return [(control, info)]

    selector = 'button,[role="button"],[tabindex],[data-e2e]'
    candidates = page.locator(selector)
    patterns = {
        "like": re.compile(r"点赞|喜欢|like|favorite", re.I),
        "comment": re.compile(r"评论|comment", re.I),
        "submit": re.compile(r"发布|发送|发表|submit|send|post", re.I),
    }
    rows = candidates.evaluate_all("""els => els.map((el, index) => {
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        return {index, visible: style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0, info: {
          tag: el.tagName.toLowerCase(), aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '', e2e: el.getAttribute('data-e2e') || '',
          text: (el.innerText || '').trim().slice(0, 100), class: String(el.className || '').toString().slice(0, 160),
          pressed: el.getAttribute('aria-pressed') || '', state: el.getAttribute('data-state') || ''
        }};
      })""")
    found = []
    seen = set()
    for row in rows:
        if not row["visible"]:
            continue
        index, info = row["index"], row["info"]
        signature = (info.get("tag"), info.get("aria"), info.get("title"), info.get("e2e"), info.get("class"), info.get("text"))
        if signature in seen:
            continue
        seen.add(signature)
        searchable = " ".join(str(info.get(key, "")) for key in ("aria", "title", "e2e", "class", "text"))
        if patterns[action].search(searchable):
            found.append((candidates.nth(index), info))
    return found


def _visible_comment_fields(page) -> list[tuple[object, dict]]:
    selector = 'textarea,input,[contenteditable],[role="textbox"],[data-placeholder]'
    candidates = page.locator(selector)
    rows = candidates.evaluate_all("""els => els.map((el, index) => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return {index, visible: style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0, info: {
          aria: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '',
          dataPlaceholder: el.getAttribute('data-placeholder') || '', role: el.getAttribute('role') || '',
          ancestorClass: String(el.closest('[class*="comment-input"]')?.className || ''),
          title: el.getAttribute('title') || '', class: String(el.className || '').toString().slice(0, 160),
          tag: el.tagName.toLowerCase()
        }};
    })""")
    fields = []
    for row in rows:
        if not row["visible"]:
            continue
        field, info = candidates.nth(row["index"]), row["info"]
        labels = " ".join(str(info.get(key, "")) for key in ("aria", "placeholder", "dataPlaceholder", "role", "title", "class", "ancestorClass"))
        if re.search(r"评论|comment|说点什么|友善发评", labels, re.I):
            fields.append((field, info))
    return fields


def interact_with_video(action: str, video_url: str, comment_text: str = "", dry_run: bool = False) -> dict:
    if action not in {"like", "comment"}:
        raise RuntimeError("只支持单条视频点赞或评论。")
    parsed = urlparse(str(video_url).strip())
    url = canonical_video_url(video_url) if parsed.scheme == "https" and not parsed.username and not parsed.password else None
    if not url:
        raise RuntimeError("只允许操作抖音标准视频页链接。")
    content = normalize_comment_text(comment_text) if action == "comment" else ""
    if action == "like" and comment_text:
        raise RuntimeError("点赞操作不能附带评论文案。")
    if sync_playwright is None:
        raise RuntimeError("Playwright is missing. Install the dependencies from requirements.txt.")

    state = read_json(INTERACTION_STATE_PATH, {"like_attempts": [], "liked_urls": [], "comment_attempts": []})
    key = interaction_comment_key(url, content) if action == "comment" else ""
    prepare_browser_temp()
    with sync_playwright() as playwright, browser_profile_lock(wait_seconds=300):
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="msedge", headless=False,
            viewport={"width": 1365, "height": 900}
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(3000)
            authenticated(page)
            if canonical_video_url(page.url) != url:
                raise RuntimeError("抖音没有停留在指定视频页；未执行互动。")

            if action == "like":
                matches = _visible_action_controls(page, "like")
                if len(matches) != 1:
                    raise RuntimeError(f"点赞控件识别到 {len(matches)} 个；为避免误点，未执行。")
                button, info = matches[0]
                current = like_control_state(info)
                if dry_run:
                    return {"action": action, "url": url, "dryRun": True,
                            "control": info, "currentlyLiked": current}
                if current is True:
                    return {"action": action, "url": url, "status": "already_liked"}
                if current is None:
                    raise RuntimeError("无法确认当前点赞状态；为避免误取消点赞，未执行。")
                attempts = state.setdefault("like_attempts", [])
                if url in attempts:
                    raise RuntimeError("这条视频曾尝试点赞但结果未确认；请先在抖音页面核对，不会重复点击。")
                attempts.append(url)
                _save_interaction_state(state)
                button.click()
                page.wait_for_timeout(1200)
                after = _visible_action_controls(page, "like")
                if len(after) != 1 or like_control_state(after[0][1]) is not True:
                    raise RuntimeError("点赞结果无法确认；已记录本次尝试，不会自动重试。")
                state.setdefault("liked_urls", []).append(url)
                _save_interaction_state(state)
                return {"action": action, "url": url, "status": "liked", "control": after[0][1]}

            comment_button = _visible_action_controls(page, "comment")
            if len(comment_button) != 1:
                raise RuntimeError(f"评论入口识别到 {len(comment_button)} 个；为避免误点，未执行。")
            comment_button[0][0].click()
            page.wait_for_timeout(800)
            fields = _visible_comment_fields(page)
            if not fields:
                placeholders = page.locator('div[class*="comment-input-inner-container"]')
                if placeholders.count() == 1:
                    placeholders.click()
                    page.wait_for_timeout(300)
                    fields = _visible_comment_fields(page)
            if len(fields) != 1:
                raise RuntimeError(f"评论输入框识别到 {len(fields)} 个；为避免误发，未执行。")
            field, field_info = fields[0]
            existing_count = page.get_by_text(content, exact=True).count()
            if existing_count:
                raise RuntimeError("这条评论文案已出现在当前视频页面；为避免重复公开评论，未提交。")
            field.fill(content)
            submit_buttons = _visible_action_controls(page, "submit")
            if len(submit_buttons) != 1:
                field.fill("")
                raise RuntimeError(f"评论发送控件识别到 {len(submit_buttons)} 个；未提交。")
            submit_button, submit_info = submit_buttons[0]
            if dry_run:
                field.fill("")
                return {"action": action, "url": url, "dryRun": True,
                        "commentField": field_info, "submitControl": submit_info}
            attempts = state.setdefault("comment_attempts", [])
            if key in attempts:
                field.fill("")
                raise RuntimeError("这条评论曾尝试提交但结果未确认；为避免重复公开评论，请先人工核对。")
            attempts.append(key)
            _save_interaction_state(state)
            submit_button.click()
            try:
                page.get_by_text(content, exact=True).first.wait_for(state="visible", timeout=10000)
            except PlaywrightTimeout as exc:
                raise RuntimeError("评论提交结果无法确认；已记录本次尝试，不会自动重发。") from exc
            if page.get_by_text(content, exact=True).count() <= existing_count:
                raise RuntimeError("评论提交结果无法确认；已记录本次尝试，不会自动重发。")
            return {"action": action, "url": url, "status": "commented", "comment": content}
        finally:
            context.close()


def send_one(page, cfg: dict, video: Video) -> None:
    editor = open_recipient_chat(page, cfg)
    send_text_in_open_chat(page, editor, make_message(video))


def deliver_selected(page, cfg: dict, videos: list[Video], state: dict, today: str,
                     limit: int, send_enabled: bool, sender=send_one,
                     state_path: Path | None = None) -> list[Video]:
    remaining = daily_remaining(state, today, cfg["daily_max"])
    excluded = set(state.get("sent_urls", [])) | set(state.get("attempted_urls", []))
    selected = select_videos(videos, excluded, min(limit, remaining))
    if not send_enabled:
        return selected
    for video in selected:
        state.setdefault("attempted_urls", []).append(video.url)
        state.setdefault("attempted_by_day", {})[today] = int(state.get("attempted_by_day", {}).get(today, 0)) + 1
        if state_path:
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        sender(page, cfg, video)
        state.setdefault("sent_urls", []).append(video.url)
        state.setdefault("sent_by_day", {})[today] = int(state.get("sent_by_day", {}).get(today, 0)) + 1
        if state_path:
            state["sent_urls"] = sorted(set(state["sent_urls"]))
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return selected


def browse_feed(page, minutes: int, history_path: Path = SHARED_INTEREST_PATH) -> list[dict]:
    """Browse normal recommendations via canonical public video pages and record actual playback only."""
    videos = collect_feed(page)
    deadline = datetime.now().timestamp() + minutes * 60
    watched: list[dict] = []
    for video in videos:
        if datetime.now().timestamp() >= deadline:
            break
        page.goto(video.url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        authenticated(page)
        current_time = playback_time(page)
        wait_until = min(deadline, datetime.now().timestamp() + 8)
        while current_time is None and datetime.now().timestamp() < wait_until:
            page.wait_for_timeout(1000)
            current_time = playback_time(page)
        if current_time is None:
            continue
        capture_started = start_video_audio_capture(page, seconds=12)
        last_time = current_time
        watched_seconds = 0.0
        frames: list[str] = []
        item_deadline = min(deadline, datetime.now().timestamp() + 20)
        next_frame_at = datetime.now().timestamp() + 2
        while datetime.now().timestamp() < item_deadline:
            page.wait_for_timeout(2000)
            next_time = playback_time(page)
            if next_time is None:
                break
            delta = next_time - last_time
            if 0 < delta <= 3:
                watched_seconds += delta
            last_time = next_time
            if len(frames) < 3 and datetime.now().timestamp() >= next_frame_at:
                frame = capture_video_frame(page)
                if frame:
                    frames.append(frame)
                next_frame_at += 4
        if watched_seconds >= 8:
            title = video.title.strip() or page.title().strip()
            title = re.sub(r"\s+", " ", title).removesuffix(" - 抖音")[:200]
            row = {
                "url": video.url,
                "title": title,
                "author": video.author,
                "watched_seconds": watched_seconds,
                "observed_at": datetime.now(SINGAPORE).isoformat(timespec="minutes"),
            }
            audio_wav = finish_video_audio_capture(page) if capture_started else ""
            analysis = analyze_video_content(frames, audio_wav)
            row.update({
                "content_summary": analysis.get("summary", ""),
                "transcript": analysis.get("transcript", ""),
                "tags": analysis.get("tags", []),
            })
            print(f"  内容理解：转写 {len(row['transcript'])} 字；画面摘要 {'完成' if row['content_summary'] else '未完成'}。")
            watched.append(row)
    accepted = watched
    saved = save_watch_history(history_path, accepted)
    print(f"浏览结束：观察到 {len(accepted)} 条实际播放达到 8 秒的视频，共写入 {saved} 条共享观看记录。")
    return accepted


def playback_time(page) -> float | None:
    value = page.evaluate("""() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
      const video = Array.from(document.querySelectorAll('video'))
        .filter(v => visible(v) && !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0)
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      return video ? video.currentTime : null;
    }""")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def current_video_index(page) -> int | None:
    return page.evaluate("""() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
      const videos = Array.from(document.querySelectorAll('video'));
      const index = videos.findIndex(v => visible(v) && !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0);
      return index < 0 ? null : index;
    }""")


def capture_video_frame(page) -> str:
    """Capture one visible frame from the video element; never fetch or save the source video."""
    index = current_video_index(page)
    if index is None:
        return ""
    try:
        return base64.b64encode(page.locator("video").nth(index).screenshot(type="jpeg", quality=55)).decode("ascii")
    except Exception:
        return ""


def start_video_audio_capture(page, seconds: int = 12) -> bool:
    """Record only the playing video element's audio track in page memory."""
    try:
        result = page.evaluate("""(seconds) => {
          const videos = Array.from(document.querySelectorAll('video'));
          const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
          const video = videos.filter(v => visible(v) && !v.paused && !v.ended && v.readyState >= 2)
            .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
          const capture = video?.captureStream || video?.mozCaptureStream;
          if (!video || !capture || !window.MediaRecorder) return false;
          const audioTracks = capture.call(video).getAudioTracks();
          if (!audioTracks.length) return false;
          const stream = new MediaStream(audioTracks);
          const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
            .find(type => MediaRecorder.isTypeSupported(type));
          const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
          window.__daFeiYuVideoCapture = new Promise(resolve => {
            const chunks = [];
            recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
            recorder.onerror = () => resolve('');
            recorder.onstop = async () => {
              try {
                const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
                const context = new AudioContext();
                const decoded = await context.decodeAudioData(encoded);
                const targetRate = 16000;
                const length = Math.floor(decoded.duration * targetRate);
                const mono = new Float32Array(length);
                for (let i = 0; i < length; i++) {
                  const sourceIndex = Math.floor(i * decoded.sampleRate / targetRate);
                  let total = 0;
                  for (let channel = 0; channel < decoded.numberOfChannels; channel++) total += decoded.getChannelData(channel)[sourceIndex] || 0;
                  mono[i] = total / decoded.numberOfChannels;
                }
                const wav = new ArrayBuffer(44 + mono.length * 2);
                const view = new DataView(wav);
                const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
                write(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
                view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
                view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true);
                view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, mono.length * 2, true);
                for (let i = 0; i < mono.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mono[i])) * 32767, true);
                const bytes = new Uint8Array(wav);
                let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                await context.close(); resolve(btoa(binary));
              } catch { resolve(''); }
            };
            recorder.start();
            setTimeout(() => { try { recorder.stop(); } catch { resolve(''); } }, Math.min(12, Math.max(1, seconds)) * 1000);
          });
          return true;
        }""", seconds)
        return result is True
    except Exception:
        return False


def finish_video_audio_capture(page) -> str:
    try:
        return str(page.evaluate("async () => await (window.__daFeiYuVideoCapture || Promise.resolve(''))") or "")
    except Exception:
        return ""


def analyze_video_content(frames: list[str], audio_wav: str) -> dict:
    """Run bounded local transcription and the configured vision model via a stdin-only helper."""
    if not frames and not audio_wav:
        return {}
    if not VIDEO_ANALYZER.is_file():
        return {}
    try:
        result = subprocess.run(
            ["node", str(VIDEO_ANALYZER)], input=json.dumps({"frames": frames[:3], "audioWav": audio_wav}),
            capture_output=True, text=True, encoding="utf-8", timeout=150, check=False,
        )
        if result.returncode != 0:
            print(f"视频内容分析未完成：{result.stderr.strip()[:240]}", file=sys.stderr)
            return {}
        value = json.loads(result.stdout)
        if value.get("audioError"):
            print(f"  音频转写不可用：{value['audioError']}", file=sys.stderr)
        if value.get("visionError"):
            print(f"  画面分析不可用：{value['visionError']}", file=sys.stderr)
        return value if isinstance(value, dict) else {}
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(f"视频内容分析未完成：{exc}", file=sys.stderr)
        return {}


def analyze_shared_video(page, event: dict) -> dict:
    """Open only a Douyin share URL, verify its final video page, and analyze bounded playback."""
    direct_url = canonical_video_url(str(event.get("videoUrl", "")))
    share_url = safe_share_url(str(event.get("shareUrl", "")))
    card_text = re.sub(r"[\r\n\t]+", " ", str(event.get("cardText", ""))).strip()[:500]
    result = {"url": direct_url or "", "shareUrl": share_url or "", "title": card_text,
              "author": "", "cardText": card_text, "status": "unresolved",
              "summary": "", "transcript": "", "tags": []}
    target = direct_url or share_url
    if not target:
        return result
    try:
        page.goto(target, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)
        authenticated(page)
        final_url = canonical_video_url(page.url)
        if not final_url or (direct_url and final_url != direct_url):
            result["status"] = "unavailable"
            return result
        result["url"] = final_url
        metadata = page.evaluate("""() => ({
          title: document.querySelector('meta[property="og:title"]')?.content || document.title || '',
          author: document.querySelector('meta[name="author"]')?.content || ''
        })""")
        if isinstance(metadata, dict):
            result["title"] = re.sub(r"[\r\n\t]+", " ", str(metadata.get("title", ""))).strip().removesuffix(" - 抖音")[:200] or card_text
            result["author"] = re.sub(r"[\r\n\t]+", " ", str(metadata.get("author", ""))).strip()[:100]

        playback_deadline = datetime.now().timestamp() + 15
        while playback_time(page) is None and datetime.now().timestamp() < playback_deadline:
            page.wait_for_timeout(1000)
        if playback_time(page) is None:
            result["status"] = "no_playback"
            return result

        capture_started = start_video_audio_capture(page, seconds=12)
        frames = []
        for capture_index in range(3):
            if capture_index:
                page.wait_for_timeout(4000)
            if playback_time(page) is None:
                break
            frame = capture_video_frame(page)
            if frame:
                frames.append(frame)
        audio_wav = finish_video_audio_capture(page) if capture_started else ""
        analysis = analyze_video_content(frames, audio_wav)
        result.update({
            "summary": str(analysis.get("summary", ""))[:400],
            "transcript": str(analysis.get("transcript", ""))[:1000],
            "tags": analysis.get("tags", [])[:5] if isinstance(analysis.get("tags"), list) else [],
            "status": "analyzed" if analysis.get("summary") or analysis.get("transcript") else "partial",
        })
        return sanitize_inbound_video_context(result) or result
    except Exception as exc:
        print(f"分享视频无法读取：{exc.__class__.__name__}", file=sys.stderr)
        result["status"] = "unavailable"
        return result


def browse_session(minutes: int, wait_seconds: int = 0) -> list[dict]:
    """Run one read-only recommendation session and return the videos actually watched."""
    if sync_playwright is None:
        raise RuntimeError("Playwright is missing. Install the dependencies from requirements.txt.")
    prepare_browser_temp()
    with sync_playwright() as playwright, browser_profile_lock(wait_seconds=wait_seconds):
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="msedge", headless=False,
            viewport={"width": 1365, "height": 900}
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            return browse_feed(page, minutes)
        finally:
            context.close()


def run_browse(minutes: int) -> int:
    rows = browse_session(minutes)
    for row in rows:
        print(f"- {row['title']} | {row['author'] or '未知作者'} | {int(row['watched_seconds'])} 秒")
    if not rows:
        print("没有确认到持续播放的视频；未保存观看记录。")
    return 0


def run_share_latest() -> int:
    """Share the newest valid video from actual watch history, once, to the verified owner."""
    if sync_playwright is None:
        raise RuntimeError("Playwright is missing. Install the dependencies from requirements.txt.")
    prepare_browser_temp()
    cfg = load_config()
    state = read_json(STATE_PATH, {"sent_by_day": {}, "sent_urls": []})
    today = datetime.now(SINGAPORE).date().isoformat()
    if daily_remaining(state, today, cfg["daily_max"]) <= 0:
        raise RuntimeError("Daily Douyin share limit reached (maximum 5).")
    require_recipient_verification(cfg, read_json(VERIFICATION_PATH, {}))
    history = read_json(SHARED_INTEREST_PATH, {"watchedVideos": []})
    watched = history.get("watchedVideos", []) if isinstance(history, dict) else []
    excluded = set(state.get("sent_urls", [])) | set(state.get("attempted_urls", []))
    video = latest_unsent_video(watched, excluded)
    if video is None:
        raise RuntimeError("No unsent, valid video in watch history. Let DaFeiYu watch a video first.")

    with sync_playwright() as playwright, browser_profile_lock(wait_seconds=300):
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="msedge", headless=False,
            viewport={"width": 1365, "height": 900}
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            delivered = deliver_selected(page, cfg, [video], state, today, 1, True, state_path=STATE_PATH)
            if not delivered:
                raise RuntimeError("Daily Douyin share limit reached or video already attempted.")
            print(json.dumps({"sent": True, "title": video.title, "author": video.author,
                              "url": video.url}, ensure_ascii=False))
            return 0
        finally:
            context.close()


def run(login_only: bool, enable_send: bool, verify_only: bool, max_items: int) -> int:
    if sync_playwright is None:
        raise RuntimeError("Playwright is missing. Install the dependencies from requirements.txt.")
    prepare_browser_temp()
    cfg = load_config()
    state = read_json(STATE_PATH, {"sent_by_day": {}, "sent_urls": []})
    today = date.today().isoformat()
    remaining = daily_remaining(state, today, cfg["daily_max"])
    if enable_send and remaining == 0:
        print("Daily maximum already reached; nothing sent.")
        return 0
    if enable_send:
        require_recipient_verification(cfg, read_json(VERIFICATION_PATH, {}))
    with sync_playwright() as playwright, browser_profile_lock():
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="msedge", headless=False,
            viewport={"width": 1365, "height": 900}
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            if login_only:
                page.goto(FEED_URL, wait_until="domcontentloaded")
                print("Complete Douyin login manually in the visible browser, then press Enter here to save the session.")
                input()
                return 0
            if verify_only:
                profile_url, expected_handle = recipient_config(cfg)
                open_recipient_chat(page, cfg)
                VERIFICATION_PATH.write_text(json.dumps({
                    "recipient_profile_url": profile_url,
                    "recipient_handle": expected_handle,
                }, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Verified Douyin ID {expected_handle} and its chat. No message sent.")
                return 0
            videos = collect_feed(page)
            selected = deliver_selected(page, cfg, videos, state, today, max_items,
                                        enable_send, state_path=STATE_PATH)
            print(f"Collected {len(selected)} eligible recommendation(s):")
            for video in selected:
                print(f"- {video.title} | {video.author or 'unknown author'} | {video.url}")
            if not enable_send:
                print("Dry run only. No messages sent.")
                return 0
            if enable_send:
                print(f"Sent {len(selected)} message(s).")
            return 0
        finally:
            context.close()


def save_daily_browse_state(state: dict) -> None:
    DAILY_BROWSE_STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def daily_browse_due(daily: dict, state: dict, now: datetime) -> bool:
    return bool(daily.get("enabled")) and state.get("last_date") != now.date().isoformat() \
        and now.strftime("%H:%M") >= str(daily.get("time", "20:30"))


def sanitize_daily_rows(rows: list[dict]) -> list[dict]:
    cleaned = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url", "")).strip()
        title = re.sub(r"\s+", " ", str(row.get("title", ""))).strip()[:200]
        if not re.fullmatch(r"https://(?:www\.)?douyin\.com/video/\d+", url) or not title:
            continue
        tags = row.get("tags") if isinstance(row.get("tags"), list) else []
        try:
            watched = round(float(row.get("watched_seconds") or 0), 1)
        except (TypeError, ValueError):
            watched = 0.0
        cleaned.append({
            "url": url,
            "title": title,
            "author": re.sub(r"\s+", " ", str(row.get("author", ""))).strip()[:60],
            "watched_seconds": watched,
            "observed_at": str(row.get("observed_at", ""))[:40],
            "content_summary": re.sub(r"\s+", " ", str(row.get("content_summary", ""))).strip()[:400],
            "tags": [re.sub(r"\s+", " ", str(tag)).strip()[:24] for tag in tags[:5]
                     if str(tag).strip()],
        })
        if len(cleaned) >= 5:
            break
    return cleaned


def post_daily_report(cfg: dict, date_text: str, rows: list[dict], share_to_owner: bool, post_qzone: bool) -> bool:
    daily = cfg.get("daily_browse") or {}
    endpoint = str(daily.get("report_url", "http://127.0.0.1:3101/douyin/daily-report"))
    parsed = urlparse(endpoint)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("Daily report backend must use loopback HTTP")
    token_path = Path(str(daily["token_file"]))
    if not token_path.is_absolute():
        token_path = ROOT / token_path
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("Local bridge console token is empty")
    body = json.dumps({
        "date": date_text,
        "minutes": int(daily["minutes"]),
        "videos": rows,
        "shareToOwner": bool(share_to_owner),
        "postQzone": bool(post_qzone),
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, headers={
        "Content-Type": "application/json", "x-console-token": token,
    }, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            detail = ""
        print(f"Daily report rejected (HTTP {exc.code}): {detail}", file=sys.stderr)
        return False
    except (OSError, urllib.error.URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"Daily report backend unavailable: {exc}", file=sys.stderr)
        return False
    if not isinstance(result, dict) or result.get("ok") is not True:
        error = result.get("error") if isinstance(result, dict) else "invalid response"
        print(f"Daily report rejected: {error}", file=sys.stderr)
        return False
    print(f"Daily report result: {json.dumps(result.get('result', {}), ensure_ascii=False)[:400]}")
    return True


def flush_daily_report(cfg: dict, state: dict) -> bool:
    pending = state.get("pending_report")
    if not isinstance(pending, dict):
        return True
    date_text = str(pending.get("date", "")).strip()
    rows = sanitize_daily_rows(pending.get("videos") or [])
    share_to_owner = pending.get("share_to_owner") is not False
    post_qzone = pending.get("post_qzone") is True
    today = datetime.now(SINGAPORE).date().isoformat()
    if date_text != today or not rows or not (share_to_owner or post_qzone):
        state.pop("pending_report", None)
        save_daily_browse_state(state)
        return True
    try:
        delivered = post_daily_report(cfg, date_text, rows, share_to_owner, post_qzone)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Daily report failed: {exc}", file=sys.stderr)
        return False
    if delivered:
        state.pop("pending_report", None)
        save_daily_browse_state(state)
        return True
    return False


def record_daily_failure(state: dict, today: str, message: str, max_attempts: int = 3) -> None:
    """Count a failed session; give up for the day only after repeated failures."""
    attempts = int(state.get("attempts", 0)) + 1 if state.get("attempt_date") == today else 1
    state["attempt_date"] = today
    state["attempts"] = attempts
    state["last_error"] = str(message)[:300]
    if attempts >= max_attempts:
        state["last_date"] = today
    save_daily_browse_state(state)


def run_daily_browse(cfg: dict, state: dict, now: datetime | None = None) -> int:
    daily = cfg.get("daily_browse") or {}
    now = now or datetime.now(SINGAPORE)
    today = now.date().isoformat()
    try:
        rows = browse_session(int(daily["minutes"]), wait_seconds=300)
    except RuntimeError as exc:
        if "already in use" in str(exc):
            print("Daily browse deferred: browser profile is busy; retrying on the next scheduled check.",
                  file=sys.stderr)
            return 0
        record_daily_failure(state, today, str(exc))
        print(f"Daily browse failed: {exc}", file=sys.stderr)
        return 0
    except Exception as exc:
        record_daily_failure(state, today, str(exc))
        print(f"Daily browse failed: {exc}", file=sys.stderr)
        return 0

    cleaned = sanitize_daily_rows(rows)
    state["last_date"] = today
    state["attempt_date"] = today
    state["attempts"] = 0
    state["last_count"] = len(cleaned)
    state["last_error"] = ""
    if not cleaned:
        state.pop("pending_report", None)
        save_daily_browse_state(state)
        print("Daily browse found no video played for at least 8 seconds; no report sent.")
        return 0
    state["pending_report"] = {
        "date": today,
        "videos": cleaned,
        "share_to_owner": bool(daily.get("share_to_owner", True)),
        "post_qzone": bool(daily.get("post_qzone", True)),
    }
    save_daily_browse_state(state)
    print(f"Daily browse watched {len(cleaned)} video(s); preparing the report.")
    if not flush_daily_report(cfg, state):
        print("Daily report is pending; retrying on the next scheduled check.", file=sys.stderr)
    return 0


def run_scheduled(poll_inbox: bool = True) -> int:
    cfg = load_config()
    inbound_cfg = cfg.get("inbound") or {}
    inbound_requested = inbound_cfg.get("enabled") is True
    inbound_ready = (inbound_requested
                     and inbound_cfg.get("selectors_verified") is True
                     and (cfg.get("reply_backend") or {}).get("enabled") is True)
    daily_cfg = cfg.get("daily_browse") or {}
    daily_enabled = daily_cfg.get("enabled") is True
    if not cfg["scheduled_enabled"] and not inbound_ready and not daily_enabled:
        print("Scheduled sending is disabled; browser not launched.")
        return 0
    state = read_json(STATE_PATH, {"sent_by_day": {}, "sent_urls": []})
    daily_state = read_json(DAILY_BROWSE_STATE_PATH, {})
    now = datetime.now(SINGAPORE)
    flush_daily_report(cfg, daily_state)
    if daily_browse_due(daily_cfg, daily_state, now):
        return run_daily_browse(cfg, daily_state, now)
    today = now.date().isoformat()
    slot = claim_due_slot(state, now) if cfg["scheduled_enabled"] else None
    if cfg["scheduled_enabled"]:
        STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    if slot is None:
        if not inbound_ready:
            if inbound_requested:
                print("Inbox polling is enabled but gated until selectors and reply backend are verified.")
            else:
                print("No due slot; browser not launched.")
            return 0
        if poll_inbox:
            inbox_result = run_inbox(inspect_only=False)
            print(f"Scheduled inbox poll result: {inbox_result}.")
            return inbox_result
        print("No due slot; persistent inbox listener remains active.")
        return 0

    if inbound_ready and poll_inbox:
        inbox_result = run_inbox(inspect_only=False)
        if inbox_result != 0:
            print(f"Scheduled inbox poll failed ({inbox_result}); continuing to the due video slot.", file=sys.stderr)

    def fail_slot(message: str) -> int:
        slot["status"] = "failed"
        slot["error"] = message[:300]
        STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Scheduled slot consumed: {message}", file=sys.stderr)
        return 2

    if daily_remaining(state, today, cfg["daily_max"]) <= 0:
        return fail_slot("Daily send maximum already reached.")
    if not verification_matches(cfg, read_json(VERIFICATION_PATH, {})):
        return fail_slot("Recipient verification is missing or no longer matches configuration.")
    if sync_playwright is None:
        return fail_slot("Playwright is missing. Install the dependencies from requirements.txt.")

    try:
        prepare_browser_temp()
        with sync_playwright() as playwright, browser_profile_lock():
            context = playwright.chromium.launch_persistent_context(
                str(PROFILE_DIR), channel="msedge", headless=False,
                viewport={"width": 1365, "height": 900}
            )
            try:
                page = context.pages[0] if context.pages else context.new_page()
                videos = collect_feed(page)
                selected = deliver_selected(page, cfg, videos, state, today, 1, True,
                                            state_path=STATE_PATH)
                if not selected:
                    slot["status"] = "no_candidate"
                else:
                    slot["status"] = "sent"
                    slot["video_url"] = selected[0].url
                STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Scheduled slot result: {slot['status']}.")
                return 0
            finally:
                context.close()
    except Exception as exc:
        return fail_slot(str(exc) or exc.__class__.__name__)


def process_inbox_page(page, editor, cfg: dict, selectors: dict, state: dict) -> int:
    consumed = set(state.get("inbound_reply_attempts", []))
    rows = read_inbound_rows(page, selectors)
    if not state.get("inbound_baseline_initialized"):
        baseline = extract_inbound_events(rows, set(), limit=200)
        state["inbound_reply_attempts"] = [event["id"] for event in baseline]
        state["inbound_baseline_initialized"] = True
        write_inbound_state(INBOUND_STATE_PATH, state)
        print(f"Saved an initial baseline of {len(baseline)} existing message IDs; no reply sent.")
        return 0
    pending = extract_inbound_events(list(reversed(rows)), consumed, limit=1)
    if not pending:
        return 0
    event = pending[0]
    if event["isVideo"]:
        video_context = analyze_shared_video(page, event)
        source_message_key = hashlib.sha256(event["id"].encode("utf-8")).hexdigest()[:12]
        state["pending_shared_video_context"] = {
            "at": datetime.now(SINGAPORE).isoformat(timespec="seconds"),
            "sourceMessageKey": source_message_key,
            "videoContext": video_context,
        }
        context_source = "current_video_message"
    else:
        previous_video = state.get("pending_shared_video_context")
        source_message_key = str(previous_video.get("sourceMessageKey", "")) if isinstance(previous_video, dict) else ""
        video_context, context_source = recent_shared_video_context(state, event)
        if context_source != "recent_shared_video":
            source_message_key = ""
    write_inbound_state(INBOUND_STATE_PATH, state)
    log_inbound_diagnostic(event, video_context, context_source, "reply_requested", source_message_key)
    try:
        reply_text = request_inbound_reply(cfg, state, cfg["recipient_handle"], event["id"],
                                           event["text"], INBOUND_STATE_PATH,
                                           video_context=video_context)
    except RuntimeError as exc:
        log_inbound_diagnostic(event, video_context, context_source, "reply_backend_failed", source_message_key)
        print(f"Inbound message consumed; model reply unavailable: {exc}", file=sys.stderr)
        return 2
    if not reply_text:
        log_inbound_diagnostic(event, video_context, context_source, "duplicate_or_empty_reply", source_message_key)
        print("Inbound message was already consumed by the local reply backend; no send attempted.")
        return 0
    if event["isVideo"]:
        editor = open_recipient_chat(page, cfg)
    send_text_in_open_chat(page, editor, reply_text)
    log_inbound_diagnostic(event, video_context, context_source, "reply_sent", source_message_key)
    print("Replied once to the newest inbound message in the verified conversation.")
    return 0


def arm_inbox_mutation_observer(page, row_selector: str) -> None:
    page.evaluate("""selector => {
      window.__daFeiYuInboxObserver?.disconnect();
      window.__daFeiYuInboxMutationVersion = 0;
      const belongsToMessage = node => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return !!element && (element.matches(selector) || !!element.closest(selector) ||
          !!element.querySelector(selector));
      };
      const observer = new MutationObserver(records => {
        if (records.some(record => belongsToMessage(record.target) ||
            Array.from(record.addedNodes).some(belongsToMessage))) {
          window.__daFeiYuInboxMutationVersion++;
        }
      });
      observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true});
      window.__daFeiYuInboxObserver = observer;
    }""", row_selector)


def run_inbox(inspect_only: bool) -> int:
    cfg = load_config()
    require_recipient_verification(cfg, read_json(VERIFICATION_PATH, {}))
    selectors = None if inspect_only else inbound_selectors(cfg)
    if not inspect_only and not (cfg.get("reply_backend") or {}).get("enabled"):
        raise RuntimeError("Enable the loopback reply backend before polling inbound messages.")
    if sync_playwright is None:
        raise RuntimeError("Playwright is missing. Install the dependencies from requirements.txt.")
    prepare_browser_temp()
    with sync_playwright() as playwright, browser_profile_lock():
        context = playwright.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="msedge", headless=False,
            viewport={"width": 1365, "height": 900}
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            editor = open_recipient_chat(page, cfg)
            if inspect_only:
                print(json.dumps(inspect_inbox_shape(page), ensure_ascii=False, indent=2))
                return 0

            state = read_json(INBOUND_STATE_PATH, {"inbound_reply_attempts": []})
            return process_inbox_page(page, editor, cfg, selectors, state)
        finally:
            context.close()


def scheduled_work_due(cfg: dict) -> bool:
    now = datetime.now(SINGAPORE)
    daily_state = read_json(DAILY_BROWSE_STATE_PATH, {})
    if daily_browse_due(cfg.get("daily_browse") or {}, daily_state, now):
        return True
    if not cfg["scheduled_enabled"]:
        return False
    state = read_json(STATE_PATH, {"sent_by_day": {}, "sent_urls": []})
    slots = ensure_daily_plan(state, now.date())
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return any(slot.get("status") == "pending" and now >= datetime.fromisoformat(slot["at"])
               for slot in slots)


def run_inbox_listener() -> int:
    """Keep the verified inbox open and react to message-row DOM mutations."""
    if sync_playwright is None:
        raise RuntimeError("Playwright is missing. Install the dependencies from requirements.txt.")
    next_schedule_check = time_module.monotonic()
    while True:
        context = None
        maintenance_due = False
        try:
            cfg = load_config()
            selectors = inbound_selectors(cfg)
            if not (cfg.get("reply_backend") or {}).get("enabled"):
                raise RuntimeError("Enable the loopback reply backend before listening for inbound messages.")
            prepare_browser_temp()
            with sync_playwright() as playwright, browser_profile_lock():
                context = playwright.chromium.launch_persistent_context(
                    str(PROFILE_DIR), channel="msedge", headless=False,
                    viewport={"width": 1365, "height": 900}
                )
                page = context.pages[0] if context.pages else context.new_page()
                editor = open_recipient_chat(page, cfg)
                conversation_url = page.url
                arm_inbox_mutation_observer(page, selectors["message_selector"])
                state = read_json(INBOUND_STATE_PATH, {"inbound_reply_attempts": []})
                process_inbox_page(page, editor, cfg, selectors, state)
                print("Persistent Douyin inbox listener is active.")
                while True:
                    if time_module.monotonic() >= next_schedule_check:
                        daily_state = read_json(DAILY_BROWSE_STATE_PATH, {})
                        flush_daily_report(cfg, daily_state)
                        if scheduled_work_due(cfg):
                            maintenance_due = True
                            break
                        next_schedule_check = time_module.monotonic() + 15
                    version = page.evaluate("() => window.__daFeiYuInboxMutationVersion || 0")
                    try:
                        page.wait_for_function(
                            "version => (window.__daFeiYuInboxMutationVersion || 0) > version",
                            arg=version, timeout=1000
                        )
                    except PlaywrightTimeout:
                        continue
                    state = read_json(INBOUND_STATE_PATH, {"inbound_reply_attempts": []})
                    process_inbox_page(page, editor, cfg, selectors, state)
                    if page.url != conversation_url:
                        editor = open_recipient_chat(page, cfg)
                        conversation_url = page.url
                    arm_inbox_mutation_observer(page, selectors["message_selector"])
        except KeyboardInterrupt:
            print("Persistent Douyin inbox listener stopped.")
            return 0
        except Exception as exc:
            print(f"Douyin inbox listener restarting after {exc.__class__.__name__}: {exc}", file=sys.stderr)
            time_module.sleep(15)
        finally:
            if context:
                try:
                    context.close()
                except Exception:
                    pass
        if maintenance_due:
            run_scheduled(poll_inbox=False)
            next_schedule_check = time_module.monotonic() + 15


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--login", action="store_true", help="Open the visible browser for manual login")
    parser.add_argument("--verify-recipient", action="store_true", help="Verify the configured visible Douyin ID without sending")
    parser.add_argument("--inspect-inbox", action="store_true", help="Open the verified chat and print sanitized DOM structure only")
    parser.add_argument("--poll-inbox", action="store_true", help="Process at most one new inbound message when verified selectors are configured")
    parser.add_argument("--listen-inbox", action="store_true", help="Keep the verified inbox open and react to new-message DOM changes")
    parser.add_argument("--browse", action="store_true", help="Browse the visible feed for a bounded session and share watch history with QQ")
    parser.add_argument("--interact", choices=("like", "comment"), help="Interact with exactly one explicitly selected video")
    parser.add_argument("--video-url", help="Canonical Douyin /video/<id> URL for --interact")
    parser.add_argument("--comment-text", default="", help="Exact user-provided single-line comment for --interact comment")
    parser.add_argument("--dry-run", action="store_true", help="Inspect controls without liking or publishing a comment")
    parser.add_argument("--share-latest", action="store_true", help="Share the newest eligible watched video to the verified recipient")
    parser.add_argument("--minutes", type=int, default=10, help="Duration for --browse (1-15 minutes; default: 10)")
    parser.add_argument("--send", action="store_true", help="Enable sending; without it this is a dry run")
    parser.add_argument("--scheduled", action="store_true", help="Process at most one due Singapore-time daily slot")
    parser.add_argument("--max-items", type=int)
    args = parser.parse_args()
    max_items = args.max_items if args.max_items is not None else 2
    if not 1 <= max_items <= 5:
        parser.error("--max-items must be between 1 and 5")
    if not 1 <= args.minutes <= 15:
        parser.error("--minutes must be between 1 and 15")
    if args.browse and (args.share_latest or args.send or args.scheduled or args.login or args.verify_recipient
                        or args.inspect_inbox or args.poll_inbox or args.listen_inbox or args.interact):
        parser.error("--browse is a separate read-only browser mode")
    if args.minutes != 10 and not args.browse:
        parser.error("--minutes can only be used with --browse")
    if args.login and (args.send or args.verify_recipient or args.scheduled):
        parser.error("--login cannot be combined with send or recipient verification")
    if args.verify_recipient and (args.send or args.scheduled):
        parser.error("--verify-recipient never sends; run it separately")
    if args.scheduled and (args.send or args.max_items is not None):
        parser.error("--scheduled manages its own one-message-per-slot limit; do not combine with --send/--max-items")
    if args.share_latest and (args.send or args.max_items is not None):
        parser.error("--share-latest sends exactly one watched video and cannot be combined with --send/--max-items")
    if args.interact and not args.video_url:
        parser.error("--interact requires --video-url")
    if args.interact == "comment" and not args.comment_text and not args.dry_run:
        parser.error("--interact comment requires exact --comment-text")
    if args.interact == "like" and args.comment_text:
        parser.error("--comment-text is only valid with --interact comment")
    if not args.interact and (args.video_url or args.comment_text or args.dry_run):
        parser.error("--video-url/--comment-text/--dry-run require --interact")
    if sum(bool(value) for value in (args.login, args.verify_recipient, args.inspect_inbox, args.poll_inbox,
                                     args.listen_inbox, args.browse, args.scheduled, args.share_latest, args.interact)) > 1:
        parser.error("Choose only one browser mode")
    if args.send and (args.inspect_inbox or args.poll_inbox):
        parser.error("--inspect-inbox never sends; --poll-inbox is separately gated by inbound configuration")
    try:
        if args.scheduled:
            return run_scheduled()
        if args.inspect_inbox:
            return run_inbox(inspect_only=True)
        if args.poll_inbox:
            return run_inbox(inspect_only=False)
        if args.listen_inbox:
            return run_inbox_listener()
        if args.browse:
            return run_browse(args.minutes)
        if args.interact:
            result = interact_with_video(args.interact, args.video_url, args.comment_text, args.dry_run)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.share_latest:
            return run_share_latest()
        return run(args.login, args.send, args.verify_recipient, max_items)
    except (RuntimeError, PlaywrightTimeout) as exc:
        print(f"Stopped safely: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
