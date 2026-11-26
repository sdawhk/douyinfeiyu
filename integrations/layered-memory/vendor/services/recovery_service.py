"""Classify historical gaps without restoring deleted or unverifiable evidence."""
import hashlib
import json
import os
from pathlib import Path


def inventory(manager, *, backup_dir=None, persist=True):
    from services.evidence_store import load as evidence
    from services.deletion_service import load as deletions
    pools={}
    with manager.lock:
        for pool in ('active','shortterm','cold'):
            path=manager._pool_path(pool)
            try:
                with open(path,encoding='utf-8') as f:pools[pool]=json.load(f).get('memories',[])
            except FileNotFoundError:pools[pool]=[]
    known={str(row.get('mem_id')) for rows in pools.values() for row in rows if row.get('mem_id')}
    known.update(evidence());retired=set(deletions().get('ids',{}))
    records={};needed=set()
    for pool,rows in pools.items():
        for row in rows:
            refs={str(mid) for mid in (row.get('source_turns') or [])+(row.get('out_turns') or [])}
            missing=sorted(refs-known);deleted=sorted(refs & retired)
            if missing or deleted:
                records[str(row.get('mem_id'))]={'pool':pool,'state':'excluded_parent' if deleted else 'quarantined_source',
                    'missing_refs':missing,'deleted_refs':deleted,'backup_status':'not_scanned',
                    'automatic_restore':False}
                needed.update(missing)
    locations={};scanned=0;bad=0
    if backup_dir:
        root=Path(backup_dir).resolve()
        if not root.is_dir():raise ValueError('backup directory unavailable')
        paths=sorted(root.rglob('*owner*.json*'))
        for path in paths[:1000]:
            if not path.is_file():continue
            if not path.resolve().is_relative_to(root) or path.stat().st_size>64*1024*1024:
                bad+=1;continue
            try:
                raw=path.read_bytes();data=json.loads(raw.decode('utf-8-sig'));scanned+=1
            except (ValueError,UnicodeError,OSError):bad+=1;continue
            for row in data.get('memories',[]) if isinstance(data,dict) else []:
                mid=str(row.get('mem_id') or '')
                if mid in needed:
                    locations.setdefault(mid,[]).append({'file':str(path),'file_sha256':hashlib.sha256(raw).hexdigest(),
                        'scope_restricted':bool(row.get('is_private')) or row.get('category')=='private',
                        'retired':mid in retired or bool(row.get('deleted') or row.get('corrected_by') or row.get('superseded_by'))})
    counts={'locatable':0,'partial':0,'unrecoverable':0,'excluded_parent':0}
    for row in records.values():
        found=[mid for mid in row['missing_refs'] if mid in locations]
        row['located_ids']=found
        if row['deleted_refs']:state='excluded_parent'
        elif len(found)==len(row['missing_refs']):state='locatable'
        elif found:state='partial'
        else:state='unrecoverable'
        row['backup_status']=state;counts[state]+=1
    out={'version':2,'state':'classified','records':records,'counts':counts,'source_locations':locations,
         'backup_files_scanned':scanned,'unreadable_backup_files':bad,'restored':0,
         'policy':'missing_or_deleted_evidence_stays_excluded','operator_action_required_for_normal_operation':False}
    out['quarantined_ids']=sorted(records)
    out['backups_are_candidates_not_authorization']=True
    if persist:
        import config
        from atomic_io import atomic_write_json
        target=os.path.join(config.BASE_DIR,'state','recovery_inventory.json')
        os.makedirs(os.path.dirname(target),exist_ok=True);atomic_write_json(target,out)
    return out
