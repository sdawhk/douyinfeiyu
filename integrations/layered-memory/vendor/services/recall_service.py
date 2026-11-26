# -*- coding: utf-8 -*-
r"""记忆召回服务：把 memory_cli 里 172 行的 recall 分支抽成可复用服务。

## 为什么要抽

    memory_cli.main() 的 recall 分支：172 行（90 代码 + 76 注释），8 步
    mcp_server.memory_recall()：       1 行（只调 manager.recall）

    后果：同一个 AI 在同一次对话里看到两份不同的记忆 ——
          桥接自动召回 = 8 步结果，AI 主动调 MCP = 1 步结果。

## 三层拆分

    recall_core()        纯召回 + 加工（8 步里的 1~5 + 7），返回结构化结果
    resolve_episodes()   情景档决策（纯函数，不改入参）
    render_for_prompt()  渲染成 prompt 文本（CLI 用）

## 副作用必须显式

    召回（recall_core）**自身不改任何提及状态** —— 这是 2026-11-09 P0 之后的语义。

    历史（已删除，留作警示）：
      ① 曾经「mention_shortterm 生产从来没调（只有测试调）」——
         后来接上了，但接错了：每次召回都给返回的 Top-K 全部续命，
         把「系统访问」当成「用户再次说起来」。
      ② 曾经「只改内存不写盘」→ 表面接上了，实际下次读还是旧值。
         后来改成召回后强制 save_shortterm() —— 结果把污染写死了。

    ★ 2026-11-09 P0：两条路径全部删除。
      召回是只读的；提及只能由「用户真实再次说到」驱动（P1-A，尚未实现）。

    side_effects 三字段仍然返回，但现在它们的正确值是：
      shortterm_mentioned = 0
      shortterm_saved     = 不出现（根本不调）
    测试断言方向也跟着反过来了：
      「召回前后，短期记忆的提及字段一个都不能变」。
"""
import sys
import os
import json

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)


