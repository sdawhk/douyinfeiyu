from contextlib import closing
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class MemoryToolsTests(unittest.TestCase):
    def test_mcp_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            env = {**os.environ, "MEMORY_DATA_DIR": folder, "DSH_MEMORY_DATA_DIR": folder,  # privacy-scan: allow
                   "PYTHONUTF8": "1"}
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--worker"],
                                    cwd=Path(__file__).resolve().parent, env=env, capture_output=True, text=True,
                                    encoding="utf-8", timeout=45)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_cli_rejects_invalid_json(self):
        with tempfile.TemporaryDirectory() as folder:
            for payload in ("{", "[]", "null", '{"query": NaN}'):
                with self.subTest(payload=payload):
                    result = self.run_entrypoint(folder, "memory_cli.py", payload, "recall")
                    self.assertEqual(result.returncode, 2)
                    self.assertIs(json.loads(result.stdout)["ok"], False)
            empty = self.run_entrypoint(folder, "memory_cli.py", "", "recall")
            self.assertEqual(empty.returncode, 0)
            self.assertIs(json.loads(empty.stdout)["ok"], True)

    def test_entrypoints_keep_handover_diagnostics_out_of_json(self):
        with tempfile.TemporaryDirectory() as folder:
            handover = Path(folder) / "state" / "handover.json"
            handover.parent.mkdir()
            handover.write_text(json.dumps({"version": 1, "sessions": {
                "session:a": {"topic": "Prepare the sample catalog", "written_at": int(time.time()), "seq": 1},
                "session:b": {"topic": "Review the sample labels", "written_at": int(time.time()), "seq": 2},
            }}), encoding="utf-8")
            cli_args = {"profile_mode": "companion"}
            request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                "name": "memory_init_session", "arguments": cli_args,
            }}
            for store in ("multiple handovers", "malformed handover"):
                with self.subTest(store=store):
                    if store == "malformed handover":
                        handover.write_text("{bad json", encoding="utf-8")
                    cli = self.run_entrypoint(folder, "memory_cli.py", json.dumps(cli_args), "init")
                    self.assertEqual(cli.returncode, 0, cli.stderr)
                    self.assertIn("[handover]", cli.stderr)
                    self.assertIs(json.loads(cli.stdout)["ok"], True)
                    mcp = self.run_entrypoint(folder, "mcp_server.py", json.dumps(request) + "\n")
                    self.assertEqual(mcp.returncode, 0, mcp.stderr)
                    self.assertIn("[handover]", mcp.stderr)
                    reply = json.loads(mcp.stdout)
                    self.assertEqual(reply["id"], 1)
                    self.assertIn("result", reply)

    def run_entrypoint(self, folder, script, data, *args):
        env = dict(os.environ, MEMORY_DATA_DIR=folder, PYTHONUTF8="1",
                   MAINTENANCE_RUN_HOUR_START="24")
        return subprocess.run([sys.executable, "-B", script, *args],
                              cwd=Path(__file__).resolve().parent, env=env,
                              input=data, capture_output=True, encoding="utf-8", timeout=45)

    def test_vector_cache_exact_and_invalidation(self):
        from services.vector_cache import load_pool
        with tempfile.TemporaryDirectory() as folder, patch("services.vector_cache._CACHE_MIN_BYTES", 0):
            p = Path(folder) / "sample_pool.json"
            first = {"memories": [{"mem_id": "a", "embedding": [0.12345678912345, 0.1]},
                                  {"mem_id": "b", "embedding": None}], "receipt": True}
            p.write_text(json.dumps(first), encoding="utf-8")
            self.assertEqual(load_pool(p), first)
            self.assertTrue((p.parent / "embeddings.sqlite").is_file())
            self.assertEqual(load_pool(p), first)
            replacement = p.with_suffix(".tmp")
            updated = {"memories": [{"mem_id": "a", "embedding": [0.5], "content": "updated"}]}
            replacement.write_text(json.dumps(updated), encoding="utf-8")
            replacement.replace(p)
            self.assertEqual(load_pool(p), updated)
            self.assertEqual(load_pool(p), updated)
            (p.parent / "embeddings.sqlite").write_bytes(b"broken cache")
            self.assertEqual(load_pool(p), updated)

    def test_vector_cache_discards_removed_or_small_pool(self):
        from services.vector_cache import load_pool
        with tempfile.TemporaryDirectory() as folder, patch("services.vector_cache._CACHE_MIN_BYTES", 512):
            root = Path(folder)
            large = {"memories": [{"mem_id": "old", "content": "old-body" * 100, "embedding": [1.0]}]}
            short = {"memories": []}
            for name, shrink in (("small.json", True), ("missing.json", False)):
                pool = root / name
                pool.write_text(json.dumps(large), encoding="utf-8")
                self.assertEqual(load_pool(pool), large)
                if shrink:
                    pool.write_text(json.dumps(short), encoding="utf-8")
                    self.assertEqual(load_pool(pool), short)
                else:
                    pool.unlink()
                    with self.assertRaises(FileNotFoundError):
                        load_pool(pool)
                with closing(sqlite3.connect(root / "embeddings.sqlite")) as conn:
                    self.assertIsNone(conn.execute("SELECT name FROM pool_snapshot_v1 WHERE name=?",
                                                   (name,)).fetchone())


