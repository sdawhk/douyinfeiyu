"""Read-only inventory; no automatic rewriting of historical evidence."""
from collections import Counter
import json


def preview(manager):
    from services.evidence_store import load as load_evidence
    pools = {}
    with manager.lock:
        for pool in ('active', 'shortterm', 'cold'):
            try:
                with open(manager._pool_path(pool), encoding='utf-8') as f:
                    pools[pool] = json.load(f).get('memories', [])
            except FileNotFoundError:
                pools[pool] = []
    known = {r.get('mem_id') for rows in pools.values() for r in rows if r.get('mem_id')}
    known.update(load_evidence())
    report = {'dry_run': True, 'pools': {}, 'action': 'review_only'}
    for pool, rows in pools.items():
        reasons = Counter()
        for row in rows:
            if not row.get('kind'):
                reasons['kind_backfill_proposed'] += 1
            if not row.get('session_id'):
                reasons['unknown_session_preserve'] += 1
            refs = (row.get('source_turns') or []) + (row.get('out_turns') or [])
            if any(str(mid) not in known for mid in refs):
                reasons['unresolved_source_review'] += 1
        ids = [r.get('mem_id') for r in rows if r.get('mem_id')]
        report['pools'][pool] = {'records': len(rows), 'duplicate_ids': len(ids)-len(set(ids)),
                                 'proposed_or_skipped': dict(reasons)}
    return report
