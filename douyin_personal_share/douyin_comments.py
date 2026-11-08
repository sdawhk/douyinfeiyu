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

import douyin_debug

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
# "4天前·四川" / "刚刚" / "昨天 12:30" style meta line that ends the comment body.
_TIME_MARKER = re.compile(
    r"(?:刚刚|今天|昨天|前天|"
    r"\d+\s*(?:秒|分钟|小时|天|周|星期|个月|月|年)前|"
    r"\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?|"
    r"\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?|"
    r"\d{1,2}:\d{2})"
)
# No boundary requirement: Douyin renders the meta row as inline spans, so
# "正文4天前·四川" is common and still must be cut at "4天前".
_TIME_AT = _TIME_MARKER
_TIME_ROW_FULL = re.compile(
    r"^(?:" + _TIME_MARKER.pattern + r")(?:\s*\d{1,2}:\d{2})?"
    r"(?:\s*[·•]\s*[^\s·•]{1,16})?$"
)
# Page-side collapsed placeholder: a lone "…" or "..." token, not ellipsis inside prose.
_STANDALONE_ELLIPSIS = re.compile(r"(?:^|(?<=\s))(?:[…]+|\.{3,})(?=\s|$)")
_EDGE_NOISE = re.compile(r"^[\s…·•]+|[\s…·•]+$")
_BODY_EDGE_NOISE = re.compile(r"^[\s…·•\.]+|[\s…·•\.]+$")
_TAIL_CONTROLS = re.compile(
    r"(?:\s*(?:分享|回复|展开\s*\d*\s*条回复|展开更多回复|展开\s*\d+\s*条|"
    r"收起|展开|作者赞过|作者置顶|作者|置顶|点赞|赞))*\s*$"
)
_GENERIC_LINES = {"作者", "回复", "分享", "展开", "收起", "置顶", "点赞", "赞"}
_REPLY_MARKERS = ("reply", "sub-comment", "subcomment")


def clamp_limit(value, default: int = DEFAULT_LIMIT) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(1, min(MAX_LIMIT, number))


def clean_comment_text(value, limit: int = MAX_TEXT_CHARS) -> str:
    """Drop emoji codes, zero-width characters, ellipsis placeholders and extra whitespace."""
    text = _ZERO_WIDTH.sub("", str(value or ""))
    text = _EMOJI_CODE.sub("", text)
    text = _STANDALONE_ELLIPSIS.sub(" ", text)
    text = _WHITESPACE.sub(" ", text).strip()
    text = _EDGE_NOISE.sub("", text).strip()
    return text[:limit].strip()


def clean_comment_body(value, limit: int = MAX_TEXT_CHARS) -> str:
    """Trim the comment body at its time/region row and drop trailing control labels."""
    text = _ZERO_WIDTH.sub("", str(value or ""))
    text = _EMOJI_CODE.sub("", text)
    text = _STANDALONE_ELLIPSIS.sub(" ", text)
    text = _WHITESPACE.sub(" ", text).strip()
    match = _TIME_AT.search(text)
    if match:
        text = text[:match.start()]
    text = _WHITESPACE.sub(" ", text).strip()
    for _ in range(3):
        trimmed = _TAIL_CONTROLS.sub("", text).strip()
        if trimmed == text:
            break
        text = trimmed
    text = _BODY_EDGE_NOISE.sub("", text).strip()
    return text[:limit].strip()


def parse_like_count(value) -> int | None:
    """Parse Douyin-style counters such as ``1.2万``, ``3.4w`` or ``1,234``.

    Returns ``None`` when the node has no number (unknown), never a fake 0.
    """
    raw = _ZERO_WIDTH.sub("", str(value or "")).strip().lower()
    raw = raw.replace(",", "").replace("，", "")
    if not raw:
        return None
    match = re.search(r"(\d+(?:\.\d+)?)\s*([万亿wkm]?)", raw)
    if not match:
        return None
    multiplier = {"万": 10_000, "w": 10_000, "k": 1_000, "千": 1_000, "m": 1_000_000, "亿": 100_000_000}
    try:
        number = float(match.group(1))
    except ValueError:
        return None
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


