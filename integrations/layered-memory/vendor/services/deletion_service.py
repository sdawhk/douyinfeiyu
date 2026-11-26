"""Deletion tombstones survive stale caches, backup copies and queued writes."""
import json
import os
import time


def _path():
    import config
    return os.path.join(config.BASE_DIR,'state','deletions.json')


def load():
    try:
        with open(_path(),encoding='utf-8') as f:data=json.load(f)
        if not isinstance(data,dict) or not isinstance(data.get('ids',{}),dict):
            raise ValueError('invalid deletion index')
        return data
    except FileNotFoundError:
        return {'ids':{},'sources':{}}


def source_key(session_id,message_id,attachment_index=None):
    return json.dumps([str(session_id or ''),str(message_id or ''),attachment_index],ensure_ascii=False)


def excluded(row, *, index=None):
    data = load() if index is None else index
    if str(row.get('mem_id') or '') in data.get('ids',{}):return True
    message=row.get('source_message_id')
    if message:
        key=source_key(row.get('session_id'),message,row.get('attachment_index'))
        return key in data.get('sources',{})
    return False


def retire(manager,ids,*,operation_id,reason='explicit deletion'):
    if not operation_id or not ids:raise ValueError('deletion requires ids and operation_id')
    from atomic_io import atomic_write_json
    wanted={str(mid) for mid in ids};found=[]
    with manager.lock:
        data=load();paths=[manager._pool_path(pool) for pool in ('active','shortterm','cold')]
        import config
        paths.append(config.WORKING_MEM_PATH)
        for path in paths:
            try:
                with open(path,encoding='utf-8') as f:document=json.load(f)
            except FileNotFoundError:continue
            rows=list(document.get('memories',[]))
            rows.extend(r for session in document.get('sessions',{}).values() for r in session.get('working_memory',[]))
            found.extend(r for r in rows if str(r.get('mem_id')) in wanted)
        at=time.time()
        for mid in wanted:
            data.setdefault('ids',{}).setdefault(mid,{'at':at,'operation_id':operation_id,'reason':reason})
        for row in found:
            if row.get('source_message_id'):
                data.setdefault('sources',{})[source_key(row.get('session_id'),row['source_message_id'],row.get('attachment_index'))]={'at':at,'operation_id':operation_id}
        os.makedirs(os.path.dirname(_path()),exist_ok=True)
        # Commit exclusion first: a crash can leave old bytes, never visible old content.
        atomic_write_json(_path(),data)
        return {'state':'retired','ids':sorted(wanted),'located':len(found),'written':True}
