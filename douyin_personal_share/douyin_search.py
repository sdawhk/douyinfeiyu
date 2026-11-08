"""Read-only Douyin topic search on the web search page.

Safety boundary: this module only opens the search page, switches to the
"视频" tab and reads already-rendered result cards. It never likes, comments,
follows, opens user profiles or sends anything. The card parser is pure Python
so it can be tested with sanitized HTML fixtures without a browser.

Search is best-effort by design: any failure returns an empty result plus a
reason, so the caller can fall back to the normal recommendation feed instead
of failing the whole browse round.
"""

from __future__ import annotations

import json
import os
import random
import re
import time as time_module
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlparse

import douyin_debug

ROOT = Path(__file__).resolve().parent
SEARCH_STATE_PATH = ROOT / "topic-search-state.json"

SEARCH_URL_TEMPLATE = "https://www.douyin.com/search/{query}?type=video"
HOME_URL = "https://www.douyin.com/"
SEARCH_ENTRY_SEARCH_BOX = "search-box"
SEARCH_ENTRY_DIRECT_URL = "direct-url"
SEARCH_ENTRIES = (SEARCH_ENTRY_SEARCH_BOX, SEARCH_ENTRY_DIRECT_URL)
DEFAULT_SEARCH_ENTRY = SEARCH_ENTRY_SEARCH_BOX
TYPE_DELAY_MS = (60, 120)
CLICK_SETTLE_MS = (120, 280)
ROUTE_WAIT_SECONDS = 12.0
HOME_SETTLE_MS = 800
TAB_SETTLE_MS = 600
DEFAULT_LIMIT = 12
MAX_LIMIT = 12
DEFAULT_TIMEOUT_SECONDS = 90
MAX_TOPIC_CHARS = 20
SEARCH_COOLDOWN_SECONDS = 24 * 60 * 60
STATE_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_STATE_TOPICS = 30
MAX_NODES = 40
MAX_NODE_HTML_CHARS = 20_000
MAX_CARD_TEXT_CHARS = 200
MAX_AUTHOR_CHARS = 40

_VIDEO_PATH = re.compile(r"^/video/(\d+)$")
_WATERFALL_ID = re.compile(r"^waterfall_item_(\d+)$")
_DATE_LINE = re.compile(r"^[·•]?\s*\d{4}年\d{1,2}月\d{1,2}日")
_TRAILING_DATE = re.compile(
    r"\s*[·•]\s*(?:(?:\d{4}年)?\d{1,2}月\d{1,2}日|昨天|前天|今天)\s*$")
_BOUNDARY = re.compile(r"[\r\n\t]")
_BRACKETS = re.compile(r"[\[\]［］【】]")
_URLISH = re.compile(r"https?://|www\.|douyin\.com|/video/", re.I)
_COUNTER = re.compile(r"\d+(?:\.\d+)?[万亿wkm]?", re.I)
_DURATION = re.compile(r"\d{1,2}:\d{2}")
_ZERO_WIDTH = re.compile("[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")
_WHITESPACE = re.compile(r"\s+")
_GENERIC_LINES = {
    "视频", "图文", "综合", "关注", "推荐", "搜索", "展开", "收起",
    "点赞", "评论", "分享", "播放", "更多",
}


def clamp_limit(value, default: int = DEFAULT_LIMIT) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(1, min(MAX_LIMIT, number))


def clean_card_text(value, limit: int = MAX_CARD_TEXT_CHARS) -> str:
    text = _ZERO_WIDTH.sub("", str(value or ""))
    text = _WHITESPACE.sub(" ", text).strip()
    return text[:limit].strip()


def normalize_topic(value, blacklist=(), max_chars: int = MAX_TOPIC_CHARS) -> tuple[str, str]:
    """Validate an owner-supplied topic; return ``(topic, error_message)``.

    An omitted/blank topic is valid and means "no topic" (``('', '')``).
    """
    if value is None:
        return "", ""
    if not isinstance(value, str):
        return "", "主题需为文字"
    if _BOUNDARY.search(value):
        return "", "主题不能包含换行或制表符"
    topic = _WHITESPACE.sub(" ", value).strip()
    if not topic:
        return "", ""
    if "cq:" in topic.lower():
        return "", "主题不能包含 CQ 码"
    if _BRACKETS.search(topic):
        return "", "主题不能包含方括号"
    if _URLISH.search(topic):
        return "", "主题不能是链接"
    if len(topic) > max_chars:
        return "", f"主题最多 {max_chars} 个字"
    lowered = topic.casefold()
    for entry in blacklist or []:
        word = str(entry or "").strip().casefold()
        if word and word in lowered:
            return "", f"主题包含黑名单词：{entry}"
    return topic, ""


