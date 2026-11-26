"""Keep scope and revision metadata when short-term source text expires.

The index cannot recall expired raw text. Missing historical sources remain
unresolved; a backup is not proof that a record was never explicitly deleted.
"""
import json
import os


def path():
    import config
    return os.path.join(config.BASE_DIR, 'state', 'evidence_sources.json')


def load():
    try:
        with open(path(), encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data.get('sources'), dict):
            raise ValueError('invalid evidence index')
        return data['sources']
    except FileNotFoundError:
        return {}


def preserve(rows):
    """Caller holds the global pool lock; commit before removing source rows."""
    from atomic_io import atomic_write_json
    from services.recall_policy import revision, private_record
    from schema import classify_for_gate
    sources = load()
    fields = ('mem_id', 'source', 'source_turns', 'out_turns', 'session_id', 'create_time',
              'category', 'is_private', 'mem_type', 'status', 'deleted',
              'recall_excluded', 'corrected_by', 'superseded_by', 'effective_from', 'effective_to')
    for row in rows:
        mid = str(row.get('mem_id') or '')
        if not mid:
            continue
        meta = {k: row.get(k) for k in fields if k in row}
        if private_record(row):
            meta['is_private'] = True
        inferred = classify_for_gate(str(row.get('content') or ''), str(row.get('source') or ''))
        meta['recallable'] = row.get('recallable') or inferred['recallable']
        meta['evidence_revision'] = revision(row)
        meta['evidence_only'] = True
        meta['content'] = ''
        sources[mid] = meta
    os.makedirs(os.path.dirname(path()), exist_ok=True)
    atomic_write_json(path(), {'sources': sources})
