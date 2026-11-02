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
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlparse

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
VIDEO_PATH = re.compile(r"^/video/(\d+)")
USER_PATH = re.compile(r"^/user/([A-Za-z0-9_-]+)")
BLOCKED_TEXT = re.compile(r"扫码登录|验证码|安全验证|访问过于频繁|操作频繁|登录后.*继续", re.I)


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
        seconds = max(0, min(3600, int(row.get("watched_seconds", 0))))
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
        "observedAt": str(row.get("observed_at", ""))[:32],
        "contentSummary": re.sub(r"[\r\n\t]+", " ", str(row.get("content_summary", ""))).strip()[:400],
        "transcript": re.sub(r"[\r\n\t]+", " ", str(row.get("transcript", ""))).strip()[:800],
        "tags": [re.sub(r"[\r\n\t]+", " ", str(tag)).strip()[:24] for tag in tag_values[:5]
                 if str(tag).strip()] if isinstance(tag_values, list) else [],
    }


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
def browser_profile_lock():
    """Fail closed if another process owns the persistent profile or left a lock behind."""
    try:
        descriptor = os.open(PROFILE_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError("The Douyin browser profile is already in use (or has a stale lock). Close the other run and inspect .browser-profile.lock before retrying.") from exc
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
    return cfg


def request_inbound_reply(cfg: dict, state: dict, sender_handle: str, message_id: str,
                          text: str, state_path: Path | None = INBOUND_STATE_PATH,
                          opener=urllib.request.urlopen) -> str | None:
    """Ask the local bridge for one owner-only reply; consume IDs before network/model work."""
    backend = cfg.get("reply_backend") or {}
    if not backend.get("enabled"):
        return None
    expected = str(cfg.get("recipient_handle", "")).strip().lstrip("@")
    if not expected or str(sender_handle).strip().lstrip("@") != expected:
        return None
    identity = str(message_id).strip()
    content = str(text).strip()
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", identity) or not content or len(content) > 4000:
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
    body = json.dumps({"handle": expected, "messageId": identity, "text": content}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, headers={
        "Content-Type": "application/json", "x-console-token": token,
    }, method="POST")
    try:
        with opener(request, timeout=130) as response:
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
      .map((node, index) => ({
        id: node.getAttribute(s.message_id_attribute) || '',
        index,
        text: (node.querySelector(s.text_selector)?.innerText || '').trim()
      }))""", selectors)
    for row in rows:
        if not row["id"] and row["text"]:
            digest = hashlib.sha256(f"{row['index']}\0{row['text']}".encode("utf-8")).hexdigest()[:32]
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


def run_browse(minutes: int) -> int:
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
            rows = browse_feed(page, minutes)
            for row in rows:
                print(f"- {row['title']} | {row['author'] or '未知作者'} | {int(row['watched_seconds'])} 秒")
            if not rows:
                print("没有确认到持续播放的视频；未保存观看记录。")
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


def run_scheduled() -> int:
    cfg = load_config()
    inbound_cfg = cfg.get("inbound") or {}
    inbound_requested = inbound_cfg.get("enabled") is True
    inbound_ready = (inbound_requested
                     and inbound_cfg.get("selectors_verified") is True
                     and (cfg.get("reply_backend") or {}).get("enabled") is True)
    if not cfg["scheduled_enabled"] and not inbound_ready:
        print("Scheduled sending is disabled; browser not launched.")
        return 0
    state = read_json(STATE_PATH, {"sent_by_day": {}, "sent_urls": []})
    now = datetime.now(SINGAPORE)
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
        inbox_result = run_inbox(inspect_only=False)
        print(f"Scheduled inbox poll result: {inbox_result}.")
        return inbox_result

    if inbound_ready:
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
            consumed = set(state.get("inbound_reply_attempts", []))
            rows = read_inbound_rows(page, selectors)
            if not state.get("inbound_baseline_initialized"):
                baseline = extract_inbound_messages(rows, set(), limit=200)
                state["inbound_reply_attempts"] = [message_id for message_id, _ in baseline]
                state["inbound_baseline_initialized"] = True
                write_inbound_state(INBOUND_STATE_PATH, state)
                print(f"Saved an initial baseline of {len(baseline)} existing message IDs; no reply sent.")
                return 0
            pending = extract_inbound_messages(list(reversed(rows)), consumed, limit=1)
            if not pending:
                print("No new inbound message from the verified conversation.")
                return 0
            message_id, message_text = pending[0]
            try:
                reply_text = request_inbound_reply(cfg, state, cfg["recipient_handle"], message_id,
                                                   message_text, INBOUND_STATE_PATH)
            except RuntimeError as exc:
                print(f"Inbound message consumed; model reply unavailable: {exc}", file=sys.stderr)
                return 2
            if not reply_text:
                print("Inbound message was already consumed by the local reply backend; no send attempted.")
                return 0
            send_text_in_open_chat(page, editor, reply_text)
            print("Replied once to the newest inbound message in the verified conversation.")
            return 0
        finally:
            context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--login", action="store_true", help="Open the visible browser for manual login")
    parser.add_argument("--verify-recipient", action="store_true", help="Verify the configured visible Douyin ID without sending")
    parser.add_argument("--inspect-inbox", action="store_true", help="Open the verified chat and print sanitized DOM structure only")
    parser.add_argument("--poll-inbox", action="store_true", help="Process at most one new inbound message when verified selectors are configured")
    parser.add_argument("--browse", action="store_true", help="Browse the visible feed for a bounded session and share watch history with QQ")
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
    if args.browse and (args.send or args.scheduled or args.login or args.verify_recipient
                        or args.inspect_inbox or args.poll_inbox):
        parser.error("--browse is a separate read-only browser mode")
    if args.minutes != 10 and not args.browse:
        parser.error("--minutes can only be used with --browse")
    if args.login and (args.send or args.verify_recipient or args.scheduled):
        parser.error("--login cannot be combined with send or recipient verification")
    if args.verify_recipient and (args.send or args.scheduled):
        parser.error("--verify-recipient never sends; run it separately")
    if args.scheduled and (args.send or args.max_items is not None):
        parser.error("--scheduled manages its own one-message-per-slot limit; do not combine with --send/--max-items")
    if sum(bool(value) for value in (args.login, args.verify_recipient, args.inspect_inbox, args.poll_inbox,
                                     args.browse, args.scheduled)) > 1:
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
        if args.browse:
            return run_browse(args.minutes)
        return run(args.login, args.send, args.verify_recipient, max_items)
    except (RuntimeError, PlaywrightTimeout) as exc:
        print(f"Stopped safely: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
