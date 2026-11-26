"""Durable delivery receipts and idempotent, source-bound feedback.

No model calls; all paths resolve from the active data configuration at call time.
"""
import copy
import json
import os
import time
import uuid

from services.recall_policy import revision, eligible, RecallContext

TTL = 86400


def state_path(base=None):
    import config
    return os.path.join(base or config.BASE_DIR, 'state', 'delivery_receipts.json')


def _read(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError('invalid receipt container')
        return value
    except FileNotFoundError:
        return {} if default is None else default


def register(items, context, *, request_id=None, now=None, base=None):
    from atomic_io import atomic_write_json
    from common.locking import state_lock
    now = time.time() if now is None else now
    request_id = request_id or uuid.uuid4().hex
    path = state_path(base)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with state_lock('delivery_receipts'):
        data = _read(path)
        data = {k: v for k, v in data.items() if v.get('expires_at', 0) >= now}
        data[request_id] = {'at': now, 'expires_at': now + TTL,
                            'query': '', 'session_id': context.session_id,
                            'remind': context.as_of is not None or __import__('recall_engine').is_remind_query(context.query),
                            'as_of': context.as_of, 'subject':context.subject, 'predicate':context.predicate,
                            'meta': __import__('recall_engine').is_meta_query(context.query),
                            'items': items}
        atomic_write_json(path, data)
    return request_id


def confirm(manager, ids, *, request_id=None, session_id=None, evidence='explicit', now=None):
    from atomic_io import atomic_write_json
    from schema import MemoryItem
    from decay_logic import reinforce_on_recall, mark_recall_used
    now = time.time() if now is None else now
    wanted = {str(x) for x in ids if x}
    report = {'confirmed': 0, 'already_applied': 0, 'rejected': [], 'errors': []}
    if evidence != 'explicit':
        report['rejected'] = [{'reason': 'heuristic_is_not_confirmation'}]
        return report
    if getattr(manager, '_active_write_fields', None) and not manager.flush():
        report['errors'] = [{'reason': 'pending_write_flush_failed'}]
        return report
    receipts = _read(state_path(os.path.dirname(manager._pool_path('active'))))
    matches = [(k, r) for k, r in receipts.items()
               if (not request_id or k == request_id) and r.get('expires_at', 0) >= now
               and (r.get('session_id') == session_id or (session_id is None and not r.get('session_id')))
               and wanted.issubset({i.get('id') for i in r.get('items', [])})]
    if len(matches) != 1:
        report['rejected'] = [{'reason': 'delivery_missing_ambiguous_or_expired'}]
        return report
    rid, receipt = matches[0]
    pools = {'active': manager._pool_path('active')}
    by_pool = {}
    for item in receipt['items']:
        if item.get('id') in wanted:
            by_pool.setdefault(item.get('pool'), []).append(item)
    for pool, items in by_pool.items():
        if pool not in pools:
            report['rejected'].append({'pool': pool, 'reason': 'pool_not_confirmable'})
            continue
        try:
            with manager.lock:
                data = _read(pools[pool])
                rows = {str(r.get('mem_id')): r for r in data.get('memories', [])}
                from services.evidence_store import load as load_evidence
                current_sources = load_evidence()
                for source_pool in ('cold', 'shortterm', 'active'):
                    source_data = data if source_pool == pool else _read(manager._pool_path(source_pool))
                    for source_row in source_data.get('memories', []):
                        source_row = dict(source_row)
                        current_sources[str(source_row.get('mem_id'))] = source_row
                applied = data.setdefault('_operation_receipts', {})
                changed = 0
                for item in items:
                    mid = item['id']
                    key = rid + ':' + mid + ':used'
                    if key in applied:
                        report['already_applied'] += 1
                        continue
                    row = rows.get(mid)
                    if row is None or revision(row) != item.get('revision'):
                        report['rejected'].append({'id': mid, 'reason': 'source_changed_or_deleted'})
                        continue
                    ctx = RecallContext('记忆系统' if receipt.get('meta') else ('还记得' if receipt.get('remind') else ''),
                                        receipt.get('session_id') or '',
                                        receipt.get('as_of'), receipt.get('subject') or '', receipt.get('predicate') or '')
                    if not eligible(row, ctx, pool=pool, sources=current_sources):
                        report['rejected'].append({'id': mid, 'reason': 'not_eligible'})
                        continue
                    mem = MemoryItem.from_dict(copy.deepcopy(row))
                    reinforce_on_recall(mem, current_timestamp=now)
                    if not receipt.get('remind'):
                        mark_recall_used(mem, now)
                    else:
                        mem.last_recalled_at = now
                    updated = mem.to_dict()
                    for field in ('strength', 'strength_at', 'last_active', 'last_recalled_at',
                                  'mention_count', 'mention_history', 'decay_slowdown',
                                  'impression_strength', 'recall_weight', 'recall_mode', 'recall_count'):
                        if field in updated:
                            row[field] = updated[field]
                    applied[key] = {'at': now, 'expires_at': receipt['expires_at'] + TTL}
                    changed += 1
                if changed:
                    data['_operation_receipts'] = {k: v for k, v in applied.items() if v.get('expires_at', now + 1) >= now}
                    atomic_write_json(pools[pool], data)
                    report['confirmed'] += changed
        except Exception as exc:
            report['errors'].append({'pool': pool, 'reason': type(exc).__name__})
    # Do not write a stale manager snapshot after the field-level commit.
    manager.refresh_active_cache()
    return report