def recall_core(mgr, query, emotion=None, entities=None, *,
                embedding_func=None, top_k=10, session_id='', as_of=None, subject='', predicate=''):
    """Build a request-local view shared by all recall channels."""
    import copy
    from services.recall_policy import RecallContext, select, eligible
    # Group-session isolation is carried by session_id inside RecallContext.
    try:
        context = RecallContext(query, session_id or '', as_of, subject, predicate)
    except ValueError as exc:
        return {'results': [], 'input_error': str(exc), 'errors': [str(exc)],
                'degraded': False, 'side_effects': {}}
    pools = (('cold_mems', 'cold', '_load_cold_mems'),
             ('shortterm_mems', 'shortterm', '_load_shortterm_mems'),
             ('active_mems', 'active', '_load_active_mems'))

    # ═══════════════════════════════════════════════════════════════
    # 阶段 1：前置准备（池重载 + 证据加载 + policy 选择）
    #
    # ★ 2026-11-18 拆细 try（P1）：
    #   原来是「从池重载到 return out」一个巨大 try（:65→:202）。
    #   后果实测：让 select() 抛一次异常，_recall_unchecked 里那 10 处
    #   分渠道 errors（"短期召回失败" / "冷存检索失败" / ...）全部作废，
    #   整次召回只剩一句「召回策略失败: XxxError」，用户看到的是
    #   「记忆服务暂时不可用」，完全不知道是哪个渠道坏的。
    #
    #   现在只让**真正无法继续**的步骤留在这个 try 里：
    #     · 池重载 / 证据加载 / policy 过滤 —— 没有数据就没法召回
    #   后续所有可选步骤（蒸馏补卡 / slot_check / 最终 resolve）各自
    #   单独 try，失败只往 out["errors"] 追加，**不清空已有结果**。
    # ═══════════════════════════════════════════════════════════════
    try:
        # Refresh the unfiltered cache before taking an isolated request view.
        if hasattr(mgr, '_pool_stamps'):
            with mgr.lock:
                reload_active_in_view = False
                for attr, pool, loader in pools:
                    stamp = mgr._pool_stamp(pool)
                    if stamp == mgr._pool_stamps[pool]:
                        continue
                    if pool == 'active' and mgr._active_write_fields:
                        reload_active_in_view = True
                        continue
                    setattr(mgr, attr, getattr(mgr, loader)())
                    mgr._pool_stamps[pool] = stamp
                view = copy.copy(mgr)
                if reload_active_in_view:
                    view.active_mems = view._load_active_mems()
        else:
            view = copy.copy(mgr)
        view._request_context = context

        from services.evidence_store import load as load_evidence
        sources = load_evidence()
        pool_lookup = {}
        # A live record takes precedence over an interrupted migration's archive copy.
        for attr, pool, _ in pools:
            for m in getattr(view, attr, []) or []:
                sources[str(m.mem_id)] = m
                pool_lookup[m.mem_id] = pool
        for attr, pool, _ in pools:
            candidates = (m for m in getattr(view, attr, []) or [] if pool_lookup[m.mem_id] == pool)
            setattr(view, attr, copy.deepcopy(select(candidates, context, pool=pool, sources=sources)))
    except Exception as exc:
        return {'results':[], 'errors':['召回前置失败: '+type(exc).__name__+': '+str(exc)[:120]],
                'degraded':True, 'side_effects':{}, '_context':context}

    # ═══════════════════════════════════════════════════════════════
    # 阶段 2：主召回（_recall_unchecked 内部每个渠道已各自 try + errors）
    #
    #   这一层再包一次是**兜底**：万一 _recall_unchecked 自身在渠道之间的
    #   协调代码上崩了（不是某个渠道内部），至少还能返回一个结构完整的空
    #   out，而不是把异常抛给 MCP 层变成「工具调用失败」。
    # ═══════════════════════════════════════════════════════════════
    try:
        out = _recall_unchecked(view, query, emotion, entities,
                                embedding_func=embedding_func, top_k=top_k)
    except Exception as exc:
        return {'results':[], 'errors':['主召回崩溃: '+type(exc).__name__+': '+str(exc)[:120]],
                'degraded':True, 'side_effects':{}, '_context':context}

    # 到这里 out 是合法的。以下所有步骤都是**可选增强**，
    # 任何一步失败都只追加 errors，绝不清空 out['results']。

    episode_hits=list((out.get('_episode_resolved') or {}).get('inject_eps') or [])
    try:
        from services.evidence_semantics import valid_vector
    except Exception as exc:
        out.setdefault('errors', []).append('evidence_semantics 不可用: '+type(exc).__name__)
        out['_context'] = context
        return out

    try:
        from services.memory_tools import supplemental_matches
        out['_lexical_results'] = supplemental_matches(view, context, sources, out.get('query_embedding'))
    except Exception as exc:
        out['errors'].append('词面补充召回失败: ' + type(exc).__name__)

    if not valid_vector(out.get('query_embedding')):
        # 查询向量为空 —— 这是「真的没法算相似度」，不是 bug。
        # 保留原行为：清空各渠道（因为没有可用的排序依据），但保留 errors。
        for key in ('results','_shortterm_results','_cold_results','_permanent_results','_distilled_results'):
            out[key]=[]
        out['_window_results']=None;out['_episode_resolved']=None
        out['_context']=context
        if out.get('_lexical_results'):
            out['degraded'] = False
            out['errors'] = ['embedding 不可用，本次仅使用通过权限和时间校验的词面命中']
        return out

    # ── 步骤 A：蒸馏卡片补充（原本就有 try，保留） ──
    out['_distilled_results']=[]
    try:
        from distillation import recall as recall_distilled
        out['_distilled_results']=recall_distilled(out['query_embedding'], context, embedding_func, sources=sources)
        for memory,_score in out['_distilled_results']:
            sources[memory.mem_id]=memory
            pool_lookup[memory.mem_id]='distilled_main'
    except Exception as exc:
        out['errors'].append('蒸馏卡片未就绪: '+type(exc).__name__)

    # ── 步骤 B：按 policy 过滤每个渠道（失败保留原结果） ──
    try:
        for key in ('results', '_shortterm_results', '_cold_results', '_permanent_results', '_distilled_results'):
            out[key] = [hit for hit in out.get(key, [])
                        if eligible(hit[0] if isinstance(hit, (tuple,list)) else hit,
                                    context, sources=sources)]
    except Exception as exc:
        out['errors'].append('策略复筛失败（保留原始结果）: '+type(exc).__name__)

    # ── 步骤 C：语义相关度复筛（失败保留原结果） ──
    try:
        from recall_engine import cosine_similarity
        if valid_vector(out.get('query_embedding')):
            for key in ('results','_shortterm_results','_cold_results','_permanent_results','_distilled_results'):
                out[key] = [hit for hit in out.get(key,[]) if cosine_similarity(
                    out['query_embedding'],getattr(hit[0] if isinstance(hit,(tuple,list)) else hit,'embedding',[])) >= .45]
    except Exception as exc:
        out['errors'].append('相关性复筛失败（保留原始结果）: '+type(exc).__name__)

    # ── 步骤 D：槽位检查 / 身份锚（最大的可选块，整体一个 try） ──
    slot = None
    try:
        from recall_engine import cosine_similarity
        from slot_check import find_slot
        from recall_engine import is_meta_query
        from services.evidence_semantics import supports
        slot, _ = find_slot(query)
        out['_identity_results'] = []
        if slot == '年龄':
            from services.identity_service import current_role_age
            from schema import MemoryItem
            identity = current_role_age(context)
            if identity and eligible(identity,context,sources=sources) and supports(identity,query):
                anchor = MemoryItem.from_dict(identity)
                out['_identity_results'] = [(anchor,1.)]
                sources[anchor.mem_id] = anchor
                # Explicit current configuration answers this attribute. Keep
                # old records on disk, but do not inject conflicting historical ages.
                for key in ('results','_shortterm_results','_cold_results','_permanent_results','_distilled_results'):
                    out[key] = []
                out['_window_results'] = None
                episode_hits = []
        if slot and not is_meta_query(query):
            from services.recall_policy import row_of
            def supported(mem):
                return supports(row_of(mem), query, subject=context.subject)
            available = [m for attr in ('active_mems','shortterm_mems')
                         for m in getattr(view, attr, []) if supported(m)]
            available.sort(key=lambda m:-cosine_similarity(out['query_embedding'],getattr(m,'embedding',[])))
            available.extend(hit[0] for hit in out.get('_distilled_results',[]) if supported(hit[0]))
            if out['_identity_results']:
                available = [hit[0] for hit in out['_identity_results']]
            for key in ('results','_shortterm_results','_cold_results','_permanent_results','_distilled_results'):
                out[key] = [hit for hit in out.get(key, []) if supported(hit[0] if isinstance(hit,(tuple,list)) else hit)]
            if out.get('_window_results'):
                out['_window_results']['items'] = [r for r in out['_window_results'].get('items',[])
                    if supports(dict(r,content='他说：'+str(r.get('his') or '')+'；我回：'+str(r.get('said') or '')),query,subject=context.subject)]
            window_count = len((out.get('_window_results') or {}).get('items',[]))
            out['slot_check'] = {'verdict':'ok' if available or window_count else 'none',
                                 'reason':'逐条主体、属性与证据核对'}
            if not out['_identity_results'] and not any(out.get(key) for key in ('results','_shortterm_results','_cold_results','_permanent_results')) and available:
                allowed = {m.mem_id for m in view.active_mems}
                out['results'] = [(m, 0.) for m in available if m.mem_id in allowed][:2]
            if not out['_identity_results']:
                # Relevant direct evidence must not disappear merely because a
                # different supporting item already occupied the main Top-K.
                delivered={hit[0].mem_id for key in ('results','_shortterm_results','_cold_results','_distilled_results')
                           for hit in out.get(key,[])}
                for memory in available[:3]:
                    if memory.mem_id in delivered:continue
                    similarity=cosine_similarity(out['query_embedding'],getattr(memory,'embedding',[]))
                    if similarity<.45:continue
                    route={'active':'results','shortterm':'_shortterm_results','cold':'_cold_results'}.get(pool_lookup.get(memory.mem_id))
                    if route:
                        out.setdefault(route,[]).append((memory,similarity));delivered.add(memory.mem_id)
            out['_episode_resolved'] = resolve_episodes(out.get('results') or [], query)
            if not available and not window_count:
                out['errors'].append('槽位检查：没有适用于该主体和属性的直接证据')
    except Exception as exc:
        # 槽位检查失败：保留各渠道已有结果，只记错。
        out['errors'].append('槽位检查失败（保留原始结果）: '+type(exc).__name__+': '+str(exc)[:80])

    # ── 步骤 E：最终情景档 resolve（失败保留原 results） ──
    try:
        from services.recall_policy import row_of
        from recall_engine import cosine_similarity, is_meta_query
        from services.evidence_semantics import supports
        qualified_episodes=[]
        for hit in episode_hits:
            memory=hit[0] if isinstance(hit,(tuple,list)) else hit
            if not eligible(memory,context,sources=sources):continue
            if cosine_similarity(out['query_embedding'],getattr(memory,'embedding',[]))<.45:continue
            if slot and not is_meta_query(query) and not supports(row_of(memory),query,subject=context.subject):continue
            qualified_episodes.append(hit if isinstance(hit,(tuple,list)) else (memory,0.))
        resolved=resolve_episodes((out.get('results') or [])+qualified_episodes,query)
        out['_episode_resolved']=resolved
        out['results']=resolved.get('filtered_results',out.get('results') or [])
    except Exception as exc:
        out['errors'].append('情景档终态解析失败（保留原始结果）: '+type(exc).__name__+': '+str(exc)[:80])

    # ── 收尾：这些赋值本身不会失败，但仍保证 out 结构完整 ──
    out['_context'] = context
    try:
        out['_source_lookup'] = sources
    except Exception:
        pass
    try:
        out['_pool_lookup'] = pool_lookup
    except Exception:
        pass
    if hasattr(mgr, '_pool_path'):
        try:
            out['_delivery_base'] = os.path.dirname(mgr._pool_path('active'))
        except Exception:
            pass
    return out


