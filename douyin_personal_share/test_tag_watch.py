#!/usr/bin/env python3
"""tag_watch 单元测试：未成年粗筛、放行记日志、dry-run 不发、去重、冷却、
群白名单拒绝、每日上限、队列忙跳过、心跳 busy 跳过、生产 topic 校验放行。"""

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import tag_watch
from douyin_share import validate_browse_topic


class TagWatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.log_path = self.base / "tag-watch.log"
        self.state_path = self.base / "state.json"
        self.interest_path = self.base / "interest.json"
        self.heartbeat_path = self.base / "heartbeat.json"

        patcher_log = mock.patch.object(tag_watch, "TAG_WATCH_LOG", self.log_path)
        patcher_heart = mock.patch.object(tag_watch, "HEARTBEAT_PATH", self.heartbeat_path)
        patcher_interest = mock.patch.object(tag_watch, "SHARED_INTEREST_PATH", self.interest_path)
        for patcher in (patcher_log, patcher_heart, patcher_interest):
            patcher.start()
            self.addCleanup(patcher.stop)

        self.settings = {
            "enabled": False, "send_enabled": False, "tags": ["cos", "美女"],
            "groups": [839367702], "daily_limit": 3, "per_tag_cooldown_hours": 24,
            "browse_minutes": 1, "browse_wait_seconds": 1, "candidates_per_run": 2,
            "minor_keywords": list(tag_watch.DEFAULT_MINOR_KEYWORDS),
            "state_file": str(self.state_path),
        }
        self.state = tag_watch.load_state(self.state_path)
        self.now = time.time()

    # ---------- 依赖注入 stub ----------
    def stub_enqueue(self, request_id="a" * 32):
        return lambda tag, settings, cfg: request_id

    def stub_wait(self, ok=True):
        return lambda request_id, settings, poll_interval=5.0: (
            {"ok": True, "videoTab": True} if ok else {"ok": False, "error": "测试失败"})

    def make_wait(self, items=None):
        """模拟监听器浏览完成后追加观看记录（baseline 之后写入才是本轮新增）。"""
        def _wait(request_id, settings, poll_interval=5.0):
            if items is not None:
                self.write_interest(items)
            return {"ok": True, "videoTab": True}
        return _wait

    def write_interest(self, items):
        payload = {"watchedVideos": items}
        self.interest_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def log_text(self):
        return self.log_path.read_text(encoding="utf-8") if self.log_path.exists() else ""

    # ---------- 用例 ----------
    def test_topic_validation_accepts_configured_tags(self):
        cfg = {"browse_topics": {"blacklist": []}}
        self.assertEqual(validate_browse_topic("cos", cfg), "cos")
        self.assertEqual(validate_browse_topic("美女", cfg), "美女")

    def test_minor_keyword_blocked(self):
        items = [{"url": "https://www.douyin.com/video/1", "title": "萝莉日常",
                  "author": "a", "tags": []}]
        candidates, blocked, _ = tag_watch.pick_candidates(
            items, self.settings, self.state, "cos", self.now)
        self.assertEqual(blocked, 1)
        self.assertEqual(candidates, [])
        self.assertIn("硬拦丢弃", self.log_text())

    def test_non_blocked_passes_and_logged(self):
        items = [{"url": "https://www.douyin.com/video/2", "title": "cos 口日常",
                  "author": "a", "tags": ["cos"]}]
        candidates, blocked, _ = tag_watch.pick_candidates(
            items, self.settings, self.state, "cos", self.now)
        self.assertEqual(blocked, 0)
        self.assertEqual(len(candidates), 1)
        self.assertIn("放行并记录", self.log_text())

    def test_dedup_skips_seen_url(self):
        tag_watch.mark_seen(self.state, "https://www.douyin.com/video/2", "cos", self.now)
        items = [{"url": "https://www.douyin.com/video/2", "title": "x", "author": "a", "tags": []}]
        candidates, _, duplicated = tag_watch.pick_candidates(
            items, self.settings, self.state, "cos", self.now)
        self.assertEqual(duplicated, 1)
        self.assertEqual(candidates, [])

    def test_cooldown_skips_tag(self):
        self.state["perTag"]["cos"] = {"lastRun": int(self.now)}
        enqueue = mock.Mock()
        report = tag_watch.run_tag(self.settings, self.state, "cos", {}, self.now,
                                   enqueue=enqueue)
        enqueue.assert_not_called()
        self.assertFalse(report["browsed"])
        self.assertTrue(any("冷却" in s for s in report["signals"]))

    def test_heartbeat_busy_skips(self):
        self.heartbeat_path.write_text(json.dumps({"busy": True}), encoding="utf-8")
        enqueue = mock.Mock()
        report = tag_watch.run_tag(self.settings, self.state, "cos", {}, self.now,
                                   enqueue=enqueue)
        enqueue.assert_not_called()
        self.assertTrue(any("busy" in s for s in report["signals"]))

    def test_dry_run_never_sends(self):
        sender = mock.Mock()
        report = tag_watch.run_tag(self.settings, self.state, "cos", {}, self.now,
                                   enqueue=self.stub_enqueue(),
                                   wait_response=self.make_wait(
                                       [{"url": "u1", "title": "t", "author": "a", "tags": []}]),
                                   sender=sender)
        sender.assert_not_called()
        self.assertTrue(report["dryRun"])
        self.assertEqual(report["candidates"], 1)
        self.assertTrue(self.state["pending"])
        self.assertIn("[dry-run]", self.log_text())

    def test_send_rejects_group_outside_whitelist(self):
        ok, reason = tag_watch.send_to_group(111111, "hi", self.settings)
        self.assertFalse(ok)
        self.assertEqual(reason, "group not in whitelist")
        self.assertIn("不在白名单", self.log_text())

    def test_send_respects_daily_limit(self):
        settings = dict(self.settings, send_enabled=True)
        tag_watch.bump_daily(self.state, self.now, "sent", 3)  # 已达 daily_limit=3
        sender = mock.Mock(return_value=(True, "ok"))
        report = tag_watch.run_tag(settings, self.state, "cos", {}, self.now,
                                   enqueue=self.stub_enqueue(),
                                   wait_response=self.make_wait(
                                       [{"url": "u1", "title": "t1", "author": "a", "tags": []},
                                        {"url": "u2", "title": "t2", "author": "a", "tags": []}]),
                                   sender=sender)
        sender.assert_not_called()
        self.assertEqual(report["sent"], 0)
        self.assertTrue(any("每日上限" in s for s in report["signals"]))

    def test_send_success_marks_seen(self):
        settings = dict(self.settings, send_enabled=True)
        sender = mock.Mock(return_value=(True, "ok"))
        report = tag_watch.run_tag(settings, self.state, "cos", {}, self.now,
                                   enqueue=self.stub_enqueue(),
                                   wait_response=self.make_wait(
                                       [{"url": "u1", "title": "t", "author": "a", "tags": []}]),
                                   sender=sender)
        sender.assert_called_once()
        self.assertEqual(report["sent"], 1)
        self.assertIn("u1", self.state["seen"])

    def test_send_failure_not_marked_seen(self):
        settings = dict(self.settings, send_enabled=True)
        sender = mock.Mock(return_value=(False, "bridge error"))
        tag_watch.run_tag(settings, self.state, "cos", {}, self.now,
                          enqueue=self.stub_enqueue(),
                          wait_response=self.make_wait(
                              [{"url": "u1", "title": "t", "author": "a", "tags": []}]),
                          sender=sender)
        self.assertNotIn("u1", self.state["seen"])

    def test_enqueue_busy_queue(self):
        request_path = self.base / "browse-request.json"
        request_path.write_text("{}", encoding="utf-8")
        with mock.patch.object(tag_watch, "BROWSE_REQUEST_PATH", request_path):
            self.assertIsNone(tag_watch.enqueue_browse_request("cos", self.settings, {}))

    def test_run_once_persists_state(self):
        reports = tag_watch.run_once(self.settings, {}, now=self.now, only_tag="cos",
                                     enqueue=self.stub_enqueue(),
                                     wait_response=self.make_wait(
                                         [{"url": "u1", "title": "t", "author": "a", "tags": []}]),
                                     state_path=self.state_path)
        self.assertEqual(len(reports), 1)
        self.assertTrue(self.state_path.exists())
        persisted = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertIn("u1", persisted["seen"])


if __name__ == "__main__":
    unittest.main()
