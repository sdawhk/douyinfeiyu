"""Explicit, source-bound correction transactions; never infer replacements."""
import copy
import json
import time


def correct(manager, mem_id, content, *, operation_id, reason, effective_from=None,
            subject=None, predicate=None, source='owner_correction', session_id=None, effective_to=None):
    if not operation_id or not reason or not str(content or '').strip():
        raise ValueError('correction requires content, reason and operation_id')
    from atomic_io import atomic_write_json
    from schema import MemoryItem
    from services.evidence_semantics import timestamp
    from services.write_receipts import previous, record
    from services.deletion_service import excluded
    from services.memory_tools import window

    scoped = session_id is not None
    if scoped and (not isinstance(session_id, str) or not session_id.strip()):
        raise ValueError("session_id is required")
    if scoped and any(not isinstance(value, str) or not value.strip() for value in (mem_id, content, reason)):
        raise ValueError("mem_id, content and reason are required")
    requested_start, requested_end = window(effective_from, effective_to)
    transaction = json.dumps([mem_id, content, reason, effective_from, subject, predicate], ensure_ascii=False)
    if scoped or effective_to is not None:
        transaction = json.dumps([mem_id, content, reason, requested_start, subject, predicate,
                                  session_id, requested_end], ensure_ascii=False)
    with manager.lock:
        for pool in ('active', 'shortterm'):
            path = manager._pool_path(pool)
            try:
                with open(path, encoding='utf-8') as f:
                    data = json.load(f)
            except FileNotFoundError:
                continue
            prior = previous(data, operation_id, transaction)
            if prior is not None:
                return prior
            row = next((r for r in data.get('memories', []) if r.get('mem_id') == mem_id), None)
            if row is None:
                continue
            if scoped and row.get('session_id') != session_id:
                raise KeyError(mem_id)
            if row.get('corrected_by') or excluded(row) or row.get('deleted'):
                raise ValueError('source already corrected or deleted')
            now = time.time()
            old_start, old_end = timestamp(row.get('effective_from')), timestamp(row.get('effective_to'))
            start = requested_start
            if start is None and (scoped or old_end is not None):
                start = max(now, old_start) if old_start is not None else now
            if start is not None and old_start is not None and start < old_start:
                raise ValueError("correction begins before the original")
            end = requested_end if effective_to is not None else old_end
            start, end = window(start, end)
            replacement = MemoryItem(str(content).strip(), mem_type='short_term' if pool == 'shortterm' else 'long_term',
                                     session_id=row.get('session_id'), source=source,
                                     category='private' if pool == 'private' else '',
                                     is_private=pool == 'private' or bool(row.get('is_private')))
            # The correction inherits scope, not the old statement's truth or emotion.
            for field in ('decay_rate', 'strength_floor', 'decay_rate_mode', 'decay_slowdown'):
                if pool == 'private' and row.get(field) is not None:
                    setattr(replacement, field, row[field])
            replacement.corrects = mem_id
            replacement.correction_reason = str(reason)
            replacement.effective_from = start  # unknown remains unknown for unbounded legacy corrections
            replacement.effective_to = end
            replacement.subject = subject
            replacement.predicate = predicate
            replacement.status = 'active'
            replacement.content_source = 'explicit_correction'
            if manager.embedding_func:
                replacement.embedding = manager.embedding_func(replacement.content)
            cutoff = start if start is not None else now
            row['effective_to'] = min(old_end, cutoff) if old_end is not None else cutoff
            row['corrected_by'] = replacement.mem_id
            row['status'] = 'superseded'
            row['corrected_at'] = now
            data['memories'].append(replacement.to_dict())
            result = {'state': 'corrected', 'pool': pool, 'original_id': mem_id,
                      'mem_id': replacement.mem_id, 'written': True}
            record(data, operation_id, transaction, result)
            atomic_write_json(path, data)
            manager.active_mems = manager._load_active_mems()
            manager.shortterm_mems = manager._load_shortterm_mems()
            return result
    raise KeyError(mem_id)