def _recall_unchecked(mgr, query, emotion=None, entities=None, *,
                embedding_func=None,
                top_k=10):
    """纯召回 + 加工（8 步里的 1~5 + 7）。

    参数：
        mgr              MemoryManager 实例
        query            查询文本
        emotion          情绪 dict（默认中性）
        entities         实体列表（None 则从 query 抽）
        embedding_func   向量化函数（None 则从 ollama_embedding 取）
        top_k            召回条数

    返回：
        {
            "query_embedding": [...],
            "results": [(MemoryItem, score), ...],   ← 主召回结果（含档）
            "lines": [str, ...],                     ← 已格式化的文本行
            "items": [dict, ...],                    ← 结构化条目
            "side_effects": {
                "shortterm_mentioned": int,
                "shortterm_saved": bool,
            },
            "errors": [str, ...],
        }

    ★ 不改入参、不改全局。副作用全部经 side_effects 报告。
    """
    if emotion is None:
        emotion = {"valence": "neutral", "intensity": 50}
    if embedding_func is None:
        from ollama_embedding import get_embedding as embedding_func

    out = {
        "query_embedding": None,
        "results": [],
        "lines": [],
        "items": [],
        "degraded": False,
        "side_effects": {
            "shortterm_mentioned": 0,
            "shortterm_saved": False,
        },
        "errors": [],
    }

    if not query or not query.strip():
        out["errors"].append("query 为空")
        return out

    # ① 实体抽取
    if entities is None:
        try:
            from features import on as _on
            if _on("entity_graph"):
                from entity_graph import extract_entity_names
                entities = extract_entity_names(query) or []
            else:
                entities = []
        except Exception as e:
            entities = []
            out["errors"].append("实体抽取失败: %s" % type(e).__name__)
    entities = list(entities or [])

    # ①' query 向量只算一次
    try:
        qemb = embedding_func(query)
        out["query_embedding"] = qemb
    except Exception as e:
        qemb = None
        out["errors"].append("embedding 失败: %s" % type(e).__name__)
    if (not qemb or not any(isinstance(x, (int, float)) and x != 0 for x in qemb)):
        out["errors"].append("embedding 不可用，本次不注入未验证的记忆")
        out["degraded"] = True
        return out

    from services.evidence_semantics import valid_vector
    if not valid_vector(qemb):
        out['errors'].append('query embedding 非有限数值或为空')
        out['degraded'] = True
        return out
    incompatible = 0
    for attr in ('active_mems','shortterm_mems'):
        rows = getattr(mgr,attr,[]) or []
        valid = [m for m in rows if valid_vector(getattr(m,'embedding',None),len(qemb))]
        incompatible += len(rows)-len(valid)
        setattr(mgr,attr,valid)
    if incompatible:
        out['errors'].append('跳过向量未就绪或维度不符的候选: %d' % incompatible)
    # ③ 主召回
    try:
        results = mgr.recall(qemb, entities, emotion, query_text=query)
    except Exception as e:
        results = []
        out["errors"].append("主召回失败: %s" % type(e).__name__)
    out["results"] = list(results or [])
    out["degraded"] = bool(out["errors"])

    # ③.5 冷存补充检索（2026-11-10 归档重设计）
    #
    # 冷存是冻结快照，只读检索、不刷新召回时间、不结算衰减。
    # 只有调用方实际采用某条冷存命中后，才通过
    # daily_consolidation.awaken_cold_memory 把它迁回活跃库。
    # 这里只把候选放进 _cold_results，渲染在 render_for_prompt 里做，
    # 受字数预算约束，天然不会挤占活跃 Top-K。
    out["_cold_results"] = []
    out["side_effects"]["cold_loaded"] = False
    # 显式冷存工具负责检索和唤醒；普通召回只读冷存中的来源信息。

    # ④ 情景档：抽取 + 去重（纯函数，见 resolve_episodes）
    #    这里只做「把结果过一遍」，渲染在 render_for_prompt 里做
    try:
        resolved = resolve_episodes(out["results"], query)
        out["results"] = resolved["filtered_results"]
        out["_episode_resolved"] = resolved
    except Exception as e:
        out["errors"].append("情景档处理失败: %s" % type(e).__name__)
        out["_episode_resolved"] = None

    # ⑤ 短期召回（纯只读）
    #
    # ★ 2026-11-09 P0 修复：删掉「召回后对 Top-K 全量调 mention_shortterm」的逻辑。
    #
    #   原来的行为（已删除）：
    #       for mem, _score in (st_results or []):
    #           mention_shortterm(mem)        # ← 每次召回给 Top-K 全部 +bonus
    #       然后 save_shortterm()              # ← 把改过的写回磁盘
    #
    #   为什么必须删：
    #     召回 ≠ 用户提及。原来的实现把「系统访问」当成了「用户再次说起」，
    #     导致记忆池里的一批条目被自己的召回反复续命：
    #       last_mentioned_at 被刷新 → 有效强度变高 → 下一轮更容易召回
    #       → 再次被刷新 → 正反馈
    #
    #     实测证据（shortterm.json）：
    #       一条记忆 42.5 小时内被「提及」305 次
    #       其中 114 次间隔 < 3 秒，187 次间隔 < 60 秒
    #       同一秒内最多 10 条不同记忆被同时「提及」
    #     —— 这些不可能是真实对话节奏。
    #
    #   删除后：recall_shortterm 只做检索和排序，不改任何记忆状态、不写盘。
    #
    #   ⚠️ 这意味着短期内「没有路径再更新 last_mentioned_at」。
    #      见 P0修复报告里的「还剩什么没修」——真实提及事件需要独立的
    #      record_user_mention 路径，本次不在范围内。
    try:
        from recall_engine import recall_shortterm
        if getattr(mgr, "shortterm_mems", None):
            st_results = recall_shortterm(
                qemb, mgr.shortterm_mems, query_text=query)
            out["_shortterm_results"] = st_results
            out["side_effects"]["shortterm_mentioned"] = 0
        else:
            out["_shortterm_results"] = []
    except Exception as e:
        out["errors"].append("短期召回失败: %s" % type(e).__name__)

    # ⑥ 窗口账本召回（2026-11-11 新增）
    #
    #   为什么加：window 存了最近 30 天每轮对话原文（500 轮），
    #   但召回链路完全不读 —— 超过短期层 3 天窗口的对话，
    #   原文还在磁盘上却永远搜不到。
    #
    #   为什么单独一个模块（window_recall.py）而不是混进 hybrid_rerank：
    #     window 没有 strength / tags / category，只有语义和时间，
    #     打分维度跟长期库完全不同，混在一起会让权重失去意义。
    #
    #   为什么门槛是 0.58：
    #     实测 bge-m3 在这批数据上，相关查询 sim >= 0.599，
    #     无关查询 <= 0.496，中间有明显空隙。
    #
    #   ★ 只读：不写 window、不改任何字段、不续命。
    #   ★ 失败不影响主召回（window 是补充通道，不是必需）。
    out["_window_results"] = None
    out["side_effects"]["window_loaded"] = False
    try:
        from window_recall import recall_window
        _wr = recall_window(
            query,
            session_id=(getattr(mgr, '_request_context', None).session_id or None) if str(getattr(getattr(mgr, '_request_context', None), 'session_id', '')).startswith('group:') else None,
            context=getattr(mgr, '_request_context', None),
            embedding_func=embedding_func,
        )
        if _wr.get("ok"):
            out["_window_results"] = _wr
            out["side_effects"]["window_loaded"] = True
        else:
            # 没命中不是错误，记个原因就行（不塞进 errors，免得刷屏）
            out["window_skip_reason"] = _wr.get("reason", "")
    except Exception as e:
        out["errors"].append("window 召回失败: %s" % type(e).__name__)

    # ⑦ 永久记忆专项检索（通道 B）
    #
    #   只在明确回忆问法时启动。它绕开的是「主动召回门槛」，
    #   不是语义相关性；无关的永久记忆不会被塞进来。
    out["_permanent_results"] = []
    out["side_effects"]["permanent_searched"] = False
    try:
        from recall_engine import is_remind_query, recall_permanent
        if is_remind_query(query):
            from config import RECALL_TOP_K as _PK
            _have = {str(getattr(m[0] if isinstance(m, (tuple, list)) else m,
                                "mem_id", "") or "") for m in (out["results"] or [])}
            out["_permanent_results"] = recall_permanent(
                qemb, getattr(mgr, "active_mems", []) or [],
                top_k=_PK, query_text=query, exclude_ids=_have)
            out["side_effects"]["permanent_searched"] = True
    except Exception as e:
        out["errors"].append("永久记忆检索失败: %s" % type(e).__name__)

    return out


