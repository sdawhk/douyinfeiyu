"""Read-only one-hop lexical candidates, deliberately separate from vector scores."""
import math
import re
from collections import Counter, defaultdict
from services.recall_policy import select, row_of


def terms(text):
    # Explicit fallback tokenizer: Chinese character bigrams, not claimed to be words.
    out = set(re.findall(r'[a-zA-Z][a-zA-Z0-9_-]{1,}', text.lower()))
    for segment in re.findall(r'[\u4e00-\u9fff]+', text):
        out.update(segment[i:i+2] for i in range(len(segment)-1))
    out.difference_update({'他说','我回','这个','那个','然后','所以','因为','我们','你们','自己','一下'})
    return out


def expand(seed_ids, records, context, *, max_results=2, min_shared=2, max_df_share=.3):
    records = list(records)
    from services.evidence_store import load as load_evidence
    sources = load_evidence()
    sources.update({str(row_of(r).get('mem_id')):r for r in records})
    allowed = select(records, context, sources=sources)
    rows = {str(row_of(r).get('mem_id')):row_of(r) for r in allowed}
    tokens = {mid:terms(str(r.get('content') or '')) for mid,r in rows.items()}
    df = Counter(t for ts in tokens.values() for t in ts)
    n = len(rows)
    cap = max(2, int(n*max_df_share))
    index = defaultdict(set)
    for mid, ts in tokens.items():
        for token in ts:
            if 2 <= df[token] <= cap:
                index[token].add(mid)
    scores = {}
    seeds = set(str(s) for s in seed_ids)
    for seed in seeds:
        shared = defaultdict(set)
        for token in tokens.get(seed, set()):
            for target in index.get(token, ()):
                if target not in seeds:
                    shared[target].add(token)
        for target, overlap in shared.items():
            if len(overlap) < min_shared:
                continue
            score = sum(math.log(1+n/df[t]) for t in overlap) / max(1, len(tokens[target]))
            candidate = {'id':target, 'seed':seed, 'edge_type':'rare_bigrams',
                         'shared':sorted(overlap), 'edge_score':score,
                         'content':rows[target].get('content','')}
            if score > scores.get(target, {}).get('edge_score',-1):
                scores[target] = candidate
    return sorted(scores.values(),key=lambda x:(-x['edge_score'],x['id']))[:max_results]
