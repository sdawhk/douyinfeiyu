# -*- coding: utf-8 -*-
r"""maintenance_trigger.py —— 每日维护的「活动触发」入口（2026-11-08）

为什么有这个文件
────────────────
原来每日维护只靠 Windows 计划任务（06:10）。
但计划任务的致命问题：**错过的窗口不会补**。

实测（2026-11-08）：
  06:10 的每日巩固任务应该跑，但电脑 11:00 才开机
  → LastRunTime 停在 11:07（那是手动触发的）
  → NumberOfMissedRuns = 0（系统认为「没漏」，因为它就不认为该跑）
  → 从 06:10 到 11:07，五个小时里没有巩固，短期层在积压

而桥接（QQ 收发）一直在跑，每轮对话都会调 memory_cli。
所以「有人说话」这件事本身就是最好的触发器 ——
它既证明系统在线，也证明「有数据要处理」。

触发条件（三条都满足才跑）
──────────────────────────
  ① 今天还没跑过（看 state/last_maintenance.json 的 date）
  ② 当前小时在 6~23 之间（不在半夜跑，免得打断休眠）
  ③ 距上次实际跑 >= MIN_GAP_HOURS（防止时钟回拨导致一天跑两次）

跑什么
──────
  ① daily_consolidation（巩固：work→long_term、情景档、经验、反思、冷迁）
  ② candidate_pool.clear_old（候选池分层清理）

不跑就返回，几乎零成本（读一个小 json + 一次时间比较）。

失败处理
────────
任何一步失败都**不影响调用方**（memory_cli 的主流程必须继续）。
但要 print 出来 —— 静默失败是今天查了一整天的那个坑。
"""

import os
import sys
import json
import time

import config as _cfg
from config import BASE_DIR
STATE_PATH = os.path.join(BASE_DIR, "state", "last_maintenance.json")
LOCK_PATH = os.path.join(BASE_DIR, "state", "maintenance.lock")

MIN_GAP_HOURS = getattr(_cfg, "MAINTENANCE_MIN_GAP_HOURS", 20)      # 两次维护至少隔这么久（防时钟回拨重复跑）
RUN_HOUR_START = getattr(_cfg, "MAINTENANCE_RUN_HOUR_START", 6)     # 早于这个点不跑（半夜别打扰）
RUN_HOUR_END = getattr(_cfg, "MAINTENANCE_RUN_HOUR_END", 23)        # 晚于这个点不跑


def _read_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _write_state(d: dict) -> None:
    from atomic_io import atomic_write_json
    atomic_write_json(STATE_PATH, d)


def _should_run(now: float = None) -> tuple:
    """返回 (要不要跑, 原因)。原因一定会被打印或返回，不会静默。"""
    now = now if now is not None else time.time()
    lt = time.localtime(now)
    today = time.strftime("%Y-%m-%d", lt)

    if not (RUN_HOUR_START <= lt.tm_hour <= RUN_HOUR_END):
        return False, "当前 %d 点，不在 %d~%d 点区间" % (
            lt.tm_hour, RUN_HOUR_START, RUN_HOUR_END)

    st = _read_state()
    if st.get("date") == today and st.get('errors'):
        if now >= float(st.get('next_retry_at') or 0):
            return True, '补跑上次失败的维护步骤'
        return False, '等待失败步骤重试时间'
    if st.get("date") == today:
        return False, "今天（%s）已经跑过" % today

    last = float(st.get("at") or 0)
    gap_h = (now - last) / 3600 if last else 999
    if gap_h < MIN_GAP_HOURS:
        return False, "距上次只有 %.1f 小时（阈值 %d）" % (gap_h, MIN_GAP_HOURS)

    return True, "今天没跑过（上次 %s）" % (
        time.strftime("%m-%d %H:%M", time.localtime(last)) if last else "从未")


def _acquire_lock():
    """拿维护锁。拿不到就返回 None（说明别人正在跑）。"""
    try:
        os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
        # O_EXCL：原子创建，已存在就失败
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        return fd
    except FileExistsError:
        # 检查是不是陈旧的锁（进程已死）
        try:
            with open(LOCK_PATH, "r", encoding="utf-8") as f:
                old_pid = int((f.read() or "0").strip() or 0)
            if old_pid and not _pid_alive(old_pid):
                os.remove(LOCK_PATH)
                return _acquire_lock()      # 重试一次
        except Exception:
            pass
        return None
    except Exception as e:
        print("[maintenance] 拿锁失败: %s: %s" % (type(e).__name__, e))
        return None


def _pid_alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except Exception:
            return True
    try:
        import subprocess
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-Process -Id %d -ErrorAction SilentlyContinue) -ne $null" % pid],
            capture_output=True, text=True, timeout=10)
        return (r.stdout or "").strip().lower() == "true"
    except Exception:
        return True     # 判断不了就当活着（宁可跳过，不要重复跑）