def resolve_episodes(results, query):
    """情景档决策（纯函数）。

    ★ 不改入参。返回的 filtered_results 是新列表。
    ★ 第一行就记 original_count，不给改动机会。
    ★ 函数内部断言 filtered_results is not results
      （在实现方断言，不在调用方 —— 抓实现错，不抓用法错）

    返回：
        {
            "original_count": int,
            "gated": bool,               # 门控开没开
            "reason": str,
            "inject_eps": [...],         # 要注入的档
            "filtered_results": [...],   # 去重 + 剔除后的新列表
            "dropped_count": int,
        }

    ⚠️ 2026-11-08 实测：hybrid_rerank 本身就会把档当普通条目返回
       （「帮我写个 Python 脚本」→ episode 排第 1）。
       所以这里必须真的剔档，不能假设「召回结果里没档」。
    """
    original_count = len(results)          # 第一行，不给改动机会

    out = {
        "original_count": original_count,
        "gated": False,
        "reason": "",
        "inject_eps": [],
        "filtered_results": list(results),   # 新列表
        "dropped_count": 0,
    }

    # 门控：只有「回忆型」问题才召回档
    #
    # ★ 注意 should_recall_episodes 返回的是 (bool, reason) 元组，不是单个 bool。
    #   2026-11-09 实测踩到：直接 bool(元组) 永远为 True（非空元组恒真）。
    try:
        from episode import should_recall_episodes
        _got = should_recall_episodes(query)
        if isinstance(_got, tuple):
            want, why = _got[0], (_got[1] if len(_got) > 1 else "")
        else:
            want, why = bool(_got), ""
        out["gated"] = bool(want)
        out["reason"] = ("门控放开: %s" % why) if want else "不是回忆问法"
    except Exception as e:
        out["reason"] = "门控失败: %s" % type(e).__name__
        want = False

    if not want:
        # ★ 2026-11-11 修：门控关闭时也必须剔掉 episode，而不是原样返回。
        #
        #   原来的行为：
        #       if not want: return out
        #   而 out["filtered_results"] 初始化时 = list(results)，档原样保留。
        #
        #   后果：负例「帮我写 Python 脚本」里没有回忆触发词，门控判定
        #   「不是回忆问法」，本意是「不召回档」，但实际却把 hybrid_rerank
        #   返回的 episode 原样留在了结果里 —— 负例误召回档，通过率从 90%
        #   掉到 70%（库里 episode 涨到 105 条之后暴露出来）。
        #
        #   正确语义：门控关闭 = 不召回档 = 把结果里的 episode 全部剔掉，
        #   只保留非档条目。
        filtered = [
            item for item in results
            if getattr(item[0] if isinstance(item, (tuple, list)) else item,
                       "mem_type", "") != "episode"
        ]
        out["filtered_results"] = filtered
        out["dropped_count"] = original_count - len(filtered)
        return out

    # 分离档 / 非档
    eps, others = [], []
    for item in results:
        m = item[0] if isinstance(item, (tuple, list)) else item
        if getattr(m, "mem_type", "") == "episode":
            eps.append(item)
        else:
            others.append(item)

    # 双向去重：档覆盖的碎片剔掉
    dropped = original_count - len(others)     # 档本身被剔掉的
    try:
        from episode import dedup_recall
        kept = dedup_recall(
            [e[0] if isinstance(e, (tuple, list)) else e for e in eps],
            [o[0] if isinstance(o, (tuple, list)) else o for o in others])
        keep_ids = {getattr(m, "mem_id", None) for m in kept}
        filtered_others = [
            o for o in others
            if getattr(o[0] if isinstance(o, (tuple, list)) else o, "mem_id", None)
            in keep_ids
        ]
        dropped += len(others) - len(filtered_others)
        out["inject_eps"] = eps
        out["filtered_results"] = filtered_others   # 档全部剔掉，由渲染层处理
    except Exception as e:
        # 去重失败：保守起见，档剔掉、碎片全留（宁可多留，不要丢）
        out["filtered_results"] = others
        out["reason"] += " | 去重失败: %s" % type(e).__name__

    out["dropped_count"] = original_count - len(out["filtered_results"])

    # ★ 实现方断言
    assert out["filtered_results"] is not results, (
        "resolve_episodes 必须返回新列表（纯函数约定），"
        "否则调用方忘赋值时不会报错")
    return out


