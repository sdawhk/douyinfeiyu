import json
import os
import random
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

from douyin_share import (
    Video,
    canonical_video_url,
    deliver_selected,
    make_message,
    prepare_browser_temp,
    recipient_config,
    require_recipient_verification,
    select_videos,
    authenticated,
    verification_matches,
    verify_recipient,
    DAILY_WINDOWS,
    SINGAPORE,
    claim_due_slot,
    ensure_daily_plan,
    run_scheduled,
    PlaywrightTimeout,
)


class FakeLocator:
    def __init__(self, text):
        self.text = text

    def inner_text(self, timeout=None):
        return self.text


class FakePage:
    def __init__(self, text, url="", title="抖音"):
        self.text = text
        self.url = url
        self._title = title

    def goto(self, url, **kwargs):
        self.url = url

    def wait_for_timeout(self, _duration):
        pass

    def wait_for_function(self, expression, arg=None, timeout=None):
        if arg and arg not in self.text:
            raise PlaywrightTimeout("condition not met")

    def title(self):
        return self._title

    def locator(self, _selector):
        return FakeLocator(self.text)


class ShareLogicTests(unittest.TestCase):
    def test_canonical_video_url_rejects_non_video_and_external_links(self):
        self.assertEqual(canonical_video_url("https://www.douyin.com/video/123?from=feed"), "https://www.douyin.com/video/123")
        self.assertIsNone(canonical_video_url("https://evil.example/video/123"))
        self.assertIsNone(canonical_video_url("https://www.douyin.com/user/123"))

    def test_profile_url_is_verified_by_visible_handle_not_url_token(self):
        cfg = {
            "recipient_profile_url": "https://www.douyin.com/user/example-sec-uid",
            "recipient_handle": "example_handle_12345",
        }
        self.assertEqual(recipient_config(cfg)[1], "example_handle_12345")
        page = FakePage("昵称\n抖音号：example_handle_12345", cfg["recipient_profile_url"])
        self.assertEqual(verify_recipient(page, cfg), (cfg["recipient_profile_url"], "example_handle_12345"))
        self.assertTrue(verification_matches(cfg, {
            "recipient_profile_url": cfg["recipient_profile_url"],
            "recipient_handle": "example_handle_12345",
        }))
        require_recipient_verification(cfg, {
            "recipient_profile_url": cfg["recipient_profile_url"],
                "recipient_handle": "example_handle_12345",
        })
        with self.assertRaisesRegex(RuntimeError, "Run --verify-recipient"):
            require_recipient_verification(cfg, {
                "recipient_profile_url": cfg["recipient_profile_url"],
                "recipient_handle": "other_handle",
            })

    def test_wrong_visible_handle_fails_recipient_gate(self):
        cfg = {
            "recipient_profile_url": "https://www.douyin.com/user/example-sec-uid",
            "recipient_handle": "example_handle_12345",
        }
        page = FakePage("昵称\n抖音号：different_example_handle", cfg["recipient_profile_url"])
        with self.assertRaisesRegex(RuntimeError, "did not load the configured Douyin ID"):
            verify_recipient(page, cfg)

    def test_profile_url_left_open_is_not_accepted_as_chat_identity(self):
        from douyin_share import open_recipient_chat
        profile_url = "https://www.douyin.com/user/example-sec-uid"
        page = Mock(url=profile_url)
        message_action = Mock()
        message_action.count.return_value = 1
        empty_links = Mock()
        empty_links.count.return_value = 0
        no_heading = Mock()
        no_heading.first.inner_text.return_value = "作品 0"
        page.get_by_role.side_effect = lambda role, **kwargs: {
            "button": message_action, "link": empty_links, "heading": no_heading
        }[role]
        with patch("douyin_share.verify_recipient", return_value=(profile_url, "example_handle_12345")):
            with patch("douyin_share.authenticated"):
                with self.assertRaisesRegex(RuntimeError, "Could not identify the verified profile name"):
                    open_recipient_chat(page, {})
        page.locator.assert_not_called()

    def test_verification_interstitial_title_fails_closed(self):
        page = FakePage("", "https://www.douyin.com/", "验证码中间页")
        with self.assertRaisesRegex(RuntimeError, "requires login or verification"):
            authenticated(page)

    def test_browser_temp_uses_ignored_module_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            local_dir = Path(tmp) / "playwright-temp"
            with patch.dict(os.environ, {"TEMP": tmp, "TMP": tmp}, clear=True):
                with patch("douyin_share.LOCAL_TEMP_DIR", local_dir):
                    self.assertEqual(prepare_browser_temp(), local_dir)
                    self.assertEqual(os.environ["TEMP"], str(local_dir))

    def test_selection_deduplicates_sent_urls_and_repeat_authors(self):
        items = [
            Video("https://www.douyin.com/video/1", "one", "A"),
            Video("https://www.douyin.com/video/2", "two", "A"),
            Video("https://www.douyin.com/video/3", "three", "B"),
            Video("https://www.douyin.com/video/4", "four", "B"),
        ]
        self.assertEqual(
            [v.url for v in select_videos(items, {items[0].url}, 3)],
            [items[1].url, items[2].url],
        )

    def test_message_includes_context_and_canonical_link(self):
        message = make_message(Video("https://www.douyin.com/video/9", "  花园  修剪  ", "A"))
        self.assertIn("花园 修剪", message)
        self.assertIn("分享给你", message)
        self.assertNotIn("你可能会感兴趣", message)
        self.assertTrue(message.endswith("https://www.douyin.com/video/9"))

    def test_dry_run_and_reached_quota_never_call_sender(self):
        cfg = {"daily_max": 2}
        videos = [Video(f"https://www.douyin.com/video/{i}", f"title {i}", f"author {i}") for i in range(3)]
        sender = Mock()
        state = {"sent_urls": [], "sent_by_day": {}}
        preview = deliver_selected(None, cfg, videos, state, "2026-10-30", 2, False, sender)
        self.assertEqual(len(preview), 2)
        sender.assert_not_called()
        exhausted = {"sent_urls": [], "sent_by_day": {"2026-10-30": 2}}
        self.assertEqual(deliver_selected(None, cfg, videos, exhausted, "2026-10-30", 2, True, sender), [])
        sender.assert_not_called()

    def test_send_is_capped_and_persisted_after_each_success(self):
        cfg = {"daily_max": 2}
        videos = [Video(f"https://www.douyin.com/video/{i}", f"title {i}", f"author {i}") for i in range(3)]
        state = {"sent_urls": [videos[0].url], "sent_by_day": {"2026-10-30": 1}}
        sender = Mock()
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            selected = deliver_selected(None, cfg, videos, state, "2026-10-30", 2, True,
                                        sender=sender, state_path=state_path)
            self.assertEqual([item.url for item in selected], [videos[1].url])
            sender.assert_called_once()
            self.assertEqual(state["sent_by_day"]["2026-10-30"], 2)
            self.assertIn(videos[1].url, state_path.read_text(encoding="utf-8"))

    def test_uncertain_send_is_recorded_as_attempt_and_not_retried(self):
        cfg = {"daily_max": 2}
        video = Video("https://www.douyin.com/video/9", "title", "author")
        state = {"sent_urls": [], "sent_by_day": {}}
        sender = Mock(side_effect=RuntimeError("ambiguous send"))
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            with self.assertRaisesRegex(RuntimeError, "ambiguous send"):
                deliver_selected(None, cfg, [video], state, "2026-10-30", 2, True,
                                 sender=sender, state_path=state_path)
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertIn(video.url, saved["attempted_urls"])
            self.assertNotIn(video.url, saved["sent_urls"])
            self.assertEqual(deliver_selected(None, cfg, [video], state, "2026-10-30", 2,
                                              False, sender), [])

    def test_daily_plan_persists_one_random_time_per_singapore_window(self):
        day = datetime(2026, 10, 30).date()
        state = {}
        plan = ensure_daily_plan(state, day, random.Random(17))
        self.assertEqual(len(plan), 5)
        self.assertEqual(ensure_daily_plan(state, day, random.Random(99)), plan)
        for slot, (start, end) in zip(plan, DAILY_WINDOWS):
            scheduled = datetime.fromisoformat(slot["at"])
            self.assertEqual(scheduled.utcoffset(), timedelta(hours=8))
            self.assertGreaterEqual(scheduled.time().replace(tzinfo=None), start)
            self.assertLess(scheduled.time().replace(tzinfo=None), end)

    def test_due_slot_is_claimed_once_and_stale_slot_is_skipped(self):
        state = {"daily_plans": {"2026-10-30": [
            {"at": "2026-10-30T09:00+08:00", "status": "pending"},
            {"at": "2026-10-30T10:00+08:00", "status": "pending"},
        ]}}
        now = datetime(2026, 10, 30, 9, 20, tzinfo=SINGAPORE)
        claimed = claim_due_slot(state, now)
        self.assertEqual(claimed["status"], "attempted")
        self.assertIsNone(claim_due_slot(state, now))
        stale_state = {"daily_plans": {"2026-10-30": [
            {"at": "2026-10-30T09:00+08:00", "status": "pending"},
            {"at": "2026-10-30T10:00+08:00", "status": "pending"},
        ]}}
        late = datetime(2026, 10, 30, 10, 10, tzinfo=SINGAPORE)
        self.assertEqual(claim_due_slot(stale_state, late)["at"], "2026-10-30T10:00+08:00")
        self.assertEqual(stale_state["daily_plans"]["2026-10-30"][0]["status"], "skipped")

    def test_scheduler_does_not_launch_browser_without_due_slot(self):
        fixed_now = datetime(2026, 10, 30, 8, 0, tzinfo=SINGAPORE)
        today = fixed_now.date().isoformat()
        state = {"daily_plans": {today: [
            {"at": f"{today}T{hour:02d}:00+08:00", "status": "pending"}
            for hour in (9, 12, 15, 18, 21)
        ]}}
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            state_path = Path(tmp) / "state.json"
            config_path.write_text('{"daily_max": 5}', encoding="utf-8")
            state_path.write_text(json.dumps(state), encoding="utf-8")
            with patch("douyin_share.CONFIG_PATH", config_path), patch("douyin_share.STATE_PATH", state_path):
                with patch("douyin_share.datetime") as mocked_datetime:
                    mocked_datetime.now.return_value = fixed_now
                    mocked_datetime.fromisoformat.side_effect = datetime.fromisoformat
                    with patch("douyin_share.sync_playwright") as playwright:
                        self.assertEqual(run_scheduled(), 0)
                        playwright.assert_not_called()


if __name__ == "__main__":
    unittest.main()
