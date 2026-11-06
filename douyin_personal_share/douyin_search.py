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
import re
import time as time_module
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlparse

ROOT = Path(__file__).resolve().parent
SEARCH_STATE_PATH = ROOT / "topic-search-state.json"

SEARCH_URL_TEMPLATE = "https://www.douyin.com/search/{query}?type=video"
DEFAULT_LIMIT = 12
MAX_LIMIT = 12
DEFAULT_TIMEOUT_SECONDS = 40
MAX_TOPIC_CHARS = 20
SEARCH_COOLDOWN_SECONDS = 24 * 60 * 60
STATE_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_STATE_TOPICS = 30
MAX_NODES = 40
MAX_NODE_HTML_CHARS = 20_000
MAX_CARD_TEXT_CHARS = 200
MAX_AUTHOR_CHARS = 40

_VIDEO_PATH = re.compile(r"^/video/(\d+)$")
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
    for line in _raw_text(node).splitlines():
        text = clean_card_text(line, MAX_AUTHOR_CHARS)
        if text.startswith("@"):
            return text.lstrip("@").strip()
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
        kept.append(text)
    return clean_card_text(" ".join(kept))


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
    '[data-e2e="search-result-card"]',
    'div[data-aweme-id]:not([data-aweme-id=""])',
    'div[class*="search-result"]',
    'div[class*="searchResult"]',
    'div[class*="video-card"]',
    'div[class*="videoCard"]',
    'li[class*="search"]'
  ];
  const bodyText = document.body ? String(document.body.innerText || '') : '';
  const blocked = /扫码登录|验证码|安全验证|访问过于频繁|操作频繁/.test(bodyText);
  const noResults = /暂无搜索结果|没有找到相关|暂无结果|未找到相关/.test(bodyText);
  for (const selector of strategies) {
    let nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (selector !== 'div[data-aweme-id]:not([data-aweme-id=""])') {
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
  const cards = dedupe(anchors.map((anchor) =>
    anchor.closest('[data-e2e], div, li, article') || anchor));
  if (cards.length) {
    return { strategy: 'a[href*="/video/"]', nodes: cards.slice(0, 40).map((node) => node.outerHTML),
             blocked, noResults, url: location.href };
  }
  return { strategy: '', nodes: [], blocked, noResults, url: location.href };
}"""

_TAB_JS = r"""() => {
  const selectors = ['a[href*="type=video"]', '[role="tab"]', '[data-e2e*="tab"]'];
  for (const selector of selectors) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      if (String(node.innerText || '').trim() === '视频') {
        node.click();
        return true;
      }
    }
  }
  return false;
}"""

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
        return page.evaluate(_TAB_JS) is True
    except Exception:
        return False


def scroll_search_results(page) -> bool:
    try:
        return page.evaluate(_SCROLL_JS) is True
    except Exception:
        return False


def _result(items: list[dict], limit: int, reason: str, strategy: str,
            search_url: str, video_tab: bool, started: float) -> dict:
    return {
        "items": items,
        "count": len(items),
        "limit": limit,
        "reason": reason,
        "strategy": strategy,
        "searchUrl": search_url,
        "videoTab": bool(video_tab),
        "elapsed_ms": int((time_module.monotonic() - started) * 1000),
    }


def collect_search_videos(page, topic: str, limit: int = DEFAULT_LIMIT,
                          timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> dict:
    """Open the topic search page and read up to ``limit`` video cards.

    Never raises. On any failure it returns an empty item list plus a reason so
    the caller can fall back to the recommendation feed.
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
    search_url = search_url_for(topic)
    strategy = ""
    video_tab = False
    items: list[dict] = []
    try:
        try:
            page.goto(search_url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)
        except Exception:
            return _result([], limit, "search-unavailable", "", search_url, False, started)
        current = str(getattr(page, "url", "") or "").lower()
        if "login" in current or "passport" in current:
            return _result([], limit, "blocked", "", search_url, False, started)
        state = extract_search_cards(page)
        if state["blocked"]:
            return _result([], limit, "blocked", state["strategy"], search_url, False, started)
        video_tab = ensure_video_tab(page)
        if video_tab:
            page.wait_for_timeout(1200)
        seen: set[str] = set()
        for _ in range(2):
            state = extract_search_cards(page)
            if not strategy:
                strategy = state["strategy"]
            for item in parse_search_cards(state["nodes"], limit):
                if item["url"] not in seen:
                    seen.add(item["url"])
                    items.append(item)
            if len(items) >= limit or time_module.monotonic() >= deadline:
                break
            if not state["nodes"]:
                break
            scroll_search_results(page)
            page.wait_for_timeout(1200)
        if not items:
            return _result([], limit, "no-results", strategy, search_url, video_tab, started)
        return _result(items[:limit], limit, "ok", strategy, search_url, video_tab, started)
    except Exception as exc:
        return _result([], limit, f"error:{exc.__class__.__name__}", strategy,
                       search_url, video_tab, started)


def _topic_key(topic) -> str:
    return _WHITESPACE.sub(" ", str(topic or "").strip()).casefold()


def _load_search_state(path: Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError, ValueError):
        return {}
    topics = data.get("topics") if isinstance(data, dict) else None
    return topics if isinstance(topics, dict) else {}


def topic_recently_searched(topic, path: Path = SEARCH_STATE_PATH, now: float | None = None) -> bool:
    """True when the same topic was searched within the last 24 hours."""
    key = _topic_key(topic)
    if not key:
        return False
    raw = _load_search_state(path).get(key)
    try:
        last = float(raw)
    except (TypeError, ValueError):
        return False
    current = time_module.time() if now is None else float(now)
    return 0 <= current - last < SEARCH_COOLDOWN_SECONDS


def mark_topic_searched(topic, path: Path = SEARCH_STATE_PATH, now: float | None = None) -> None:
    """Record a successful search; keep the newest 30 topics and drop entries older than 7 days."""
    key = _topic_key(topic)
    if not key:
        return
    current = time_module.time() if now is None else float(now)
    topics = _load_search_state(path)
    topics[key] = current
    fresh: dict[str, float] = {}
    for name, value in topics.items():
        try:
            stamp = float(value)
        except (TypeError, ValueError):
            continue
        if 0 <= current - stamp < STATE_TTL_SECONDS:
            fresh[name] = stamp
    ordered = sorted(fresh.items(), key=lambda item: item[1])[-MAX_STATE_TOPICS:]
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
