"""Shared, side-effect-free eligibility and evidence revision rules."""
import hashlib
import json
import time
from dataclasses import dataclass


def row_of(record):
    return record if isinstance(record, dict) else vars(record)


def private_record(record, pool=None):
    r = row_of(record)
    if pool == 'private' or bool(r.get('is_private')) or r.get('category') == 'private':
        return True
    from services.privacy_index import is_private_copy
    return is_private_copy(r)


# Backward-compatible alias: call sites that predate the rename still work.
private = private_record


def revision(record):
    r = row_of(record)
    keys = ('content', 'source', 'source_turns', 'out_turns', 'session_id',
            'create_time', 'category', 'is_private', 'recallable', 'mem_type',
            'distill_status', 'status', 'corrected_by', 'superseded_by',
            'effective_from', 'effective_to', 'subject', 'predicate',
            'source_kind', 'speaker', 'source_message_id', 'attachment_index', 'event_time', 'user_confirmed',
            'content_source', 'content_confidence', 'deleted', 'recall_excluded')
    defaults = {'out_turns': [], 'source_turns': [], 'is_private': False,
                'status': 'active', 'source_kind': '', 'speaker': '',
                'source_message_id': '', 'user_confirmed': False,
                'content_source': 'original', 'content_confidence': 'high',
                'deleted': False, 'recall_excluded': False}
    value = {k: r.get(k, defaults.get(k)) for k in keys}
    for key, default in defaults.items():
        if value.get(key) is None:
            value[key] = default
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    default=str).encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class RecallContext:
    query: str = ''
    session_id: str = ''
    as_of: object = None
    subject: str = ''
    predicate: str = ''

    def __post_init__(self):
        if self.as_of is not None:
            from services.evidence_semantics import timestamp
            try:
                object.__setattr__(self, 'as_of', timestamp(self.as_of))
            except (ValueError, OverflowError, OSError):
                raise ValueError('as_of 必须是 ISO 日期时间或 Unix 时间戳') from None


def eligible(record, context=None, *, pool=None, sources=None, _seen=None):
    context = context or RecallContext()
    r = row_of(record)
    # QQ 数据只能由带真实身份上下文的适配器查询，原版泛用 MCP 不得绕过范围。
    if r.get('qq_memory'):
        return False
    from services.deletion_service import excluded
    if excluded(r):
        return False
    if private_record(r, pool):
        return False
    session = str(context.session_id or '')
    owner = str(r.get('session_id') or '')
    if (session.startswith('group:') or owner.startswith('group:')) and owner != session:
        return False
    from services.evidence_semantics import timestamp, placeholder
    if not r.get('evidence_only') and placeholder(r):
        return False
    at = context.as_of if context.as_of is not None else time.time()
    try:
        since, until = timestamp(r.get('effective_from')), timestamp(r.get('effective_to'))
    except (ValueError, OverflowError, OSError):
        return False
    if (since is not None and at < since) or (until is not None and at >= until):
        return False
    historical_version = until is not None and at < until
    if r.get('deleted') or r.get('recall_excluded'):
        return False
    if r.get('status') in ('deleted', 'rejected', 'unavailable') or (r.get('status') == 'superseded' and not historical_version):
        return False
    if r.get('mem_type') in ('superseded', 'unavailable', 'lesson', 'reflection'):
        return False
    if (r.get('superseded_by') or r.get('corrected_by')) and not historical_version:
        return False
    if r.get('mem_type') == 'distilled' and r.get('distill_status') != 'active':
        return False
    from recall_engine import is_meta_query, is_remind_query
    if r.get('recall_mode') == 'on_demand' and not is_remind_query(context.query):
        return False
    flag = r.get('recallable')
    if flag is False or flag == 'no':
        return False
    from schema import classify_for_gate
    inferred = classify_for_gate(str(r.get('content') or ''), str(r.get('source') or ''))
    if inferred.get('recallable') == 'no':
        return False
    if (flag == 'meta_only' or inferred.get('recallable') == 'meta_only') and not is_meta_query(context.query):
        return False
    if sources is not None:
        seen = set(_seen or ())
        own_id = str(r.get('mem_id') or '')
        if own_id:
            seen.add(own_id)
        for ref in (r.get('source_turns') or []) + (r.get('out_turns') or []):
            ref = str(ref)
            if ref in seen:
                return False
            parent = sources.get(ref)
            # Missing derived evidence cannot establish visibility or validity.
            if parent is None:
                return False
            if not eligible(parent, context, sources=sources, _seen=seen):
                return False
    from recall_exclusions import excluded_memory
    return not excluded_memory(r)


def select(records, context=None, *, pool=None, sources=None):
    return [r for r in records if eligible(r, context, pool=pool, sources=sources)]