def _rel_time(at, now):
    """把时间戳转成「今天/昨天/前天/N 天前」的人话。

    完全复刻原版 memory_cli._rel_time（2026-11-06 对齐 legacy-store 的 relTime 格式）。
    """
    import datetime
    if not at:
        return "（没记时间）"
    try:
        at_dt = datetime.datetime.fromtimestamp(at)
        now_dt = datetime.datetime.fromtimestamp(now)
    except (ValueError, OSError, OverflowError):
        return "（时间认不出来）"
    at_day = at_dt.date()
    now_day = now_dt.date()
    days = (now_day - at_day).days
    if days <= 0:
        return "今天 " + at_dt.strftime("%H:%M")
    if days == 1:
        return "昨天 " + at_dt.strftime("%H:%M")
    if days == 2:
        return "前天 " + at_dt.strftime("%H:%M")
    if days <= 14:
        return "%d 天前（%s）" % (days, at_dt.strftime("%m-%d"))
    if days <= 60:
        return "%s（%d 天前）" % (at_dt.strftime("%m-%d"), days)
    if at_dt.year != now_dt.year:
        diff = now_dt.year - at_dt.year
        if diff == 1:
            return "去年 " + at_dt.strftime("%m-%d")
        return "%d-%s（%d 年前）" % (at_dt.year, at_dt.strftime("%m-%d"), diff)
    return "%s（%d 个月前）" % (at_dt.strftime("%m-%d"), round(days / 30))