def search_url_for(topic: str) -> str:
    return SEARCH_URL_TEMPLATE.format(query=quote(topic, safe=""))


def normalize_search_entry(value) -> str:
    """Map a configured entry to a known mode; unknown values use the homepage box."""
    entry = str(value or "").strip().lower()
    return entry if entry in SEARCH_ENTRIES else DEFAULT_SEARCH_ENTRY


class _DomNode:
    __slots__ = ("tag", "attrs", "children", "text", "_parent")

    def __init__(self, tag: str, attrs: dict | None = None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[_DomNode] = []
        self.text = ""
        self._parent: _DomNode | None = None


class _DomBuilder(HTMLParser):
    _VOID = {
        "img", "br", "hr", "input", "meta", "link", "source", "area", "base",
        "col", "embed", "param", "track", "wbr",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _DomNode("#root")
        self._stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _DomNode(tag, {str(key): str(value or "") for key, value in attrs})
        node._parent = self._stack[-1]
        self._stack[-1].children.append(node)
        if tag not in self._VOID:
            self._stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = _DomNode(tag, {str(key): str(value or "") for key, value in attrs})
        node._parent = self._stack[-1]
        self._stack[-1].children.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == tag:
                del self._stack[index:]
                return

    def handle_data(self, data):
        node = _DomNode("#text")
        node.text = data
        self._stack[-1].children.append(node)


_SKIP_TEXT_TAGS = {"script", "style", "noscript", "template"}
_BLOCK_TAGS = {
    "div", "p", "li", "section", "article", "header", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "a", "span",
}


def _walk(node: _DomNode):
    for child in node.children:
        yield child
        yield from _walk(child)


def _raw_text(node: _DomNode) -> str:
    parts: list[str] = []

    def walk(current: _DomNode) -> None:
        if current.tag == "#text":
            parts.append(current.text)
        elif current.tag == "br":
            parts.append("\n")
        elif current.tag in _SKIP_TEXT_TAGS:
            return
        else:
            for child in current.children:
                walk(child)
            if current.tag in _BLOCK_TAGS:
                parts.append("\n")

    walk(node)
    return _ZERO_WIDTH.sub("", "".join(parts))


def _attr(node: _DomNode, name: str) -> str:
    return str(node.attrs.get(name, ""))


def _markers(node: _DomNode) -> str:
    return " ".join((
        _attr(node, "data-e2e"), _attr(node, "class"),
        _attr(node, "aria-label"), _attr(node, "title"),
    )).lower()


def _video_url(node: _DomNode) -> str:
    # 真实搜索卡片把 aweme id 放在 #waterfall_item_<id> 或 data-aweme-id 上。
    for current in [node, *_walk(node)]:
        match = _WATERFALL_ID.match(_attr(current, "id"))
        if match:
            return f"https://www.douyin.com/video/{match.group(1)}"
    for current in [node, *_walk(node)]:
        aweme = _attr(current, "data-aweme-id")
        if aweme.isdigit():
            return f"https://www.douyin.com/video/{aweme}"
    for child in _walk(node):
        if child.tag != "a":
            continue
        match = _VIDEO_PATH.match(urlparse(_attr(child, "href")).path)
        if match:
            return f"https://www.douyin.com/video/{match.group(1)}"
    return ""


def _author_from_card(node: _DomNode) -> str:
    for child in _walk(node):
        if child.tag != "a" or "/user/" not in _attr(child, "href"):
            continue
        text = clean_card_text(_raw_text(child), MAX_AUTHOR_CHARS).lstrip("@").strip()
        if text:
            return text
    for child in _walk(node):
        if child.tag == "#text":
            continue
        if any(hint in _markers(child) for hint in ("user-name", "username", "nickname", "author")):
            text = clean_card_text(_raw_text(child), MAX_AUTHOR_CHARS).lstrip("@").strip()
            if text:
                return text
    lines = [clean_card_text(line, MAX_AUTHOR_CHARS) for line in _raw_text(node).splitlines()]
    for index, text in enumerate(lines):
        if not text:
            continue
        if text.startswith("@") and len(text) > 1:
            return text.lstrip("@").strip()
        if text == "@" and index + 1 < len(lines):
            # 真实卡片把“@”和昵称放在相邻两个 span 里。
            name = lines[index + 1].lstrip("@").strip()
            if name and not name.startswith("·") and not _DATE_LINE.match(name):
                return name
    return ""


def _title_from_card(node: _DomNode, author: str) -> str:
    for child in _walk(node):
        if child.tag == "#text":
            continue
        if any(hint in _markers(child) for hint in ("title", "desc", "caption")):
            text = clean_card_text(_raw_text(child))
            if text and text != author:
                return text
    kept: list[str] = []
    for line in _raw_text(node).splitlines():
        text = clean_card_text(line)
        if not text or text == author or text.startswith("@"):
            continue
        if _COUNTER.fullmatch(text) or _DURATION.fullmatch(text) or text in _GENERIC_LINES:
            continue
        if text == "·" or _DATE_LINE.match(text):
            continue
        kept.append(text)
    return _TRAILING_DATE.sub("", clean_card_text(" ".join(kept))).strip()


def parse_search_cards(nodes, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """Parse candidate search-result card HTML into ``{url, title, author}``.

    A broken card is skipped; one bad card never fails the batch.
    """
    limit = clamp_limit(limit)
    items: list[dict] = []
    seen: set[str] = set()
    for html in nodes or []:
        if len(items) >= limit:
            break
        if not isinstance(html, str) or not html.strip():
            continue
        if len(html) > MAX_NODE_HTML_CHARS:
            html = html[:MAX_NODE_HTML_CHARS]
        try:
            builder = _DomBuilder()
            builder.feed(html)
            builder.close()
        except Exception:
            continue
        root = next((child for child in builder.root.children if child.tag != "#text"), None)
        if root is None:
            continue
        try:
            url = _video_url(root)
            if not url or url in seen:
                continue
            author = _author_from_card(root)
            title = _title_from_card(root, author)
            seen.add(url)
            items.append({"url": url, "title": title, "author": author})
        except Exception:
            continue
    return items


_EXTRACT_SEARCH_JS = r"""() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hasVideo = (node) => !!node.querySelector('a[href*="/video/"]');
  const containerish = /(list|container|wrapper|panel|header|footer|input|editor)/i;
  // 真实搜索卡片（2026-11 快照）没有 <a href="/video/">，视频 id 在
  // 外层 #waterfall_item_<awemeId> 上；这两类策略按结构本身命中。
  const structural = new Set(['div.search-result-card', '[id^="waterfall_item_"]']);
  const expandCard = (node) => node.closest('[id^="waterfall_item_"]') || node;
  const dedupe = (nodes) => {
    const pool = new Set(nodes);
    return nodes.filter((node) => {
      let parent = node.parentElement;
      while (parent) {
        if (pool.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  };
  const strategies = [
    'div.search-result-card',
    '[id^="waterfall_item_"]',
    '[data-e2e="search-result-card"]',
    '[data-e2e*="search-result"]',
    '[data-e2e*="result-card"]',
    'div[data-aweme-id]:not([data-aweme-id=""])',
    'div[class*="search-result"]',
    'div[class*="searchResult"]',
    'div[class*="result-card"]',
    'div[class*="resultCard"]',
    'div[class*="video-card"]',
    'div[class*="videoCard"]',
    'div[class*="video-info"]',
    'div[class*="videoInfo"]',
    'div[class*="aweme"]',
    'div[data-e2e*="video"]',
    'li[class*="search"]'
  ];
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const blocked = /扫码登录|验证码|安全验证|访问过于频繁|操作频繁/.test(bodyText);
  const noResults = /暂无搜索结果|没有找到相关|暂无结果|未找到相关/.test(bodyText);
  for (const selector of strategies) {
    let nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (structural.has(selector)) {
      nodes = nodes.filter((node) => {
        const text = String(node.innerText || '');
        return text.length >= 10 && text.length <= 1500;
      }).map(expandCard);
    } else if (selector !== 'div[data-aweme-id]:not([data-aweme-id=""])') {
      nodes = nodes.filter((node) => {
        if (containerish.test(String(node.className || ''))) return false;
        return hasVideo(node) && String(node.innerText || '').length <= 1200;
      });
    }
    nodes = dedupe(nodes);
    if (nodes.length) {
      return { strategy: selector, nodes: nodes.slice(0, 40).map((node) => node.outerHTML),
               blocked, noResults, url: location.href };
    }
  }
  const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]')).filter(visible);
  const cardFor = (anchor) => {
    let node = anchor;
    for (let level = 0; level < 6 && node.parentElement; level += 1) {
      node = node.parentElement;
      const text = String(node.innerText || '');
      if (node.querySelector('a[href*="/user/"]') && text.length >= 10) return node;
      if (text.length >= 30) return node;
    }
    return anchor;
  };
  const cards = dedupe(anchors.map(cardFor));
  if (cards.length) {
    return { strategy: 'a[href*="/video/"]', nodes: cards.slice(0, 40).map((node) => node.outerHTML),
             blocked, noResults, url: location.href };
  }
  return { strategy: '', nodes: [], blocked, noResults, url: location.href };
}"""

_TAB_JS = r"""() => {
  // 真实 DOM（2026-11 快照）：搜索页工具栏里的“视频”是 span[data-key="video"]，
  // 不是 <a href="?type=video"> 也不是 role=tab。选中态体现为 class 与未选中 tab 不同。
  const node = document.querySelector('#search-toolbar-container [data-key="video"]')
    || Array.from(document.querySelectorAll('[data-key="video"]'))
      .find(el => String(el.innerText || '').trim() === '视频');
  if (!node) return { found: false, clicked: false, selected: false };
  const peers = Array.from(document.querySelectorAll('#search-toolbar-container [data-key]'))
    .filter(el => el !== node);
  const marker = String(node.getAttribute('aria-selected') || '').toLowerCase() === 'true'
    || (peers.length > 0 && peers.every(el => el.className !== node.className));
  if (marker) return { found: true, clicked: false, selected: true };
  node.click();
  return { found: true, clicked: true, selected: false };
}"""

_FIND_SEARCH_BOX_JS = r"""() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  };
  const selectors = [
    'input[data-e2e="searchbar-input"]',
    'input[data-e2e*="search"]',
    'input[placeholder*="搜索"]',
    'input[aria-label*="搜索"]',
    'input[type="search"]',
    'form input[type="text"]',
    '[data-e2e*="search"] input'
  ];
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const blocked = /扫码登录|验证码|安全验证|访问过于频繁|操作频繁/.test(bodyText);
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector)).find(visible);
    if (node) {
      return {
        selector,
        placeholder: String(node.placeholder || ''),
        e2e: String(node.getAttribute('data-e2e') || ''),
        aria: String(node.getAttribute('aria-label') || ''),
        className: String(node.className || '').slice(0, 160),
        blocked, url: location.href
      };
    }
  }
  return { selector: '', blocked, url: location.href };
}"""

POLL_INTERVAL_MS = 500
FIRST_RESULT_WAIT_SECONDS = 20.0
TAB_RESULT_WAIT_SECONDS = 10.0
SCROLL_RESULT_WAIT_SECONDS = 3.0
SEARCH_ROUNDS = 3


def _poll_for_cards(page, deadline: float, max_wait: float) -> tuple[dict, float]:
    """Poll the search page until cards, a block flag or the per-phase budget ends."""
    started = time_module.monotonic()
    end = min(deadline, started + max(0.0, max_wait))
    state = {"strategy": "", "nodes": [], "blocked": False, "noResults": False}
    while True:
        state = extract_search_cards(page)
        if state["nodes"] or state["blocked"] or state["noResults"]:
            break
        if time_module.monotonic() >= end:
            break
        try:
            page.wait_for_timeout(POLL_INTERVAL_MS)
        except Exception:
            break
    return state, (time_module.monotonic() - started) * 1000.0


def _snapshot(page, prefix: str, meta: dict, body: str | None = None) -> None:
    """Read-only debug snapshot; a no-op unless DOUYIN_DEBUG_DOM_SNAPSHOT=1."""
    if not douyin_debug.enabled():
        return
    text = body
    if text is None:
        try:
            text = page.content()
        except Exception:
            text = ""
    douyin_debug.save(prefix, text, meta)


_SCROLL_JS = r"""() => {
  const card = document.querySelector(
    '[data-e2e="search-result-card"], div[data-aweme-id], a[href*="/video/"]'
  );
  let node = card;
  while (node) {
    const style = getComputedStyle(node);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 24) {
      node.scrollTop = node.scrollHeight;
      return true;
    }
    node = node.parentElement;
  }
  window.scrollTo(0, document.body.scrollHeight);
  return true;
}"""


def extract_search_cards(page) -> dict:
    """Return candidate card HTML and page flags; never raises."""
    fallback = {"strategy": "", "nodes": [], "blocked": False, "noResults": False}
    try:
        raw = page.evaluate(_EXTRACT_SEARCH_JS)
    except Exception:
        return fallback
    if not isinstance(raw, dict):
        return fallback
    nodes = raw.get("nodes")
    if not isinstance(nodes, list):
        nodes = []
    nodes = [node[:MAX_NODE_HTML_CHARS] for node in nodes
             if isinstance(node, str) and node.strip()][:MAX_NODES]
    return {
        "strategy": str(raw.get("strategy") or "")[:120],
        "nodes": nodes,
        "blocked": raw.get("blocked") is True,
        "noResults": raw.get("noResults") is True,
    }


def ensure_video_tab(page) -> bool:
    """Best-effort click on the search page's 视频 tab; never raises."""
    try:
        result = page.evaluate(_TAB_JS)
    except Exception:
        return False
    if isinstance(result, dict):
        return bool(result.get("found"))
    return result is True


def wait_for_video_tab(page, seconds: float = 8.0,
                       deadline: float | None = None) -> tuple[bool, str]:
    """Poll for the 视频 tab (it mounts after the route), then click it.

    Returns ``(ok, reason)``: ``selected``/``clicked+selected``/``clicked`` on
    success, ``tab-not-found`` when it never appears. Capped by ``seconds`` and
    the caller's deadline so it can never stall the whole browse round.
    """
    started = time_module.monotonic()
    limit = started + max(0.0, seconds)
    if deadline is not None:
        limit = min(limit, deadline)
    reason = "tab-not-found"
    while True:
        try:
            info = page.evaluate(_TAB_JS)
        except Exception:
            info = {}
        if isinstance(info, dict) and info.get("found"):
            if info.get("selected"):
                return True, "selected"
            if info.get("clicked"):
                page.wait_for_timeout(500)
                try:
                    confirm = page.evaluate(_TAB_JS)
                except Exception:
                    confirm = {}
                if isinstance(confirm, dict) and confirm.get("selected"):
                    return True, "clicked+selected"
                return True, "clicked"
            reason = "tab-unselected"
        if time_module.monotonic() >= limit:
            return False, reason
        try:
            page.wait_for_timeout(300)
        except Exception:
            return False, reason


def _find_search_box(page) -> dict:
    try:
        raw = page.evaluate(_FIND_SEARCH_BOX_JS)
    except Exception:
        return {"selector": "", "blocked": False}
    return raw if isinstance(raw, dict) else {"selector": "", "blocked": False}


def _open_via_search_box(page, topic: str, deadline: float) -> dict:
    """Open the homepage, type the topic into its search box and press Enter.

    Typing is human-paced (one character at a time, 60-120 ms apart) and never
    touches likes, comments, follows or profiles. Returns ``{"ok", "reason",
    "blocked", "extra"}``; ``reason`` is empty on success.
    """
    extra = {"searchEntry": SEARCH_ENTRY_SEARCH_BOX, "boxSelector": "",
             "typeMs": 0, "routeUrl": ""}
    try:
        page.goto(HOME_URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(HOME_SETTLE_MS)
    except Exception:
        return {"ok": False, "reason": "search-unavailable", "blocked": False, "extra": extra}
    _snapshot(page, "home", {"phase": "home", "url": str(getattr(page, "url", "") or "")})

    found = _find_search_box(page)
    probe_started = time_module.monotonic()
    while not str(found.get("selector") or "") and not found.get("blocked"):
        if time_module.monotonic() - probe_started >= 5.0 or time_module.monotonic() >= deadline:
            break
        try:
            page.wait_for_timeout(POLL_INTERVAL_MS)
        except Exception:
            break
        found = _find_search_box(page)
    if found.get("blocked"):
        _snapshot(page, "home-blocked", {
            "phase": "home", "url": str(getattr(page, "url", "") or ""), "blocked": True,
        })
        return {"ok": False, "reason": "blocked", "blocked": True, "extra": extra}
    selector = str(found.get("selector") or "")
    if not selector:
        _snapshot(page, "home-no-search-box", {
            "phase": "home", "url": str(getattr(page, "url", "") or ""),
            "blocked": False, "selector": "",
        })
        return {"ok": False, "reason": "search-box-missing", "blocked": False, "extra": extra}
    extra["boxSelector"] = selector

    try:
        box = page.locator(selector).first
        try:
            box.click(timeout=8000)
        except Exception:
            box.focus()
        page.wait_for_timeout(random.randint(*CLICK_SETTLE_MS))
        typed_at = time_module.monotonic()
        for char in topic:
            page.keyboard.type(char)
            page.wait_for_timeout(random.randint(*TYPE_DELAY_MS))
        extra["typeMs"] = int((time_module.monotonic() - typed_at) * 1000)
        try:
            if topic not in str(box.input_value() or ""):
                box.fill(topic)
        except Exception:
            pass
        page.keyboard.press("Enter")
    except Exception:
        return {"ok": False, "reason": "search-box-input-failed", "blocked": False,
                "extra": extra}

    route_started = time_module.monotonic()
    while True:
        url = str(getattr(page, "url", "") or "")
        if "/search/" in url:
            extra["routeUrl"] = url
            _snapshot(page, "search-route", {
                "phase": "route", "url": url, "selector": selector,
                "typeMs": extra["typeMs"],
            })
            return {"ok": True, "reason": "", "blocked": False, "extra": extra}
        if (time_module.monotonic() - route_started >= ROUTE_WAIT_SECONDS
                or time_module.monotonic() >= deadline):
            extra["routeUrl"] = url
            return {"ok": False, "reason": "search-box-route-timeout", "blocked": False,
                    "extra": extra}
        try:
            page.wait_for_timeout(250)
        except Exception:
            break
    extra["routeUrl"] = str(getattr(page, "url", "") or "")
    return {"ok": False, "reason": "search-box-route-timeout", "blocked": False, "extra": extra}


def scroll_search_results(page) -> bool:
    try:
        return page.evaluate(_SCROLL_JS) is True
    except Exception:
        return False


def _result(items: list[dict], limit: int, reason: str, strategy: str,
            search_url: str, video_tab: bool, started: float,
            wait_ms: float = 0.0, extra: dict | None = None) -> dict:
    payload = {
        "items": items,
        "count": len(items),
        "limit": limit,
        "reason": reason,
        "strategy": strategy,
        "searchUrl": search_url,
        "videoTab": bool(video_tab),
        "waitMs": int(max(0.0, wait_ms)),
        "elapsed_ms": int((time_module.monotonic() - started) * 1000),
    }
    if extra:
        payload.update(extra)
    return payload


def collect_search_videos(page, topic: str, limit: int = DEFAULT_LIMIT,
                          timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
                          entry: str = SEARCH_ENTRY_DIRECT_URL) -> dict:
    """Open topic search and read up to ``limit`` video cards.

    ``entry="search-box"`` opens the homepage, types the topic into its search
    box like a person and presses Enter; ``entry="direct-url"`` keeps the old
    direct ``/search/<topic>?type=video`` navigation as the fallback. If the
    homepage box cannot be found the call degrades to the direct URL and marks
    ``entryFallback`` in the result. Waits up to 15 s for the SPA result area,
    then optionally clicks the 视频 tab and waits up to 10 s more. Never raises.
    """
    limit = clamp_limit(limit)
    started = time_module.monotonic()
    topic, error = normalize_topic(topic)
    if error or not topic:
        return _result([], limit, "invalid-topic", "", "", False, started)
    try:
        budget = float(timeout_seconds)
    except (TypeError, ValueError):
        budget = DEFAULT_TIMEOUT_SECONDS
    deadline = started + max(1.0, min(120.0, budget))
    entry = normalize_search_entry(entry)
    search_url = search_url_for(topic)
    strategy = ""
    video_tab = False
    video_tab_reason = ""
    wait_ms = 0.0
    items: list[dict] = []
    extra = {"searchEntry": entry, "entryFallback": False, "boxSelector": "",
             "typeMs": 0, "routeUrl": "", "videoTabReason": ""}
    try:
        if entry == SEARCH_ENTRY_SEARCH_BOX:
            nav = _open_via_search_box(page, topic, deadline)
            extra.update({key: value for key, value in (nav.get("extra") or {}).items()
                          if value not in ("", 0)})
            if nav.get("reason") == "blocked":
                return _result([], limit, "blocked", "", search_url, False, started,
                               0.0, extra)
            if not nav.get("ok"):
                # 首页搜索框不可用（未渲染/输入失败/未跳转）时退回直开 URL。
                extra["entryFallback"] = True
                extra["entryError"] = str(nav.get("reason") or "")
                print(f"首页搜索框入口失败（{extra['entryError']}）；退回直开搜索 URL。")
                try:
                    page.goto(search_url, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(600)
                except Exception:
                    return _result([], limit, str(nav.get("reason") or "search-unavailable"),
                                   "", search_url, False, started, 0.0, extra)
        else:
            try:
                page.goto(search_url, wait_until="domcontentloaded", timeout=45000)
                # SPA shell first; result cards stream in after this.
                page.wait_for_timeout(600)
            except Exception:
                return _result([], limit, "search-unavailable", "", search_url, False,
                               started, 0.0, extra)
        current = str(getattr(page, "url", "") or "")
        extra["routeUrl"] = current
        lowered = current.lower()
        if "login" in lowered or "passport" in lowered:
            return _result([], limit, "blocked", "", search_url, False, started, 0.0, extra)
        if entry == SEARCH_ENTRY_SEARCH_BOX and not extra["entryFallback"] \
                and "type=video" not in lowered:
            # 从首页搜索默认落在“综合”tab；工具栏是路由后才挂载的，轮询等它出现。
            video_tab, video_tab_reason = wait_for_video_tab(
                page, seconds=8.0, deadline=deadline)
            extra["videoTabReason"] = video_tab_reason
            _snapshot(page, "search-tab-switch", {
                "phase": "tab-switch", "url": current,
                "videoTab": bool(video_tab), "videoTabReason": video_tab_reason,
            })
            if video_tab:
                try:
                    page.wait_for_timeout(400)
                except Exception:
                    pass
                state, tab_ms = _poll_for_cards(page, deadline, TAB_RESULT_WAIT_SECONDS)
                wait_ms += tab_ms
                if not strategy:
                    strategy = state["strategy"]
        else:
            extra["videoTabReason"] = "already-video" if "type=video" in lowered else ""
        state, poll_ms = _poll_for_cards(page, deadline, FIRST_RESULT_WAIT_SECONDS)
        wait_ms += poll_ms
        if state["strategy"]:
            strategy = state["strategy"]
        if state["blocked"]:
            _snapshot(page, "search-blocked", {
                "phase": "before-tab", "url": str(getattr(page, "url", "") or ""),
                "strategy": strategy, "waitMs": int(wait_ms), "blocked": True,
            })
            return _result([], limit, "blocked", strategy, search_url, bool(video_tab),
                           started, wait_ms, extra)
        _snapshot(page, "search-before-tab", {
            "phase": "before-tab", "url": str(getattr(page, "url", "") or ""),
            "strategy": strategy, "cards": len(state["nodes"]),
            "waitMs": int(wait_ms), "noResults": state["noResults"],
        })
        if state["nodes"]:
            _snapshot(page, "search-cards-before-tab", "\n".join(state["nodes"]), {
                "phase": "before-tab", "url": str(getattr(page, "url", "") or ""),
                "strategy": strategy, "cards": len(state["nodes"]),
            })
        if not state["nodes"] and not state["noResults"] and not video_tab:
            video_tab = ensure_video_tab(page)
            if video_tab:
                extra["videoTabReason"] = "clicked"
                state, tab_ms = _poll_for_cards(page, deadline, TAB_RESULT_WAIT_SECONDS)
                wait_ms += tab_ms
                if not strategy:
                    strategy = state["strategy"]
                _snapshot(page, "search-after-tab", {
                    "phase": "after-tab", "url": str(getattr(page, "url", "") or ""),
                    "strategy": strategy, "cards": len(state["nodes"]),
                    "waitMs": int(tab_ms),
                })
                if state["nodes"]:
                    _snapshot(page, "search-cards-after-tab",
                              "\n".join(state["nodes"]), {
                                  "phase": "after-tab",
                                  "url": str(getattr(page, "url", "") or ""),
                                  "strategy": strategy, "cards": len(state["nodes"]),
                              })
        seen: set[str] = set()
        for round_index in range(SEARCH_ROUNDS):
            if round_index:
                scroll_search_results(page)
                state, extra_ms = _poll_for_cards(page, deadline, SCROLL_RESULT_WAIT_SECONDS)
                wait_ms += extra_ms
            if not strategy:
                strategy = state["strategy"]
            for item in parse_search_cards(state["nodes"], limit):
                if item["url"] not in seen:
                    seen.add(item["url"])
                    items.append(item)
            if (len(items) >= limit or not state["nodes"]
                    or time_module.monotonic() >= deadline):
                break
        if douyin_debug.enabled() and state["nodes"]:
            _snapshot(page, "search-cards-final", "\n".join(state["nodes"]), {
                "phase": "final", "url": str(getattr(page, "url", "") or ""),
                "strategy": strategy, "cards": len(state["nodes"]),
                "parsed": len(items), "waitMs": int(wait_ms),
            })
        if not items:
            return _result([], limit, "no-results", strategy, search_url, video_tab,
                           started, wait_ms, extra)
        return _result(items[:limit], limit, "ok", strategy, search_url, video_tab,
                       started, wait_ms, extra)
    except Exception as exc:
        return _result([], limit, f"error:{exc.__class__.__name__}", strategy,
                       search_url, video_tab, started, wait_ms, extra)


def _topic_key(topic) -> str:
    return _WHITESPACE.sub(" ", str(topic or "").strip()).casefold()


def _state_entry(raw) -> tuple[float | None, str]:
    """Normalize a stored topic entry; legacy entries were bare float timestamps."""
    if isinstance(raw, dict):
        try:
            last = float(raw.get("at"))
        except (TypeError, ValueError):
            return None, ""
        return last, str(raw.get("reason") or "")[:80]
    try:
        return float(raw), ""
    except (TypeError, ValueError):
        return None, ""


def _load_search_state(path: Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError, ValueError):
        return {}
    topics = data.get("topics") if isinstance(data, dict) else None
    return topics if isinstance(topics, dict) else {}


def topic_cooldown_reason(topic, path: Path = SEARCH_STATE_PATH,
                          now: float | None = None) -> str | None:
    """Return ``None`` outside the 24 h cooldown, else the recorded reason.

    An empty string means the last attempt succeeded; a non-empty value is the
    failure reason (``no-results`` / ``blocked`` / ``search-unavailable`` /
    ``error:*``) that was recorded for that topic.
    """
    key = _topic_key(topic)
    if not key:
        return None
    last, reason = _state_entry(_load_search_state(path).get(key))
    if last is None:
        return None
    current = time_module.time() if now is None else float(now)
    return reason if 0 <= current - last < SEARCH_COOLDOWN_SECONDS else None


def topic_recently_searched(topic, path: Path = SEARCH_STATE_PATH, now: float | None = None) -> bool:
    """True when the same topic was searched (successfully or not) within 24 hours."""
    return topic_cooldown_reason(topic, path, now) is not None


def mark_topic_searched(topic, path: Path = SEARCH_STATE_PATH, now: float | None = None,
                        reason: str = "") -> None:
    """Record one search attempt with its reason; keep 30 topics and drop entries older than 7 days."""
    key = _topic_key(topic)
    if not key:
        return
    current = time_module.time() if now is None else float(now)
    topics = _load_search_state(path)
    topics[key] = {"at": current, "reason": str(reason or "")[:80]}
    fresh: dict[str, dict] = {}
    for name, raw in topics.items():
        stamp, entry_reason = _state_entry(raw)
        if stamp is not None and 0 <= current - stamp < STATE_TTL_SECONDS:
            fresh[name] = {"at": stamp, "reason": entry_reason}
    ordered = sorted(fresh.items(), key=lambda item: item[1]["at"])[-MAX_STATE_TOPICS:]
    payload = {"schemaVersion": 1, "topics": dict(ordered)}
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        # 去重状态只是风控节制，写不进去也不能拖垮本轮浏览。
        pass
