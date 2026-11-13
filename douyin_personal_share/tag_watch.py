#!/usr/bin/env python3
"""tag_watch：话题标签 → 监听器搜索浏览 → 筛选 → 发链接+文案到指定群。

数据源完全复用监听器现成的 service_browse_request 文件队列，零生产代码改动：
- 向 browse-request.json 原子投递 {id, minutes, topic}，由登录态监听器消费浏览；
- 浏览记录（watchedVideos，最近 30 条）落在 bridge/state/douyin-interest-memory.json；
- 本模块按「投递前 baseline 快照」取本轮新增条目，做未成年关键词粗筛（唯一硬拦）、
  URL 去重、每标签冷却、每日上限，然后 dry-run 记录或调 bridge /api/send/group。

内容闸口径（用户 2026-11-12 拍板，最小必要）：
- 标题/话题命中未成年关键词 → 直接丢弃，不入候选不进队列；
- 其余内容（含擦边、性感、cos 服装）一律放行并记日志；
- 群白名单只允许 config.tag_watch.groups 内的群（默认 839367702），其余一律拒绝。

CLI：
- python tag_watch.py --once --force   # dry-run 实跑（enabled=false 时需 --force）
- python tag_watch.py --once           # 常规调度入口（要求 enabled=true）
- 真实发送只由 config tag_watch.send_enabled 控制，本模块 CLI 不提供绕过。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from douyin_share import (
    BROWSE_ACTIVE_PATH,
    BROWSE_REQUEST_PATH,
    ROOT,
    SHARED_INTEREST_PATH,
    load_config,
    validate_browse_topic,
    read_json,
)

TAG_WATCH_LOG = ROOT / "logs" / "tag-watch.log"
HEARTBEAT_PATH = ROOT / "listener-heartbeat.json"
BRIDGE_BASE = "http://127.0.0.1:3101"
CONSOLE_TOKEN_PATH = ROOT.parent / "bridge" / "state" / "console-token"

DEFAULT_MINOR_KEYWORDS = [
    "未成年", "小学生", "初中生", "幼儿园", "儿童", "小孩", "萝莉",
    "loli", "幼女", "正太", "童模", "child", "kid", "teen", "teenager",
]

DEFAULT_SETTINGS = {
    "enabled": False,          # 总开关（调度器检查；CLI --force 可越过）
    "send_enabled": False,     # 发送开关：false = dry-run，绝不发消息
    "tags": ["cos", "美女"],
    "groups": [839367702],     # 群白名单：只允许这些群，其余一律拒绝
    "daily_limit": 3,          # 单日发送条数上限（真实发送时生效）
    "per_tag_cooldown_hours": 24,
    "browse_minutes": 1,       # 每标签每次浏览时长（1-5，topic 模式生产上限 3）
    "browse_wait_seconds": 300,
    "candidates_per_run": 2,   # 每标签每轮最多入候选条数
    "minor_keywords": DEFAULT_MINOR_KEYWORDS,
    "state_file": "tag-watch-state.json",
}


def log(message: str, path: Path | None = None) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    text = f"{stamp} [tag-watch] {message}"
    print(text, flush=True)
    target = path if path is not None else TAG_WATCH_LOG
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    except OSError:
        pass


def load_settings(cfg: dict | None = None) -> dict:
    cfg = cfg if cfg is not None else load_config()
    section = cfg.get("tag_watch")
    if not isinstance(section, dict):
        section = {}
    settings = dict(DEFAULT_SETTINGS)
    settings.update(section)
    settings["groups"] = [int(g) for g in settings["groups"] if str(g).strip().isdigit()] or list(
        DEFAULT_SETTINGS["groups"])
    settings["tags"] = [str(t).strip() for t in settings["tags"] if str(t).strip()]
    return settings


def state_path_for(settings: dict) -> Path:
    name = str(settings.get("state_file") or "tag-watch-state.json")
    path = Path(name)
    return path if path.is_absolute() else ROOT / path


def load_state(path: Path) -> dict:
    state = read_json(path, {})
    if not isinstance(state, dict):
        return {}
    state.setdefault("seen", {})
    state.setdefault("perTag", {})
    state.setdefault("daily", {})
    return state


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def day_key(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now))


def daily_sent(state: dict, now: float) -> int:
    bucket = state["daily"].get(day_key(now)) or {}
    return int(bucket.get("sent") or 0)


def bump_daily(state: dict, now: float, field: str, amount: int = 1) -> None:
    key = day_key(now)
    bucket = state["daily"].setdefault(key, {})
    bucket[field] = int(bucket.get(field) or 0) + amount


def tag_on_cooldown(state: dict, tag: str, hours: float, now: float) -> int:
    """返回剩余冷却秒数，0 表示可以跑。"""
    last = float((state["perTag"].get(tag) or {}).get("lastRun") or 0)
    remaining = last + hours * 3600 - now
    return max(0, int(remaining))


def is_minor_content(title: str, tags: list, keywords: list) -> bool:
    """唯一硬拦：标题/话题命中未成年关键词。小写粗筛，不做画面级判定。"""
    haystack = f"{title or ''} {' '.join(str(t) for t in (tags or []))}".lower()
    return any(str(word).lower() in haystack for word in keywords)


def read_heartbeat_busy(path: Path | None = None) -> bool | None:
    """None = 心跳不可读（监听器状态未知，保守视为不忙但不投递由队列兜底）。"""
    target = path if path is not None else HEARTBEAT_PATH
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return bool(payload.get("busy"))


def browse_queue_idle() -> bool:
    return not BROWSE_REQUEST_PATH.exists() and not BROWSE_ACTIVE_PATH.exists()


def watched_urls_now() -> set[str]:
    data = read_json(SHARED_INTEREST_PATH, {})
    rows = data.get("watchedVideos") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return set()
    return {str(row.get("url")) for row in rows if isinstance(row, dict) and row.get("url")}


def enqueue_browse_request(tag: str, settings: dict, cfg: dict) -> str | None:
    """向监听器投递一次话题浏览请求；队列忙/话题被生产黑名单拦截时返回 None。"""
    try:
        topic = validate_browse_topic(tag, cfg)
    except RuntimeError as exc:
        log(f"tag={tag} topic 被生产校验拒绝（validate_browse_topic）：{exc}")
        return None
    if not browse_queue_idle():
        log(f"tag={tag} browse 队列忙（request/active 占用），本轮跳过")
        return None
    request_id = uuid.uuid4().hex
    payload = {"id": request_id, "minutes": int(settings["browse_minutes"]), "topic": topic}
    temporary = BROWSE_REQUEST_PATH.with_suffix(f".{request_id}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, BROWSE_REQUEST_PATH)
    log(f"tag={tag} browse 请求已投递 id={request_id} minutes={payload['minutes']}")
    return request_id


def wait_browse_response(request_id: str, settings: dict,
                         poll_interval: float = 5.0) -> dict | None:
    """轮询监听器写回的 browse-response-{id}.json；读到即删除响应文件。"""
    response_path = ROOT / f"browse-response-{request_id}.json"
    deadline = time.time() + float(settings["browse_wait_seconds"])
    while time.time() < deadline:
        if response_path.exists():
            try:
                payload = json.loads(response_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
            finally:
                response_path.unlink(missing_ok=True)
            return payload if isinstance(payload, dict) else None
        time.sleep(poll_interval)
    log(f"request {request_id} 等待响应超时（{settings['browse_wait_seconds']}s）")
    return None


def risk_signals(response: dict) -> list[str]:
    """从浏览响应里提取风控信号（只记录，不硬闯）。"""
    signals = []
    if not response:
        return ["响应超时或丢失"]
    if not response.get("ok"):
        signals.append(f"浏览失败：{response.get('error') or '?'}")
    if response.get("topicFallback"):
        signals.append(f"话题回退：{response.get('topicFallbackReason') or '?'}")
    if response.get("restoreError"):
        signals.append("收件箱恢复异常")
    if response.get("ok") and not response.get("videoTab"):
        signals.append("未进入视频 tab")
    return [s for s in signals if s]


def fresh_items(baseline: set[str]) -> list[dict]:
    """返回本轮新增的观看记录（保序），字段 url/title/author/tags。"""
    data = read_json(SHARED_INTEREST_PATH, {})
    rows = data.get("watchedVideos") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    fresh = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url") or "")
        if not url or url in baseline:
            continue
        fresh.append({
            "url": url,
            "title": str(row.get("title") or "").strip(),
            "author": str(row.get("author") or "").strip(),
            "tags": [str(t) for t in (row.get("tags") or []) if str(t).strip()],
        })
    return fresh


def pick_candidates(items: list[dict], settings: dict, state: dict,
                    tag: str, now: float) -> tuple[list[dict], int, int]:
    """粗筛 + 去重 + 上限。返回 (候选, 拦截数, 重复跳过数)。"""
    candidates, blocked, duplicated = [], 0, 0
    for item in items:
        url = item["url"]
        if url in state["seen"]:
            duplicated += 1
            continue
        if is_minor_content(item["title"], item["tags"], settings["minor_keywords"]):
            blocked += 1
            log(f"tag={tag} 硬拦丢弃（未成年粗筛）：{item['title'][:40]} {url}")
            continue
        log(f"tag={tag} 放行并记录：{item['title'][:40]} {url}")
        candidates.append(item)
        if len(candidates) >= int(settings["candidates_per_run"]):
            break
    return candidates, blocked, duplicated


def build_share_text(item: dict, tag: str) -> str:
    title = item["title"] or "(无标题)"
    author = f"（作者：{item['author']}）" if item["author"] else ""
    text = f"刷到一条{tag}视频：{title}{author}\n{item['url']}"
    return text[:480]


def send_to_group(group: int, message: str, settings: dict) -> tuple[bool, str]:
    """发送前双层校验：群白名单 + 发送开关。失败如实返回，不硬发不重试。"""
    if int(group) not in [int(g) for g in settings["groups"]]:
        log(f"拒绝发送：群 {group} 不在白名单 {settings['groups']}")
        return False, "group not in whitelist"
    if not settings["send_enabled"]:
        log(f"send_enabled=false，dry-run 模式，不实际发送到群 {group}")
        return False, "dry-run"
    try:
        token = CONSOLE_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return False, "console token 不可读"
    if not token:
        return False, "console token 为空"
    body = json.dumps({"groupId": int(group), "message": message}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{BRIDGE_BASE}/api/send/group", data=body,
        headers={"Content-Type": "application/json", "x-console-token": token}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        log(f"发送失败（群 {group}）：{exc.__class__.__name__}")
        return False, f"bridge error: {exc.__class__.__name__}"
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False, "bridge 响应异常"
    if isinstance(result, dict) and result.get("ok"):
        log(f"已发送到群 {group}")
        return True, "ok"
    reason = (result or {}).get("error") if isinstance(result, dict) else "?"
    log(f"发送被 bridge 拒绝（群 {group}）：{reason}")
    return False, f"bridge rejected: {reason}"


def run_tag(settings: dict, state: dict, tag: str, cfg: dict, now: float,
            enqueue=enqueue_browse_request,
            wait_response=wait_browse_response,
            sender=send_to_group) -> dict:
    """跑一个标签的完整流程，返回报告。冷却未到/队列忙/心跳忙都会安全跳过。"""
    report = {"tag": tag, "browsed": False, "newCount": 0, "blocked": 0,
              "duplicated": 0, "candidates": 0, "sent": 0, "dryRun": True,
              "elapsedMs": 0, "signals": []}
    started = time.monotonic()
    remaining = tag_on_cooldown(state, tag, float(settings["per_tag_cooldown_hours"]), now)
    if remaining > 0:
        report["signals"] = [f"冷却中，剩余 {remaining}s"]
        log(f"tag={tag} 冷却中，剩余 {remaining}s，跳过")
        return report
    if read_heartbeat_busy():
        report["signals"] = ["监听器心跳 busy，本轮跳过"]
        log("监听器 busy，本轮跳过")
        return report

    baseline = watched_urls_now()
    request_id = enqueue(tag, settings, cfg)
    if not request_id:
        report["signals"] = ["投递失败（topic 校验或队列忙）"]
        return report
    # 投递即占冷却：无论后续成败，本标签本轮不再重试，避免硬闯。
    state["perTag"][tag] = {"lastRun": int(now), "requestId": request_id}

    response = wait_response(request_id, settings)
    report["signals"].extend(risk_signals(response))
    if not response or not response.get("ok"):
        report["elapsedMs"] = int((time.monotonic() - started) * 1000)
        return report
    report["browsed"] = True

    items = fresh_items(baseline)
    report["newCount"] = len(items)
    candidates, blocked, duplicated = pick_candidates(items, settings, state, tag, now)
    report["blocked"], report["duplicated"] = blocked, duplicated

    group = int(settings["groups"][0]) if settings["groups"] else 0
    for item in candidates:
        text = build_share_text(item, tag)
        if not settings["send_enabled"]:
            log(f"[dry-run] 候选入档（将发群 {group}）：{text.splitlines()[0]}")
            state.setdefault("pending", []).append(
                {"tag": tag, "text": text, "url": item["url"], "ts": int(now)})
            report["candidates"] += 1
            mark_seen(state, item["url"], tag, now)
            continue
        if daily_sent(state, now) >= int(settings["daily_limit"]):
            report["signals"].append("达到每日上限，剩余候选不再发送")
            log(f"tag={tag} 达到每日上限，跳过 {item['url']}")
            continue
        ok, reason = sender(group, text, settings)
        if ok:
            bump_daily(state, now, "sent")
            report["sent"] += 1
            report["dryRun"] = False
            mark_seen(state, item["url"], tag, now)
        else:
            report["signals"].append(f"发送未成功：{reason}")
            # 不 mark_seen：失败条目下轮仍可重试
    if settings["send_enabled"]:
        report["candidates"] = len(candidates)
        report["dryRun"] = False
    report["elapsedMs"] = int((time.monotonic() - started) * 1000)
    return report


def mark_seen(state: dict, url: str, tag: str, now: float) -> None:
    state["seen"][url] = {"ts": int(now), "tag": tag}


def run_once(settings: dict, cfg: dict, now: float | None = None,
             only_tag: str | None = None,
             enqueue=enqueue_browse_request,
             wait_response=wait_browse_response,
             sender=send_to_group,
             state_path: Path | None = None) -> list[dict]:
    now = time.time() if now is None else now
    state_path = state_path or state_path_for(settings)
    state = load_state(state_path)
    reports = []
    for tag in settings["tags"]:
        if only_tag and tag != only_tag:
            continue
        reports.append(run_tag(settings, state, tag, cfg, now,
                               enqueue=enqueue, wait_response=wait_response,
                               sender=sender))
    save_state(state_path, state)
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="tag_watch：话题标签监控分享（默认 dry-run）")
    parser.add_argument("--once", action="store_true", help="执行一轮后退出")
    parser.add_argument("--force", action="store_true",
                        help="忽略 enabled 总开关（仍受 send_enabled 约束，用于 dry-run 实跑）")
    parser.add_argument("--tag", default=None, help="只跑指定标签")
    args = parser.parse_args(argv)
    if not args.once:
        parser.error("当前仅支持 --once 模式（调度接入需另行注册计划任务）")
    cfg = load_config()
    settings = load_settings(cfg)
    if not settings["enabled"] and not args.force:
        log("tag_watch.enabled=false，未执行（dry-run 实跑请加 --force）")
        return 1
    reports = run_once(settings, cfg, only_tag=args.tag)
    for report in reports:
        mode = "dry-run" if report["dryRun"] else "send"
        log(f"报告 tag={report['tag']} mode={mode} browsed={report['browsed']} "
            f"new={report['newCount']} blocked={report['blocked']} "
            f"duplicated={report['duplicated']} candidates={report['candidates']} "
            f"sent={report['sent']} elapsedMs={report['elapsedMs']} "
            f"signals={report['signals'] or '无'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
