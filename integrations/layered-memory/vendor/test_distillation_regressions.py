"""Offline regression checks for distillation approval, scope, and checkpoints."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch


def isolated(script, *, cli=None, payload=None):
    with tempfile.TemporaryDirectory() as folder:
        env = dict(os.environ, PYTHONUTF8="1", MEMORY_DATA_DIR=folder)
        env["DSH_MEMORY_DATA_DIR"] = folder  # privacy-scan: allow
        return subprocess.run(
            [sys.executable, "-B", *(cli or ["-c", script])],
            input=json.dumps(payload) if payload is not None else None,
            capture_output=True, encoding="utf-8", env=env, timeout=45,
        )


class DistillationRegressionTests(unittest.TestCase):
    def assert_isolated(self, script):
        result = isolated(script)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_approved_versions_stay_immutable_and_terminal(self):
        self.assert_isolated("""
import json
import time
from unittest.mock import patch
from pathlib import Path
import distillation as d
import config
from schema import MemoryItem

vector = [1.0, 0.0]
now = time.time()
source = MemoryItem("每周三开会，先写好纪要", mem_type="long_term")
path = Path(config.LONG_TERM_ACTIVE_PATH)
path.write_text(json.dumps({"memories": [source.to_dict()]}), encoding="utf-8")
def provider(body):
    def generate(prompt):
        return [{"content": body, "out_kind": "偏好", "out_turns": [source.mem_id],
                 "quotes": {source.mem_id: source.content}}]
    return generate

with patch("ollama_embedding.get_embedding", return_value=vector):
    first = d.generate("main", llm=provider("偏好周三会前整理纪要"), model="old")["cards"][0]
    assert d.review("main", first["id"], reviewer="owner", approved=True) == "active"
    new = dict(first, id="duplicate draft", content="另一个很相似的结论", status="provisional",
               user_confirmed=False, embedding=vector)
    approved = d.active_cards("main")[0]
    history = [approved]
    assert d.upsert_card(history, new, embed=lambda _: vector)["action"] == "created"
    assert approved["id"] == first["id"] and approved["content"] == first["content"]
    assert approved["status"] == "active" and new["status"] == "provisional"

    second = d.generate("main", llm=provider("后来改为先确认议题"), model="new")["cards"][0]
    assert d.review("main", second["id"], reviewer="owner", approved=True, supersedes=first["id"]) == "active"
    d.generate("main", llm=lambda _: [], model="third")
    d.maintain("main")
    cards = {card["id"]: card for card in d._load(d._path("main"))["cards"]}
    assert cards[first["id"]]["status"] == "superseded"
    assert cards[second["id"]]["status"] == "stale"
    assert d.review("main", second["id"], reviewer="owner", approved=True) == "active"
    d.maintain("main")
    assert [card["id"] for card in d.active_cards("main")] == [second["id"]]
    try:
        d.review("main", first["id"], reviewer="owner", approved=True)
    except ValueError as exc:
        assert "terminal" in str(exc)
    else:
        raise AssertionError("superseded card was revived")

    legacy = dict(cards[second["id"]], status="active", content="历史覆写的结论",
                  user_confirmed=True, review={"at": now - 10}, updated_at=now,
                  revisions=[{"at": now, "content": "审核时的正文"}])
    file = Path(d._path("main"))
    data = d._load(file)
    data["cards"] = [legacy]
    file.write_text(json.dumps(data), encoding="utf-8")
    assert d.active_cards("main") == []
    d.maintain("main")
    assert d.active_cards("main") == []
    assert d._load(file)["cards"][0]["revisions"] == legacy["revisions"]
""")

    def test_tool_privacy_session_scope_and_cold_sources(self):
        self.assert_isolated("""
import json
from pathlib import Path
from unittest.mock import patch
import config
import distillation as d
from schema import MemoryItem

def write(path, *records):
    Path(path).write_text(json.dumps({"memories": records}), encoding="utf-8")

owner = "private:study"
source = MemoryItem("保存会议资料时只处理 PDF 文件", session_id=owner,
                    mem_type="long_term").to_dict()
tool = MemoryItem("隐私证据标记", session_id=owner, source="tool_result").to_dict()
# Use schema markers appropriate to the containing version; no real user content.
tool.update(is_private=True, tool_result={"status": "succeeded"})
write(config.LONG_TERM_ACTIVE_PATH, source)
write(config.SHORT_TERM_PATH, tool)
assert tool["mem_id"] not in d.gather("main")
capture = []
def provider(prompt):
    capture.append(prompt)
    return [{"content": "PDF 资料整理", "out_kind": "skill",
             "trigger": "收到 .pdf 文件", "trigger_kind": "file",
             "action": "整理会议资料", "steps": ["打开文件", "提取议题"],
             "required_tools": [], "out_turns": [source["mem_id"]],
             "quotes": {source["mem_id"]: source["content"]}}]