def _release_lock(fd):
    if fd is None:
        return
    try:
        os.close(fd)
    except Exception:
        pass
    try:
        if os.path.exists(LOCK_PATH):
            os.remove(LOCK_PATH)
    except Exception:
        pass


def run_now(force: bool = False) -> dict:
    now = time.time()
    if not force:
        ok, why = _should_run(now)
        if not ok:
            return {'ran':False, 'reason':why}
    fd = _acquire_lock()
    if fd is None:
        return {'ran':False,'reason':'维护锁被占用'}
    today = time.strftime('%Y-%m-%d', time.localtime(now))
    old = _read_state()
    previous = {s['step']:s for s in old.get('steps', [])} if old.get('date') == today else {}
    out = {'ran':True,'steps':[],'errors':[]}
    try:
        def consolidate():
            import daily_consolidation as dc
            result = dc.process_working_memory_to_long_term()
            if result.get('pending_error') or result.get('episodes_error'):
                raise RuntimeError('巩固子步骤失败')
            return {'consolidated':result.get('consolidated'), 'updated':result.get('updated')}
        def candidates():
            import candidate_pool as cp
            return {'removed':cp.clear_old()}
        def patrol():
            import nightly_patrol as np
            report = np.run_patrol(None)
            if not report:
                raise RuntimeError('夜巡没有返回报告')
            return {'report_path':np.save_report(report),'abnormal':report.get('abnormal')}
        for name, action in (('consolidate',consolidate),('candidate_clear_old',candidates),('patrol',patrol)):
            if previous.get(name, {}).get('ok'):
                out['steps'].append(dict(previous[name], reused=True))
                continue
            try:
                out['steps'].append({'step':name,'ok':True,'completed_at':time.time(),**action()})
            except Exception as exc:
                out['steps'].append({'step':name,'ok':False,'error':type(exc).__name__})
                out['errors'].append({'step':name,'error':str(exc)})
        _write_state({'date':today,'at':now,'steps':out['steps'],'errors':out['errors'],
                      'next_retry_at': now+60 if out['errors'] else None})
        out['ok'] = not out['errors']
    finally:
        _release_lock(fd)
    return out


def maybe_run() -> dict:
    """给 memory_cli 调用的轻量入口。任何异常都不往外抛。"""
    try:
        return run_now(force=False)
    except Exception as e:
        print("[maintenance] 入口异常（不影响主流程）: %s: %s"
              % (type(e).__name__, e))
        return {"ran": False, "reason": "异常: %s" % e}


def selftest():
    """自检：时间判断 + 状态读写 + 锁。用临时路径，不碰生产。"""
    import tempfile
    import shutil

    global STATE_PATH, LOCK_PATH
    tmp = tempfile.mkdtemp(prefix="maint_test_")
    old_state, old_lock = STATE_PATH, LOCK_PATH
    STATE_PATH = os.path.join(tmp, "state", "last_maintenance.json")
    LOCK_PATH = os.path.join(tmp, "state", "maintenance.lock")
    try:
        # ① 没状态 → 该跑（如果在时间窗口内）
        now = time.mktime(time.strptime("2026-11-08 10:00:00", "%Y-%m-%d %H:%M:%S"))
        ok, why = _should_run(now)
        assert ok, "没跑过应该跑: %s" % why
        print("  ✅ ① 没跑过 → 该跑")

        # ② 半夜 → 不跑
        night = time.mktime(time.strptime("2026-11-08 03:00:00", "%Y-%m-%d %H:%M:%S"))
        ok, why = _should_run(night)
        assert not ok, "半夜不该跑"
        print("  ✅ ② 半夜 → 不跑（%s）" % why)

        # ③ 今天跑过 → 不跑
        _write_state({"date": "2026-11-08", "at": now - 3600})
        ok, why = _should_run(now)
        assert not ok, "今天跑过不该跑"
        print("  ✅ ③ 今天跑过 → 不跑（%s）" % why)

        # ④ 昨天跑过且在窗口内 → 该跑
        _write_state({"date": "2026-11-07", "at": now - 24 * 3600})
        ok, why = _should_run(now)
        assert ok, "昨天跑过应该跑: %s" % why
        print("  ✅ ④ 昨天跑过 → 该跑")

        # ⑤ 锁：拿两次，第二次失败
        fd1 = _acquire_lock()
        assert fd1 is not None, "第一次该拿到"
        fd2 = _acquire_lock()
        assert fd2 is None, "第二次该拿不到"
        _release_lock(fd1)
        print("  ✅ ⑤ 锁互斥正常")
        _release_lock(fd2)

        print("maintenance_trigger selftest OK")
    finally:
        STATE_PATH, LOCK_PATH = old_state, old_lock
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    elif "--force" in sys.argv:
        print(run_now(force=True))
    else:
        print(run_now(force=False))
