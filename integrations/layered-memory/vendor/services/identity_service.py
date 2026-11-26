"""Exact attributes from the current role configuration, never inferred from old chat."""
import hashlib
import os
import re
from datetime import datetime


def current_role_age(context, *, now=None):
    from slot_check import find_slot
    from services.evidence_semantics import requested_subject
    if find_slot(context.query)[0] != '年龄' or requested_subject(context.query) != 'role':
        return None
    import config
    path = config.ROLE_FILE_PATH
    try:
        with open(path, 'rb') as stream:
            raw = stream.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            return None
        text = raw.decode('utf-8-sig')
    except (FileNotFoundError, UnicodeError):
        return None
    year = (now or datetime.now()).year
    years={int(value) for value in re.findall(r'(\d{4})\s*年',context.query)}
    if (context.as_of is not None or years-{year}
            or re.search(r'去年|前年|当时|以前|那年|过去|曾经|明年|后年|将来',context.query)):
        return None
    # A dated, structured age field is configuration data. Undated prose,
    # instructions, historical notes ages and ages of other people are ignored.
    matches = re.findall(r'(?m)^\s*[-*]?\s*\*{0,2}年龄\*{0,2}\s*[：:]\s*(\d{1,2})\s*岁[^\n]*?\b(\d{4})\s*年', text)
    values = {int(age) for age, date in matches if int(date) == year}
    if len(values) != 1:
        return None
    age = values.pop()
    if not 0 <= age <= 120:
        return None
    digest = hashlib.sha256(raw).hexdigest()
    return {'mem_id': 'role-age-' + digest[:24], 'content': f'角色配置：{year} 年年龄为 {age} 岁。',
            'mem_type': 'role_attribute', 'source': 'current_role_configuration',
            'source_kind': 'configuration', 'speaker': 'role', 'subject': 'role',
            'session_id': context.session_id, 'recallable': 'yes', 'status': 'active',
            'create_time': os.path.getmtime(path), 'source_document': path,
            'source_document_sha256': digest, 'user_confirmed': True}
