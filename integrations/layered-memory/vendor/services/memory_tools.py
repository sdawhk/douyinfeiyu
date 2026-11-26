import json
import time

from services.evidence_semantics import timestamp
from services.recall_policy import RecallContext, select


def window(start, end):
    start, end = timestamp(start), timestamp(end)
    if start is not None and end is not None and start >= end:
        raise ValueError("effective_from must precede effective_to")
    return start, end


def add_active(manager, content, session_id, options, operation_id=None, fingerprint=None):
    from atomic_io import atomic_write_json
    from schema import MemoryItem
    from services.deletion_service import excluded
    from services.write_receipts import previous, record

    if not str(content or "").strip():
        return None
    fields = dict(options)
    fields.pop("mem_type", None)
    fields.setdefault("source", "auto")
    start, end = window(fields.pop("effective_from", None), fields.pop("effective_to", None))
    payload = fingerprint if fingerprint is not None else content
    path = manager._pool_path("active")
    with manager.lock:
        if excluded(dict(fields, content=content, session_id=session_id)):
            raise ValueError("source_deleted")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            data = {"memories": []}
        prior = previous(data, operation_id, payload)
        if prior is not None:
            return prior
        item = MemoryItem(content, mem_type="long_term", session_id=session_id, **fields)
        item.effective_from, item.effective_to = start, end
        if manager.embedding_func:
            item.embedding = manager.embedding_func(content)
        item.strength = max(item.strength, 70.0)
        item.consolidation_level = 3
        data.setdefault("memories", []).append(item.to_dict())
        result = {"written": True, "mem_id": item.mem_id, "pool": "active"}
        record(data, operation_id, payload, result)
        atomic_write_json(path, data)
        manager.active_mems.append(item)
        return result


def mcp_add(manager, args):
    from config import WORKING_MEM_PATH
    from services.write_receipts import previous

    session_id, content = args.get("session_id"), args.get("content")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id is required")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("content is required")
    manual, tags = args.get("is_manual", False), args.get("tags", [])
    if not isinstance(manual, bool) or not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError("invalid is_manual or tags")
    start, end = window(args.get("effective_from"), args.get("effective_to"))
    operation_id = args.get("operation_id")
    if operation_id is not None and (not isinstance(operation_id, str) or not operation_id.strip() or len(operation_id) > 128):
        raise ValueError("invalid operation_id")
    if operation_id is not None:
        operation_id = "mcp-add:" + operation_id
    fields = {"tags": tags, "chunk_priority": 10 if manual else 5,
              "source": "manual_remember" if manual else "auto"}
    durable = manual or start is not None or end is not None
    if durable:
        fields.update(effective_from=start, effective_to=end)
    payload = json.dumps([session_id, content, manual, tags, start, end], ensure_ascii=False)
    with manager.lock:
        if operation_id:
            other_pool = WORKING_MEM_PATH if durable else manager._pool_path("active")
            try:
                with open(other_pool, encoding="utf-8") as f:
                    prior = previous(json.load(f), operation_id, payload)
            except FileNotFoundError:
                prior = None
            if prior is not None:
                return prior
        if durable:
            return add_active(manager, content, session_id, fields, operation_id, payload)
        return manager.add_working_memory(session_id, content, **fields,
                                          operation_id=operation_id, receipt_payload=payload)


def cold_search(manager, args, embedding_func):
    from daily_consolidation import awaken_cold_memory
    from recall_engine import recall_cold
    from services.evidence_store import load
    from services.evidence_semantics import labels, supports
    from slot_check import find_slot

    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query is required")
    session_id = args.get("session_id", "")
    top_k, awake = args.get("top_k", 3), args.get("awake", False)
    if not isinstance(session_id, str) or type(top_k) is not int or not 1 <= top_k <= 10 or not isinstance(awake, bool):
        raise ValueError("invalid session_id, top_k or awake")
    context = RecallContext(query, session_id, as_of=args.get("as_of"))
    if awake and (not session_id or context.as_of is not None):
        raise ValueError("awakening requires a current session")
    with manager.lock:
        archived = manager._load_cold_mems()
        active = manager._load_active_mems()
        sources = load()
        sources.update({m.mem_id: m for m in [*archived, *active]})
        candidates = select(archived, context, pool="cold", sources=sources)
        if find_slot(query)[0]:
            candidates = [m for m in candidates if supports(vars(m), query)]
        if awake:
            candidates = [m for m in candidates if not m.session_id or m.session_id == session_id]
        active_ids = {m.mem_id for m in active}
    hits = recall_cold(embedding_func(query), candidates, top_k=top_k,
                       query_text=query, exclude_ids=active_ids if not awake else None)
    items = []
    for item, score in hits:
        if awake:
            try:
                awaken_cold_memory(item.mem_id, context=context)
            except (KeyError, ValueError):
                continue
        items.append({"mem_id": item.mem_id, "content": item.content[:280],
                      "score": score, "qualification": labels(vars(item)),
                      "pool": "active" if awake else "cold"})
    return {"items": items}


def limit_text(text, limit=4096):
    if len(text) <= limit:
        return text
    if limit != 4096:
        return text[:limit - 1] + "…"
    omitted = len(text) - 2560
    return text[:2048] + f"\n[…已截断 {omitted} 字符…]\n" + text[-512:]


def supplemental_matches(view, context, sources, query_vector):
    import re
    from difflib import SequenceMatcher
    from config import WORKING_MEM_PATH, WORKING_MEM_DEFAULT_TTL
    from schema import MemoryItem
    from services.evidence_semantics import valid_vector

    query = re.sub(r"[^\w]+", " ", context.query.casefold()).strip()[:400]
    use_lexical = not valid_vector(query_vector)
    active = [m for m in view.active_mems if m.source == "manual_remember"
              and (use_lexical or not valid_vector(m.embedding))]
    shortterm = [m for m in view.shortterm_mems if use_lexical or not valid_vector(m.embedding)]
    work = []
    if context.session_id and context.as_of is None:
        try:
            with open(WORKING_MEM_PATH, encoding="utf-8") as f:
                sessions = json.load(f).get("sessions", {})
        except FileNotFoundError:
            sessions = {}
        rows = sessions.get(context.session_id, {}).get("working_memory", [])
        now = time.time()
        work = [MemoryItem.from_dict(dict(row, session_id=row.get("session_id") or context.session_id))
                for row in rows
                if now - float(row.get("create_time") or 0)
                < float(row.get("ttl", WORKING_MEM_DEFAULT_TTL))]
        work = select(work, context, pool="working", sources=sources)
    hits = []
    for item in [*active, *shortterm, *work]:
        content = re.sub(r"[^\w]+", " ", item.content.casefold()).strip()[:2000]
        match = SequenceMatcher(None, query, content, autojunk=False).find_longest_match()
        anchor = query[match.a:match.a + match.size].strip()
        if (len(anchor) >= 4 and (anchor == query or anchor == content
                or len(re.findall(r"[㐀-鿿]", anchor)) >= 4
                or len(anchor.split()) >= 2)):
            hits.append((item, min(1.0, len(anchor) / max(1, len(query)))))
    hits.sort(key=lambda hit: hit[1], reverse=True)
    return hits[:2]