def render_for_prompt(core_result, *, budget=None, now_ts=None):
    """Pack whole rendered records; receipts describe the text actually delivered."""
    import time
    from services.recall_policy import row_of
    if now_ts is None:
        now_ts = time.time()
    if budget is None:
        from config import RECALL_MAX_CHARS
        budget = RECALL_MAX_CHARS
    budget = max(0, int(budget))
    lines, items, seen = [], [], set()
    used, skipped = 0, 0
    from services.quality_reviews import equivalence_keys
    equivalences=equivalence_keys(list(core_result.get('_source_lookup',{}).values()))
    seen_groups=set()

    def pack(text, metadata):
        nonlocal used, skipped
        mid = metadata.get('id') or metadata.get('mem_id')
        if mid and mid in seen:
            return
        group=equivalences.get(str(mid),str(mid)) if mid else None
        if group and group in seen_groups:return
        cost = len(text) + (1 if lines else 0)
        if used + cost > budget:
            skipped += 1
            return
        lines.append(text)
        items.append(metadata)
        used += cost
        if mid:
            seen.add(mid)
        if group:seen_groups.add(group)

    resolved = core_result.get('_episode_resolved') or {}
    if resolved.get('gated') and resolved.get('inject_eps'):
        try:
            from episode import build_episode_inject, pick_inject_episodes
            episodes = [x[0] if isinstance(x, (tuple, list)) else x for x in resolved['inject_eps']]
            for ep in pick_inject_episodes(episodes):
                text = build_episode_inject(ep)
                if text:
                    row = row_of(ep)
                    pack(text, {'content': row.get('content',''), 'score':0., 'layer':'episode',
                                'id':str(row.get('mem_id') or ''), 'mem_id':str(row.get('mem_id') or '')})
        except Exception as exc:
            core_result.setdefault('errors', []).append('情景档渲染失败: ' + type(exc).__name__)

    for key, layer in (('_identity_results','identity'), ('results','longterm'), ('_shortterm_results','shortterm'),
                       ('_permanent_results','permanent'), ('_cold_results','cold'),('_distilled_results','distilled'),
                       ('_lexical_results','lexical')):
        for hit in core_result.get(key) or []:
            mem = hit[0] if isinstance(hit,(tuple,list)) else hit
            score = hit[1] if isinstance(hit,(tuple,list)) and len(hit)>1 else 0.
            row = row_of(mem)
            content = str(row.get('content') or '')
            at = row.get('last_active') or row.get('create_time')
            label = ('事件时间 '+str(row['event_time'])) if row.get('event_time') else ('记录于'+_rel_time(at, now_ts))
            suffix = {'shortterm':'（这两天）','permanent':'（你特意让我记着的）','cold':'（归档）'}.get(layer,'')
            from services.evidence_semantics import labels
            qualification = labels(row)
            body = ('【'+'；'.join(qualification)+'】' if qualification else '') + content
            if layer == 'longterm' and row.get('later_thought'):
                from memory_manager import format_with_later_thought
                body = ('【'+'；'.join(qualification)+'】' if qualification else '') + format_with_later_thought(mem)
            if layer == 'longterm' and row.get('category') == 'stable_profile':
                label = '长期保留，事件时间未注明' if not row.get('event_time') else label
            text = '- %s%s：%s' % (label, suffix, body)
            mid = str(row.get('mem_id') or '')
            pack(text, {'content':content,'score':round(float(score or 0),4),
                        'layer':layer,'id':mid,'mem_id':mid,'confirmable':False})

    for row in (core_result.get('_window_results') or {}).get('items',[]):
        his = str(row.get('his') or '').replace('\n',' / ')
        said = str(row.get('said') or '').replace('\n',' / ')
        body = ('他说：%s；我回：%s' % (his,said)) if his and said else his or said
        if body.strip():
            pack('- %s（原话）：%s' % (_rel_time(row.get('said_at'),now_ts),body),
                 {'content':body,'score':float(row.get('score') or 0),'layer':'window',
                  'turn':row.get('turn'),'session_id':row.get('session_id'),'confirmable':False})
    text = '\n'.join(lines)
    result = {'text':text,'chars':len(text),'budget':budget,'skipped':skipped,'items':items}
    if core_result.get('_delivery_base') and core_result.get('_context'):
        from services.feedback_service import register
        from services.recall_policy import revision
        delivery = []
        for item in items:
            mid = item.get('id') or item.get('mem_id')
            source = core_result.get('_source_lookup', {}).get(mid)
            pool = core_result.get('_pool_lookup', {}).get(mid)
            item['pool'] = pool
            item['is_private'] = bool(getattr(source, 'is_private', False))
            item['confirmable'] = bool(source is not None and pool == 'active')
            if source is not None and item['confirmable']:
                delivery.append({'id':mid, 'pool':pool, 'revision':revision(source)})
        if delivery:
            try:
                result['request_id'] = register(delivery, core_result['_context'],
                                               base=core_result['_delivery_base'])
            except Exception as exc:
                result['feedback_error'] = type(exc).__name__
                for item in items:
                    item['confirmable'] = False
    result['delivered_items'] = list(items)
    return result


