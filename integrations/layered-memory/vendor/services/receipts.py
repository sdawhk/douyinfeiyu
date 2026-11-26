"""Compatibility receipts describe verified target outcomes, never aspirations."""
def receipt(result, *, target, operation_id=None, saved=None):
    out = dict(result)
    did_save = bool(out.get('written') if saved is None else saved)
    state = 'duplicate' if out.get('duplicate') else ('stored' if did_save else 'rejected')
    ids = [str(out['mem_id'])] if out.get('mem_id') else []
    targets = {target:{'state':state,'ids':ids,'reason':out.get('reason')}}
    if out.get('reason') == 'capacity_evicted':
        state = 'duplicate' if out.get('duplicate') else 'queued'
        targets[target]['state'] = 'capacity_evicted'
        targets['pending_longterm'] = {'state':'queued','ids':ids,'reason':'durable_overflow'}
    out.update(receipt_version=1, request_id=operation_id, state=state,
               targets=targets,
               retry_targets=[])
    return out
