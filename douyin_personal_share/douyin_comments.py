"""Read-only extraction of the first N comments under one Douyin video page.

Safety boundary: this module only opens the comment panel when necessary,
scrolls the comment list and parses already-rendered items. It never clicks
like / reply / follow / "view more replies" controls and never sends anything.

The item parser is pure Python so it can be tested with sanitized HTML
fixtures without a browser. The page-side helper only collects candidate
comment-item outerHTML; all field extraction happens here.
"""

from __future__ import annotations

import re
import time as time_module
from html.parser import HTMLParser

DEFAULT_LIMIT = 10
MAX_LIMIT = 30
DEFAULT_TIMEOUT_SECONDS = 20
MAX_TEXT_CHARS = 200
MAX_NODES = 60
MAX_NODE_HTML_CHARS = 20_000

# Prompt-side budgets: at most 10 comments, each trimmed to 60 characters.
PROMPT_MAX_COMMENTS = 10
PROMPT_TEXT_CHARS = 60
PROMPT_AUTHOR_CHARS = 20

_ZERO_WIDTH = re.compile("[\u200b-\u200f\u202a-\u202e\u2060\ufeff]")
_EMOJI_CODE = re.compile(r"[\[［][^\[\]［］\r\n]{1,10}[\]］]")
_WHITESPACE = re.compile(r"\s+")


def clamp_limit(value, default: int = DEFAULT_LIMIT) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(1, min(MAX_LIMIT, number))


def clean_comment_text(value, limit: int = MAX_TEXT_CHARS) -> str:
    """Drop emoji codes, zero-width characters and redundant whitespace."""
    text = _ZERO_WIDTH.sub("", str(value or ""))
    text = _EMOJI_CODE.sub("", text)
    text = _WHITESPACE.sub(" ", text).strip()
    return text[:limit].strip()


def parse_like_count(value) -> int:
    """Parse Douyin-style counters such as ``1.2万``, ``3.4w`` or ``1,234``."""
    raw = _ZERO_WIDTH.sub("", str(value or "")).strip().lower()
    raw = raw.replace(",", "").replace("，", "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*([万亿wkm]?)", raw)
    if not match:
        return 0
    multiplier = {"万": 10_000, "w": 10_000, "k": 1_000, "千": 1_000, "m": 1_000_000, "亿": 100_000_000}
    try:
        number = float(match.group(1))
    except ValueError:
        return 0
    return int(round(number * multiplier.get(match.group(2), 1)))


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
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
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


_AUTHOR_HINTS = ("username", "user-name", "nickname", "author-name", "authorname")
_TEXT_HINTS = (
    "comment-text", "commenttext", "comment-content", "commentcontent",
    "content-text", "contenttext", "comment-item-text", "commentitem-text",
    "commentitemtext",
)


def _author_from_item(item: _DomNode) -> str:
    for node in _walk(item):
        if node.tag != "a":
            continue
        if "/user/" not in _attr(node, "href"):
            continue
        text = clean_comment_text(_raw_text(node), 40)
        if text and text != "作者":
            return text
    for node in _walk(item):
        if node.tag == "#text":
            continue
        if any(hint in _markers(node) for hint in _AUTHOR_HINTS):
            text = clean_comment_text(_raw_text(node), 40)
            if text and text != "作者":
                return text
    for line in _raw_text(item).splitlines():
        text = clean_comment_text(line, 40)
        if text and text not in {"作者", "回复", "展开", "收起"}:
            return text
    return ""


def _comment_text_from_item(item: _DomNode, author: str) -> str:
    for node in _walk(item):
        if node.tag == "#text":
            continue
        if any(hint in _markers(node) for hint in _TEXT_HINTS):
            text = clean_comment_text(_raw_text(node))
            if text:
                return text

    lines = [_WHITESPACE.sub(" ", line).strip() for line in _raw_text(item).splitlines()]
    kept: list[str] = []
    for line in lines:
        if not line or line == author or line in {"作者", "回复", "展开", "收起"}:
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?[万亿wkm]?", line):
            continue
        if re.fullmatch(r"(?:刚刚|昨天|今天|\d+.*前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})", line):
            continue
        kept.append(line)
    return clean_comment_text(" ".join(kept))