def _is_reply_container(node: _DomNode) -> bool:
    """Nested replies (楼中楼) are excluded from the main comment's own fields."""
    if node.tag in {"#text", "#root"}:
        return False
    markers = _markers(node)
    return any(hint in markers for hint in _REPLY_MARKERS)


def _walk_main(node: _DomNode):
    """Walk descendants while skipping every nested reply container."""
    for child in node.children:
        if child.tag != "#text" and _is_reply_container(child):
            continue
        yield child
        yield from _walk_main(child)


def _raw_text_main(node: _DomNode) -> str:
    parts: list[str] = []

    def walk(current: _DomNode) -> None:
        if current.tag == "#text":
            parts.append(current.text)
        elif current.tag == "br":
            parts.append("\n")
        elif current.tag in _SKIP_TEXT_TAGS:
            return
        elif _is_reply_container(current):
            return
        else:
            for child in current.children:
                walk(child)
            if current.tag in _BLOCK_TAGS:
                parts.append("\n")

    for child in node.children:
        walk(child)
    return _ZERO_WIDTH.sub("", "".join(parts))


def _strip_author_badge(text: str) -> str:
    """The 作者 badge is rendered inside the name anchor, so it leaks into the name."""
    cleaned = re.sub(r"\s*作者\s*$", "", str(text or "")).strip()
    return cleaned


def _author_node(item: _DomNode) -> tuple[str, _DomNode | None]:
    for node in _walk_main(item):
        if node.tag != "a" or "/user/" not in _attr(node, "href"):
            continue
        text = _strip_author_badge(clean_comment_text(_raw_text(node), 40))
        if text and text != "作者":
            return text, node
    for node in _walk_main(item):
        if node.tag == "#text":
            continue
        if any(hint in _markers(node) for hint in _AUTHOR_HINTS):
            text = _strip_author_badge(clean_comment_text(_raw_text(node), 40))
            if text and text != "作者":
                return text, node
    for line in _raw_text_main(item).splitlines():
        text = _strip_author_badge(clean_comment_text(line, 40))
        if not text or text in _GENERIC_LINES or _TIME_AT.search(text):
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?[万亿wkm]?", text):
            continue
        return text, None
    return "", None


def _author_from_item(item: _DomNode) -> str:
    return _author_node(item)[0]


def _time_row_node(item: _DomNode) -> _DomNode | None:
    """Find the small "2周前·北京" element; its previous sibling is the body."""
    for node in _walk_main(item):
        if node.tag == "#text":
            continue
        text = _WHITESPACE.sub(" ", _raw_text(node)).strip()
        if text and len(text) <= 24 and _TIME_ROW_FULL.match(text):
            return node
    return None


def _body_node_from_time_row(item: _DomNode) -> _DomNode | None:
    time_node = _time_row_node(item)
    if time_node is None or time_node._parent is None:
        return None
    siblings = time_node._parent.children
    try:
        index = siblings.index(time_node)
    except ValueError:
        return None
    for previous in reversed(siblings[:index]):
        if previous.tag == "#text" or _is_reply_container(previous):
            continue
        return previous
    return None


def _comment_text_from_item(item: _DomNode, author: str) -> str:
    for node in _walk_main(item):
        if node.tag == "#text":
            continue
        if any(hint in _markers(node) for hint in _TEXT_HINTS):
            text = clean_comment_body(_raw_text(node))
            if author and text.startswith(author):
                text = clean_comment_body(text[len(author):].lstrip("：: "))
            if text:
                return text

    # Real 2026-11 DOM: body sits in the element right before the time row.
    body_node = _body_node_from_time_row(item)
    if body_node is not None:
        text = clean_comment_body(_raw_text(body_node))
        if author and text.startswith(author):
            text = clean_comment_body(text[len(author):].lstrip("：: "))
        if text:
            return text

    kept: list[str] = []
    for line in _raw_text_main(item).splitlines():
        text = clean_comment_body(line)
        if not text or text == author or text in _GENERIC_LINES:
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?[万亿wkm]?", text):
            continue
        kept.append(text)
    text = clean_comment_body(" ".join(kept))
    if author and text.startswith(author):
        text = clean_comment_body(text[len(author):])
    return text


