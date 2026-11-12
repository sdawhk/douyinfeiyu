"""douyin_watchdog 的验证框（captcha）告警检查单测。"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import douyin_watchdog as watchdog

SINGAPORE = ZoneInfo("Asia/Singapore")

# 真实 listener.log 里浏览/播放行的存储形态（GBK 误解码后的乱码，文件本身是 UTF-8）。
MOJI_CAPTCHA = ("2026-11-12T16:30:55   鎾斁鏈捣鎾細https://www.douyin.com/video/7702867212667094498"
                "锛坴ideo=1锛岄獙璇佹=鏄紝鏍囬=锛?")
MOJI_CAPTCHA_NO = ("2026-11-12T16:30:55   鎾斁鏈捣鎾細https://www.douyin.com/video/111"
                   "锛坴ideo=1锛岄獙璇佹=鍚紝鏍囬=锛?")
MOJI_PLAY_OK = ("2026-11-12T16:35:00 娴忚缁撴潫锛氳瀹熷埌 1 鏉″疄闄呮挱鏀捐揪鍒?8 绉掔殑瑙嗛锛?"
                "屽叡鍐欏叆 1 鏉″叡浜汙鐪嬭褰曘€?")
MOJI_PLAY_ZERO = ("2026-11-12T16:31:00 娴忚缁撴潫锛氳瀹熷埌 0 鏉″疄闄呮挱鏀捐揪鍒?8 绉掔殑瑙嗛锛?"
                  "屽叡鍐欏叆 0 鏉″叡浜汙鐪嬭褰曞€?")
# 修复编码后的正常中文形态（管道修好后也能识别）。
PLAIN_CAPTCHA = "2026-11-12T16:30:55   播放未起播：https://www.douyin.com/video/222（video=1，验证框=是，标题=x）"
PLAIN_PLAY_OK = "2026-11-12T16:35:00 浏览结束：观察到 1 条实际播放达到 8 秒的视频，共写入 1 条共观看记录。"


def at(hour, minute=0):
    return datetime(2026, 11, 12, hour, minute, tzinfo=SINGAPORE)


class CaptchaCheckTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.log = Path(self._tmp.name) / "listener.log"

    def write_log(self, lines):
        self.log.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def check(self, now):
        with patch.object(watchdog, "LISTENER_LOG_PATH", self.log):
            return watchdog.check_douyin_captcha(now)

    def test_mojibake_captcha_line_is_detected(self):
        self.write_log([MOJI_CAPTCHA, MOJI_PLAY_ZERO])
        self.assertEqual(self.check(at(17, 0)), "douyin_captcha")

    def test_plain_utf8_captcha_line_is_detected(self):
        self.write_log([PLAIN_CAPTCHA])
        self.assertEqual(self.check(at(17, 0)), "douyin_captcha")

    def test_captcha_cleared_by_successful_play(self):
        self.write_log([MOJI_CAPTCHA, MOJI_PLAY_ZERO, MOJI_PLAY_OK])
        self.assertIsNone(self.check(at(17, 0)))

    def test_plain_play_ok_clears_captcha(self):
        self.write_log([PLAIN_CAPTCHA, PLAIN_PLAY_OK])
        self.assertIsNone(self.check(at(17, 0)))

    def test_captcha_frame_no_is_not_an_issue(self):
        self.write_log([MOJI_CAPTCHA_NO])
        self.assertIsNone(self.check(at(17, 0)))

    def test_old_captcha_outside_window_is_ignored(self):
        self.write_log([MOJI_CAPTCHA])
        self.assertIsNone(self.check(at(23, 0)))

    def test_play_zero_alone_is_not_captcha(self):
        self.write_log([MOJI_PLAY_ZERO])
        self.assertIsNone(self.check(at(17, 0)))

    def test_missing_log_is_not_an_issue(self):
        with patch.object(watchdog, "LISTENER_LOG_PATH", Path(self._tmp.name) / "nope.log"):
            self.assertIsNone(watchdog.check_douyin_captcha(at(17, 0)))


class CooldownAndMessageTest(unittest.TestCase):
    def test_captcha_has_its_own_long_cooldown(self):
        self.assertEqual(watchdog.alert_cooldown_for("douyin_captcha"), 6 * 3600)
        self.assertEqual(watchdog.alert_cooldown_for("listener_down"), watchdog.ALERT_COOLDOWN_SECONDS)

    def test_captcha_messages_read_naturally(self):
        alert = watchdog.compose_alert(["douyin_captcha"], repeat=False)
        self.assertIn("滑", alert)
        self.assertIn("验证", alert)
        self.assertIn("Edge", alert)
        self.assertEqual(watchdog.compose_recovery(["douyin_captcha"]),
                         "爸，抖音验证好了，能正常刷了，谢啦。")

    def test_captcha_alert_switches_to_status_only_when_browser_is_down(self):
        alert = watchdog.compose_alert(["douyin_captcha"], repeat=False, browser_down=True)
        self.assertNotIn("帮我手动滑", alert)
        self.assertIn("没在跑", alert)
        alive = watchdog.compose_alert(["douyin_captcha"], repeat=False, browser_down=False)
        self.assertIn("帮我手动滑", alive)

    def test_other_messages_still_compose(self):
        watchdog.compose_alert(["listener_down"], repeat=True)
        watchdog.compose_recovery(["listener_down", "crash_loop"])


class PlanRoundTest(unittest.TestCase):
    """自愈不打扰 / 持续超阈值才报 / 报过才补恢复 的策略单测。"""

    def plan(self, detected, records, now):
        return watchdog.plan_round(detected, records, now)

    def test_first_sighting_of_gated_issue_starts_clock_silently(self):
        plan = self.plan(["listener_down"], {}, at(17, 0))
        self.assertEqual(plan["toAlert"], [])
        self.assertEqual(plan["starting"], ["listener_down"])
        self.assertEqual(plan["recoveries"], [])
        self.assertEqual(plan["selfHealed"], [])

    def test_gated_issue_inside_tolerance_window_stays_silent(self):
        records = {"listener_down": {"firstSeenAt": at(17, 0).isoformat(timespec="seconds")}}
        plan = self.plan(["listener_down"], records, at(17, 5))
        self.assertEqual(plan["toAlert"], [])
        self.assertEqual(plan["starting"], [])

    def test_gated_issue_alerts_after_ten_minutes(self):
        records = {"listener_down": {"firstSeenAt": at(17, 0).isoformat(timespec="seconds")}}
        plan = self.plan(["listener_down"], records, at(17, 10))
        self.assertEqual(plan["toAlert"], ["listener_down"])
        self.assertFalse(plan["repeat"])

    def test_recovery_before_any_alert_is_silent(self):
        records = {"listener_down": {"firstSeenAt": at(17, 0).isoformat(timespec="seconds")}}
        plan = self.plan([], records, at(17, 5))
        self.assertEqual(plan["toAlert"], [])
        self.assertEqual(plan["recoveries"], [])
        self.assertEqual(plan["selfHealed"], ["listener_down"])

    def test_recovery_after_real_alert_owes_a_note(self):
        records = {"listener_down": {
            "firstSeenAt": at(17, 0).isoformat(timespec="seconds"),
            "alertedAt": at(17, 10).isoformat(timespec="seconds")}}
        plan = self.plan([], records, at(17, 20))
        self.assertEqual(plan["recoveries"], ["listener_down"])
        self.assertEqual(plan["selfHealed"], [])

    def test_repeat_alert_respects_cooldown_and_marks_repeat(self):
        records = {"listener_down": {"alertedAt": at(17, 10).isoformat(timespec="seconds")}}
        plan = self.plan(["listener_down"], records, at(17, 15))
        self.assertEqual(plan["toAlert"], [])  # 5 分钟 < 30 分钟冷却
        plan = self.plan(["listener_down"], records, at(17, 41))
        self.assertEqual(plan["toAlert"], ["listener_down"])
        self.assertTrue(plan["repeat"])

    def test_captcha_and_backlog_are_not_gated(self):
        for key in ("douyin_captcha", "reply_backlog", "reply_failures"):
            plan = self.plan([key], {}, at(17, 0))
            self.assertEqual(plan["toAlert"], [key], key)

    def test_crash_loop_and_profile_lock_are_gated(self):
        for key in ("crash_loop", "profile_locked"):
            plan = self.plan([key], {}, at(17, 0))
            self.assertEqual(plan["toAlert"], [], key)
            self.assertEqual(plan["starting"], [key], key)

    def test_replay_of_real_flapping_timeline_sends_nothing(self):
        """回放 2026-11-12 下午真实时间线：掉了又被拉起、反复闪断，全程 0 条消息。"""
        records = {}
        timeline = [
            (17, 0, ["listener_down"]),   # 旧代码：报 listener_down
            (17, 5, []),                  # 旧代码：报恢复
            (17, 10, ["listener_down"]),  # 旧代码：又报
            (17, 15, []),                 # 旧代码：又报恢复
            (17, 25, ["listener_down"]),  # 旧代码：再报
            (17, 30, []),                 # 旧代码：再报恢复
        ]
        for hour, minute, detected in timeline:
            now = at(hour, minute)
            plan = self.plan(detected, records, now)
            self.assertEqual(plan["toAlert"], [], f"{hour}:{minute:02d} 不该告警")
            self.assertEqual(plan["recoveries"], [], f"{hour}:{minute:02d} 不该报恢复")
            for key in plan["starting"]:
                records[key] = {"firstSeenAt": now.isoformat(timespec="seconds")}
            for key in plan["selfHealed"]:
                records.pop(key, None)

    def test_replay_of_sustained_outage_alerts_once_then_recovers(self):
        """回放持续宕机：17:00 掉、一直没起来，17:10 报一次，17:20 恢复补一条。"""
        records = {}
        now = at(17, 0)
        plan = self.plan(["listener_down"], records, now)
        records["listener_down"] = {"firstSeenAt": now.isoformat(timespec="seconds")}
        self.assertEqual(plan["toAlert"], [])

        now = at(17, 5)
        self.assertEqual(self.plan(["listener_down"], records, now)["toAlert"], [])

        now = at(17, 10)
        plan = self.plan(["listener_down"], records, now)
        self.assertEqual(plan["toAlert"], ["listener_down"])
        records["listener_down"]["alertedAt"] = now.isoformat(timespec="seconds")

        now = at(17, 15)
        plan = self.plan(["listener_down"], records, now)
        self.assertEqual(plan["toAlert"], [])  # 冷却内不重复报

        plan = self.plan([], records, at(17, 20))
        self.assertEqual(plan["recoveries"], ["listener_down"])


if __name__ == "__main__":
    unittest.main()