def _likes_from_item(item: _DomNode) -> int:
    for node in _walk(item):
        if node.tag == "#text":
            continue
        if "like" in _markers(node):
            value = _raw_text(node).strip()
            if re.search(r"\d", value):
                return parse_like_count(value)
    return 0


def _is_author(item: _DomNode) -> bool:
    for node in _walk(item):
        if node.tag == "#text":
            continue
        text = _WHITESPACE.sub(" ", _raw_text(node)).strip()
        if text == "作者":
            return True
        markers = _markers(node)
        if ("author-tag" in markers or "authortag" in markers) and "作者" in text:
            return True
    return False


def _has_image(item: _DomNode) -> bool:
    for node in _walk(item):
        if node.tag == "img":
            if _is_avatar_image(node):
                continue
            return True
        if node.tag == "#text":
            continue
        markers = _markers(node)
        if "emoji" in markers or "comment-image" in markers or "commentimage" in markers:
            return True
    return False


def _is_avatar_image(node: _DomNode) -> bool:
    if _inside_user_link(node):
        return True
    source = _attr(node, "src").lower()
    classes = _attr(node, "class").lower()
    return "avatar" in classes or "avatar" in source or "100x100" in source


def _inside_user_link(node: _DomNode) -> bool:
    current: _DomNode | None = node
    while current is not None:
        if current.tag == "a" and "/user/" in _attr(current, "href"):
            return True
        current = current._parent
    return False


def parse_comment_nodes(nodes, limit: int = MAX_LIMIT) -> list[dict]:
    """Parse candidate comment-item HTML snippets into structured rows.

    A broken or empty item is skipped; one bad item never fails the batch.
    """
    limit = clamp_limit(limit)
    items: list[dict] = []
    seen: set[tuple[str, str]] = set()
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
            author = _author_from_item(root)
            text = _comment_text_from_item(root, author)
            has_image = _has_image(root) or bool(
                _EMOJI_CODE.search(_ZERO_WIDTH.sub("", _raw_text(root)))
            )
            if not text:
                if not has_image:
                    continue
                text = "[图片/表情]"
            signature = (author, text)
            if signature in seen:
                continue
            seen.add(signature)
            items.append({
                "author": author,
                "text": text,
                "likes": _likes_from_item(root),
                "isAuthor": _is_author(root),
                "hasImage": has_image,
            })
        except Exception:
            continue
    return items


_EXTRACT_JS = r"""() => {
  const selectors = [
    '[data-e2e="comment-item"]',
    '[data-e2e*="comment-item"]',
    'div[class*="commentItem"]',
    'div[class*="comment-item"]',
    'div[class*="CommentItem"]'
  ];
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const containerish = /(list|container|wrapper|panel|header|footer|input|editor)/i;
  const looksLikeItem = (node) => !!node.querySelector(
    'a[href*="/user/"], [data-e2e*="text"], [class*="text"],' +
    '[class*="content"], [class*="user"]'
  );
  for (const selector of selectors) {
    let nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (selector !== '[data-e2e="comment-item"]') {
      nodes = nodes.filter((node) => {
        const cls = String(node.className || '');
        if (containerish.test(cls)) return false;
        if (!looksLikeItem(node)) return false;
        return String(node.innerText || '').length <= 1200;
      });
    }
    const pool = new Set(nodes);
    nodes = nodes.filter((node) => {
      let parent = node.parentElement;
      while (parent) {
        if (pool.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
    if (nodes.length) {
      return {
        strategy: selector,
        panel: true,
        nodes: nodes.slice(0, 60).map((node) => node.outerHTML)
      };
    }
  }
  const panel = !!document.querySelector(
    '[data-e2e*="comment-list"], div[class*="comment-input-inner-container"],' +
    'div[class*="comment-list"], div[class*="commentList"]'
  );
  return { strategy: '', panel, nodes: [] };
}"""

_OPEN_SELECTORS = (
    '[data-e2e="comment-icon"]',
    '[data-e2e*="comment"][role="button"]',
    'div[class*="comment-icon"]',
    '[aria-label*="评论"]',
)

_SCROLL_JS = r"""() => {
  const item = document.querySelector(
    '[data-e2e="comment-item"], [data-e2e*="comment-item"],' +
    'div[class*="commentItem"], div[class*="comment-item"]'
  );
  let node = item;
  while (node) {
    const style = getComputedStyle(node);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 24) {
      node.scrollTop = node.scrollHeight;
      return true;
    }
    node = node.parentElement;
  }
  return false;
}"""


