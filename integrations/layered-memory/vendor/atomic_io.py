# -*- coding: utf-8 -*-
"""原子写 JSON —— 全项目唯一实现（2026-11-08 抽出）。

## 为什么要抽出来

原来有 5 份几乎一样的副本，各自叫 `_atomic_write_json`：

    memory_manager.py    episode.py    handover.py
    lessons.py           reflection.py

它们不能互相 import（memory_manager 是 L3，episode/lessons/reflection 是 L2，
反过来 import 就是循环依赖），所以只能各抄一份。后果是**改一处不会跟着改其余**：

    2026-11-08 审计实测：8 次重试 / 1.8s 窗口在并发下会穿透
    （4 线程 × 60 次写 → 2 次 PermissionError）
    修的时候必须去 5 个文件里各改一遍 —— 这就是重复的代价。

现在：逻辑收在这一个文件，谁用谁 import。本模块**只依赖标准库**，不 import 项目内任何模块，
所以任何层级都可以安全 import 它，不会制造循环依赖。

## 它保证什么、不保证什么

保证（实测验证过的范围）：
  · 任何时刻进程被杀 → 要么旧文件完整，要么新文件完整，不会出现第三态
    （实测：12 次随机时刻 kill -9，读到损坏 JSON 0 次）
  · 写入过程本身不会让读者看到半个文件
  · 失败时不留 tmp（except 覆盖到的路径）

**不保证（没验过，别当成安全）**：
  · 断电安全。fsync 有，但没做过整机掉电实测。
  · POSIX 上 rename 后目录项落盘需要 fsync 父目录，本实现没做（Windows 上影响很小）。
  · 「两个人同时读-改-写」的丢失更新 —— 那是调用方加锁的事，本模块管不了。
    （handover.py 就栽在这上面：40 个并发写丢了 19 个。
      它的问题不是原子写，是读-改-写没锁。）

## 用法

    from atomic_io import atomic_write_json
    atomic_write_json(path, data)

    # 需要顺手清陈旧 tmp 的（目前只有 memory_manager 用）：
    atomic_write_json(path, data, sweep=True)
"""

import glob as _glob
import json
import os
import time
import uuid

# Windows 上 os.replace 会因为目标被别的进程读着而失败，这些都是「忙」类，
# 重试有意义；路径不存在、是目录这类错误重试多少次都一样，早点抛出去比拖着强。
_RETRYABLE = {32, 5, 33}      # 被占用 / 拒绝访问 / 锁冲突

_RETRY_TIMES = 12             # 12 次，退避 0.05*n 但单次封顶 0.5s → 合计约 3.3s
_RETRY_CAP = 0.5

# 清扫陈旧 tmp 的默认年龄。见 sweep_stale_tmp 的说明（这个数是有争议的）。
_STALE_AGE = 3600.0


def sweep_stale_tmp(path: str, older_than: float = _STALE_AGE) -> int:
    """清掉同目标的**陈旧**临时文件，返回清掉几个。

    ## 为什么需要

    tmp 的清理写在 finally 里，但 finally 只覆盖「异常 / 正常返回」——
    进程被 kill -9 / 断电 / 蓝屏时 finally **根本不执行**。
    实测：12 次随机时刻 kill -9 → 数据全部完好（这点要表扬 os.replace），
    但留下了 10 个 .tmp。生产目录里已经攒过 2 个（合计 3.18 MB，内容都是坏 JSON）。

    ## 为什么按「年龄」而不是按 pid 判断（这条有争议，见下）

    当前实现：修改时间超过 older_than 才算陈旧。
    同一时刻可能有别的进程正在写同一个目标，它那份 tmp 是**活**的，不能删。
    按文件名里的 pid 判断不可靠（pid 会复用）。

    **已知缺陷（2026-11-08 审计指出，未修）**：
    「1 小时」是拍脑袋的数。一个写得很慢的任务（大文件 + 慢盘）可能超过 1 小时，
    就会被误删成「死文件」。真正稳的做法是记 pid 进 tmp 名再判断进程存活 ——
    tmp 名里本来就有 pid，可以用上。**这个改动待维护者决定，不要自己改。**

    失败静默跳过：清扫是顺手做的事，不能因为它让写入失败。
    """
    try:
        d = os.path.dirname(os.path.abspath(path)) or "."
        base = os.path.basename(path)
        cutoff = time.time() - older_than
        removed = 0
        for f in _glob.glob(os.path.join(d, base + ".*.tmp")):
            try:
                if os.path.getmtime(f) < cutoff:
                    os.remove(f)
                    removed += 1
            except OSError:
                pass                     # 别人正在用 / 已删除 → 跳过
        return removed
    except Exception:
        return 0


