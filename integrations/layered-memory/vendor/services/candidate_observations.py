"""Durable uncertain observations: original evidence, never promoted facts."""
import hashlib
import json
import os
import time

REVIEW_INTERVAL=7*86400

def fingerprint(row):
    value=[row.get(k) for k in ('content','session_id','meta','at')]
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,default=str).encode()).hexdigest()

def path():
    import config
    return os.path.join(config.BASE_DIR,'state','candidate_observations.json')

def load():
    try:
        with open(path(),encoding='utf-8') as f:data=json.load(f)
    except FileNotFoundError:return {'version':1,'observations':{}}
    if not isinstance(data.get('observations'),dict):raise ValueError('invalid observation archive')
    return data

def private_context(row):
    """Whether a candidate must stay out of the shared archive.

    The keyword lists that upstream used here were a private vocabulary and
    were removed with the layer they served. What remains is the structural
    check (an explicit flag) and the privacy index lookup, both of which are
    content-agnostic.
    """
    meta=row.get('meta') or {}
    if row.get('is_private') or row.get('category')=='private' or meta.get('is_private') or meta.get('category')=='private':return True
    from services.privacy_index import is_private_copy
    if is_private_copy(row):return True
    return False

def archive(rows):
    """Caller holds candidate lock. Commit archive before candidate receipts."""
    from atomic_io import atomic_write_json
    data=load();now=time.time()
    for row,reason in rows:
        mid=str(row['id']);fp=fingerprint(row);previous=data['observations'].get(mid)
        if previous and previous['source_fingerprint']==fp:continue
        entry={'candidate_id':mid,'content':row.get('content',''),'session_id':row.get('session_id'),
               'source_meta':row.get('meta') or {},'original_at':row.get('at'),
               'category_hint':row.get('category'),'confidence_hint':row.get('confidence'),
               'source_fingerprint':fp,'recorded_at':now,'reason':reason,
               'is_private':private_context(row),'scope':'source_session_only',
               'record_kind':'uncertain_observation','ordinary_recall_enabled':False,
               'user_confirmed':False,'candidate_category_is_not_verified_fact':True}
        if previous:
            entry['previous_versions']=previous.get('previous_versions',[])+[
                {k:v for k,v in previous.items() if k!='previous_versions'}]
        data['observations'][mid]=entry
    os.makedirs(os.path.dirname(path()),exist_ok=True)
    atomic_write_json(path(),data)
    return len(rows)

def status():
    data=load()['observations']
    return {'observations':len(data),'private_observations':sum(bool(r.get('is_private')) for r in data.values()),
            'ordinary_recall_enabled':False,'review_interval_days':7}
