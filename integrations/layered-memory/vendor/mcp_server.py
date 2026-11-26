import json
import os
import sys
import time
import hashlib
_START_TIME = time.time()

try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Reserve stdout for JSON-RPC replies before loading the memory store.
if __name__ == "__main__":
    _response_stdout = sys.stdout
    sys.stdout = sys.stderr

from memory_manager import (
    MemoryManager,
    add_later_thought,           # 2026-11-08 感受分层写入（memory_add_later_thought 用）
    format_with_later_thought,   # 2026-11-08 双层渲染
)
from ollama_embedding import get_embedding
from services.memory_tools import cold_search, limit_text, mcp_add

# 初始化记忆管理器（数据文件全部独立，不触碰宿主原有文件）
manager = MemoryManager(
    summarize_func=lambda t: t[:300] + "...",
    embedding_func=get_embedding,
)
last_cache_refresh = time.time()
CACHE_REFRESH_INTERVAL = 600  # 10 分钟刷新一次长时记忆缓存


def _check_refresh_cache():
    global last_cache_refresh
    if time.time() - last_cache_refresh > CACHE_REFRESH_INTERVAL:
        manager.refresh_active_cache()
        last_cache_refresh = time.time()


# ── 代码更新检测（2026-11-09 加）──────────────────────────────
#   记录「本进程启动时」依赖的那些文件的 mtime；
#   每次 tools/call 前比一次，变了就明确报错而不是静默返回旧结果。
_LOADED_AT = None
_WATCHED = [
    "mcp_server.py", "memory_manager.py", "schema.py", "config.py",
    "services/recall_service.py", "episode.py", "episode_base.py",
    "episode_compose.py", "episode_store.py", "episode_recall.py",
    "recall_engine.py", "decay_logic.py", "handover.py",
    "services/recall_policy.py", "services/feedback_service.py", "window_recall.py",
    "services/evidence_store.py", "recall_exclusions.py", "atomic_io.py",
    "window_ledger.py", "slot_check.py", "session_init.py",
    "services/evidence_semantics.py", "services/deletion_service.py",
    "services/receipts.py", "services/recovery_service.py",
    "services/distillation_provider.py", "distillation.py", "association_edges.py",
    "ollama_embedding.py",
    "services/identity_service.py",
    "services/correction_service.py", "services/memory_tools.py",
    "services/vector_cache.py", "daily_consolidation.py",
    "services/privacy_index.py",
    "candidate_pool.py", "services/candidate_observations.py",
    "services/category_registry.py", "services/quality_reviews.py", "services/source_recovery.py",
]


def _snapshot_mtimes():
    d = {}
    base = os.path.dirname(os.path.abspath(__file__))
    for f in _WATCHED:
        p = os.path.join(base, f)
        try:
            with open(p, "rb") as source:
                d[f] = (os.stat(p).st_mtime_ns, hashlib.sha256(source.read()).hexdigest())
        except OSError:
            d[f] = None
    return d


def _check_stale_modules():
    """返回「启动后被改过的文件列表」。空列表 = 全部是最新的。"""
    global _LOADED_AT
    if _LOADED_AT is None:
        # 第一次调用时记快照（≈ 本进程启动时的状态）
        _LOADED_AT = _snapshot_mtimes()
        return []
    now = _snapshot_mtimes()
    stale = []
    for f, t_now in now.items():
        t_then = _LOADED_AT.get(f)
        if t_now is None or t_then is None:
            continue
        if t_now != t_then:
            stale.append(f)
    return stale


# Capture at module load, not at the first business request.
_LOADED_AT = _snapshot_mtimes()