def atomic_write_json(path: str, data: dict, sweep: bool = False) -> None:
    """原子写 JSON：先写同目录唯一 tmp → fsync → os.replace（带重试）。

    参数：
      path   目标路径
      data   要写的 dict
      sweep  是否顺手清陈旧 tmp。**默认 False** —— 只有 memory_manager 传 True，
             其余调用方保持原样（铺开与否待维护者决定）。

    ## tmp 为什么是「同目录 + 唯一名」

    · 同目录：保证跟目标同一个文件系统。跨盘 os.replace 会抛异常，
      所以绝不能用 tempfile.gettempdir()。
    · 唯一名（pid + 6 位随机）：两个进程同时写时不会抢同一个 .tmp
      （固定名在 Windows 上会 WinError 32，或者两边互相覆盖对方写了一半的内容）。
    · 不受 TEMP / TMP 环境变量影响（那些可能指向另一块盘）。

    ## os.replace 在 Windows 上的行为（实测）

      目标被读句柄占着 → 抛 OSError winerror=5（拒绝访问），**不是静默失败**。
      这个行为是对的：抛异常才能让重试层接住；静默失败才是灾难。

    ## 失败时

      finally 无条件删 tmp。所以序列化失败、replace 重试 8→12 次全失败，
      都不会留下垃圾。**唯一例外是进程被 kill**（finally 不执行），
      那种情况由 sweep 兜底。
    """
    if sweep:
        sweep_stale_tmp(path)

    # Pool writers historically reconstruct {memories: ...}. Preserve only the
    # reserved transaction receipts, under the caller's existing pool lock.
    # Malformed existing state must not be silently overwritten.
    if isinstance(data, dict) and (isinstance(data.get('memories'), list) or isinstance(data.get('sessions'), dict)) and os.path.exists(path):
        with open(path, encoding='utf-8') as previous_file:
            previous = json.load(previous_file)
        old_receipts = previous.get('_operation_receipts', {}) if isinstance(previous, dict) else {}
        if old_receipts:
            data = dict(data)
            merged = {**old_receipts, **data.get('_operation_receipts', {})}
            data['_operation_receipts'] = {k:v for k,v in merged.items()
                                           if v.get('expires_at', time.time()+1) >= time.time()}

    tmp = "%s.%d.%s.tmp" % (path, os.getpid(), uuid.uuid4().hex[:6])
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError as _fserr:
                # ★ 2026-11-08 修：原来这里是 except Exception: pass。
                #
                #   为什么不能静默：
                #     fsync 失败 = 数据还停在 OS 缓存里，没真正落盘。
                #     而代码接下来会 os.replace 并返回成功 ——
                #     断电/崩溃时这个文件就退回旧内容（或者 half-written），
                #     但调用方以为写成了。这是「写了但没落盘」这类假绿。
                #
                #   为什么不 raise：
                #     有些文件系统本来就不支持 fsync（某些网络盘/FUSE），
                #     raise 会让整条写盘失败 —— 而 memory_manager 的 recall
                #     写回是「强化记忆」用的，失败一次就会丢一批续命。
                #     两害相权：记下来，继续写。
                #
                #   ⚠️ 跟 window_ledger.py._atomic_write_text 的处理保持一字不差，
                #      否则两处「一个记账一个不记」，会让人误以为都安全。
                try:
                    import sys as _sys
                    print("[atomic_io] fsync 失败（数据可能未落盘）: %s"
                          % _fserr, file=_sys.stderr)
                except Exception:
                    pass
        last_err = None
        for attempt in range(_RETRY_TIMES):
            try:
                os.replace(tmp, path)
                return
            except OSError as e:
                last_err = e
                if getattr(e, "winerror", None) not in _RETRYABLE \
                        and e.errno not in _RETRYABLE:
                    raise                    # 不是「忙」，重试没用
                time.sleep(min(_RETRY_CAP, 0.05 * (attempt + 1)))
        raise last_err if last_err else RuntimeError("os.replace failed")
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def selftest() -> None:
    """自检：不依赖真实数据，不碰生产文件，5 秒内跑完。"""
    import tempfile
    import shutil

    d = tempfile.mkdtemp(prefix="atomic_io_selftest_")
    try:
        p = os.path.join(d, "t.json")

        # ① 正常写
        atomic_write_json(p, {"a": 1})
        assert json.load(open(p, encoding="utf-8")) == {"a": 1}

        # ② 覆盖写
        atomic_write_json(p, {"b": 2})
        assert json.load(open(p, encoding="utf-8")) == {"b": 2}

        # ③ 不可序列化 → 抛异常 + 不留 tmp + 旧文件完好
        class Bad:
            pass

        try:
            atomic_write_json(p, {"x": Bad()})
            raise AssertionError("应该抛 TypeError")
        except TypeError:
            pass
        assert json.load(open(p, encoding="utf-8")) == {"b": 2}, "旧文件被破坏"
        assert not [f for f in os.listdir(d) if f.endswith(".tmp")], "留下了 tmp"

        # ④ tmp 与目标同目录（不跨盘）
        #    直接看实现用的路径构造：写一个到子目录，确认 tmp 也在子目录
        sub = os.path.join(d, "sub")
        os.makedirs(sub)
        p2 = os.path.join(sub, "u.json")
        atomic_write_json(p2, {"c": 3})
        assert json.load(open(p2, encoding="utf-8")) == {"c": 3}
        assert not [f for f in os.listdir(os.path.dirname(os.path.abspath(p2)))
                    if f.endswith(".tmp")]

        # ⑤ replace 全失败 → 抛异常 + 不留 tmp + 旧文件完好
        orig = os.replace
        os.replace = lambda *a, **k: (_ for _ in ()).throw(PermissionError(32, "busy"))
        try:
            atomic_write_json(p, {"d": 4})
            raise AssertionError("应该抛 PermissionError")
        except PermissionError:
            pass
        finally:
            os.replace = orig
        assert json.load(open(p, encoding="utf-8")) == {"b": 2}, "旧文件被破坏"
        assert not [f for f in os.listdir(d) if f.endswith(".tmp")], "留下了 tmp"

        # ⑥ 非「忙」类错误立刻抛，不拖 3.3s
        t0 = time.time()
        try:
            atomic_write_json(os.path.join(d, "nope", "x.json"), {"e": 5})
            raise AssertionError("应该抛 FileNotFoundError")
        except FileNotFoundError:
            pass
        dt = time.time() - t0
        assert dt < 1.0, "不可重试错误拖了 %.1fs" % dt

        # ⑦ sweep：陈旧清掉、新鲜保留
        p3 = os.path.join(d, "v.json")
        atomic_write_json(p3, {"f": 6})
        old = os.path.join(d, "v.json.9999.dead.tmp")
        fresh = os.path.join(d, "v.json.8888.alive.tmp")
        for f_ in (old, fresh):
            open(f_, "w").write("x")
        os.utime(old, (time.time() - 7200, time.time() - 7200))
        removed = sweep_stale_tmp(p3)
        assert removed == 1, "应该只清掉 1 个陈旧的，实际 %d" % removed
        assert os.path.exists(fresh), "新鲜 tmp 被误删"
        os.remove(fresh)

        # ⑧ sweep=True 参数确实会触发清扫
        old2 = os.path.join(d, "v.json.7777.dead2.tmp")
        open(old2, "w").write("x")
        os.utime(old2, (time.time() - 7200, time.time() - 7200))
        atomic_write_json(p3, {"g": 7}, sweep=True)
        assert not os.path.exists(old2), "sweep=True 没清掉陈旧 tmp"

        # ⑨ 默认 sweep=False 不清扫（其余三处靠这个保持原行为）
        old3 = os.path.join(d, "v.json.6666.dead3.tmp")
        open(old3, "w").write("x")
        os.utime(old3, (time.time() - 7200, time.time() - 7200))
        atomic_write_json(p3, {"h": 8})
        assert os.path.exists(old3), "sweep=False 却清了 tmp"
        os.remove(old3)

        print("atomic_io.py selftest OK")
        print("  重试 %d 次 / 单次封顶 %.1fs（合计约 %.1fs）"
              % (_RETRY_TIMES, _RETRY_CAP, 0.05 * sum(min(_RETRY_CAP, 0.05 * (i + 1)) / 0.05
                                                      for i in range(_RETRY_TIMES))))
        print("  可重试错误: %s" % sorted(_RETRYABLE))
        print("  sweep 默认年龄: %.0f 秒" % _STALE_AGE)
    finally:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    selftest()