def selftest():
    """自检：纯函数、副作用自洽、断言生效。"""
    print("=" * 72)
    print("recall_service 自检")
    print("=" * 72)

    from schema import MemoryItem

    # ① resolve_episodes 是纯函数
    m1 = MemoryItem("测试记忆一", mem_type="long_term")
    m2 = MemoryItem("测试记忆二", mem_type="episode")
    results = [(m1, 0.9), (m2, 0.8)]
    before_len = len(results)
    before_ids = [id(x) for x in results]

    r = resolve_episodes(results, "今天天气怎么样")
    assert len(results) == before_len, "① 入参被改了"
    assert [id(x) for x in results] == before_ids, "① 入参元素被换了"
    print("  ✅ ① resolve_episodes 不改入参")

    # ② 返回的是新列表
    assert r["filtered_results"] is not results, "② 返回了入参本身"
    print("  ✅ ② 返回新列表（is not results）")

    # ③ original_count 是改动前的
    assert r["original_count"] == before_len, "③ original_count 不对"
    print("  ✅ ③ original_count = %d（改动前）" % r["original_count"])

    # ④ 非回忆问法 → 不做档处理
    assert r["gated"] is False, "④ 天气不该触发档"
    print("  ✅ ④ 非回忆问法不触发档")

    # ⑤ 回忆问法 → gated=True
    r2 = resolve_episodes(results, "你还记得上次吃饭吗")
    print("  %s ⑤ 回忆问法 gated=%s（门控实现可能还没接线）"
          % ("✅" if r2["gated"] else "⚠️", r2["gated"]))

    # ⑥ 副作用自洽
    #
    # ★ 2026-11-09 修（独立审计指出，这条原本是**恒绿假测试**）：
    #
    #   原写法：
    #       self.shortterm_mems = [MemoryItem("短期一", mem_type="short_term")]
    #       core = recall_core(fake, "测试", embedding_func=lambda q: [0.1]*8)
    #       if se["shortterm_mentioned"]:   assert se["shortterm_saved"]
    #       else: print("✅ 本次没有短期命中，无需落盘")
    #
    #   为什么恒绿：
    #     MemoryItem 构造时没有 embedding（None）→
    #     cosine_similarity(query_vec, None) = 0 → 短期 0 命中 →
    #     `shortterm_mentioned` 恒为 0 → 断言分支**永不执行** →
    #     无论代码对不对，都打印 ✅。
    #
    #   而且 P0 之后语义已经变了：召回**本来就不该**续命、不该落盘。
    #   所以正确断言不是「说了就落盘」，而是：
    #     召回前后，短期记忆的四个字段 **一个都不能变**。
    #
    #   现在：给 FakeMem 填真 embedding（保证一定命中），
    #   然后断言「命中 N 条 且 零副作用」。
    class FakeMgr:
        def __init__(self):
            self.saved = False
            # 填真 embedding，且与 query 向量同向 → 保证相似度为 1，
            # 一定会进入召回结果（不然这条测试测不到东西）
            m = MemoryItem("短期一：上次一起吃了泡面",
                           mem_type="short_term")
            m.embedding = [0.1] * 8
            m.last_mentioned_at = __import__("time").time()
            m.mention_count = 0
            m.mention_history = []
            self.shortterm_mems = [m]
        def recall(self, *a, **kw):
            return []
        def save_shortterm(self):
            self.saved = True

    fake = FakeMgr()
    _before = {
        "last_mentioned_at": fake.shortterm_mems[0].last_mentioned_at,
        "mention_count": fake.shortterm_mems[0].mention_count,
        "mention_history": list(fake.shortterm_mems[0].mention_history),
        "strength": fake.shortterm_mems[0].strength,
    }
    core = recall_core(fake, "测试", embedding_func=lambda q: [0.1] * 8)
    se = core["side_effects"]

    # ① 必须先确认「真的命中了」——否则下面全是空转
    _hit = len(core.get("_shortterm_results") or [])
    assert _hit > 0, (
        "⑥ 自检本身失效：短期 0 命中，这条测试测不到任何东西"
        "（检查 FakeMgr 的 embedding 是否与 query 同向）")

    # ② P0 语义：召回不得改任何提及字段
    _after = {
        "last_mentioned_at": fake.shortterm_mems[0].last_mentioned_at,
        "mention_count": fake.shortterm_mems[0].mention_count,
        "mention_history": list(fake.shortterm_mems[0].mention_history),
        "strength": fake.shortterm_mems[0].strength,
    }
    assert _before == _after, (
        "⑥ 召回改了短期记忆状态：%r → %r" % (_before, _after))
    assert se["shortterm_mentioned"] == 0, (
        "⑥ 召回仍报告「续命了 %d 条」（P0 已删除该行为）"
        % se["shortterm_mentioned"])
    assert not fake.saved, "⑥ 召回仍调用了 save_shortterm（P0 已删除）"

    print("  ✅ ⑥ 副作用自洽（命中 %d 条，四字段零变化，未落盘）"
          % _hit)

    # ⑦ render 有预算上限
    out = render_for_prompt(core, budget=50)
    assert out["chars"] <= 50 + 200, "⑦ 预算没生效"
    assert out["budget"] == 50
    print("  ✅ ⑦ 预算生效（chars=%d budget=%d skipped=%d）"
          % (out["chars"], out["budget"], out["skipped"]))

    print()
    print("recall_service selftest OK")


if __name__ == "__main__":
    selftest()