def handle_request(req: dict):
    """处理一条 JSON-RPC 请求。

    JSON-RPC 通知（无 id 字段，如 notifications/initialized）按规范不得返回响应，
    返回 None 表示静默处理。
    """
    if "id" not in req:
        return None

    _check_refresh_cache()
    method = req.get("method")
    params = req.get("params") or {}

    if method == "initialize":
        import config
        return {
            "jsonrpc": "2.0",
            "id": req["id"],
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "dsh-human-like-memory", "version": getattr(config, "VERSION", "2.1.2")},
            },
        }

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req["id"],
            "result": {
                "tools": [
                    {"name":"memory_runtime_status", "description":"查看记忆服务加载版本、启动时间和源码漂移状态",
                     "inputSchema":{"type":"object","properties":{}}},
                    {
                        "name": "memory_recall",
                        "description": "从长时记忆库中召回与当前输入语义相关的记忆内容",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string", "description": "当前对话内容，用于匹配记忆"},
                                "session_id":{"type":"string"},
                                "as_of":{"type":["string","number"],"description":"明确的历史查询时间；不填代表当前"},
                                "subject":{"type":"string","description":"可选的明确主体"},
                                "predicate":{"type":"string"},
                                "entities": {"type": "array", "items": {"type": "string"}, "description": "实体关键词"},
                                "emotion": {"type": "object", "description": "当前情绪状态"},
                            },
                            "required": ["query"],
                        },
                    },
                    {
                        "name": "memory_add",
                        "description": "写入记忆。用户主动记住或指定有效期时立即持久化，否则进入工作记忆",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "session_id": {"type": "string", "description": "会话ID"},
                                "content": {"type": "string", "description": "记忆内容"},
                                "tags": {"type": "array", "items": {"type": "string"}},
                                "is_manual": {"type": "boolean", "default": False, "description": "是否用户主动标记"},
                                "operation_id": {"type": "string", "description": "客户端重试时复用的写入标识"},
                                "effective_from": {"type": "number"},
                                "effective_to": {"type": "number"},
                            },
                            "required": ["session_id", "content"],
                        },
                    },
                    {
                        "name": "memory_correct",
                        "description": "更正指定会话中已保存的记忆并保留原版本",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "session_id": {"type": "string"},
                                "mem_id": {"type": "string"},
                                "content": {"type": "string"},
                                "reason": {"type": "string"},
                                "operation_id": {"type": "string"},
                                "effective_from": {"type": ["number", "string"]},
                                "effective_to": {"type": ["number", "string"]},
                                "subject": {"type": "string"},
                                "predicate": {"type": "string"},
                            },
                            "required": ["session_id", "mem_id", "content", "reason", "operation_id"],
                        },
                    },
                    {
                        "name": "memory_recall_cold",
                        "description": "检索冷存记忆，默认只读，显式 awake 才迁回活跃库",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string"},
                                "session_id": {"type": "string"},
                                "as_of": {"type": ["number", "string"]},
                                "top_k": {"type": "integer", "minimum": 1, "maximum": 10, "default": 3},
                                "awake": {"type": "boolean", "default": False},
                            },
                            "required": ["query"],
                        },
                    },
                    {
                        "name": "memory_add_later_thought",
                        "description": (
                            "给一条已有记忆追加「后来再想」。**不改原来的 content / 情绪**，"
                            "只加一层「现在怎么想」。比如当时「他说要去外地」很难过，"
                            "后来知道只去三天，就追加一条「白担心了」——"
                            "当时难过是真的，后来的理解也是真的，两层分开留。"
                        ),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "mem_id": {"type": "string", "description": "记忆 ID（召回结果里能看到）"},
                                "thought": {"type": "string", "description": "后来怎么想的（人话，一句话）"},
                                "reason": {"type": "string", "description": "是哪件事改变了看法（可追溯）"},
                            },
                            "required": ["mem_id", "thought"],
                        },
                    },
                    {
                        "name": "memory_confirm_used",
                        "description": (
                            "标记哪些记忆真正被这次回复采用。只有被确认使用的记忆"
                            "才会累计采用次数并逐步降低主动召回权重（可降到 0，"
                            "转为仅按需检索，但内容永远保留）。"
                        ),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "mem_ids": {"type": "array", "items": {"type": "string"},
                                            "description": "真正影响回复的记忆 ID"},
                                "request_id": {"type": "string", "description": "本轮召回返回的 request_id"},
                                "session_id": {"type": "string"},
                            },
                            "required": ["mem_ids"],
                        },
                    },
                    {
                        "name": "memory_init_session",
                        "description": "获取会话初始化上下文，包含人设、情绪和核心记忆锚点",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "session_id": {"type": "string", "description": "会话ID，为空则为新会话"},
                                "query": {"type": "string", "description": "用户开场白"},
                                "profile_mode": {"type": "string", "enum": ["compact", "companion"]},
                            },
                        },
                    },
                ]
            },
        }

    if method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments") or {}

        # ★ 2026-11-09 加：代码更新检测。
        #
        #   为什么：MCP 进程由宿主常驻拉起（stdio 长连接），
        #   宿主不会因为源码改动重启它。今天实测踩到：
        #     mcp_server.py  10:44 改的
        #     PID 62032      08:00 启动
        #     → 164 分钟内 AI 调 memory_recall 拿到的都是旧的 1 步结果
        #
        #   为什么不自作主张重启：宿主是 asar 打包的，查不到它的 MCP 客户端
        #   会不会自动重连。如果不会，杀了就等于把工具弄坏。不确定的事不做。
        #
        #   为什么不用 importlib.reload 自我修复：Python 的 reload 会留旧引用
        #   （其他模块还持有旧函数指针），半新半旧比全旧更危险。宁可明确报错。
        _stale = _check_stale_modules()
        if tool_name == 'memory_runtime_status':
            import config
            from services.distillation_provider import configured as distillation_configured
            snapshot = json.dumps(_LOADED_AT, sort_keys=True).encode()
            return {'jsonrpc':'2.0','id':req['id'],'result':{'content':[{'type':'text','text':json.dumps({
                'version':getattr(config, 'VERSION', '2.1.2'),'pid':os.getpid(),'started_at':_START_TIME,
                'loaded_fingerprint':hashlib.sha256(snapshot).hexdigest(),
                'stale_modules':_stale,'data_dir':config.BASE_DIR,
                'feedback_protocol':'delivery-bound-v1',
                'distillation':'configured_review_required' if distillation_configured() else 'disabled_no_provider',
                'edges':'optional_default_off'},ensure_ascii=False)}]}}
        if _stale:
            return {
                "jsonrpc": "2.0",
                "id": req["id"],
                "result": {
                    "content": [{
                        "type": "text",
                        "text": ("[MCP] 代码已更新但进程还是旧的，结果不可信。\n"
                                 "需要重启宿主进程才能加载新代码。\n"
                                 "变了的文件：%s\n"
                                 "（桥接自动召回走 memory_cli，每次新进程，"
                                 "不受此影响 —— 这条只影响 AI 主动调 MCP）")
                                % ", ".join(_stale[:5]),
                    }],
                    "isError": True,
                },
            }

        if tool_name == "memory_recall":
            # ★ 2026-11-09 改：跟 CLI 走同一套 8 步逻辑。
            #
            #   原来这里只有 1 步 manager.recall()，
            #   而 CLI（桥接自动召回走的那条）是 8 步：
            #     / 短期召回 + 提及续命 + 写盘 / 字数装箱 / 感受分层 / 格式渲染
            #
            #   后果（方案 P1 描述的 bug）：
            #     同一个 AI 在同一次对话里看到两份不同的记忆 ——
            #     桥接自动召回的 8 步结果，和它主动调 MCP 拿到的 1 步结果。
            #
            #   现在两个入口都走 services/recall_service.py：
            #     recall_core()        → 8 步召回 + 处理
            #     render_for_prompt()  → 渲染（跟 CLI 逐字一致）
            #
            #   MCP 的额外要求（方案原话）：
            #     ① 不返回被档覆盖的碎片（否则 AI 看到两份）
            #     ② 每条档带 type='episode' + summary_of=N 轮
            try:
                from services.recall_service import recall_core, render_for_prompt
            except Exception as _e:
                return {
                    "jsonrpc": "2.0",
                    "id": req["id"],
                    "result": {"content": [{"type": "text",
                                            "text": "召回服务不可用: %s" % _e}],
                               "isError": True},
                }

            query = args.get("query")
            if not isinstance(query, str) or not query.strip():
                return {"jsonrpc": "2.0", "id": req["id"], "result": {
                    "isError": True, "content": [{"type": "text", "text": "query is required"}]}}

            core = recall_core(
                manager,
                query,
                emotion=args.get("emotion"),
                entities=args.get("entities"),
                embedding_func=get_embedding,
                session_id=str(args.get('session_id') or ''),
                as_of=args.get('as_of'),subject=str(args.get('subject') or ''),
                predicate=str(args.get('predicate') or ''),
            )
            if core.get("input_error"):
                return {"jsonrpc": "2.0", "id": req["id"], "result": {
                    "isError": True, "content": [{"type": "text", "text": core["input_error"]}]}}

            # 渲染方式跟 CLI 完全一致（情景档专用格式 + 时间前缀 + 一直：）
            rendered = render_for_prompt(core)

            # ① 被档覆盖的碎片已经由 recall_core 的 resolve_episodes 去掉了，
            #    这里只需把「档」的信息补上，让 AI 知道这是归纳的、不是原话。
            _items = rendered.get("items") or []
            if rendered.get("request_id"):
                _items_meta = {"request_id": rendered["request_id"], "session_id": args.get("session_id", ""), "confirmable_ids": [x.get("id") or x.get("mem_id") for x in _items if x.get("confirmable")]}
            else:
                _items_meta = {}
            _ep_n = sum(1 for x in _items if x.get("layer") == "episode")
            _st_n = sum(1 for x in _items if x.get("layer") == "shortterm")
            _lt_n = sum(1 for x in _items if x.get("layer") == "longterm")

            _head = ""
            if _ep_n or _st_n:
                _head = ("[召回] 情景档 %d 条 / 短期 %d 条 / 长时 %d 条"
                         "（与桥接自动召回同一套逻辑）\n"
                         % (_ep_n, _st_n, _lt_n))

            if core.get("degraded") and not rendered.get("text"):
                _text = "记忆服务暂时不可用，本次没有可靠的记忆可召回"
            else:
                _text = (_head + rendered.get("text", "")) or "无相关记忆"

            # 错误也报出来（不静默 —— 这是方案 P1 的核心诉求）。
            trailer = "\n" + json.dumps(_items_meta, ensure_ascii=False) if _items_meta else ""
            _errs = core.get("errors") or []
            if _errs:
                report = "\n[召回过程中 %d 个问题: %s]" % (len(_errs), "; ".join(_errs[:3]))
                _text += limit_text(report, max(1, 4096 - len(_text) - len(trailer)))
            _text = limit_text(_text, max(1, 4096 - len(trailer))) + trailer

            return {
                "jsonrpc": "2.0",
                "id": req["id"],
                "result": {"content": [{"type": "text", "text": _text}],
                           "isError": bool(core.get("degraded"))},
            }

        if tool_name in ("memory_add", "memory_correct", "memory_recall_cold"):
            try:
                if tool_name == "memory_add":
                    outcome = mcp_add(manager, args)
                    if not (isinstance(outcome, dict) and outcome.get("written") is True
                            and outcome.get("pool") and outcome.get("mem_id")):
                        raise ValueError("记忆未完成持久写入")
                    payload = {"ok": True, **outcome}
                elif tool_name == "memory_correct":
                    from services.correction_service import correct
                    operation_id = args.get("operation_id")
                    if not isinstance(operation_id, str) or not operation_id.strip() or len(operation_id) > 128:
                        raise ValueError("operation_id is required")
                    payload = correct(manager, args["mem_id"], args["content"],
                                      operation_id="mcp-correct:" + operation_id,
                                      reason=args["reason"], session_id=args["session_id"],
                                      effective_from=args.get("effective_from"), effective_to=args.get("effective_to"),
                                      subject=args.get("subject"), predicate=args.get("predicate"))
                else:
                    payload = cold_search(manager, args, get_embedding)
            except (ValueError, KeyError) as exc:
                return {"jsonrpc": "2.0", "id": req["id"], "result": {
                    "isError": True, "content": [{"type": "text", "text": str(exc)[:200]}]}}
            return {"jsonrpc": "2.0", "id": req["id"], "result": {
                "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}}

        if tool_name == "memory_add_later_thought":
            mem_id = str(args.get("mem_id") or "").strip()
            thought = str(args.get("thought") or "").strip()
            reason = str(args.get("reason") or "").strip()
            if not mem_id or not thought:
                return {
                    "jsonrpc": "2.0",
                    "id": req["id"],
                    "result": {"isError": True, "content": [
                        {"type": "text", "text": "mem_id 和 thought 都必须给"}]},
                }
            ok = add_later_thought(mem_id, thought, reason)
            if not ok:
                # 找不到就如实报失败 —— 不能「无脑返回成功」，那就是假解决
                return {
                    "jsonrpc": "2.0",
                    "id": req["id"],
                    "result": {"isError": True, "content": [
                        {"type": "text",
                         "text": f"没找到这条记忆（或写入失败）: {mem_id}。"
                                 f"只在活跃库里找，冷存档案不支持追加。"}]},
                }
            return {
                "jsonrpc": "2.0",
                "id": req["id"],
                "result": {"content": [
                    {"type": "text", "text": limit_text(f"已追加「后来再想」到 {mem_id}：{thought}")}]},
            }

        if tool_name == "memory_confirm_used":
            ids = args.get("mem_ids") or []
            try:
                n = manager.confirm_used(ids, request_id=args.get('request_id'),
                                         session_id=args.get('session_id'))
            except Exception as e:
                return {
                    "jsonrpc": "2.0", "id": req["id"],
                    "result": {"isError": True, "content": [
                        {"type": "text", "text": "确认使用失败: %s" % e}]},
                }
            return {
                "jsonrpc": "2.0", "id": req["id"],
                "result": {"isError": bool(manager.last_feedback_report.get("errors") or manager.last_feedback_report.get("rejected")), "content": [{"type": "text",
                                        "text": json.dumps(manager.last_feedback_report, ensure_ascii=False)}]},
            }

        if tool_name == "memory_init_session":
            query_emb = get_embedding(args.get("query", "")) if args.get("query") else None
            init_ctx = manager.init_session(args.get("session_id"), query_emb,
                                            profile_mode=args.get("profile_mode"), opening_text=args.get("query"))
            from session_init import _bound_init
            context = _bound_init(init_ctx["context"], 4096, unit="characters")
            return {
                "jsonrpc": "2.0",
                "id": req["id"],
                "result": {"content": [{"type": "text", "text": context}]},
            }

    return {
        "jsonrpc": "2.0",
        "id": req.get("id"),
        "error": {"code": -32601, "message": "Method not found"},
    }


if __name__ == "__main__":
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            resp = handle_request(req)
            if resp is not None:
                _response_stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                _response_stdout.flush()
        except Exception as e:
            sys.stderr.write(f"MCP Server Error: {e}\n")
            sys.stderr.flush()
            # ★ 2026-11-18（P5）：原来这里只写 stderr，**不往 stdout 回任何东西**。
            #
            #   后果：按 MCP/JSON-RPC 协议，客户端发了带 id 的请求却收不到响应，
            #   只能一直等（挂死）或超时。它不知道是「服务崩了」还是「服务慢」。
            #
            #   修法：只要能确认「这是一条带 id 的合法请求」，就补一个标准的
            #   -32603（Internal error）响应，让客户端立刻拿到确定结果。
            #   注意：
            #     · 通知（无 id）不能回响应 —— 协议规定，回了反而是错的
            #     · req 解析失败（不是 dict）时无从得知 id，只能写 stderr
            try:
                if isinstance(req, dict) and "id" in req:
                    _err = {
                        "jsonrpc": "2.0",
                        "id": req.get("id"),
                        "error": {
                            "code": -32603,
                            "message": "Internal error: %s" % type(e).__name__,
                            "data": str(e)[:300],
                        },
                    }
                    _response_stdout.write(json.dumps(_err, ensure_ascii=False) + "\n")
                    _response_stdout.flush()
            except Exception:
                # 连错误响应都发不出去就只能认了，别再抛
                pass