with patch("ollama_embedding.get_embedding", return_value=[1.0, 0.0]):
    card = d.generate("main", llm=provider, model="test")["cards"][0]
assert "隐私证据标记" not in capture[0]
assert d.review("main", card["id"], reviewer="owner", approved=True) == "active"
def match(session, names):
    return d.match_skills("main", session_id=session, has_file=True, file_names=names)
assert match(owner, ["doc.pdf"])
assert not match("private:other", ["doc.pdf"])
assert not match("group:study", ["doc.pdf"])
assert not match("", ["doc.pdf"])
assert not match(owner, ["folder.pdf/doc.docx"])
assert not match(owner, [])
source["archived_at"] = 1000
write(config.LONG_TERM_ACTIVE_PATH)
write(config.LONG_TERM_COLD_PATH, source)
assert match(owner, ["doc.PDF"])
""")

    def test_valid_empty_batch_is_checkpointed(self):
        self.assert_isolated("""
import json
from pathlib import Path
from unittest.mock import Mock
import config
import distillation
from schema import MemoryItem
source = MemoryItem("上周聊过备份").to_dict()
Path(config.LONG_TERM_ACTIVE_PATH).write_text(json.dumps({"memories": [source]}), encoding="utf-8")
llm = Mock(return_value=[])
first = distillation.generate("main", llm=llm, model="test")
second = distillation.generate("main", llm=llm, model="test")
assert first["batches_completed_this_call"] == 1 and first["cards"] == []
assert second["state"] == "unchanged"
assert llm.call_count == 1
""")


    def test_course_windows_still_filter_at_start_and_end(self):
        self.assert_isolated("""
import json
from pathlib import Path
import time
import config
from memory_manager import MemoryManager
from services.memory_tools import mcp_add
from services.recall_service import recall_core, render_for_prompt

session = "private:course-test"
embedding = lambda _: [1.0, 0.0]
manager = MemoryManager(embedding_func=embedding)
start = time.time() + 600
windows = [
    ("测试课表：第一周周一上理论课", start, start + 3600),
    ("测试课表：第二周周一上实验课", start + 3600, start + 7200),
]
for content, before, after in windows:
    receipt = mcp_add(manager, {"session_id": session, "content": content,
                                "effective_from": before, "effective_to": after,
                                "is_manual": True})
    assert receipt["written"] and receipt["pool"] == "active"
def recalled(at):
    core = recall_core(manager, "周一课表", session_id=session, as_of=at, embedding_func=embedding)
    return render_for_prompt(core, budget=1100)["text"]

assert "理论课" not in recalled(start - 1)
assert "理论课" in recalled(start) and "实验课" not in recalled(start)
assert "理论课" not in recalled(start + 3600) and "实验课" in recalled(start + 3600)
assert "实验课" not in recalled(start + 7200)
""")

    def test_review_requires_boolean_and_failure_exits_nonzero(self):
        result = isolated("", cli=["memory_cli.py", "distill"],
                          payload={"sub": "review", "card_id": "synthetic",
                                   "reviewer": "owner", "approved": "false"})
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        reply = json.loads(result.stdout)
        self.assertFalse(reply["ok"])
        self.assertIn("approved must be a JSON boolean", reply["error"])

    def test_invalid_model_output_error_omits_model_text(self):
        from services.distillation_provider import _http_provider

        response = Mock(status_code=200)
        response.iter_content.return_value = [json.dumps({"choices": [{
            "finish_reason": "stop", "message": {"content": "synthetic-secret-marker"}
        }]}).encode()]
        with patch.dict(os.environ, {"DSH_DISTILLATION_BASE_URL": "http://localhost:1",
                                    "DSH_DISTILLATION_MODEL": "synthetic",
                                    "DSH_DISTILLATION_API_KEY": "unused"}), patch("requests.Session") as session:
            session.return_value.__enter__.return_value.post.return_value = response
            with self.assertRaises(ValueError) as error:
                _http_provider()["call"]("synthetic evidence")
        self.assertIn("not valid JSON", str(error.exception))
        self.assertNotIn("synthetic-secret-marker", str(error.exception))


if __name__ == "__main__":
    unittest.main()