"""Recognize faithful copies of private raw turns across otherwise unlinked channels."""
import json
import os
import re

_cache = None


def _text(value):
    value = str(value or '').replace('\r\n','\n').replace('\n',' / ')
    return re.sub(r'\s+', '', value)


def pair(row):
    if row.get('his') is not None or row.get('said') is not None:
        return _text(row.get('his')), _text(row.get('said'))
    match = re.fullmatch(r'他说[：:](.*?)；我回[：:](.*)',str(row.get('content') or ''),re.S)
    return (_text(match.group(1)),_text(match.group(2))) if match else ('','')


def build_index(rows):
    ids = set(); pairs = set()
    for row in rows:
        if row.get('mem_id'):
            ids.add(str(row['mem_id']))
        his,said = pair(row)
        # Short confirmations recur in ordinary dialogue. They cannot establish
        # that two turns are the same private event without an ID link.
        if len(his)+len(said)>=24 and len(said)>=12:
            pairs.add((his,said))
    return ids,pairs


def _body_key(row):
    if row.get('his') is not None or row.get('said') is not None:
        body='他说：'+str(row.get('his') or '')+'；我回：'+str(row.get('said') or '')
    else:
        body=str(row.get('content') or '')
    if not re.match(r'^他说[：:]',body) or not re.search(r'；我回[：:]',body):
        return ''
    body=re.sub(r'^他说[：:]','他说：',body).replace('；我回:','；我回：')
    key=_text(body)
    return key if len(key)>=24 else ''


def is_private_copy(row):
    global _cache
    import config
    path = config.LONG_TERM_ACTIVE_PATH
    archive_path=os.path.join(config.BASE_DIR,'state','recovered_source_archive.json')
    def signature(filename):
        try:
            stat=os.stat(filename)
            return (filename,stat.st_mtime_ns,stat.st_size)
        except FileNotFoundError:return (filename,None,None)
    stamp=(signature(path),signature(archive_path))
    if _cache is None or _cache[0]!=stamp:
        if stamp[0][1] is None:
            rows=[]
        else:
            with open(path,encoding='utf-8') as stream:
                rows=[r for r in json.load(stream)['memories']
                      if r.get('is_private') or r.get('category') == 'private']
        if stamp[1][1] is not None:
            with open(archive_path,encoding='utf-8') as stream:
                archived=json.load(stream)['sources']
            rows=rows+[entry['record'] for entry in archived.values() if entry['record'].get('is_private')]
        _cache=(stamp,build_index(rows),{key for row in rows if (key:=_body_key(row))})
    ids,pairs=_cache[1]
    return (str(row.get('mem_id') or '') in ids or pair(row) in pairs
            or bool((key:=_body_key(row)) and key in _cache[2]))
