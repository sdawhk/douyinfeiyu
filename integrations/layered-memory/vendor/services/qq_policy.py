"""QQ 共享摘要的准入规则。无身份上下文时不召回适配器数据。"""


def visible(record, context):
    row = record if isinstance(record, dict) else vars(record)
    meta = row.get('qq_memory')
    if not isinstance(meta, dict) or not meta or meta.get('bot') != context.get('bot'):
        return False
    if row.get('status') != 'active' or row.get('deleted') or row.get('recall_excluded'):
        return False
    if row.get('corrected_by') or row.get('superseded_by'):
        return False
    visibility = meta.get('visibility')
    if meta.get('confidential'):
        return meta.get('chat') == context.get('chat') and meta.get('subject') == context.get('actor')
    if visibility == 'public':
        return meta.get('kind') == 'event'
    if visibility == 'person':
        return meta.get('subject') == context.get('actor')
    if visibility == 'chat':
        return meta.get('chat') == context.get('chat') and (
            str(meta.get('chat', '')).startswith('group:') or meta.get('subject') == context.get('actor'))
    return False
