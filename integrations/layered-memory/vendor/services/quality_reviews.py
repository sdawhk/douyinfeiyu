"""Version-bound adjudications preserve original rows and invalidate on change."""
import json
import os

def load():
    import config
    path=os.path.join(config.BASE_DIR,'state','quality_reviews.json')
    try:
        with open(path,encoding='utf-8') as f:data=json.load(f)
    except FileNotFoundError:return {'pairs':[]}
    except (ValueError,OSError) as exc:return {'pairs':[],'error':type(exc).__name__}
    if (not isinstance(data,dict) or not isinstance(data.get('pairs'),list)
            or any(not isinstance(entry,dict) or not all(k in entry for k in ('a','b','decision','revisions'))
                   or not isinstance(entry['revisions'],dict) for entry in data.get('pairs',[]))):
        return {'pairs':[],'error':'invalid_schema'}
    return data

def relation(a,b):
    from services.recall_policy import row_of,revision
    a,b=row_of(a),row_of(b)
    for entry in load()['pairs']:
        if {entry['a'],entry['b']}!={a.get('mem_id'),b.get('mem_id')}:continue
        expected=entry['revisions']
        if expected.get(a.get('mem_id'))==revision(a) and expected.get(b.get('mem_id'))==revision(b):
            return entry['decision']
    return None

def equivalence_keys(rows):
    from services.recall_policy import row_of,revision
    rows={str(row_of(r).get('mem_id')):row_of(r) for r in rows}
    parent={mid:mid for mid in rows}
    def root(mid):
        while parent[mid]!=mid:
            parent[mid]=parent[parent[mid]];mid=parent[mid]
        return mid
    for entry in load()['pairs']:
        a,b=entry['a'],entry['b']
        if entry['decision']!='equivalent' or a not in rows or b not in rows:continue
        if any(entry['revisions'].get(mid)!=revision(rows[mid]) for mid in (a,b)):continue
        parent[root(b)]=root(a)
    return {mid:root(mid) for mid in rows}
