"""Manually authenticated Douyin feed reader and allowlisted DM sender."""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import tempfile
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
VERIFICATION_PATH = ROOT / "recipient-verification.json"
LOCAL_TEMP_DIR = ROOT / "playwright-temp"
SINGAPORE = ZoneInfo("Asia/Singapore")
DAILY_WINDOWS = (
    (time(9, 0), time(11, 30)),
    (time(11, 30), time(14, 0)),
    (time(14, 0), time(17, 0)),
    (time(17, 0), time(20, 0)),
    (time(20, 0), time(23, 0)),
)
FEED_URL = "https://www.douyin.com/"
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
    return f"刷到这个关于「{title}」的视频，分享给你：{video.url}"


def read_json(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Missing {CONFIG_PATH}. Copy config.example.json and edit it.")
    cfg = read_json(CONFIG_PATH, {})
    cfg.setdefault("daily_max", 5)
    if not isinstance(cfg["daily_max"], int) or not 1 <= cfg["daily_max"] <= 5:
        raise RuntimeError("daily_max must be between 1 and 5")
    return cfg


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
    page.goto(FEED_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)
    authenticated(page)
    cards = page.locator('div[data-aweme-id]:not([data-aweme-id=""])')
    try:
        cards.first.wait_for(state="visible", timeout=20000)
    except PlaywrightTimeout as exc:
        raise RuntimeError("No recommendation cards found; feed markup may have changed or failed to load.") from exc
    for _ in range(3):
        page.mouse.wheel(0, 850)
        page.wait_for_timeout(700)
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


def send_one(page, cfg: dict, video: Video) -> None:
    editor = open_recipient_chat(page, cfg)
    message = make_message(video)
    editor.fill(message)
    send_button = page.locator("svg.e2e-send-msg-btn:visible")
    if send_button.count() != 1 or send_button.get_attribute("aria-disabled") == "true":
        raise RuntimeError("Could not uniquely identify an enabled send button; stopping.")
    send_button.click()
    try:
        sent_message = page.get_by_text(message, exact=True)
        sent_message.first.wait_for(state="visible", timeout=8000)
        if sent_message.count() != 1 or editor.inner_text(timeout=3000).strip() == message:
            raise RuntimeError("Send result is ambiguous. Inspect the conversation before retrying.")
    except PlaywrightTimeout as exc:
        raise RuntimeError("Send result is ambiguous. Inspect the conversation before retrying.") from exc


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
    with sync_playwright() as playwright:
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
    state = read_json(STATE_PATH, {"sent_by_day": {}, "sent_urls": []})
    now = datetime.now(SINGAPORE)
    today = now.date().isoformat()
    slot = claim_due_slot(state, now)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    if slot is None:
        print("No due slot; browser not launched.")
        return 0

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
        with sync_playwright() as playwright:
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--login", action="store_true", help="Open the visible browser for manual login")
    parser.add_argument("--verify-recipient", action="store_true", help="Verify the configured visible Douyin ID without sending")
    parser.add_argument("--send", action="store_true", help="Enable sending; without it this is a dry run")
    parser.add_argument("--scheduled", action="store_true", help="Process at most one due Singapore-time daily slot")
    parser.add_argument("--max-items", type=int)
    args = parser.parse_args()
    max_items = args.max_items if args.max_items is not None else 2
    if not 1 <= max_items <= 5:
        parser.error("--max-items must be between 1 and 5")
    if args.login and (args.send or args.verify_recipient or args.scheduled):
        parser.error("--login cannot be combined with send or recipient verification")
    if args.verify_recipient and (args.send or args.scheduled):
        parser.error("--verify-recipient never sends; run it separately")
    if args.scheduled and (args.send or args.max_items is not None):
        parser.error("--scheduled manages its own one-message-per-slot limit; do not combine with --send/--max-items")
    try:
        if args.scheduled:
            return run_scheduled()
        return run(args.login, args.send, args.verify_recipient, max_items)
    except (RuntimeError, PlaywrightTimeout) as exc:
        print(f"Stopped safely: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
