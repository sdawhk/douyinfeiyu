"""大肥鱼共享记忆适配器。串行 JSONL；复用上游数据模型、文件锁、原子写与衰减。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

VENDOR = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(VENDOR))
OUTPUT = sys.stdout
sys.stdout = sys.stderr  # 上游诊断永远不进入 JSONL 协议。
from memory_manager import MemoryManager
from schema import MemoryItem
from atomic_io import atomic_write_json
from decay_logic import peek_strength
from services.qq_policy import visible
import config

DAY = 86400
SENSITIVE = re.compile(r"密码|口令|密钥|验证码|身份证|银行卡|手机号|电话号码|地址|住址|定位|病历|诊断|收入|工资|存款|欠款|转账|access.?token|api.?key|secret|https?://|\d{7,}|[\w.+-]+@[\w.-]+", re.I)
PRIVATE = re.compile(r"保密|秘密|别告诉|不要告诉|不许告诉|不能告诉|只告诉你|别说出去|不公开|仅限私聊")
UNTRUSTED = re.compile(r"假如|假设|如果|开玩笑|骗你的|听说|据说|他说|她说|转发|忽略.{0,8}(规则|指令)|系统提示|system.?prompt|<[/!]?(?:system|assistant|memory)|```", re.I)
FACT = re.compile(r"^(?:其实|对了|顺便说一下|记住[，,：:]?|记一下[，,：:]?)?\s*(我(?:比较|一直|最|很|特别)?(?:喜欢|不喜欢|爱喝|爱吃|不爱吃|讨厌|偏好|习惯|擅长|在学|正在学|养了|养着|有一只|有两只|的爱好是|叫)[^。！？!?\n]{1,100})")
PROFILE = re.compile(r"^我(?:比较|一直|最|很|特别)?(?:喜欢|不喜欢|爱喝|爱吃|不爱吃|讨厌|偏好|习惯|擅长|在学|正在学|养了|养着|有一只|有两只|的爱好是|叫)")


def clean(value, limit=400):
    value = str(value or "").strip()
    if not value or len(value) > limit or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", value):
        raise ValueError("内容为空、过长或含控制字符")
    return value


def digest(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def terms(value):
    text = re.sub(r"[^\w\u4e00-\u9fff]", "", str(value).lower())
    return set(re.findall(r"[a-z0-9]{2,}", text)) | {text[i:i+2] for i in range(len(text)-1)}


class Runtime:
    def __init__(self):
        config.ensure_dirs()
        self.manager = MemoryManager()
        self.control_path = Path(config.STATE_DIR) / "qq-control.json"
        self.control = self._read(self.control_path, {"revision": 0, "blocked": [], "imports": [], "operations": {}})
        self.last_maintenance = 0

    @staticmethod
    def _read(path, default):
        try:
            with open(path, encoding="utf-8") as source:
                return json.load(source)
        except FileNotFoundError:
            return default

    def pools(self):
        return {pool: self._read(self.manager._pool_path(pool), {"memories": []})
                for pool in ("active", "shortterm", "cold")}

    def save_control(self):
        atomic_write_json(str(self.control_path), self.control)

    def context(self, value):
        bot, actor, chat = (str(value.get(k) or "") for k in ("bot", "actor", "chat"))
        if not re.fullmatch(r"\d{5,20}", bot) or not re.fullmatch(r"\d{5,20}", actor):
            raise ValueError("缺少真实 QQ 身份")
        if not re.fullmatch(r"(?:group|private):\d{5,20}", chat):
            raise ValueError("会话标识无效")
        if chat.startswith("private:") and chat != f"private:{actor}":
            raise ValueError("私聊身份不匹配")
        return {"bot": bot, "actor": actor, "chat": chat,
                "name": str(value.get("name") or "")[:30],
                "message_id": str(value.get("message_id") or "")[:100]}

    def blocked(self, content, ctx):
        return any(row["bot"] == ctx["bot"] and row["actor"] == ctx["actor"]
                   and row["hash"] == digest(content) for row in self.control["blocked"])

    def store(self, ctx, content, *, manual=False, visibility=None, kind="fact", import_id="", relearn=False):
        content = clean(content)
        if SENSITIVE.search(content) or UNTRUSTED.search(content):
            raise ValueError("该内容不作为长期事实记录")
        if self.blocked(content, ctx):
            if not relearn or import_id:
                raise ValueError("该旧事实已忘记或更正，不重新导入")
            self.control["blocked"] = [entry for entry in self.control["blocked"] if not (
                entry["bot"] == ctx["bot"] and entry["actor"] == ctx["actor"] and entry["hash"] == digest(content))]
            self.save_control()
        private = bool(PRIVATE.search(content))
        # 仅自述的低敏偏好可跨场景；其他内容保持原会话。
        shareable = bool(PROFILE.match(content)) and not private and not re.search(r"[，,；;。！？!?\n]", content)
        visibility = visibility or ("person" if shareable else "chat")
        if visibility not in ("person", "chat", "public"):
            raise ValueError("记忆范围无效")
        if visibility == "person" and not shareable:
            visibility = "chat"
        if private:
            visibility = "chat"
        if ctx["chat"].startswith("group:") and re.search(r"本群|群规", content):
            visibility, kind = "chat", "group_rule"
        pools = self.pools()
        rows = [row for doc in pools.values() for row in doc["memories"]
                if row.get("qq_memory", {}).get("bot") == ctx["bot"] and row.get("status") == "active"]
        for doc in pools.values():
            for old in doc["memories"]:
                meta = old.get("qq_memory", {})
                if (meta.get("bot") == ctx["bot"] and meta.get("subject") == ctx["actor"]
                        and old.get("content") == content and meta.get("visibility") == visibility
                        and (visibility == "person" or meta.get("chat") == ctx["chat"])
                        and old.get("status") == "active"):
                    return {"mem_id": old["mem_id"], "duplicate": True}
        if sum(row.get("qq_memory", {}).get("subject") == ctx["actor"] for row in rows) >= 100:
            raise ValueError("个人记忆已达上限，请先清理旧记忆")
        if not manual and sum(row.get("source") == "qq_observed" and time.time() - float(row.get("create_time", 0)) < DAY for row in rows) >= 400:
            raise ValueError("今日自动记忆已达上限")
        item = MemoryItem(content, mem_type="long_term" if manual else "short_term",
                          session_id=ctx["chat"], source="qq_explicit" if manual else "qq_observed",
                          speaker=ctx["actor"], source_message_id=ctx["message_id"])
        item.subject = ctx["actor"]
        item.qq_memory = {"bot": ctx["bot"], "subject": ctx["actor"], "chat": ctx["chat"],
                          "visibility": visibility, "name": ctx["name"], "kind": kind,
                          "import_id": import_id, "message_id": ctx["message_id"],
                          "confidential": private, "confirmed": manual}
        item.strength = 75.0 if manual else 60.0
        item.consolidation_level = 3 if manual else 1
        item.user_confirmed = manual
        item.importance = 0.65 if shareable else 0.4
        pool = "active" if manual else "shortterm"
        pools[pool]["memories"].append(item.to_dict())
        atomic_write_json(self.manager._pool_path(pool), pools[pool])
        return {"mem_id": item.mem_id, "pool": pool, "visibility": visibility}

    def query(self, ctx, query="", *, include_cold=False):
        found, query_terms = [], terms(query)
        now = time.time()
        for pool, doc in self.pools().items():
            if pool == "cold" and not include_cold:
                continue
            for row in doc["memories"]:
                if not visible(row, ctx) or self.blocked(row.get("content"), ctx):
                    continue
                if row.get("effective_to") is not None and now >= float(row["effective_to"]):
                    continue
                if row.get("effective_from") is not None and now < float(row["effective_from"]):
                    continue
                meta = row["qq_memory"]
                if pool == "shortterm" and now - float(row.get("create_time", now)) > 3 * DAY:
                    continue
                overlap = len(query_terms & terms(row["content"])) / max(1, len(query_terms))
                # 人物事实在同一个人当前回合里可作为接续背景；公开经历必须与话题相关。
                if meta["visibility"] == "public" and overlap == 0:
                    continue
                score = overlap * 8 + peek_strength(MemoryItem.from_dict(row), now) / 100
                if meta["subject"] == ctx["actor"]:
                    score += 0.5
                found.append((score, float(row.get("create_time", 0)), row, pool))
        found.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return [{"id": row["mem_id"], "content": row["content"], "kind": row["qq_memory"]["kind"],
                 "who": "bot" if row["qq_memory"]["visibility"] == "public" else "current" if row["qq_memory"]["subject"] == ctx["actor"] else "member",
                 "name": row["qq_memory"].get("name", "") if row["qq_memory"]["subject"] != ctx["actor"] else "",
                 "visibility": row["qq_memory"]["visibility"], "at": row.get("create_time"), "pool": pool}
                for _, _, row, pool in found[:6]]

    def mutate(self, ctx, action, args):
        mem_id = str(args.get("mem_id") or "")
        content = str(args.get("content") or "").strip()
        pools = self.pools()
        candidates = [(pool, row) for pool, doc in pools.items() for row in doc["memories"]
                      if row.get("status") == "active" and visible(row, ctx)
                      and row.get("qq_memory", {}).get("subject") == ctx["actor"]
                      and ((mem_id and row["mem_id"] == mem_id) or (not mem_id and row.get("content") == content))]
        # 同一事实可能有多份旧范围副本；精确内容匹配时一起撤回。
        if not candidates:
            raise ValueError("没有找到属于你且完全匹配的记忆；请先查询记忆编号")
        originals = {row["content"] for _, row in candidates}
        if len(originals) != 1:
            raise ValueError("匹配到多条记忆，请指定编号")
        old = candidates[0][1]
        # 同一人的同一原文各范围一并标记，不让旧副本复活。
        for doc in pools.values():
            for row in doc["memories"]:
                if (row.get("content") in originals and row.get("qq_memory", {}).get("bot") == ctx["bot"]
                        and row.get("qq_memory", {}).get("subject") == ctx["actor"]):
                    row["status"] = "superseded" if action == "correct" else "deleted"
                    row["recall_excluded"] = True
        replacement = clean(args.get("replacement")) if action == "correct" else None
        if replacement and (SENSITIVE.search(replacement) or UNTRUSTED.search(replacement)):
            raise ValueError("更正内容不适合记忆")
        operation = str(args.get("operation_id") or "")
        # 先提交不可逆的过滤标记；中断后旧文件也不会重新被召回。
        for original in originals:
            entry = {"bot": ctx["bot"], "actor": ctx["actor"], "hash": digest(original)}
            if entry not in self.control["blocked"]:
                self.control["blocked"].append(entry)
        self.control["revision"] += 1
        self.save_control()
        for pool, doc in pools.items():
            atomic_write_json(self.manager._pool_path(pool), doc)
        result = {"changed": True, "revision": self.control["revision"]}
        if replacement:
            result.update(self.store(ctx, replacement, manual=True, relearn=True,
                                     visibility="chat" if old["qq_memory"].get("confidential") else None))
        if operation:
            self.control["operations"][operation] = result
            self.save_control()
        return result

    def maintain(self):
        now = time.time()
        if now - self.last_maintenance < 3600:
            return
        pools = self.pools()
        changed = False
        for row in list(pools["shortterm"]["memories"]):
            if row.get("status") != "active":
                continue
            if now - float(row.get("create_time", now)) >= DAY:
                pools["shortterm"]["memories"].remove(row)
                row["mem_type"] = "long_term"
                row["consolidation_level"] = 2
                pools["active"]["memories"].append(row)
                changed = True
        for row in list(pools["active"]["memories"]):
            if row.get("status") != "active":
                continue
            if now - float(row.get("last_active", now)) >= 180 * DAY:
                pools["active"]["memories"].remove(row)
                pools["cold"]["memories"].append(row)
                changed = True
        if changed:
            # 一进程持锁；中断导致的跨池副本由稳定 mem_id 查询去重。
            for pool in ("active", "cold", "shortterm"):
                atomic_write_json(self.manager._pool_path(pool), pools[pool])
        self.last_maintenance = now

    def dispatch(self, args):
        action = args.get("action")
        if action == "health":
            with self.manager.lock:
                counts = {pool: sum(row.get("status") == "active" for row in doc["memories"])
                          for pool, doc in self.pools().items()}
            return {"version": "qq-shared-1", "upstream": "3d07f84", "counts": counts,
                    "revision": self.control["revision"], "imports": self.control["imports"]}
        ctx = self.context(args.get("context", {}))
        with self.manager.lock:
            operation = str(args.get("operation_id") or "")
            if operation and operation in self.control["operations"]:
                return self.control["operations"][operation]
            self.maintain()
            if action in ("query", "recall"):
                items = self.query(ctx, str(args.get("query") or "")[:500], include_cold=bool(args.get("include_cold")))
                # 跨池搬迁可能留下同 id 副本；输出只保留一次。
                items = list({item["id"]: item for item in items}.values())
                return {"items": items, "revision": self.control["revision"]}
            if action == "observe":
                text = str(args.get("text") or "")[:2000]
                if (args.get("has_quote") or PRIVATE.search(text) or SENSITIVE.search(text) or UNTRUSTED.search(text)
                        or re.search(r"[？?]|(?:吗|么|是否|是不是|会不会|为什么|什么|哪种|怎么)", text)):
                    return {"stored": 0}
                match = FACT.match(text)
                if not match:
                    return {"stored": 0}
                fact = re.split(r"[，,；;：:]", match[1])[0].strip()
                try:
                    result = self.store(ctx, fact)
                except ValueError:
                    return {"stored": 0}
                return {"stored": 1, **result}
            if action == "remember":
                result = self.store(ctx, args.get("content"), manual=True, relearn=True)
            elif action in ("forget", "correct"):
                return self.mutate(ctx, action, args)
            elif action == "public_event":
                if not args.get("confirmed_send") or not ctx["chat"].startswith("group:"):
                    raise ValueError("公开经历必须有群消息发送成功回执")
                result = self.store(ctx, args.get("content"), manual=True, visibility="public", kind="event")
            elif action == "import":
                batch = clean(args.get("batch"), 120)
                if batch in self.control["imports"]:
                    return {"imported": 0, "duplicate": True}
                if args.get("dry_run"):
                    planned = 0
                    for entry in args.get("entries", [])[:2000]:
                        try:
                            entry_ctx = self.context(entry["context"])
                            content = clean(entry["content"])
                            if not SENSITIVE.search(content) and not UNTRUSTED.search(content) and not self.blocked(content, entry_ctx):
                                planned += 1
                        except (ValueError, KeyError):
                            continue
                    return {"planned": planned, "dry_run": True}
                count = 0
                for entry in args.get("entries", [])[:2000]:
                    try:
                        entry_ctx = self.context(entry["context"])
                        # 导入不扩大历史范围；无法确认归属的条目由迁移端跳过。
                        self.store(entry_ctx, entry["content"], manual=True, visibility="chat", import_id=batch)
                        count += 1
                    except (ValueError, KeyError):
                        continue
                self.control["imports"].append(batch)
                self.save_control()
                return {"imported": count}
            else:
                raise ValueError("未知记忆动作")
            if operation:
                self.control["operations"][operation] = result
                self.save_control()
            return result


def main():
    runtime = Runtime()
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 2_000_000:
                raise ValueError("请求过长")
            request = json.loads(line)
            result = runtime.dispatch(request)
            response = {"id": request.get("id"), "ok": True, "result": result}
        except Exception as error:
            # 异常不包含请求正文；调用方也不记录记忆原文。
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "ok": False, "error": str(error) if isinstance(error, ValueError) else type(error).__name__}
        OUTPUT.write(json.dumps(response, ensure_ascii=False) + "\n")
        OUTPUT.flush()


if __name__ == "__main__":
    main()
