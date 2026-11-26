#!/usr/bin/env python3
"""供 chat-bridge 调用的记忆命令行（JSON 进 / JSON 出）。

用法：
  echo '{"query":"朋友生日","sessionId":"private:..."}' | python memory_cli.py recall
  echo '{"sessionId":"...","content":"...","tags":["对话"]}' | python memory_cli.py add
  echo '{"sessionId":"...","query":"..."}' | python memory_cli.py init
  echo '{"mem_id":"mem_...","thought":"...","reason":"..."}' | python memory_cli.py later

约定：
- 只读写本目录下的记忆文件；绝不触碰 social-v2.json
- 错误返回 {"ok": false, "error": "..."}。无效输入的退出码为 2。
"""
import json
import sys
import traceback
import datetime
import time

_started = time.perf_counter()
_timings = []

def _mark(stage):
    _timings.append((stage, round((time.perf_counter() - _started) * 1000)))

# Keep stdout reserved for JSON, including while importing the runtime.
_response_stdout = None
if __name__ == "__main__":
    _response_stdout = sys.stdout
    sys.stdout = sys.stderr

from memory_manager import (
    MemoryManager,
    add_later_thought,          # 2026-11-08 感受分层写入（later action 用）
    later_thought_lines,        # 2026-11-08 感受分层注入（有「后来」才追加）
    format_with_later_thought,  # 2026-11-08 双层渲染（唯一格式真源）
)
from ollama_embedding import get_embedding
from session_init import build_session_init_context
from async_summarizer import local_compress  # FIX-1103-SUM-WIRE
# FIX-1107-IMPORT：_shortterm_cmd 里一直用 MemoryItem 但从来没导入过。
#   因为这一层此前是死代码（没人调），这个 NameError 一直没暴露。
#   接线后才测出来：list/detail/stats 全部报 NameError。
from schema import MemoryItem
_mark("imports")