def _likes_from_item(item: _DomNode) -> int | None:
    """Read the main comment's like counter; ``None`` means the page hid it."""
    # Real 2026-11 DOM: <div class="... comment-item-stats-container">
    #   <p><svg .../><span>401</span></p><p><svg .../></p>  (first <p> = likes)
    for node in _walk_main(item):
        if node.tag == "#text" or _is_reply_container(node):
            continue
        markers = _markers(node)
        if "comment-item-stats" not in markers and "stats-container" not in markers:
            continue
        for child in _walk_main(node):
            if child.tag != "p":
                continue
            value = _WHITESPACE.sub(" ", _raw_text(child)).strip()
            return parse_like_count(value)

    best: int | None = None
    for node in _walk_main(item):
        if node.tag == "#text" or _is_reply_container(node):
            continue
        markers = _markers(node)
        if "like" not in markers and "digg" not in markers:
            continue
        value = _WHITESPACE.sub(" ", _raw_text(node)).strip()
        if not value or len(value) > 24 or "\n" in value:
            continue
        parsed = parse_like_count(value)
        if parsed is not None and (best is None or parsed > best):
            best = parsed
    return best


def _contains_author_badge(node: _DomNode) -> bool:
    for child in _walk_main(node):
        if child.tag == "#text":
            continue
        text = _WHITESPACE.sub(" ", _raw_text(child)).strip()
        if not text or len(text) > 8:
            continue
        markers = _markers(child)
        if text == "作者":
            return True
        if "作者" in text and ("author-tag" in markers or "authortag" in markers):
            return True
    return False


def _is_author(item: _DomNode, author: str) -> bool:
    """True only when the *main* commenter's name carries the 作者 badge."""
    name, node = _author_node(item)
    if not name or not author or name != author or node is None:
        return False
    current: _DomNode | None = node
    for _ in range(3):
        if current is None:
            return False
        if _contains_author_badge(current):
            return True
        current = current._parent
    return False


def _has_image(item: _DomNode) -> bool:
    for node in _walk_main(item):
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
                "isAuthor": _is_author(root, author),
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


def _snapshot_comments(page, state: dict) -> None:
    """Read-only debug snapshot of the comment DOM; no-op unless the env flag is on."""
    if not douyin_debug.enabled():
        return
    meta = {
        "url": str(getattr(page, "url", "") or ""),
        "strategy": str(state.get("strategy") or ""),
        "panel": bool(state.get("panel")),
        "nodes": len(state.get("nodes") or []),
    }
    douyin_debug.save("comments-items", "\n".join((state.get("nodes") or [])[:3]), meta)
    try:
        page_html = page.content()
    except Exception:
        page_html = ""
    if page_html:
        douyin_debug.save("comments-page", page_html, meta)


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

    def finish(result: dict) -> dict:
        if douyin_debug.enabled():
            douyin_debug.save_json("comments-parsed", result, {
                "url": str(getattr(page, "url", "") or ""),
            })
        return result

    try:
        if not ensure_comment_panel(page, deadline):
            return finish(_result([], limit, False, "no-comment-panel", strategy, started))
        _snapshot_comments(page, extract_comment_nodes(page))
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
                return finish(_result(items, limit, False, "ok", strategy, started))
            if time_module.monotonic() >= deadline:
                return finish(_result(items, limit, bool(items), "timeout", strategy, started))
            if not state["nodes"]:
                # The panel can render slightly after it opens; give it a short grace.
                empty_rounds += 1
                if empty_rounds >= 3:
                    return finish(_result(items, limit, False, "no-comments", strategy, started))
                time_module.sleep(0.6)
                continue
            empty_rounds = 0
            idle = 0 if grew else idle + 1
            if idle >= 3:
                return finish(_result(items, limit, False, "exhausted", strategy, started))
            if not scroll_comment_list(page):
                idle += 1
                if idle >= 3:
                    return finish(_result(items, limit, False, "exhausted", strategy, started))
            if time_module.monotonic() >= deadline:
                return finish(_result(items, limit, bool(items), "timeout", strategy, started))
            time_module.sleep(0.6)
    except Exception as exc:
        return finish(_result(items[:limit], limit, bool(items),
                              f"error:{exc.__class__.__name__}", strategy, started))
