#!/usr/bin/env python3
"""抖音视频解析 worker：游客浏览器解析 + 下载，文件队列驱动。

与 douyin_share.py 的生产监听器完全独立：
- 独立 profile（browser-profile-parser），绝不触碰监听器的 browser-profile；
- 不登录、headless、按请求拉起浏览器，处理完即关闭；
- 请求走 video-queue/ 目录队列（按文件名排序、原子认领），响应写
  douyin-video-response-<id>.json，由 bridge 侧轮询取走。

启动方式：
- 常驻：python douyin_video_worker.py（bridge 检测到无心跳时会自动拉起）
- 单次：python douyin_video_worker.py --once（处理一条请求后退出，用于测试）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.request
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
QUEUE_DIR = ROOT / "video-queue"
CACHE_DIR = ROOT / "video-cache"
HEARTBEAT_PATH = ROOT / "video-worker-heartbeat.json"
WORKER_LOCK_PATH = ROOT / ".video-worker.lock"
PARSER_PROFILE_DIR = ROOT / "browser-profile-parser"

VIDEO_ID_RE = re.compile(r"/video/(\d+)")
AWEME_DETAIL_MARKER = "/aweme/v1/web/aweme/detail/"
STALE_SECONDS = 2 * 60 * 60
CACHE_TTL_SECONDS = 60 * 60
HEARTBEAT_INTERVAL_SECONDS = 10
IDEMPOTENT_ID_RE = re.compile(r"^[0-9a-f]{8,32}$")
# 沙箱/受限环境下系统 Temp 可能不可写（Playwright mkdtemp EPERM），
# 与监听器同理：把浏览器临时目录指到项目内。
PARSER_TEMP_DIR = ROOT / "playwright-temp-parser"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
)


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    print(f"{stamp} [video-worker] {message}", flush=True)


def load_config() -> dict:
    try:
        payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    section = payload.get("video_parser")
    return section if isinstance(section, dict) else {}


def prepare_browser_temp() -> Path:
    chosen = Path(os.environ.get("DOUYIN_VIDEO_PLAYWRIGHT_TEMP") or PARSER_TEMP_DIR)
    chosen.mkdir(parents=True, exist_ok=True)
    os.environ["TEMP"] = str(chosen)
    os.environ["TMP"] = str(chosen)
    return chosen


def write_json_atomic(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


# ---------- 常驻模式的心跳与单实例守卫 ----------

def acquire_worker_lock() -> bool:
    """轻量单实例锁：锁文件超过 10 分钟没被touch就视为陈旧并接管。"""
    try:
        if WORKER_LOCK_PATH.exists():
            if time.time() - WORKER_LOCK_PATH.stat().st_mtime < 600:
                return False
        WORKER_LOCK_PATH.write_text(str(os.getpid()), encoding="utf-8")
        return True
    except OSError:
        return False


def touch_heartbeat() -> None:
    try:
        write_json_atomic(HEARTBEAT_PATH, {"pid": os.getpid(), "ts": time.time()})
    except OSError:
        pass


def start_heartbeat_thread() -> threading.Thread:
    def loop() -> None:
        while True:
            touch_heartbeat()
            try:
                WORKER_LOCK_PATH.touch()
            except OSError:
                pass
            time.sleep(HEARTBEAT_INTERVAL_SECONDS)

    thread = threading.Thread(target=loop, daemon=True, name="video-worker-heartbeat")
    thread.start()
    return thread


# ---------- 请求队列 ----------

def claim_request() -> dict | None:
    """认领最早的一条排队请求（rename 原子性保证不会被处理两次）。"""
    QUEUE_DIR.mkdir(exist_ok=True)
    for entry in sorted(QUEUE_DIR.iterdir()):
        if not entry.name.startswith("req-") or entry.suffix != ".json":
            continue
        try:
            payload = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            entry.unlink(missing_ok=True)
            continue
        if not isinstance(payload, dict) or not IDEMPOTENT_ID_RE.fullmatch(str(payload.get("id") or "")):
            entry.unlink(missing_ok=True)
            continue
        if time.time() - float(payload.get("created_at") or 0) > STALE_SECONDS:
            entry.unlink(missing_ok=True)
            continue
        target = QUEUE_DIR / f"active-{payload['id']}.json"
        try:
            os.replace(entry, target)
        except OSError:
            continue  # 另一个 worker 先认领了
        return payload
    return None


def cleanup_cache() -> None:
    if not CACHE_DIR.exists():
        return
    now = time.time()
    for entry in CACHE_DIR.iterdir():
        try:
            if entry.is_file() and now - entry.stat().st_mtime > CACHE_TTL_SECONDS:
                entry.unlink(missing_ok=True)
        except OSError:
            continue


# ---------- 解析与下载 ----------

def extract_video_id(url: str) -> str | None:
    match = VIDEO_ID_RE.search(url or "")
    return match.group(1) if match else None


def resolve_aweme_id(page, url: str, timeout_ms: int) -> str:
    direct = extract_video_id(url)
    if direct:
        return direct
    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    landed = extract_video_id(page.url)
    if landed:
        return landed
    match = VIDEO_ID_RE.search(page.content() or "")
    if match:
        return match.group(1)
    raise RuntimeError("短链没有跳转到视频页，可能是失效或非视频分享")


def parse_video_detail(page, aweme_id: str, timeout_ms: int) -> dict:
    """打开视频页并截获 detail 响应；响应体必须立即读取，晚读会被浏览器 GC。"""
    url = f"https://www.douyin.com/video/{aweme_id}"
    with page.expect_response(
        lambda response: AWEME_DETAIL_MARKER in response.url, timeout=timeout_ms
    ) as response_info:
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    response = response_info.value
    data = response.json() or {}
    if data.get("status_code") not in (0, None):
        raise RuntimeError(f"detail 接口返回 status_code={data.get('status_code')}")
    detail = data.get("aweme_detail") or {}
    if not detail:
        raise RuntimeError("detail 响应里没有 aweme_detail")
    return detail


def extract_play_info(detail: dict) -> tuple[str, str]:
    if detail.get("images"):
        raise UnsupportedContent("图集")
    play_addr = (detail.get("video") or {}).get("play_addr") or {}
    url_list = [str(u) for u in (play_addr.get("url_list") or []) if u]
    if not url_list:
        raise RuntimeError("没有拿到播放直链")
    title = str(detail.get("desc") or "").strip()
    return url_list[0], title


class UnsupportedContent(RuntimeError):
    pass


def download_video(play_url: str, destination: Path, max_bytes: int, timeout: int) -> tuple[Path | None, int]:
    """流式下载；超过 max_bytes 立即中止并返回 (None, 实际大小)。"""
    request = urllib.request.Request(play_url, headers={
        "User-Agent": USER_AGENT,
        "Referer": "https://www.douyin.com/",
    })
    temporary = destination.with_suffix(".part")
    total = 0
    with urllib.request.urlopen(request, timeout=timeout) as response, \
            open(temporary, "wb") as handle:
        declared = int(response.headers.get("Content-Length") or 0)
        if declared > max_bytes:
            handle.close()
            temporary.unlink(missing_ok=True)
            return None, declared
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                handle.close()
                temporary.unlink(missing_ok=True)
                return None, total
            handle.write(chunk)
    os.replace(temporary, destination)
    return destination, total


def process_request(payload: dict, cfg: dict) -> dict:
    request_id = str(payload.get("id"))
    share_url = str((payload.get("urls") or [""])[0])
    max_mb = int(payload.get("maxMB") or 95)
    max_bytes = max_mb * 1024 * 1024
    timeout_ms = int(cfg.get("page_timeout_ms") or 45_000)
    download_timeout = int(cfg.get("download_timeout") or 300)
    headless = bool(cfg.get("headless", True))
    profile_dir = ROOT / str(cfg.get("profile_dir") or "browser-profile-parser")
    if sync_playwright is None:
        return {"ok": False, "error": "playwright 未安装"}

    CACHE_DIR.mkdir(exist_ok=True)
    last_error: Exception | None = None
    for attempt in (1, 2):  # 单视频失败重试一次
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    str(profile_dir), channel="msedge", headless=headless)
                try:
                    page = context.pages[0] if context.pages else context.new_page()
                    aweme_id = resolve_aweme_id(page, share_url, timeout_ms)
                    detail = parse_video_detail(page, aweme_id, timeout_ms)
                    play_url, title = extract_play_info(detail)
                finally:
                    context.close()
            destination = CACHE_DIR / f"{aweme_id}.mp4"
            result, size = download_video(play_url, destination, max_bytes, download_timeout)
            if result is None:
                return {"ok": True, "oversize": True, "title": title,
                        "sizeBytes": size, "url": share_url, "awemeId": aweme_id}
            return {"ok": True, "videoPath": str(result), "title": title,
                    "sizeBytes": size, "awemeId": aweme_id}
        except UnsupportedContent:
            return {"ok": False, "error": "图集"}
        except Exception as exc:  # noqa: BLE001 - 响应里只带回一句话，不带栈
            last_error = exc
            log(f"attempt {attempt} failed for {share_url}: {exc}")
            time.sleep(3)
    return {"ok": False, "error": "解析失败"}


def serve_request(payload: dict, cfg: dict) -> None:
    request_id = str(payload.get("id"))
    response = process_request(payload, cfg)
    response["id"] = request_id
    write_json_atomic(ROOT / f"douyin-video-response-{request_id}.json", response)
    summary = "oversize" if response.get("oversize") else (
        response.get("videoPath") or response.get("error") or "?")
    log(f"request {request_id} done: {summary}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="抖音视频解析 worker（游客浏览器）")
    parser.add_argument("--once", action="store_true",
                        help="处理一条排队请求后退出（测试用）")
    parser.add_argument("--request-file", type=Path, default=None,
                        help="直接处理指定请求文件（测试用，不排队）")
    args = parser.parse_args(argv)
    cfg = load_config()
    prepare_browser_temp()

    if args.request_file:
        payload = json.loads(args.request_file.read_text(encoding="utf-8"))
        serve_request(payload, cfg)
        return 0

    if args.once:
        payload = claim_request()
        if payload is None:
            log("no queued request, exit")
            return 0
        serve_request(payload, cfg)
        return 0

    if not acquire_worker_lock():
        log("another worker holds the lock, exit")
        return 0
    start_heartbeat_thread()
    log(f"loop mode started, profile={cfg.get('profile_dir') or 'browser-profile-parser'}, "
        f"headless={bool(cfg.get('headless', True))}")
    last_cache_cleanup = 0.0
    while True:
        try:
            payload = claim_request()
            if payload is not None:
                serve_request(payload, cfg)
                continue
            if time.time() - last_cache_cleanup > 600:
                cleanup_cache()
                last_cache_cleanup = time.time()
        except Exception as exc:  # noqa: BLE001 - 常驻循环绝不能退出
            log(f"loop error: {exc}")
            time.sleep(5)
        time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
