"""Recover verified backup evidence into a read-only archive, not active memory."""
import hashlib
import json
import os
import time
from pathlib import Path

def sha(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,default=str).encode()).hexdigest()

def _known(manager):
    from services.evidence_store import load
    known=set(load())
    for pool in ('active','cold','shortterm'):
        path=manager._pool_path(pool)
        if os.path.exists(path):
            with open(path,encoding='utf-8') as f:known.update(str(r['mem_id']) for r in json.load(f).get('memories',[]) if r.get('mem_id'))
    return known

def plan(manager, inventory):
    from services.deletion_service import load
    retired=set(load().get('ids',{}));versions={};file_errors=[]
    files={}
    for mid,locations in inventory['source_locations'].items():
        for location in locations:files.setdefault(location['file'],{})[mid]=location
    for name,expected in sorted(files.items()):
        try:
            raw=Path(name).read_bytes();digest=hashlib.sha256(raw).hexdigest()
            if not all(loc['file_sha256']==digest for loc in expected.values()):
                file_errors.append({'file':name,'reason':'changed_backup'});continue
            data=json.loads(raw.decode('utf-8-sig'))
        except (OSError,ValueError) as exc:
            file_errors.append({'file':name,'reason':type(exc).__name__});continue
        for row in data.get('memories',[]):
            mid=str(row.get('mem_id') or '')
            if mid not in expected:continue
            text=str(row.get('content') or '')
            key=hashlib.sha256(text.encode()).hexdigest()
            item=versions.setdefault(mid,{}).setdefault(key,{'row':{k:v for k,v in row.items() if k!='embedding'},'locations':[],
                                                         'private':False,'retired':False})
            loc=expected[mid]
            item['private']|=bool(loc.get('scope_restricted') or row.get('is_private') or row.get('category')=='private')
            item['retired']|=bool(loc.get('retired') or row.get('deleted') or row.get('corrected_by') or row.get('superseded_by'))
            item['locations'].append({'file':name,'sha256':digest})
    with manager.lock:known=_known(manager)
    selected=[];skipped={}
    for mid,variants in sorted(versions.items()):
        if mid in known:skipped[mid]='already_present';continue
        if mid in retired:skipped[mid]='explicitly_deleted';continue
        if len(variants)!=1:skipped[mid]='multiple_body_versions';continue
        variant=next(iter(variants.values()))
        if variant['retired']:skipped[mid]='retired_backup_version';continue
        if not str(variant['row'].get('content') or '').strip():skipped[mid]='empty_body';continue
        selected.append(dict(variant,id=mid,body_sha256=next(iter(variants))))
    result={'version':1,'sources':selected,'skipped':skipped,'file_errors':file_errors,
            'mode':'evidence_archive_only','active_pool_writes':0}
    result['plan_sha256']=sha(result)
    return result

def apply(manager, manifest, *, operation_id):
    from atomic_io import atomic_write_json
    from services import evidence_store
    from services.candidate_observations import private_context
    from services.recall_policy import revision
    from services.deletion_service import load as deletions
    import config
    signature=manifest.get('plan_sha256')
    if not operation_id or sha({k:v for k,v in manifest.items() if k!='plan_sha256'})!=signature:
        raise ValueError('invalid recovery plan')
    path=os.path.join(config.BASE_DIR,'state','recovered_source_archive.json')
    with manager.lock:
        try:
            with open(path,encoding='utf-8') as f:archive=json.load(f)
        except FileNotFoundError:archive={'version':1,'sources':{},'operations':{}}
        previous=archive['operations'].get(operation_id)
        if previous:
            if previous['signature']!=signature:raise ValueError('operation reused for another recovery plan')
            # Archive committed first; retry always repairs the metadata half.
        else:
            retired=set(deletions().get('ids',{}));known=_known(manager)
            verified=set()
            for item in manifest['sources']:
                if item['id'] in retired:raise ValueError('source deleted since plan')
                for location in item['locations']:
                    file_key=(location['file'],location['sha256'])
                    if file_key in verified:continue
                    raw=Path(location['file']).read_bytes()
                    if hashlib.sha256(raw).hexdigest()!=location['sha256']:raise ValueError('backup changed since plan')
                    verified.add(file_key)
            recovered=[]
            for item in manifest['sources']:
                mid=item['id']
                if mid in known:continue
                row=dict(item['row'])
                reviewed=row.get('privacy_review') or {}
                normal_scope_verified=(reviewed.get('decision')=='retain'
                                       and reviewed.get('source_revision')==revision(row))
                row['is_private']=bool(item['private'] or private_context(row) or not normal_scope_verified)
                row['recovery_scope_policy']='preserve restrictions; unknown legacy scope remains restricted'
                row.update(recovery_evidence_only=True,recovery_operation=operation_id)
                archive['sources'][mid]={'record':row,'body_sha256':item['body_sha256'],
                                        'original_revision':revision(item['row']),'locations':item['locations'],
                                        'archived_at':time.time()}
                recovered.append(mid)
            archive['operations'][operation_id]={'signature':signature,'source_ids':recovered,'at':time.time()}
            os.makedirs(os.path.dirname(path),exist_ok=True);atomic_write_json(path,archive)
        rows=[archive['sources'][mid]['record'] for mid in archive['operations'][operation_id]['source_ids']]
        # Existing scope/retirement metadata wins; reconstruction never removes it.
        indexed=evidence_store.load()
        evidence_store.preserve([row for row in rows if str(row['mem_id']) not in indexed])
        return {'state':'committed','source_evidence_recovered':len(rows),
                'active_pool_writes':0,'original_text_in_archive':True,'ordinary_raw_recall':False,
                'operation_id':operation_id,'retry':bool(previous)}