# Windows 下 Python 默认用 GBK 读写管道：bridge 传的是 UTF-8 JSON，必须显式改掉
for _stream in (sys.stdin, _response_stdout or sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _out(obj):
    if len(sys.argv) > 1 and sys.argv[1] in ("recall", "add"):
        _mark("output")
        print("[memory_cli] %s timings_ms=%s" % (sys.argv[1], _timings), file=sys.stderr)
    stream = _response_stdout or sys.stdout
    stream.write(json.dumps(obj, ensure_ascii=False) + "\n")
    stream.flush()


def _shortterm_cmd(sub: str, payload: dict):
    """短期记忆：add / list / detail / stats"""
    from config import SHORT_TERM_PATH, SHORT_TERM_FORGET_THRESHOLD
    from decay_logic import calculate_shortterm_strength
    import os as _os

    # ── 2026-11-07 新增 add：桥接每轮写入短期层 ──────────────
    #   背景：这一层 11-06 就写了，但**生产环境从来没调用过 add_shortterm**，
    #   shortterm.json 一直不存在 —— 等于死代码。
    #   现在由桥接每轮调它写入。承诺/约定/日期类不进短期层（返回 skipped）。
    if sub == "add":
        content = str(payload.get("content") or "").strip()
        if not content:
            return _out({"ok": True, "added": False, "reason": "内容为空"})
        try:
            mgr = MemoryManager(embedding_func=get_embedding, summarize_func=local_compress)
            src = str(payload.get("source") or "bridge_auto")
            tags = payload.get("tags") or ["对话"]
            # 2026-11-08 修（问题 7.7，设计-契约 实测发现）：
            #   原来没传 session_id → 45 条短期记忆全是 None
            #   → 按会话召回时一条都匹配不上，情景档也只能标成 'legacy'
            #   桥接一直在传 sessionId（runHumanMemory('shortterm', {...})），只是这里没接。
            _sid = str(payload.get("sessionId") or payload.get("session_id") or "").strip()
            # ★ 2026-11-09 P0（独立审计指出）：改用 add_shortterm_ex()。
            #
            #   原来用 add_shortterm() 只拿 None / 非 None，而 None 现在有两种含义：
            #     ① 被拒收（fact / date / commitment）
            #     ② 被容量淘汰（capacity_evicted）
            #   老代码一律报「承诺/约定/日期类不进短期层（归长期）」，
            #   若真触发 ②，就会**谎报成「已转长期」** —— 内容其实丢了。
            #
            #   add_shortterm_ex() 返回结构化结果，reason 精确区分两者。
            # ★ 2026-11-15：工具结果记忆的结构化字段透传。
            #   桥接传 tool_result（dict），这里原样带进 MemoryItem，
            #   使得「按 status 过滤 / 按 artifact 查产物」成为可能，
            #   而不是只能对 content 做全文搜索。
            _tool_result = payload.get("tool_result")
            if not isinstance(_tool_result, dict):
                _tool_result = None
            r = mgr.add_shortterm_ex(content, tags=tags, source=src,
                                     session_id=(_sid or None),
                                     chunk_priority=int(payload.get("priority") or 5),
                                     operation_id=payload.get("operation_id"),
                                     tool_result=_tool_result,
                                     source_kind=str(payload.get('source_kind') or ''),
                                     speaker=str(payload.get('speaker') or ''),
                                     source_message_id=str(payload.get('source_message_id') or ''),
                                     attachment_index=payload.get('attachment_index'),
                                     content_source='generated' if payload.get('source_kind') in ('vision','ocr','transcript') else 'original',
                                     content_confidence='low' if payload.get('source_kind') in ('vision','ocr','transcript') else 'high')
            # ★ 2026-11-15 加：产物同时写进独立账本。
            #
            #   为什么不能只写短期层：
            #     短期层衰减窗口 3 天，而「上次下载的视频在哪」可能 30 天后才问。
            #     需求明确要求：产物路径要有长期保存，不能只依赖短期池。
            #
            #   为什么写在这里（memory_cli）而不是桥接：
            #     ① 桥接只管「这次调用了什么」，不理解「什么算产物」；
            #     ② 写在这里，任何来源（桥接/手动/未来其它调用方）都自动进账本；
            #     ③ 失败不影响短期层写入 —— 账本是附加保障，不是前置条件。
            _artifact_saved = False
            try:
                if isinstance(_tool_result, dict):
                    _art = str(_tool_result.get("artifact") or "").strip()
                    _st = str(_tool_result.get("status") or "")
                    if _art and _st == "succeeded":
                        import artifact_ledger as _al
                        _artifact_saved = _al.record(
                            operation_id=payload.get("operation_id") or "",
                            tool=str(_tool_result.get("tool") or ""),
                            artifact=_art,
                            action=str(_tool_result.get("action") or ""),
                            status=_st,
                            result=str(_tool_result.get("result") or ""),
                            session_id=(_sid or ""),
                        )
            except Exception as _ae:
                print("[memory_cli] 产物账本写入失败（不影响短期层）: %s" % _ae,
                      file=sys.stderr)
            from services.receipts import receipt
            _res = {'ok':True,'added':bool(r.get('saved')),**r}
            if _artifact_saved:
                _res['artifact_ledger'] = True
            return _out(receipt(_res,
                                target='shortterm',operation_id=payload.get('operation_id'),saved=r.get('saved')))

        except Exception as e:
            return _out({"ok": False, "added": False, "error": str(e)[:120]})

    if not _os.path.exists(SHORT_TERM_PATH):
        return _out({"ok": True, "total": 0, "items": [], "note": "短期记忆层为空"})
    with open(SHORT_TERM_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    from services.deletion_service import excluded, load as load_deletions
    deletions = load_deletions()
    mems = [MemoryItem.from_dict(row) for row in data.get("memories", [])
            if not excluded(row, index=deletions)]
    now = datetime.datetime.now().timestamp()

    if sub == "stats":
        total = len(mems)
        fresh24 = 0
        near_expire = 0
        forgotten = 0
        for m in mems:
            s = calculate_shortterm_strength(m, now)
            last = getattr(m, "last_mentioned_at", None) or getattr(m, "create_time", now)
            if now - last <= 86400:
                fresh24 += 1
            elif s < SHORT_TERM_FORGET_THRESHOLD:
                forgotten += 1
            elif s < 50:
                near_expire += 1
        return _out({"ok": True, "total": total, "fresh_24h": fresh24,
                     "near_expire": near_expire, "forgotten": forgotten})

    if sub == "detail":
        mid = str(payload.get("mem_id") or "")
        for m in mems:
            if m.mem_id == mid:
                s = calculate_shortterm_strength(m, now)
                hist = [datetime.datetime.fromtimestamp(t).strftime("%m-%d %H:%M") for t in (m.mention_history or [])]
                return _out({"ok": True, "mem_id": m.mem_id, "content": m.content,
                             "strength": round(s, 1), "mention_count": m.mention_count,
                             "mention_history": hist, "create_time": datetime.datetime.fromtimestamp(m.create_time).strftime("%m-%d %H:%M")})
        return _out({"ok": False, "error": f"找不到 mem_id: {mid}"})

    # list（默认）
    items = []
    for m in mems:
        s = calculate_shortterm_strength(m, now)
        if s < SHORT_TERM_FORGET_THRESHOLD:
            continue  # 忘了的不列
        last = getattr(m, "last_mentioned_at", None) or getattr(m, "create_time", now)
        items.append({
            "mem_id": m.mem_id,
            "content": (m.content or "")[:50],
            "strength": round(s, 1),
            "mention_count": m.mention_count,
            "last_mentioned": datetime.datetime.fromtimestamp(last).strftime("%m-%d %H:%M"),
        })
    items.sort(key=lambda x: -x["strength"])
    return _out({"ok": True, "total": len(items), "items": items})


def _window_cmd(sub: str, payload: dict):
    """窗口账本运维 + 写入（2026-11-08，T08 接线）

    sub 取值：
      append  —— 桥接每轮出站后写一条（唯一有副作用的）
                 参数：sessionId / his / said / notes? / blocks?
      stats   —— 看今天写了多少轮
      tail    —— 取最近 N 轮拼成文本（模拟「换会话后能接上」要看的效果）
      sessions—— 列出所有有数据的会话

    设计原则（跟 window_ledger.py 一致）：
      · 只写不读：append 之后不参与召回，先把「每轮留底」跑起来
      · 失败不抛：桥接是 .catch() 吞掉的，这里也不该因为写不进去就崩
      · his 由调用方提供（窗口账本不猜原话，见 window_ledger.py 文档）
    """
    try:
        import window_ledger as W
    except Exception as exc:
        return _out({"ok": False, "error": f"window_ledger 导入失败: {exc}"})

    # ── append：唯一有副作用的动作 ────────────────────────────
    if sub == "append":
        sid = str(payload.get("sessionId") or "").strip()
        if not sid:
            return _out({"ok": False, "error": "缺 sessionId"})
        his = payload.get("his")
        said = payload.get("said")
        notes = payload.get("notes")
        blocks = payload.get("blocks")
        # 2026-11-08 加：来源标记。
        #   桥接不传 → 默认 'bridge'（生产）。
        #   测试/探针脚本要显式传 'test' / 'probe'，
        #   否则交接单分不出「真对话」和「人写进去的」。
        source = payload.get("source") or W.SOURCE_BRIDGE
        # 三个都空 = 这一轮没内容，不写（避免空行污染账本）
        if not (his or said or notes or blocks):
            return _out({"ok": True, "turn": 0, "skipped": True,
                         "reason": "his/said/notes/blocks 全空"})
        r = W.append_turn(sid, his, said, notes=notes, blocks=blocks, source=source,
                          operation_id=payload.get("operation_id"),
                          is_private=bool(payload.get("is_private")))
        return _out({"ok": True, **(r or {})})

    # ── strip：只剥离，不写库 ──
    #   Kept as a no-op shim: the upstream bridge used to extract inline
    #   "unsent thoughts" from a reply before storing it. That feature was
    #   removed (it never fired in practice), so the contract is preserved —
    #   text in, same text out, empty list — without any tag parsing.
    if sub == "strip":
        text = payload.get("text") or ""
        return _out({"ok": True, "clean": str(text), "notes": [],
                     "changed": False})

    # ── stats：统计 ────────────────────────────────────────
    if sub == "stats":
        sid = payload.get("sessionId")
        s = W.stats(sid) if sid else W.stats()
        return _out({"ok": True, **(s or {})})

    # ── tail：取最近几轮 ────────────────────────────────────
    if sub == "tail":
        sid = str(payload.get("sessionId") or "").strip()
        if not sid:
            return _out({"ok": False, "error": "缺 sessionId"})
        turns = int(payload.get("turns") or 20)
        max_chars = int(payload.get("maxChars") or 2400)
        txt = W.tail_text(sid, turns=turns, max_chars=max_chars)
        return _out({"ok": True, "text": txt, "chars": len(txt or "")})

    # ── sessions：列出有数据的会话 ────────────────────────────
    if sub in ("sessions", "list"):
        s = W.stats() or {}
        return _out({"ok": True, **(s or {})})

    return _out({"ok": False, "error": f"unknown window sub: {sub}"})


def _episode_cmd(sub: str, payload: dict):
    """情景档运维：stats / audit / show（2026-11-08）

    只读。情景档存在 active.json 里（mem_type == "episode"）。

    为什么要有这三个：
      · stats —— 聚合到底跑没跑、跑出来的档有多大、主题是不是都落在「闲聊」
      · audit —— 主题词表是人工维护的，跑偏的（临时:xxx / 闲聊）得能捞出来补词
      · show  —— content 是规则拼接的，怀疑拼错了要能翻回原文核对
    """
    import os as _os
    from config import LONG_TERM_ACTIVE_PATH as _ACTIVE

    if not _os.path.exists(_ACTIVE):
        return _out({"ok": True, "total": 0, "items": [],
                     "note": "长时库文件不存在，还没有任何情景档"})

    with open(_ACTIVE, "r", encoding="utf-8") as f:
        raw = json.load(f)
    all_mems = raw.get("memories", [])
    episodes = [m for m in all_mems if str(m.get("mem_type") or "") == "episode"]

    # ── stats：总数 / 平均条数 / 主题分布 / 置信度分布 ──────────
    if sub == "stats":
        if not episodes:
            return _out({"ok": True, "total": 0, "note": "还没有情景档",
                         "hint": "情景档在第0步聚合时生成；episodes_error 非空说明聚合没跑成"})
        n = len(episodes)
        turns = [len(m.get("source_turns") or []) for m in episodes]
        theme_dist = {}
        kind_dist = {}
        conf_dist = {}
        src_dist = {}
        sess_dist = {}
        low_conf = 0
        low_only = 0
        for m in episodes:
            sc = m.get("scene") or {}
            th = str(sc.get("theme") or "(未标)")
            theme_dist[th] = theme_dist.get(th, 0) + 1
            kd = str(sc.get("theme_kind") or "(未标)")
            kind_dist[kd] = kind_dist.get(kd, 0) + 1
            cf = str(m.get("content_confidence") or "(未标)")
            conf_dist[cf] = conf_dist.get(cf, 0) + 1
            if cf in ("low", "medium"):
                low_conf += 1          # 兼容老口径（下面统计里不再用它）
            if cf == "low":
                low_only += 1          # 真正的低置信度：只有 low
            sd = str(m.get("content_source") or "(未标)")
            src_dist[sd] = src_dist.get(sd, 0) + 1
            sid = str(m.get("session_id") or "legacy")
            sess_dist[sid] = sess_dist.get(sid, 0) + 1

        def _top(d, k=10):   # 按次数倒序，最多列 k 项
            return dict(sorted(d.items(), key=lambda kv: -kv[1])[:k])

        # 2026-11-08：核心统计复用 episode.episode_stats —— 别在 CLI 里再写一遍。
        #   为什么：同一件事写两遍就会分叉（比如将来改「低置信度」的定义，
        #   改了一处忘了另一处，CLI 报的数就跟模块自己报的对不上）。
        #   episode_stats 负责 total/avg_turns/themes/kinds/known_ratio/low_confidence_ratio，
        #   这里再补 CLI 特有的（max/min、置信度分布、session 分布）。
        #   拿不到 episode 模块就回落本地算，不因为一个 import 失败让命令报错。
        core = {}
        try:
            import episode as _ep
            core = _ep.episode_stats(episodes) or {}
        except Exception:
            core = {}

        return _out({
            "ok": True,
            "total": core.get("total", n),
            "avg_turns": core.get("avg_turns", round(sum(turns) / n, 2) if n else 0),
            "max_turns": max(turns) if turns else 0,
            "min_turns": min(turns) if turns else 0,
            # 「猜的 + 闲聊」占比高 = 词表覆盖不够，该补词了
            "guessed_ratio": core.get("guessed_ratio", round(
                (kind_dist.get("guess", 0) + kind_dist.get("fallback", 0)) / n, 3) if n else 0),
            # 2026-11-08 统一口径：只有 content_confidence == "low" 才算低置信度。
            #   原来这里算的是 low+medium，而 episode_stats 算的是 low —— 于是会出现
            #   「low_confidence: 11 但 low_confidence_ratio: 0.0」这种自相矛盾的输出。
            #   medium 是「规则拼接、动作原文照抄」的正常档，不是问题。
            "low_confidence": low_only,
            "low_confidence_ratio": core.get(
                "low_confidence_ratio", round(low_only / n, 3) if n else 0),
            "theme_dist": core.get("themes", _top(theme_dist)),
            "theme_kind_dist": core.get("kinds", kind_dist),
            "confidence_dist": conf_dist,
            "content_source_dist": src_dist,
            "session_dist": _top(sess_dist),
        })

    # ── audit：捞主题跑偏的，用来补主题词表 ─────────────────────
    if sub == "audit":
        guess_or_fallback = []
        for m in episodes:
            sc = m.get("scene") or {}
            kd = str(sc.get("theme_kind") or "")
            if kd not in ("guess", "fallback"):
                # 置信度是 low 的也要看（可能是模型改写过，跟原文对不上）
                if str(m.get("content_confidence") or "") != "low":
                    continue
            guess_or_fallback.append({
                "mem_id": m.get("mem_id"),
                "theme": sc.get("theme"),
                "theme_kind": sc.get("theme_kind"),
                "confidence": m.get("content_confidence"),
                "session_id": m.get("session_id"),
                "turn_count": sc.get("turn_count") or len(m.get("source_turns") or []),
                "date": sc.get("date"),
                "content": (m.get("content") or "")[:120],
            })
        # 按主题聚合，方便一眼看出「哪个临时话题反复出现」（≥3 次就该进词表）
        theme_counter = {}
        for it in guess_or_fallback:
            t = str(it.get("theme") or "(未标)")
            theme_counter[t] = theme_counter.get(t, 0) + 1
        promote = [t for t, c in sorted(theme_counter.items(), key=lambda kv: -kv[1]) if c >= 3]
        return _out({
            "ok": True,
            "total": len(guess_or_fallback),
            "hint": "theme_kind=guess/fallback 说明主题是猜的或兜底闲聊 → 补进 episode.THEMES",
            "term_suggestions": promote,   # 出现 ≥3 次的临时主题，建议升级进词表
            "theme_counter": dict(sorted(theme_counter.items(), key=lambda kv: -kv[1])),
            "items": guess_or_fallback[:50],
        })

    # ── show：看某条详情 + 回溯原文 ─────────────────────────────
    if sub == "show":
        mid = str(payload.get("mem_id") or payload.get("id") or "").strip()
        if not mid:
            return _out({"ok": False, "error": "缺少 mem_id"})
        ep = next((m for m in episodes if m.get("mem_id") == mid), None)
        if ep is None:
            return _out({"ok": False, "error": f"找不到情景档: {mid}"})

        # 回溯原文：碎片可能已经过期被清，能翻到几条就几条，翻不到要说清楚
        from config import SHORT_TERM_PATH as _ST_PATH
        sources = []
        missing = 0
        st_map = {}
        try:
            if _os.path.exists(_ST_PATH):
                with open(_ST_PATH, "r", encoding="utf-8") as f:
                    st = json.load(f)
                st_map = {d.get("mem_id"): d for d in st.get("memories", [])}
        except Exception:
            st_map = {}
        for tid in (ep.get("source_turns") or []):
            d = st_map.get(tid)
            if d is None:
                # 短期层 3 天窗口已过 → 原文被清了（这是预期行为，不是 bug）
                missing += 1
                sources.append({"mem_id": tid, "content": None,
                                "note": "短期层 3 天窗口已过，原文已清理"})
            else:
                src = d.get("create_time")
                sources.append({
                    "mem_id": tid,
                    "content": d.get("content"),
                    "at": datetime.datetime.fromtimestamp(src).strftime("%m-%d %H:%M") if src else None,
                })

        return _out({
            "ok": True,
            "episode": {
                "mem_id": ep.get("mem_id"),
                "content": ep.get("content"),
                "content_source": ep.get("content_source"),
                "content_confidence": ep.get("content_confidence"),
                "session_id": ep.get("session_id"),
                "scene": ep.get("scene") or {},
                "strength": ep.get("strength"),
                "importance": ep.get("importance"),
                "embed_status": ep.get("embed_status"),
                "has_embedding": bool(ep.get("embedding")),
                "source_turns": ep.get("source_turns") or [],
                "create_time": (
                    datetime.datetime.fromtimestamp(ep["create_time"]).strftime("%Y-%m-%d %H:%M")
                    if ep.get("create_time") else None),
                "tags": ep.get("tags") or [],
            },
            "sources": sources,
            "sources_missing": missing,
        })

    return _out({"ok": False, "error": f"unknown episode sub: {sub}",
                 "supported": ["stats", "audit", "show"]})



def _candidate_cmd(sub: str, payload: dict):
    """候选池运维：stats / list / clean（2026-11-08 T07）

    **只读 + 清理**。候选池这一阶段「只写不读」——
    这里看得到，但召回永远不用它（设计 1.2：先攒 1-2 周数据再设计裁决）。

    为什么现在就要有入口：
      观察期的意义是「看候选池里都是什么」，如果只能手翻 jsonl，
      1-2 周后没人会去翻 —— 那这个池子就白攒了。
    """
    import candidate_pool as cp

    # ── stats：总数 / 今天 / 按原因 / 升级了几条 ──────────────
    if sub == "stats":
        st = cp.stats()
        out = {"ok": True}
        out.update(st)
        out["feature_on"] = cp._switch_on()
        if st["total"] == 0:
            out["note"] = "候选池还是空的"
            out["hint"] = ("没数据有两种可能：① 还没接线（add_working_memory 尚未调 write_candidate）"
                           "② 接上了但这一阶段所有内容都判成 pass/block")
        return _out(out)

    # ── list：看具体条目（观察期主要用这个）──────────────
    if sub == "list":
        limit = int(payload.get("limit") or 50)
        items = cp.list_candidates(limit=limit)
        now = __import__("time").time()
        rows = []
        for r in items:
            rows.append({
                "id": r.get("id"),
                "when": _rel_time(float(r.get("at") or 0), now),
                "content": str(r.get("content") or "")[:120],
                "reason": r.get("reason"),
                "confidence": r.get("confidence"),
                "category": r.get("category"),
                "importance": r.get("importance"),
                "repeat": r.get("repeat"),
                "escalated": bool(r.get("escalated")),
                "scrubbed": r.get("scrubbed"),
                "session": r.get("session_id"),
            })
        return _out({"ok": True, "total": len(rows), "items": rows})

    # ── clean：清掉 N 天前的（默认 14）────────────────────
    if sub == "clean":
        days = int(payload.get("days") or cp.CANDIDATE_KEEP_DAYS)
        if not payload.get("confirm"):
            # 删除类操作必须显式确认 —— 跟「任何删除先问」的硬规则一致
            return _out({"ok": True, "cleaned": 0, "dry_run": True,
                         "would_clean_older_than_days": days,
                         "hint": "加 \"confirm\": true 才会真删"})
        n = cp.clear_old(days)
        return _out({"ok": True, "cleaned": n, "older_than_days": days})

    return _out({"ok": False, "error": f"未知子命令: {sub}",
                 "available": ["stats", "list", "clean"]})


def _handover_cmd(payload: dict) -> dict:
    """交接单写入路径（2026-11-09 加）。

    两种用法：
      ① 只问「该不该写」+ 拿提示词：
         {"trigger": "cross_day", "session_id": "private:123"}
         → {"ok": true, "should_write": true, "reason": "cross_day",
            "prompt": "让me写交接单的提示词..."}

      ② 从她的回复真写入：
         {"trigger": "cross_day", "session_id": "private:123",
          "reply": "【主题】...\n【情绪】...\n【没说完】...\n【小事】..."}
         → {"ok": true, "written": {topic, emotion, ...}, "verify": "ok"}

    ★ 为什么要两步：桥接那边的流程是
        会话快结束时 → 问她「写个交接单」→ 她回复 → 解析写入
      第一步要判断「该不该问」，第二步才是真写。
      但也可以一步到位（桥接自己判断该写就直接问、回传）。
    """
    try:
        from handover import (
            should_write, build_prompt, write_from_reply,
            SOURCE_SESSION,
        )
    except Exception as e:
        return _out({"ok": False, "error": "handover 导入失败: %s" % e})

    trigger = str(payload.get("trigger") or "normal").strip().lower()
    session_id = str(payload.get("session_id") or "").strip()

    # ① 该不该写
    try:
        ok_to_write = bool(should_write(trigger))
    except Exception as e:
        return _out({"ok": False, "error": "should_write 失败: %s" % e})

    out = {
        "ok": True,
        "trigger": trigger,
        "session_id": session_id or None,
        "should_write": ok_to_write,
    }

    if not ok_to_write:
        out["reason"] = "trigger=%s 不在写入触发点（rotate/cross_day/compress）" % trigger
        return _out(out)

    # ② 要提示词（桥接拿去问她）
    if not payload.get("reply"):
        try:
            out["prompt"] = build_prompt(payload.get("topic_hint"))
        except Exception as e:
            out["prompt_error"] = str(e)[:100]
        out["reason"] = "需要她的回复：把 reply 字段填上来才会真写"
        return _out(out)

    # ③ 从回复真写
    if not session_id:
        return _out({"ok": False, "error": "写了 reply 就必须给 session_id"})

    reply = str(payload.get("reply") or "")
    try:
        rec = write_from_reply(session_id, reply, is_private=bool(payload.get("is_private")))
    except Exception as e:
        return _out({"ok": False, "error": "write_from_reply 失败: %s" % e})

    if rec is None:
        # 解析不出来 → 不写空壳（这是设计意图，不是错误）
        out["written"] = None
        out["reason"] = "回复解析不出四块内容，未写入（不写空壳）"
        return _out(out)

    out["written"] = {
        "topic": rec.get("topic"),
        "emotion": rec.get("emotion"),
        "pending_tail": rec.get("pending_tail"),
        "trivia": rec.get("trivia"),
        "source": rec.get("source"),
    }
    # 回读校验结果（write_handover 里加的，2026-11-09）
    out["verify"] = rec.get("_verify")
    return _out(out)




def _apply_episode_recall(results, query, lines, items):
    """把关卡打开的「情景档」从 results 里摘出来，按专用格式注入。

    就地修改 lines（注入文本）和 items（台账）。

    参数：
        results —— mgr.recall 的返回值 [(MemoryItem, score), ...]
        query   —— 本轮问题，用来判要不要召回情景档
        lines   —— 注入行列表，本函数只 **插入**，不改别人的行
        items   —— 台账列表，本函数只 append layer='episode' 的条目

    返回：真正注入的档 mem_id 列表（没注入就是 []）。

    为什么先判 should_recall_episodes：
        实测「今天好累」「嗯」「最近在忙什么」这类普通轮次，
        情景档一条都不会被召回（相似度不够）——所以门控在这一层是**冗余的**。
        但它不是没用的：
          · 一旦记忆库变大、或者加进 RRF/联想等其他路子，
            普通轮次也可能捞到档；那时没有门控就会每轮多注 2~3 段经历。
          · 门控也让「为什么这轮没想起那件事」变得可解释（reason 字段）。

    为什么档要提到 lines 最前面：
        档是「一件事」，比单条碎片完整。读者应该先看到事件再看到细节。
    """
    if not results:
        return []

    from episode import (should_recall_episodes, build_episode_inject,
                         dedup_recall, pick_inject_episodes)

    ok, _reason = should_recall_episodes(query)
    if not ok:
        return []

    eps = [m for m, _ in results
           if str(getattr(m, "mem_type", "") or "") == "episode"]
    if not eps:
        return []

    others = [m for m, _ in results
              if str(getattr(m, "mem_type", "") or "") != "episode"]

    # 双向去重：被档覆盖的碎片不再单独注入（否则同一件事出现两遍）
    kept = dedup_recall(eps, others)
    # dedup 后**该保留的非档记忆**（kept 里混着档，这里只取非档）
    kept_non_ep = {str(getattr(m, "mem_id", "") or "") for m in kept
                   if str(getattr(m, "mem_type", "") or "") != "episode"}

    # 只注入预算内那几条档（跟 inject_text_of 用同一套选择标准）
    chosen = pick_inject_episodes(eps)

    injected = []
    for ep in chosen:
        text = build_episode_inject(ep)
        if not text:
            continue
        # 放在最前面：事件优先于细节
        lines.insert(0, text)
        items.insert(0, {"content": getattr(ep, "content", ""),
                         "score": 0.0,
                         "layer": "episode",
                         "mem_id": str(getattr(ep, "mem_id", "") or "")})
        injected.append(str(getattr(ep, "mem_id", "") or ""))

    # ── 从 results 里剔掉：所有档 + 被档覆盖的碎片 ──
    #   档已经用专用格式注入过了，绝不能再走通用分支（否则同一段经历注两遍，
    #   而且通用分支没有「我归纳的」标注 —— 那正是我们要修的问题）。
    #   超预算没注入的档也一并剔掉：宁可这轮不提，也不要它以普通记忆的样子冒充原话。
    #   用切片赋值保对象身份不变（调用方还持有 results 这个引用）。
    if injected:
        keep = []
        for m, s in results:
            mt = str(getattr(m, "mem_type", "") or "")
            if mt == "episode":
                continue
            mid = str(getattr(m, "mem_id", "") or "")
            if mid not in kept_non_ep:
                continue              # 被 dedup 吃掉的碎片
            keep.append((m, s))
        results[:] = keep

    return injected


def _rel_time(at: float, now: float) -> str:
    """把时间戳转成「今天/昨天/前天/N 天前」的人话（对齐 legacy-store 的 relTime 格式）。"""
    import datetime
    if not at:
        return "（没记时间）"
    try:
        at_dt = datetime.datetime.fromtimestamp(at)
        now_dt = datetime.datetime.fromtimestamp(now)
    except (ValueError, OSError, OverflowError):
        return "（时间认不出来）"
    # 用日期差（忽略时分秒），按自然日算「几天前」
    at_day = at_dt.date()
    now_day = now_dt.date()
    days = (now_day - at_day).days
    if days <= 0:
        return "今天 " + at_dt.strftime("%H:%M")
    if days == 1:
        return "昨天 " + at_dt.strftime("%H:%M")
    if days == 2:
        return "前天 " + at_dt.strftime("%H:%M")
    if days <= 14:
        return f"{days} 天前（{at_dt.strftime('%m-%d')}）"
    if days <= 60:
        return f"{at_dt.strftime('%m-%d')}（{days} 天前）"
    if at_dt.year != now_dt.year:
        diff = now_dt.year - at_dt.year
        if diff == 1:
            return "去年 " + at_dt.strftime("%m-%d")
        return f"{at_dt.year}-{at_dt.strftime('%m-%d')}（{diff} 年前）"
    return f"{at_dt.strftime('%m-%d')}（{round(days / 30)} 个月前）"


def _reject_json_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def main():
    action = (sys.argv[1] if len(sys.argv) > 1 else "recall").strip().lower()
    try:
        raw = "" if sys.stdin.isatty() else sys.stdin.read()
    except OSError:
        _out({"ok": False, "error": "unable to read stdin"})
        return 2
    try:
        payload = json.loads(raw, parse_constant=_reject_json_constant) if raw.strip() else {}
    except (ValueError, RecursionError):
        _out({"ok": False, "error": "invalid JSON input"})
        return 2
    if not isinstance(payload, dict):
        _out({"ok": False, "error": "input must be a JSON object"})
        return 2

    # ── 每日维护的「活动触发」（2026-11-08 加）─────────────────────
    #   为什么挂在这里：memory_cli 是桥接每轮对话都会调的入口，
    #   天然是「系统正在被使用」的信号。
    #   而计划任务的致命问题是「错过的窗口不补」——
    #   实测今天 06:10 因关机被跳过，11:00 开机后没任何机制补跑。
    #
    #   成本：读一个小 json + 两次时间比较（< 1 毫秒）
    #   失败：绝不影响主流程（maybe_run 内部吞掉所有异常）
    #   时机：只在 6~23 点、今天没跑过、距上次 >= 20 小时时才真跑
    # ★ 2026-11-08 修：只在这些 action 之后触发维护。
    #
    #   原来的问题：这段在 action 判断之前，所以 stats / window / episode
    #   这些纯查询也会触发巩固 + 夜巡（2.7 秒）。
    #   实测 stats 本来 0.3 秒，加了维护变 3 秒 —— 而且它什么都没做。
    #
    #   为什么只留这三个：
    #     recall → 桥接每轮都调，这是主路径（有对话 = 有数据要处理）
    #     add    → 他让记东西（有新数据）
    #     init   → 跨天开局（有交接单要读）
    #   其余都是「查询」，不该有任何副作用。
    _MAINT_ACTIONS = ("recall", "add", "init")
    if action in _MAINT_ACTIONS:
        try:
            import maintenance_trigger
            maintenance_trigger.maybe_run()
        except Exception as _mte:
            # 维护触发失败不能影响这次调用
            print(f"[memory_cli] 维护触发异常（不影响主流程）: {_mte}",
                  file=sys.stderr)
    if action in ("recall", "add"):
        _mark("maintenance")

    try:
        if action == "recall":
            query = str(payload.get("query") or "").strip()
            if not query:
                return _out({"ok": True, "text": "", "items": []})

            # ★ 2026-11-09：8 步召回搬到 services/recall_service。
            #
            #   为什么搬：原来这 165 行逻辑只写在 CLI 里，
            #   而 mcp_server.memory_recall 只有 1 行（直接调 manager.recall）。
            #   后果是**同一个 AI 在同一次对话里看到两份不同的记忆**：
            #     桥接自动召回 = 8 步结果
            #     AI 主动调 MCP = 1 步结果
            #
            #   搬完之后 CLI 和 MCP 都能调同一份逻辑，
            #   两边只差「渲染成文本」还是「返回结构化条目」。
            from services.recall_service import (
                recall_core, render_for_prompt)
            from config import RECALL_MAX_CHARS as _BUDGET

            mgr = MemoryManager(embedding_func=get_embedding,
                                summarize_func=local_compress)
            _mark("load")
            emotion = payload.get("emotion") or {"valence": "neutral",
                                                 "intensity": 50}
            core = recall_core(
                mgr, query, emotion=emotion,
                entities=payload.get("entities") or None,
                embedding_func=get_embedding,
                top_k=10, session_id=str(payload.get('sessionId') or ''),
                as_of=payload.get('as_of'),subject=str(payload.get('subject') or ''),
                predicate=str(payload.get('predicate') or ''))
            if core.get('input_error'):
                return _out({"ok": False, "error": core['input_error']})
            requested_budget = max(100, min(_BUDGET, int(payload.get('budget') or _BUDGET)))
            rendered = render_for_prompt(core, budget=requested_budget)
            _mark("recall_render")
            return _out({
                "ok": True,
                "text": rendered["text"],
                "items": rendered["items"],
                "skipped": rendered["skipped"],
                "chars": rendered["chars"],
                "budget": rendered["budget"],
                "request_id": rendered.get("request_id"),
                "degraded": bool(core.get("degraded") or core.get("errors")),
                "errors": core.get("errors") or [],
            })

        # ── 2026-11-08 感受分层（T05）：给一条记忆追加「后来再想」 ──────
        #   echo '{"mem_id":"mem_xxx","thought":"原来只是出差三天","reason":"他说只去三天"}' \\
        #     | python memory_cli.py later
        #   · 只追加 later_thought，**不改 content / emotion_valence / emotion_intensity**
        #   · 原 content 是「当时」的事实，改了就是篡改记忆（《主系统设计》26.3）
        if action == "later":
            mem_id = str(payload.get("mem_id") or payload.get("id") or "").strip()
            thought = str(payload.get("thought") or "").strip()
            reason = str(payload.get("reason") or "").strip()
            if not mem_id:
                return _out({"ok": False, "error": "缺少 mem_id"})
            if not thought:
                return _out({"ok": False, "error": "缺少 thought（「后来怎么想的」不能为空）"})
            try:
                ok = add_later_thought(mem_id, thought, reason)
            except Exception as e:
                return _out({"ok": False, "error": f"写入失败: {str(e)[:120]}"})
            if not ok:
                # 找不到 / 内容为空 / 写盘失败 —— 必须如实报失败，
                #   「没找到也返回 ok」就是假解决。
                return _out({"ok": False, "added": False,
                             "error": f"找不到这条记忆或写入失败: {mem_id}",
                             "hint": "只在活跃库（active.json）里找；冷存档案不支持追加"})
            return _out({"ok": True, "added": True, "mem_id": mem_id,
                         "thought": thought, "reason": reason})

        if action == "add":
            session_id = str(payload.get("sessionId") or "default")
            content = str(payload.get("content") or "").strip()
            if not content:
                return _out({"ok": False, "error": "empty content"})
            category = str(payload.get("category") or "")
            # FIX-1103-SUM-WIRE：原来只传 embedding_func，summarize_func=None
            #   ⇒ 摘要器根本不构造 ⇒ 长记忆永不压缩。
            #   现在传本地抽取式压缩（不需要 LLM，ollama 里也没有对话模型）。
            mgr = MemoryManager(embedding_func=get_embedding, summarize_func=local_compress)
            _mark("load")
            # ★ 2026-11-12 修：500 → 800，跟桥接侧 slice(0, 800) 对齐。
            #   原因：她看图后按规则把课表这类内容写成正文，300~600 字是常态，
            #   截 500 会把后半截丢掉。两边上限必须一致，否则桥接放开也白改。
            #   下面回读校验的 content[:500] 也要同步改成 800。
            outcome = mgr.add_working_memory(
                session_id=session_id,
                content=content[:800],
                tags=payload.get("tags") or ["对话"],
                chunk_priority=int(payload.get("priority") or 5),
                source=str(payload.get('source') or ('manual_remember' if payload.get('isManual') else 'bridge_auto')),
                source_kind=str(payload.get('source_kind') or ''),
                speaker=str(payload.get('speaker') or ''),
                source_message_id=str(payload.get('source_message_id') or ''),
                attachment_index=payload.get('attachment_index'),
                content_source='generated' if payload.get('source_kind') in ('vision','ocr','transcript') else 'original',
                content_confidence='low' if payload.get('source_kind') in ('vision','ocr','transcript') else 'high',
                category=category,
                operation_id=payload.get("operation_id"),
                durable=bool(payload.get("isManual")),
                effective_from=payload.get("effective_from"),
                effective_to=payload.get("effective_to"),
            )
            _mark("add_write")
            if not outcome or not outcome.get('written'):
                return _out({"ok": False, "error": "工作记忆未完成持久写入"})
            from services.receipts import receipt
            return _out(receipt({'ok':True,**outcome},target=outcome.get('pool') or 'working',
                                operation_id=payload.get('operation_id')))

        if action == 'retire':
            from services.deletion_service import retire
            result=retire(MemoryManager(embedding_func=None),payload.get('ids') or [],
                          operation_id=payload.get('operation_id'),reason=str(payload.get('reason') or 'explicit deletion'))
            return _out({'ok':True,**result})

        if action == 'correct':
            from services.correction_service import correct
            mgr = MemoryManager(embedding_func=get_embedding)
            result = correct(mgr, str(payload.get('mem_id') or ''), payload.get('content'),
                             operation_id=payload.get('operation_id'), reason=payload.get('reason'),
                             effective_from=payload.get('effective_from'),
                             subject=payload.get('subject'), predicate=payload.get('predicate'))
            return _out({'ok': True, **result})

        if action == 'audit':
            from services.migration_preview import preview
            return _out({'ok': True, **preview(MemoryManager(embedding_func=None))})

        if action == 'private':
            # The dedicated private pool and its migration tooling were
            # removed. The subcommand stays so an existing script gets a clear
            # answer instead of a traceback.
            return _out({'ok': False,
                         'error': 'private pool 已移除（该层不再存在）',
                         'removed': True})

        if action == 'reconcile':
            import candidate_pool as cp
            from services import candidate_observations as observations
            sub=str(payload.get('sub') or 'status')
            if sub=='candidates':
                result=cp.adjudicate_candidates(limit=int(payload.get('limit',500)))
                return _out({'ok':True,'decisions':result,'observation_archive':observations.status()})
            if sub=='status':
                from services.quality_reviews import load as quality_status
                from collections import Counter
                records,bad=cp._read_records()
                counts=Counter(r.get('status','pending') for r in records if r.get('kind','candidate')=='candidate')
                return _out({'ok':True,'candidate_statuses':dict(counts),'bad_lines':bad,
                             'observation_archive':observations.status(),
                             'quality_review_index_error':quality_status().get('error')})
            return _out({'ok':False,'error':'unknown reconciliation operation'})

        if action == 'recovery':
            from services.recovery_service import inventory
            report=inventory(MemoryManager(embedding_func=None),backup_dir=payload.get('backup_dir'))
            return _out({'ok':True,**report})

        if action == 'distill':
            import distillation as d
            scope=str(payload.get('scope') or 'main'); sub=str(payload.get('sub') or 'status')
            if sub=='generate':
                return _out({'ok':True,**d.generate(scope,max_batches=int(payload.get('max_batches', 1)))})
            if sub=='review':
                approved = payload.get('approved')
                if type(approved) is not bool:
                    raise ValueError('approved must be a JSON boolean')
                state=d.review(scope,str(payload.get('card_id') or ''),reviewer=payload.get('reviewer'),
                               approved=approved,embedding_func=get_embedding,
                               supersedes=payload.get('supersedes'))
                return _out({'ok':True,'state':state})
            if sub=='list':
                return _out({'ok':True,'cards':[d.card_view(c) for c in d._load(d._path(scope)).get('cards',[])]})
            if sub=='maintain':
                return _out({'ok':True,**d.maintain(scope)})
            # ── 2026-11-14 skill 侧（只读查询入口，不生成、不执行）──────────
            #   echo '{"sub":"list_skills","scope":"main"}' | python memory_cli.py distill
            #   只返回 active 且结构过关的 skill；provisional/draft 要看 all=true。
            if sub in ('list_skills','skills'):
                if scope not in ('main',):
                    raise ValueError('invalid scope')
                cards=d.active_skills(scope)
                if payload.get('all') is True:
                    cards=[d.skill_view(c) for c in d._load(d._path(scope)).get('cards',[])
                           if d.is_skill(c)]
                out=[{k:v for k,v in c.items() if k not in ('embedding','quotes')} for c in cards]
                return _out({'ok':True,'scope':scope,'count':len(out),'skills':out,
                             'skill_capacity':d.SKILL_MAX,'fail_threshold':d.SKILL_FAIL_THRESHOLD})
            # 桥接注入前的命中判断：只读，返回该注入的建议文本（没命中就是空串）。
            #   echo '{"sub":"match","scope":"main","text":"...","has_image":true}' | python memory_cli.py distill
            if sub in ('match','match_skills'):
                if scope not in ('main',):
                    raise ValueError('invalid scope')
                hits=d.match_skills(scope,text=str(payload.get('text') or ''),
                                    has_image=payload.get('has_image') is True,
                                    has_file=payload.get('has_file') is True,
                                    session_id=str(payload.get('session_id') or payload.get('sessionId') or ''),
                                    file_names=payload.get('file_names') or ())
                text=d.skill_injection_text(hits)
                return _out({'ok':True,'count':len(hits),
                             'ids':[c['id'] for c in hits],'text':text})
            if sub != 'status':
                raise ValueError('invalid distillation operation')
            from services.distillation_provider import load_provider
            provider=load_provider()
            return _out({'ok':True,'state':'ready' if provider else 'disabled',
                         'reason':None if provider else 'no_provider',
                         'model':provider['model'] if provider else None,
                         'active_cards':len(d.active_cards(scope)),
                         'active_skills':len(d.active_skills(scope)),
                         'skill_capacity':d.SKILL_MAX})

        if action == 'observe':
            if payload.get('sub') == 'edges':
                from association_edges import expand
                from services.recall_policy import RecallContext
                mgr = MemoryManager(embedding_func=get_embedding)
                rows = mgr.active_mems + mgr.shortterm_mems
                hits = expand(payload.get('seed_ids') or [], rows,
                              RecallContext(str(payload.get('query') or ''),
                                            str(payload.get('sessionId') or '')))
                return _out({'ok': True, 'observation_only': True, 'items': hits})
            from distillation import generate
            return _out({'ok': True, **generate(payload.get('scope') or 'main')})

        if action == "confirm":
            # 2026-11-12：回复实际用了哪些记忆 → 只有这些降权。
            #   桥接在本轮「不是他主动问回忆」时才调它；
            #   单纯召回不经过这里，所以翻看不加分、也不降权。
            ids = payload.get("mem_ids") or payload.get("ids") or []
            if not isinstance(ids, list):
                ids = [ids]
            mgr = MemoryManager(embedding_func=get_embedding,
                                summarize_func=local_compress)
            changed = mgr.confirm_used([str(x) for x in ids if x],
                                       request_id=payload.get('request_id'),
                                       session_id=payload.get('sessionId'),
                                       evidence=payload.get('evidence', 'explicit'))
            report = mgr.last_feedback_report
            return _out({"ok": not report['errors'] and not report['rejected'], **report})

        if action == "init":
            # 2026-11-08：把开场白传进去 —— session_init 要用它抽实体做召回加分。
            #   桥接本来就在传（runHumanMemory('init', { sessionId, query })），
            #   是这一层一直没往下传，等于白给。
            ctx = build_session_init_context(
                payload.get("sessionId"), None,
                opening_text=str(payload.get("query") or ""),
                profile_mode=payload.get("profile_mode"))
            return _out({"ok": True, "text": ctx.get("context", ""), "estimated_token": ctx.get("estimated_token")})

        # ── 2026-11-06 联想（A+ 方案：关键词触发，不自动跑）────────────
        # 设计：平时不联想（省 token），只在「她在回忆」时才顺着联想一串往事。
        #   实测每条联想链约 464 字 ≈ 697 token，所以绝不能每轮都跑。
        if action in ("associate", "recall_associate"):
            query = str(payload.get("query") or "").strip()
            if not query:
                return _out({"ok": True, "text": "", "items": [], "triggered": False})

            # 触发判据：查询含「回忆类」词，或者调用方显式要求
            TRIGGER_WORDS = ('记得', '想想', '想想看', '上次', '那次', '以前', '之前',
                             '回忆', '想起来', '曾经', '那会儿', '那时候', '还记得',
                             '老早', '当年', '过去')
            forced = payload.get("force") is True
            matched = [w for w in TRIGGER_WORDS if w in query]
            if not forced and not matched:
                # 不是回忆场景，直接返回空（不联想，不占 token）
                return _out({"ok": True, "text": "", "items": [],
                             "triggered": False, "reason": "不是回忆场景"})

            try:
                from associate_engine import associate, associate_to_text
            except ModuleNotFoundError:
                return _out({"ok": False, "error": "associate_engine 未包含在当前发布版中",
                             "removed": True})
            mgr = MemoryManager(embedding_func=get_embedding, summarize_func=local_compress)
            from services.recall_policy import select, RecallContext
            from services.evidence_store import load as load_evidence
            context=RecallContext(query,str(payload.get('sessionId') or ''))
            source_lookup=load_evidence()
            source_lookup.update({m.mem_id:m for m in mgr.active_mems+mgr.shortterm_mems+mgr.cold_mems})
            cands=select(mgr.active_mems,context,sources=source_lookup)
            chain = associate(get_embedding(query), query, cands)
            if not chain:
                return _out({"ok": True, "text": "", "items": [],
                             "triggered": True, "reason": "库里没有相关记忆"})

            from features import on as _on
            if _on("lexical_edges"):
                from association_edges import expand
                by_id={m.mem_id:m for m in cands}
                existing={row['mem'].mem_id for row in chain}
                extras=expand([row['mem'].mem_id for row in chain if row.get('hop')==0],cands,context)
                for edge in extras:
                    if edge['id'] not in existing:
                        chain.append({'mem':by_id[edge['id']],'hop':1,'score':edge['edge_score'],
                                      'edge_type':edge['edge_type'],'reason':'词边：'+','.join(edge['shared'])})
            text = associate_to_text(chain, query)
            items = [{
                "id":c["mem"].mem_id,
                "edge_type":c.get("edge_type"),
                "content": c['mem'].content,
                "hop": c['hop'],
                "score": c['score'],
                "reason": c.get('reason', ''),
            } for c in chain]
            return _out({
                "ok": True,
                "text": text,
                "items": items,
                "triggered": True,
                "trigger_words": matched,
                "count": len(chain),
            })

        # 2026-11-06 短期记忆检索
        if action == "shortterm":
            sub = str(payload.get("sub") or "list").strip().lower()
            return _shortterm_cmd(sub, payload)

        # 2026-11-08 情景档运维（只读）
        #   echo '{"sub":"stats"}'  | python memory_cli.py episode
        #   echo '{"sub":"audit"}'  | python memory_cli.py episode
        #   echo '{"sub":"show","mem_id":"ep_..."}' | python memory_cli.py episode
        if action == "episode":
            sub = str(payload.get("sub") or "stats").strip().lower()
            return _episode_cmd(sub, payload)

        # 2026-11-08 窗口账本接线（T08）
        #   桥接每轮出站后调：
        #     echo '{"sub":"append","sessionId":"private:xxx","his":"他说的","said":"我回的"}' \
        #       | python memory_cli.py window
        #   只写不读（不接召回），先把「每轮留底」跑起来。
        if action == "window":
            sub = str(payload.get("sub") or "stats").strip().lower()
            return _window_cmd(sub, payload)

        # 2026-11-08 候选池运维（只读 + 清理，不参与召回）
        #   echo '{"sub":"stats"}'            | python memory_cli.py candidate
        #   echo '{"sub":"list","limit":50}'  | python memory_cli.py candidate
        #   echo '{"sub":"clean","confirm":true}' | python memory_cli.py candidate
        if action in ("candidate", "candidates"):
            sub = str(payload.get("sub") or "stats").strip().lower()
            return _candidate_cmd(sub, payload)

        # ★ 2026-11-09 加：交接单写入路径（接上 handover 的写侧）
        #
        #   为什么加：wiring_audit 显示 handover.py 有 3 个函数待接
        #   （should_write / write_from_reply / build_prompt）。
        #   当时只有「补记」路径（reconstruct_handover，source='reconstructed'），
        #   没有「正常写入」路径（source='session'）。
        #
        #   后果：交接单永远只有【交接单（补记）】。
        #   而补记是从工作记忆反推的，信息量不如真交接单 ——
        #   真交接单是会话临走时她亲口总结的四块（话题/情绪/没说完的话/小事）。
        #
        #   两种用法：
        #     ① 只问该不该写：
        #        {"trigger":"cross_day","session_id":"x"} → should_write + prompt
        #     ② 从她的回复写入：
        #        {"trigger":"cross_day","session_id":"x","reply":"..."} → written
        if action == "handover":
            return _handover_cmd(payload)

        return _out({"ok": False, "error": f"unknown action: {action}"})
    except Exception as exc:  # fail-open：bridge 侧拿不到就当没有记忆
        print(f"[memory_cli] {action} 失败: {exc}", file=sys.stderr)
        print(traceback.format_exc(), file=sys.stderr)
        _out({"ok": False, "error": str(exc)})
        return 1 if action in ("distill", "retire", "audit", "recovery") else None


if __name__ == "__main__":
    sys.exit(main())
