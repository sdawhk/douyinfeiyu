"""Run every module self-test plus the cross-module suites.

    python tests/run_all.py [-v]

Each self-test runs in its own process with an isolated data directory, so a
failure cannot leak state into the next one. Exit code 0 means everything passed.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: 有 selftest() 的模块。新增模块时加到这里。
SELFTEST_MODULES = [
    "atomic_io",
    "candidate_pool",
    "common.io",
    "common.locking",
    "decay_logic",
    "distillation",
    "entity_graph",
    "episode",
    "episode_store",
    "features",
    "handover",
    "lessons",
    "maintenance_trigger",
    "memory_health",
    "memory_manager",
    "nightly_patrol",
    "observation_report",
    "pending_longterm",
    "policy",
    "query_route",
    "recall_engine",
    "reflection",
    "services.recall_service",
    "services.window_fallback",
    "session_init",
    "shortterm_detail",
    "slot_check",
    "window_ledger",
    "window_recall",
]

def run(script, args=(), timeout=300):
    """Run one script with an isolated data directory. Returns (ok, output)."""
    tmp = tempfile.mkdtemp(prefix="mm_test_")
    env = dict(os.environ)
    env["MEMORY_DATA_DIR"] = tmp
    env.pop("DSH_MEMORY_DATA_DIR", None)  # privacy-scan: allow
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        proc = subprocess.run(
            [sys.executable, script, *args],
            cwd=REPO, env=env, capture_output=True, text=True,
            encoding="utf-8", timeout=timeout,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode == 0, out
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT after %ds" % timeout
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    verbose = "-v" in argv or "--verbose" in argv
    failures = []
    total = 0

    print("=" * 64)
    print("module self-tests")
    print("=" * 64)
    for mod in SELFTEST_MODULES:
        total += 1
        ok, out = run("-m", (mod,))
        print("  %s  %s" % ("PASS" if ok else "FAIL", mod))
        if not ok:
            failures.append((mod, out))
            if verbose:
                print(_indent(out))

    # 跨模块端到端
    print()
    print("=" * 64)
    print("cross-module")
    print("=" * 64)
    for name, script in (("e2e_empty_store", "tests/e2e_empty_store.py"),
                         ("memory_tools", "test_memory_tools_integration.py"),
                         ("distillation_regressions", "test_distillation_regressions.py"),
                         ("privacy_gate", "tools/privacy_scan.py")):
        total += 1
        ok, out = run(script)
        print("  %s  %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            failures.append((name, out))
            if verbose:
                print(_indent(out))

    print()
    print("=" * 64)
    if failures:
        print("FAILED %d/%d" % (len(failures), total))
        for name, out in failures:
            print()
            print("── %s " % name + "─" * max(0, 56 - len(name)))
            print(_indent(_tail(out, 30)))
        return 1
    print("PASSED %d/%d" % (total, total))
    return 0


def _tail(text, n):
    lines = (text or "").splitlines()
    return "\n".join(lines[-n:])


def _indent(text, prefix="    "):
    return "\n".join(prefix + line for line in (text or "").splitlines())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