def check_tools():
    import mcp_server as api
    from atomic_io import atomic_write_json
    from schema import MemoryItem
    from services.memory_tools import limit_text

    import config
    import session_init
    from handover import write_handover

    import artifact_ledger
    from window_ledger import append_turn
    from services.window_fallback import search_window

    assert Path(artifact_ledger.LEDGER_PATH).is_relative_to(config.BASE_DIR)
    from concurrent.futures import ThreadPoolExecutor
    def record_artifact(_):
        return artifact_ledger.record(operation_id="catalog", tool="report", artifact="catalog.txt")
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(record_artifact, range(8))) == 1
    with patch.object(artifact_ledger, "MAX_LINES", 1):
        assert artifact_ledger.record(operation_id="next", tool="report", artifact="next.txt")
        assert artifact_ledger.latest()[0]["operation_id"] == "next"
        assert json.loads(Path(artifact_ledger.ROTATE_PATH).read_text("utf-8"))["operation_id"] == "catalog"
    append_turn("group:catalog", "展品编号写在标签上", "已核对展品编号")
    found = search_window("展品编号", session_id="group:catalog")
    assert found["items"], found

    write_handover("group:demo", "准备展品清单", "", "", [])
    compact = session_init.build_session_init_context("group:demo", profile_mode="compact")
    assert "准备展品清单" in compact["context"]
    with patch.object(session_init, "_read_file", return_value="展品记录" * 5000):
        full = session_init.build_session_init_context(None, profile_mode="companion")["context"]
    assert all(label in full for label in ("【人格卡】", "【记忆库】", "【情绪基线】", "【记忆线索】"))
    assert len(full.encode("utf-8")) <= config.INIT_MAX_TOKEN

    assert len(limit_text("a" * 3999)) == 3999
    assert "已截断" in limit_text("a" * 6000) and len(limit_text("a" * 6000)) <= 4096
    vector = lambda _: [1.0, 0.0]
    api.get_embedding = api.manager.embedding_func = vector
    session, other = "group:integration", "group:other"
    now = time.time()
    names = {entry["name"] for entry in api.handle_request({"id": 1, "method": "tools/list"})["result"]["tools"]}
    assert {"memory_correct", "memory_recall_cold"} <= names

    def call(name, **arguments):
        response = api.handle_request({"id": 2, "method": "tools/call",
                                       "params": {"name": name, "arguments": arguments}})
        body = response["result"]
        text = body["content"][0]["text"]
        try:
            value = json.loads(text)
        except ValueError:
            value = text
        return body.get("isError", False), value

    assert call("memory_add", session_id=session, content="")[0]
    added = call("memory_add", session_id=session, content="默认端口为 9090", is_manual=True, operation_id="first")
    assert not added[0] and added[1]["pool"] == "active", added
    assert call("memory_add", session_id=session, content="默认端口为 9090", is_manual=True,
                operation_id="first")[1]["mem_id"] == added[1]["mem_id"]
    assert call("memory_add", session_id=session, content="默认端口为 9090", is_manual=True,
                operation_id="first", effective_from=now)[0]
    assert call("memory_add", session_id=session, content="默认端口为 9090", operation_id="first")[0]
    assert "9090" in call("memory_recall", session_id=session, query="默认端口是多少")[1]
    assert "9090" not in call("memory_recall", session_id=other, query="默认端口是多少")[1]
    assert "9090" not in call("memory_recall", session_id="private:owner", query="默认端口是多少")[1]
    assert "9090" in call("memory_recall", session_id=session, query="默认端口是多少", as_of="")[1]
    err, invalid = call("memory_recall", session_id=session, query="默认端口是多少", as_of="invalid")
    assert err and invalid.startswith("as_of"), invalid

    import distillation
    mock_model = Mock(return_value=[])
    assert distillation.generate("main", llm=mock_model, model="test")["state"] == "empty"
    mock_model.assert_not_called()
    args = {"mem_id": added[1]["mem_id"], "content": "默认端口为 8181", "reason": "端口调整", "operation_id": "correction"}
    assert call("memory_correct", session_id=other, **args)[0]
    corrected = call("memory_correct", session_id=session, **args)
    assert not corrected[0] and corrected[1]["written"], corrected
    assert call("memory_correct", session_id=session, **args)[1]["mem_id"] == corrected[1]["mem_id"]
    found = call("memory_recall", session_id=session, query="默认端口是多少")[1]
    assert "8181" in found and "9090" not in found, found

    current_id = corrected[1]["mem_id"]
    active_path = Path(api.manager._pool_path("active"))
    active_doc = json.loads(active_path.read_text(encoding="utf-8"))
    current = next(row for row in active_doc["memories"] if row["mem_id"] == current_id)
    malformed = MemoryItem("默认端口为 3333", mem_type="long_term", session_id=session)
    malformed.embedding = vector(None)
    malformed.effective_from = "invalid"
    active_doc["memories"].append(malformed.to_dict())
    atomic_write_json(str(active_path), active_doc)
    archive_path = Path(api.manager._pool_path("cold"))
    atomic_write_json(str(archive_path), {"memories": [dict(current, content="默认端口为 5555")]})
    with patch.object(api.manager, "_load_active_mems", wraps=api.manager._load_active_mems) as load_active:
        for _ in range(2):
            err, found = call("memory_recall", session_id=session, query="默认端口是多少")
            assert not err and "8181" in found and "3333" not in found and "5555" not in found, found
        assert load_active.call_count == 1, load_active.call_count
    receipt = json.loads(found.splitlines()[-1])
    assert receipt["confirmable_ids"].count(current_id) == 1, receipt
    err, confirmation = call("memory_confirm_used", session_id=session, mem_ids=[current_id],
                             request_id=receipt["request_id"])
    assert not err and confirmation["confirmed"] == 1, confirmation

    working = call("memory_add", session_id=session, content="排查备份窗口改在周三", operation_id="working")
    assert not working[0] and working[1]["pool"] == "working", working
    assert "排查备份窗口改在周三" in call("memory_recall", session_id=session, query="备份窗口是哪天")[1]
    assert "排查备份窗口改在周三" not in call("memory_recall", session_id=other, query="备份窗口是哪天")[1]
    api.get_embedding = api.manager.embedding_func = lambda _: [0.0, 0.0]
    assert not call("memory_add", session_id=session, content="默认最大行数为 700", is_manual=True)[0]
    assert "默认最大行数为 700" in call("memory_recall", session_id=session, query="默认最大行数是多少")[1]
    api.get_embedding = api.manager.embedding_func = vector

    from decay_logic import should_archive, should_drop
    scheduled = MemoryItem("预计明年维护服务", mem_type="long_term", session_id=session, strength=1)
    scheduled.effective_from = now + 86400 * 365
    scheduled.last_active = scheduled.create_time = now - 86400 * 400
    assert not should_archive(scheduled, now) and not should_drop(scheduled)

    archived = MemoryItem("历史备份清单在蓝柜子", mem_type="long_term", session_id=session)
    archived.embedding = vector(None)
    atomic_write_json(str(archive_path), {"memories": [archived.to_dict()]})
    old = archive_path.read_bytes()
    assert "历史备份清单" not in call("memory_recall", session_id=session, query="历史备份清单")[1]
    checked = call("memory_recall_cold", session_id=session, query="历史备份清单")
    assert checked[1]["items"][0]["mem_id"] == archived.mem_id and archive_path.read_bytes() == old
    assert call("memory_recall_cold", session_id=other, query="历史备份清单", awake=True)[1]["items"] == []
    awake = call("memory_recall_cold", session_id=session, query="历史备份清单", awake=True)
    assert awake[1]["items"][0]["pool"] == "active", awake
    assert not json.loads(archive_path.read_text(encoding="utf-8"))["memories"]

    import session_init
    with patch.object(session_init, "_read_file", return_value="规则内容" * 4000):
        for profile, budget in (("compact", 1500), ("companion", 8000)):
            err, context = call("memory_init_session", session_id=session, profile_mode=profile)
            assert not err and len(context.encode("utf-8")) <= budget, (profile, len(context))
            assert ("<!--MEM_START-->" in context) == context.endswith("<!--MEM_END-->"), profile

    short_path = api.manager._pool_path("shortterm")
    retired = MemoryItem("临时记录甲", mem_type="short_term", session_id=session, source_message_id="message-a")
    copied = MemoryItem("临时记录甲的副本", mem_type="short_term", session_id=session, source_message_id="message-a")
    retained = MemoryItem("临时记录乙", mem_type="short_term", session_id=session)
    atomic_write_json(short_path, {"memories": [row.to_dict() for row in (retired, copied, retained)]})

    def cli(action, **arguments):
        run = subprocess.run([sys.executable, "-B", "memory_cli.py", action],
                             input=json.dumps(arguments), capture_output=True, text=True,
                             encoding="utf-8", timeout=12)
        return run.returncode, json.loads(run.stdout)

    assert cli("shortterm", sub="detail", mem_id=retired.mem_id)[1]["ok"]
    rc, retirement = cli("retire", ids=[retired.mem_id], operation_id="test-retire")
    assert rc == 0 and retirement["written"], retirement
    listing = cli("shortterm", sub="list")[1]
    assert {item["mem_id"] for item in listing["items"]} == {retained.mem_id}, listing
    for row in (retired, copied):
        assert not cli("shortterm", sub="detail", mem_id=row.mem_id)[1]["ok"]
    for action in ("audit", "recovery"):
        rc, report = cli(action)
        assert rc == 0 and report["ok"], report
    rc, invalid = cli("retire", ids=[retired.mem_id])
    assert rc != 0 and not invalid["ok"], invalid

    # Non-manual CLI add keeps stdout strictly JSON even if maintenance triggers, and writes working memory.
    rc, added = cli("add", sessionId=session, content="普通工作记忆测试")
    assert rc == 0 and added["ok"] and added.get("written") is True, added

    # Missing associate_engine fails cleanly with JSON rather than a traceback.
    rc, assoc = cli("associate", sessionId=session, query="还记得上次吗")
    assert rc == 0 and not assoc["ok"] and assoc.get("removed") is True, assoc

    # Private working memory retains is_private and never leaks into recall.
    priv_out = api.manager.add_working_memory(session, "私密备注内容示例", is_private=True)
    assert priv_out and priv_out.get("written") is True, priv_out
    assert "私密备注内容示例" not in call("memory_recall", session_id=session, query="私密备注内容示例")[1]

    # Private handover verifies cleanly on disk without being returned by read_handover.
    import handover
    handover.write_handover("private:public_demo", "普通话题", "", "", [])
    priv_ho = handover.write_handover("private:secret_demo", "私密话题", "", "", [], is_private=True)
    assert priv_ho.get("_verify") == "ok", priv_ho
    assert (handover.read_handover("private:secret_demo") or {}).get("topic") != "私密话题"

    # Observation report reads configured MEMORY_DATA_DIR pools.
    import observation_report
    assert observation_report.memory_stats()["active"] >= 1

    # Contradictory long memories must not be grouped as merge duplicates.
    import memory_health
    contra = [
        {"mem_id": "c1", "content": "我真的非常非常喜欢吃重庆麻辣火锅和烤肉"},
        {"mem_id": "c2", "content": "我真的非常非常不喜欢吃重庆麻辣火锅和烤肉"},
    ]
    assert memory_health.find_merge_groups(contra) == []

    # MCP missing query & null params return clean tool error / valid response.
    err_missing, _ = call("memory_recall")
    assert err_missing is True
    assert api.handle_request({"jsonrpc": "2.0", "id": 99, "method": "tools/list", "params": None}).get("result")

    # Reminder delegations classify as high-priority commitment, while negations/questions do not.
    from schema import classify_importance
    assert classify_importance("下周提醒我交报告")[0] == "commitment"
    assert classify_importance("明天提醒我吃药")[0] == "commitment"
    assert classify_importance("不用提醒我交报告")[0] != "commitment"
    assert classify_importance("你会不会提醒我交报告")[0] != "commitment"


if __name__ == "__main__":
    if sys.argv[-1:] == ["--worker"]:
        check_tools()
    else:
        unittest.main()
