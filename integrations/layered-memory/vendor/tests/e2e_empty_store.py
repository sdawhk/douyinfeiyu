"""Empty-store end-to-end: a fresh checkout must work with no data at all.

Points MEMORY_DATA_DIR at a temp directory and verifies the contract that
matters for a new deployment. Each check is independent: one failure does not
stop the rest, so a run reports the whole picture.

    python tests/e2e_empty_store.py [-v]

Exit code 0 means every check passed.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv
results = []


def check(name, fn):
    try:
        detail = fn()
        results.append((name, True, detail or ""))
    except Exception as exc:  # noqa: BLE001 - the point is to report every failure
        results.append((name, False, "%s: %s" % (type(exc).__name__, str(exc)[:200])))


def run_cli(env, action, payload, timeout=120):
    """Call memory_cli.py: action is argv[1], payload is JSON on stdin."""
    proc = subprocess.run(
        [sys.executable, "memory_cli.py", action],
        cwd=REPO, env=env, input=json.dumps(payload),
        capture_output=True, text=True, encoding="utf-8", timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError("cli %s exit %d: %s"
                           % (action, proc.returncode, _tail(proc.stderr, 400)))
    lines = [l for l in (proc.stdout or "").splitlines() if l.strip().startswith("{")]
    if not lines:
        raise RuntimeError("cli %s produced no JSON: %s"
                           % (action, _tail(proc.stdout, 300)))
    return json.loads(lines[-1])


def _tail(text, n):
    return "\n".join((text or "").splitlines()[-n:])


def _run_script(env, script, args=(), timeout=300):
    proc = subprocess.run([sys.executable, script, *args], cwd=REPO, env=env,
                          capture_output=True, text=True, encoding="utf-8",
                          timeout=timeout)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main():
    tmp = tempfile.mkdtemp(prefix="mm_e2e_")
    env = dict(os.environ)
    env["MEMORY_DATA_DIR"] = tmp
    env.pop("DSH_MEMORY_DATA_DIR", None)  # privacy-scan: allow
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # Keep the fresh-store checks independent of the host clock.
    env["MAINTENANCE_RUN_HOUR_START"] = "24"

    def t01_boot():
        out = run_cli(env, "recall", {"sessionId": "e2e", "query": "hello"})
        assert out.get("ok") is True, out
        # 空库必须返回空结果，而不是异常或占位内容
        assert out.get("text") == "", out
        return "empty store recalls cleanly"

    def t02_write():
        out = run_cli(env, "shortterm", {"sub": "add", "sessionId": "e2e",
                                         "content": "organising the public release",
                                         "tags": ["work"]})
        assert out.get("ok") is True, out
        path = os.path.join(tmp, "shortterm.json")
        assert os.path.exists(path), "shortterm.json was not created"
        data = json.load(open(path, encoding="utf-8"))
        assert data.get("memories"), "short-term pool is still empty: %s" % out
        return "short-term write (%d items)" % len(data["memories"])

    def t03_recall_hit():
        out = run_cli(env, "recall", {"sessionId": "e2e", "query": "public release"})
        assert out.get("ok") is True, out
        blob = json.dumps(out, ensure_ascii=False)
        assert "organising the public release" in blob, \
            "wrote it but recall cannot see it: %s" % blob[:400]
        return "written item is recallable"

    def t04_pools():
        assert os.path.isfile(os.path.join(tmp, "shortterm.json")), "shortterm.json missing"
        for name in ("active.json", "cold.json"):
            assert not os.path.exists(os.path.join(tmp, name)), name + " created before a pool write"
        return "short-term write leaves the active and cold pools unmaterialized"

    def t05_window():
        out = run_cli(env, "window", {"sub": "append", "sessionId": "e2e",
                                      "his": "ping", "said": "pong"})
        assert out.get("ok") is True, out
        assert out.get("turn") == 1, out
        win = os.path.join(tmp, "window")
        assert os.path.isdir(win), "window directory missing"
        turns = [os.path.join(r, f) for r, _, fs in os.walk(win)
                 for f in fs if f == "turns.jsonl"]
        assert turns, "turns.jsonl not written"
        rel = os.path.relpath(turns[0], tmp)
        assert "data" not in rel.split(os.sep), "path gained an extra data/ layer: " + rel
        row = json.loads(open(turns[0], encoding="utf-8").readline())
        assert row["his"] == "ping" and row["said"] == "pong", row
        return "ledger written, path not doubled"

    def t06_handover():
        out = run_cli(env, "handover", {"sub": "read", "sessionId": "e2e"})
        assert out.get("ok") is True, out
        return "handover reads cleanly with nothing to read"

    def t07_consolidate():
        code, out = _run_script(env, "daily_consolidation.py", ["--dry-run"])
        assert code == 0, _tail(out, 600)
        assert "Traceback" not in out, _tail(out, 600)
        return "consolidation previews without writing"

    def t08_patrol():
        code, out = _run_script(env, "nightly_patrol.py")
        assert code == 0, _tail(out, 600)
        assert "selftest OK" in out, _tail(out, 400)
        return "nightly patrol reports normal on an empty store"

    def t09_privacy():
        code, out = _run_script(env, "tools/privacy_scan.py", ["--strict"])
        assert code == 0, _tail(out, 600)
        assert "硬门禁 0" in out or "0 hit" in out or "0 命中" in out, _tail(out, 400)
        return "privacy gate passes"

    def t10_import():
        # 逐个模块在**独立子进程**里导入。
        #   为什么不能在一个进程里 for 一圈：好几个模块在 import 期就
        #   reconfigure / 包装 sys.stdout（中文 Windows 的 GBK 崩溃防护），
        #   连续导入会把 stdout 关掉，后面所有导入都报
        #   「I/O operation on closed file」—— 那是测试写法的问题，不是代码的问题。
        mods = []
        for dirpath, dirnames, filenames in os.walk(REPO):
            dirnames[:] = [d for d in dirnames
                           if d not in {"__pycache__", "data", "state", ".git"}]
            for f in filenames:
                if not f.endswith(".py") or f.startswith("__"):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, f), REPO)
                mods.append(rel[:-3].replace(os.sep, "."))
        mods.sort()

        failed = []
        for mod in mods:
            proc = subprocess.run([sys.executable, "-c", "import " + mod],
                                  cwd=REPO, env=env, capture_output=True,
                                  text=True, encoding="utf-8", timeout=120)
            if proc.returncode != 0:
                failed.append((mod, (proc.stderr or "").strip().splitlines()[-1:]))
        assert not failed, "import failed: %s" % failed[:5]
        return "%d modules import cleanly" % len(mods)

    try:
        check("01 empty store boots and recalls", t01_boot)
        check("02 short-term write", t02_write)
        check("03 written item is recallable", t03_recall_hit)
        check("04 on-demand pool creation", t04_pools)
        check("05 window ledger", t05_window)
        check("06 handover", t06_handover)
        check("07 consolidation preview", t07_consolidate)
        check("08 nightly patrol", t08_patrol)
        check("09 privacy gate", t09_privacy)
        check("10 all modules import", t10_import)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("=" * 64)
    for name, passed, detail in results:
        print("%s %s%s" % ("PASS" if passed else "FAIL", name,
                           ("  — " + detail) if (detail and (VERBOSE or not passed)) else ""))
    ok = sum(1 for _, p, _ in results if p)
    print("=" * 64)
    print("%d/%d passed" % (ok, len(results)))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