def extract_comment_nodes(page) -> dict:
    """Return candidate comment-item HTML from the page; never raises."""
    try:
        raw = page.evaluate(_EXTRACT_JS)
    except Exception:
        return {"strategy": "", "panel": False, "nodes": []}
    if not isinstance(raw, dict):
        return {"strategy": "", "panel": False, "nodes": []}
    nodes = raw.get("nodes")
    if not isinstance(nodes, list):
        nodes = []
    nodes = [node[:MAX_NODE_HTML_CHARS] for node in nodes
             if isinstance(node, str) and node.strip()][:MAX_NODES]
    return {
        "strategy": str(raw.get("strategy") or "")[:120],
        "panel": raw.get("panel") is True,
        "nodes": nodes,
    }


def ensure_comment_panel(page, deadline: float) -> bool:
    """Open the comment panel only through explicit comment controls."""
    state = extract_comment_nodes(page)
    if state["nodes"] or state["panel"]:
        return True
    for selector in _OPEN_SELECTORS:
        if time_module.monotonic() >= deadline:
            return False
        try:
            locator = page.locator(selector)
            if locator.count() < 1:
                continue
            locator.first.click(timeout=3000)
        except Exception:
            continue
        time_module.sleep(0.8)
        state = extract_comment_nodes(page)
        if state["nodes"] or state["panel"]:
            return True
    return False


def scroll_comment_list(page) -> bool:
    """Scroll only the comment list container, never the video page."""
    try:
        return page.evaluate(_SCROLL_JS) is True
    except Exception:
        return False


def _result(items: list[dict], limit: int, partial: bool, reason: str,
            strategy: str, started: float) -> dict:
    return {
        "items": items,
        "count": len(items),
        "limit": limit,
        "partial": bool(partial),
        "reason": reason,
        "strategy": strategy,
        "elapsed_ms": int((time_module.monotonic() - started) * 1000),
    }


def collect_video_comments(page, limit: int = DEFAULT_LIMIT,
                           timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> dict:
    """Collect up to ``limit`` comments with a hard total timeout.

    Returns an empty list plus a reason instead of raising when the comment
    panel is unavailable, the video has no comments, or the page breaks.
    """
    limit = clamp_limit(limit)
    started = time_module.monotonic()
    try:
        budget = float(timeout_seconds)
    except (TypeError, ValueError):
        budget = DEFAULT_TIMEOUT_SECONDS
    deadline = started + max(1.0, min(60.0, budget))
    collected: dict[tuple[str, str], dict] = {}
    strategy = ""
    items: list[dict] = []
    try:
        if not ensure_comment_panel(page, deadline):
            return _result([], limit, False, "no-comment-panel", strategy, started)
        idle = 0
        empty_rounds = 0
        while True:
            state = extract_comment_nodes(page)
            if not strategy:
                strategy = state["strategy"]
            grew = False
            for item in parse_comment_nodes(state["nodes"], limit):
                signature = (item["author"], item["text"])
                if signature not in collected:
                    collected[signature] = item
                    grew = True
            items = list(collected.values())[:limit]
            if len(items) >= limit:
                return _result(items, limit, False, "ok", strategy, started)
            if time_module.monotonic() >= deadline:
                return _result(items, limit, bool(items), "timeout", strategy, started)
            if not state["nodes"]:
                # The panel can render slightly after it opens; give it a short grace.
                empty_rounds += 1
                if empty_rounds >= 3:
                    return _result(items, limit, False, "no-comments", strategy, started)
                time_module.sleep(0.6)
                continue
            empty_rounds = 0
            idle = 0 if grew else idle + 1
            if idle >= 3:
                return _result(items, limit, False, "exhausted", strategy, started)
            if not scroll_comment_list(page):
                idle += 1
                if idle >= 3:
                    return _result(items, limit, False, "exhausted", strategy, started)
            if time_module.monotonic() >= deadline:
                return _result(items, limit, bool(items), "timeout", strategy, started)
            time_module.sleep(0.6)
    except Exception as exc:
        return _result(items[:limit], limit, bool(items),
                       f"error:{exc.__class__.__name__}", strategy, started)
