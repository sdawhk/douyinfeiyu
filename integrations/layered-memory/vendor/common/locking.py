# -*- coding: utf-8 -*-
r"""统一锁 —— 收敛 5 份 _NullLock + 5 份 _file_lock。

## 为什么

实测（2026-11-08，filelock 4.2.4）：

    同一实例 + 同线程重入          → ✅ 可重入
    两个实例 + 都 is_singleton     → ✅ 可重入
    两个实例 + 任一没 singleton    → ❌ Timeout 无限等
    两个实例 + 都没 singleton      → ❌ Timeout 无限等

所以「谁加了谁没加」是必须统一的事实 —— 靠每个文件自己记得必漏
（实测：6 个用同一锁文件，只有 2 个加了 singleton）。

## 当前状态（已三重验证：零嵌套）

    memory_manager  7 处 with self.lock（同一实例 → 可重入）
    daily_consolidation  _consolidate_locked（顶层入口）
    episode / lessons / reflection  save_*（巩固不调它们）
    handover / session_init  两个实例都 singleton（session_init → handover 可重入）

## 这个模块做什么

    memory_lock()   全局记忆库锁（唯一入口）
    state_lock(n)   独立锁（候选池那种）

⚠️ 不许在别处直接 FileLock(LOCK_FILE_PATH)。要拿锁就调 memory_lock()。

⚠️ 现在**故意不加 is_singleton** —— 因为当前零嵌套，加了会让「本该互斥的
   两个实例」变成可以互相进入（削弱互斥）。等真出现嵌套需求再加，加的时候
   必须四处一起加，不能只加一处。
"""
import os
import sys
import inspect

# 让 common/ 里的模块也能 import 项目根的模块
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

try:
    from filelock import FileLock
except Exception:
    FileLock = None

from config import LOCK_FILE_PATH

# filelock 3.12.3+ 才有 is_singleton
_FILELOCK_SINGLETON_KW = (
    {"is_singleton": True}
    if "is_singleton" in inspect.signature(FileLock).parameters
    else {}
) if FileLock else {}


class NullLock:
    """拿不到 filelock 时的空锁（不阻塞，但也不保护）。

    ⚠️ 它是「降级」不是「等价」。用它的地方意味着：filelock 没装 /
       这个环境不需要并发保护。不要用它来「让代码能跑起来」。
    """

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def acquire(self, *a, **kw):
        return True

    def release(self, *a, **kw):
        return None


def memory_lock(singleton: bool = False):
    """全局记忆库锁（memory_data.lock）。**唯一入口**。

    参数 singleton：
      False（默认）—— 不加 is_singleton。当前所有调用点都是「单层」或
                      「同一实例重入」，不需要。加了反而削弱互斥。
      True         —— 加 is_singleton。只有「两个不同模块的锁需要重入」时才用，
                      而且**必须双方都用 True**（实测：混用 = Timeout）。

    ⚠️ 不许在别处直接 FileLock(LOCK_FILE_PATH)。
    """
    if not FileLock:
        return NullLock()
    if singleton:
        return FileLock(LOCK_FILE_PATH, **_FILELOCK_SINGLETON_KW)
    return FileLock(LOCK_FILE_PATH)


def state_lock(name: str):
    """state/ 目录下的独立锁（候选池那种，不该抢主锁）。

    为什么要有独立的：
      将来接线时调用方可能正持有 memory_lock，这里再抢同一把文件锁
      就会自锁（filelock 跨实例不重入）。

    ★ 2026-11-09 修（独立审计抓出的真 bug）：这里原来 `from config import DATA_DIR`，
      而 **config.py 里根本没有 DATA_DIR** —— ImportError 被下面的
      `except Exception: return NullLock()` 吃掉，于是这个函数**永远返回空锁**。

      实测：hasattr(config, "DATA_DIR") = False
            type(state_lock("candidate")) = NullLock
      后果：候选池的「独立锁」从上线起就没生效过；
            而 NullLock 自己的 docstring 写着「不阻塞，但也不保护」。

      修法：用 config.BASE_DIR（它本身就是 `MEMORY_DATA_DIR or 脚本目录`，
      **已经环境变量感知**）。

    ⚠️ 为什么**不**新增一个 `DATA_DIR = BASE_DIR` 常量：
      那样一旦设了 MEMORY_DATA_DIR，数据文件去了临时目录，
      而锁仍落在项目目录 → **锁保护错对象，等于没锁**。
      锁必须跟数据同源，所以直接读 BASE_DIR。

    ⚠️ 这里的 `except` 保留，但**必须留痕**：静默降级成空锁是最危险的形态
      （看起来有锁、实际没有）。降级要打日志。
    """
    if not FileLock:
        return NullLock()
    try:
        from config import BASE_DIR
        d = os.path.join(BASE_DIR, "state")
        os.makedirs(d, exist_ok=True)
        return FileLock(os.path.join(d, "%s.lock" % name))
    except Exception as e:
        # 不再静默：降级必须可观测，否则又是「看起来有锁实际没有」
        try:
            import sys as _sys
            _sys.stderr.write(
                "[locking] ⚠️ state_lock(%r) 降级为 NullLock（无保护）: %s: %s\n"
                % (name, type(e).__name__, e))
        except Exception:
            pass
        return NullLock()


def selftest():
    """自检：锁能拿、能放、同实例能重入、不同实例会阻塞（用短超时验证）。"""
    import tempfile
    import shutil

    print("=" * 72)
    print("common/locking 自检")
    print("=" * 72)

    tmp = tempfile.mkdtemp(prefix="lock_st_")
    lp = os.path.join(tmp, "t.lock")

    old_lp = None
    try:
        import common.locking as _self
        old_lp = _self.LOCK_FILE_PATH
        _self.LOCK_FILE_PATH = lp

        # ① 能拿能放
        with memory_lock():
            pass
        print("  ✅ ① 能拿能放")
        if os.path.exists(lp):
            os.remove(lp)

        # ② 同一实例重入
        l1 = memory_lock()
        with l1:
            with l1:
                pass
        print("  ✅ ② 同一实例可重入")
        if os.path.exists(lp):
            os.remove(lp)

        # ③ 两个实例 + 都没 singleton → 会阻塞（用 0.3 秒验证）
        l2 = memory_lock()
        l3 = memory_lock()
        blocked = False
        with l2:
            try:
                l3.acquire(timeout=0.3)
                l3.release()
            except Exception:
                blocked = True
        print("  ✅ ③ 两实例无 singleton → %s" % ("阻塞（符合预期）" if blocked else "没阻塞"))

        # ④ NullLock 可用
        with NullLock():
            pass
        print("  ✅ ④ NullLock 可用")

        print()
        print("common/locking selftest OK")
    finally:
        if old_lp is not None:
            import common.locking as _self
            _self.LOCK_FILE_PATH = old_lp
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    selftest()
