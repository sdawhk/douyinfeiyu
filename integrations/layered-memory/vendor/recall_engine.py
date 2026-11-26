import copy
import math
import re
from datetime import datetime
from typing import List, Tuple

from config import (
    WEIGHT_SIM, WEIGHT_STRENGTH, WEIGHT_EMOTION,
    ENTITY_BONUS, ENTITY_BONUS_MAX, RECALL_TOP_K, COLD_AWAKE_STRENGTH,
    COLD_RECALL_TOP_K, COLD_RECALL_MIN_SIM,
    LAYER_THRESHOLDS, LAYER_L1_WEIGHT, LAYER_L2_WEIGHT,
    RRF_K,
    # 2026-11-10 第二步：印象候选（Q2=A，rerank 之后补充，不改原公式）
    IMPRESSION_RECALL_MIN, IMPRESSION_DETAIL_MAX, IMPRESSION_MAX_EXTRA,
    IMPRESSION_MIN_SIM, IMPRESSION_SCORE_CAP,
)
from schema import MemoryItem
from decay_logic import calculate_current_strength
from decay_logic import peek_detail_strength, peek_impression
from decay_logic import note_silent_error

# 外部知识降权：默认将外部摘要或主动学习来源权重打 0.55 折，避免淹没亲历记忆。
KNOWLEDGE_SOURCES = {
    'external_digest',
    'learned',
}
KNOWLEDGE_DISCOUNT = 0.55


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """余弦相似度，返回 0~1；长度不匹配或零向量返回 0"""
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    norm1 = math.sqrt(sum(a ** 2 for a in vec1))
    norm2 = math.sqrt(sum(b ** 2 for b in vec2))
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return max(0.0, dot / (norm1 * norm2))


def _credibility_of(mem: MemoryItem) -> float:
    """取可信度 0~1（2026-11-08 T06）。

    兜底链：字段有值就用 → 没有就按内容现推 → 再不行给 1.0。
    为什么要在读侧兜底：老数据（215 条）和外部构造的 dict 可能没有这个字段，
    直接 float(...) 会抛异常，而召回路径绝不能因为一条脏数据整个炸掉。
    """
    v = getattr(mem, "credibility", None)
    if v is None:
        try:
            from schema import infer_credibility
            return float(infer_credibility(
                getattr(mem, "source", "") or "",
                getattr(mem, "content", "") or ""))
        except Exception:
            return 1.0
    try:
        return min(1.0, max(0.0, float(v)))
    except (TypeError, ValueError):
        return 1.0


def _emotion_match_score(query_valence: str, query_intensity: float, mem: MemoryItem) -> float:
    """情绪匹配得分 0~100：极性一致取记忆情绪强度，相反取 0，中性折半"""
    if query_valence == "neutral" or mem.emotion_valence == "neutral":
        return mem.emotion_intensity * 0.5
    elif query_valence == mem.emotion_valence:
        return mem.emotion_intensity
    return 0.0


def _layer_weight(mem: MemoryItem, current_timestamp: float = None) -> float:
    """按未召回天数返回分层降权系数（方案 A：只降权，不截断）。

    层 = f(last_recalled_at 距今)，实时算，不存字段：
      L0 (0~7天)    → 1.0（正常）
      L1 (7~30天)   → LAYER_L1_WEIGHT（0.8，轻微降权）
      L2 (30~180天) → LAYER_L2_WEIGHT（0.5，明显降权）
      180天+         → 已在冷库，不在这里（走 recall_cold）

    ★ 只降权、不截断：久远的记忆仍参与排序，只是靠后，不漏。
    """
    try:
        if current_timestamp is None:
            current_timestamp = datetime.now().timestamp()
        last = getattr(mem, "last_recalled_at", None)
        if last is None:
            last = getattr(mem, "last_active", None)
        if last is None:
            return 1.0
        days = max(0.0, (float(current_timestamp) - float(last)) / 86400.0)
    except (TypeError, ValueError):
        return 1.0

    t1, t2 = float(LAYER_THRESHOLDS[0]), float(LAYER_THRESHOLDS[1])
    if days < t1:
        return 1.0                     # L0 活跃
    if days < t2:
        w = float(LAYER_L1_WEIGHT)     # L1 近淡
    else:
        w = float(LAYER_L2_WEIGHT)     # L2 久远

    # FIX-LAYER-IMPORTANCE-FLOOR（2026-11-11）：
    #   年龄乘子乘在整个 final 上，而地板只保护 strength 项，
    #   导致「重要记忆」30 天后被腰斩，地板保不住排名。
    #   方案 C：重要记忆的 layer_weight 有下限，不被年龄压太狠。
    try:
        imp = float(getattr(mem, "importance", None) or 0.0)
    except (TypeError, ValueError):
        imp = 0.0
    if imp >= 0.85:
        return max(w, 0.8)     # 承诺/事实/日期：几乎不减
    if imp >= 0.55:
        return max(w, 0.6)     # 关于他/工具/事件：只减一点
    return w                   # 琐事照旧（可降到 0.5）


def hybrid_rerank(
    query_embedding: List[float],
    query_entities: List[str],
    query_emotion: dict,
    candidates: List[MemoryItem],
    top_k: int = RECALL_TOP_K,
    update_strength: bool = True,
    query_text: str = "",
    min_similarity: float = None,
) -> List[Tuple[MemoryItem, float]]:
    """混合召回重排：语义相似度 + 记忆强度 + 情绪匹配，全部归一化到 0~1。

    - 打分阶段使用深拷贝，避免计算污染候选对象（防止虚假激活）
    - 仅对最终入选 Top-K 的记忆更新强度与最后激活时间

    ★ 2026-11-09 加 update_strength 开关：

      下面这段「对 Top-K 更新强度」原来是无条件的，而且改的是**原始对象**
      （calculate_current_strength 有副作用）：

          for orig_mem, score in scored[:top_k]:
              updated_mem, _ = calculate_current_strength(orig_mem)   ← 改原对象
              results.append((updated_mem, score))

      实测后果（跟 recall() 的 reinforce 是两个独立的污染源）：
        只读分析脚本跑一遍，Top-K 记忆的 strength / last_active 就被刷新，
        衰减计时器被重置 → 本该归档的一直被续命。

      update_strength=False 时返回深拷贝，原对象零接触。
      生产调用不传这个参数 → 默认 True，行为完全不变。
    """
    # 零向量代表本地嵌入失败，不是「语义相似度为零」。没有可用向量时，
    # 不得按强度/情绪硬凑 Top-K 冒充相关记忆。
    if (not query_embedding or len(query_embedding) == 0
            or not any(isinstance(x, (int, float)) and x != 0 for x in query_embedding)):
        return []
    query_valence = query_emotion.get("valence", "neutral")
    query_intensity = query_emotion.get("intensity", 50.0)
    query_entity_set = set(query_entities)
    scored = []
    mode = str(query_emotion.get("recall_mode") or "active")

    # ★ 2026-11-13：**meta_only 门控接线**（原来这段判据写了但没人调）
    #
    #   背景：schema.classify_for_gate 会给每条记忆打 recallable 标签：
    #     yes        —— 正常参与召回
    #     meta_only  —— 讨论系统本身的技术流水，只在**用户问系统**时才该被召回
    #     no         —— 测试内容，永远不召回
    #
    #   实测生产库 521 条里有 7 条 meta_only（「睡眠潜水的 bug 还没修好」
    #   「短视频取视频的接口调不通」这类）。而 hybrid_rerank **从来没读这个字段**
    #   —— 于是它们跟真实生活记忆一样参与打分，问「我在哪工作」时
    #   技术流水能靠字面重叠挤进 Top-K。
    #
    #   这正是 is_meta_query / is_recallable 两个函数「写了没人调」的原因：
    #   判据齐了，门没装。
    #
    #   判据（宁可判窄）：
    #     用户没问系统  → meta_only 一条都不进
    #     用户在问系统  → meta_only 正常参与（这时它才是答案）
    #     no（测试内容）→ 永远不进，跟用户问什么无关
    #
    #   ⚠️ 判据炸了必须**放行**，不能把召回带崩 ——
    #     门控是优化，不是安全边界。判不出来时宁可多给一条，
    #     也不能因为一个分类函数异常让整次召回空掉。
    #     （memory_manager.recall 里那段旧门控也是这个口径，两处必须一致。）
    try:
        _meta_q = bool(query_text) and is_meta_query(query_text)
    except Exception as _e:
        note_silent_error('is_meta_query', _e)
        _meta_q = False

    for mem in candidates:
        # on_demand 的记忆不进普通候选池。只在排序里乘小系数不够 ——
        # 语义足够像时仍可能挤进 Top-K，等于没沉睡。
        if mode == "active" and getattr(mem, "recall_mode", "active") == "on_demand":
            continue
        # meta_only / no 门控（见上面那段说明）
        #
        # ★ 用 schema.is_recallable 而不是在这里重写一遍判据：
        #   那条判据是「这条记忆该不该进答案池」，跟 classify_for_gate 同源。
        #   内联复制一份的话，以后 schema 那边改了这里就分叉 ——
        #   而分叉的后果是「同一个字段两处解释不一样」，最难查的那种 bug。
        #   （⚠️ 不要写成 `import ... as _别名`：link_check 只认 name( 形式，
        #     别名会让它把这函数判成「无人调用」。）
        try:
            from schema import is_recallable
            if not is_recallable(
                    getattr(mem, "content", "") or "",
                    getattr(mem, "source", "") or "",
                    query_is_meta=_meta_q):
                continue
        except Exception as _e:
            # 判据炸了不能把召回带崩 —— 退回「放行」（跟原来行为一致）
            note_silent_error('is_recallable', _e)
        sim = cosine_similarity(query_embedding, mem.embedding)
        if min_similarity is not None and sim < min_similarity:
            continue
        temp_mem, _ = calculate_current_strength(copy.deepcopy(mem))
        strength_norm = temp_mem.strength / 100.0
        emotion_norm = _emotion_match_score(query_valence, query_intensity, temp_mem) / 100.0

        base_score = sim * WEIGHT_SIM + strength_norm * WEIGHT_STRENGTH + emotion_norm * WEIGHT_EMOTION
        # 主动召回权重独立于强度；永久记忆也受它控制，避免反复冒出。
        try:
            base_score *= max(0.0, min(1.0, float(getattr(temp_mem, "recall_weight", 1.0) or 0.0)))
        except (TypeError, ValueError):
            pass

        # 2026-11-08 信任度（T06）：低可信的降权。
        #   credibility 不随时间衰减（见 decay_logic），所以「三个月没提的事实」
        #   仍然按 1.0 参与打分，只是 strength 那一项掉下来 —— 这才是对的。
        #   乘在**相关度基分**上、不乘实体加分：实体命中是「跟这次话题有关」，
        #   跟这条记忆可不可信是两件事。
        base_score *= _credibility_of(temp_mem)

        # ★ 2026-11-13：按内容类别加权（kind）。
        #
        #   为什么用「乘权重」而不是「按类过滤」：
        #     实测按类硬过滤会把 @3 从 89.7% 拉到 82.8% —— 因为 query 分类器
        #     判不准（29 条正例里只有 8 条类别对得上，27.6%）。
        #     而加权是零损失的：实测 72.4% → 75.9%（+1 条），无一丢失。
        #
        #   为什么权重这么定：
        #     元讨论 ×0.3 —— 实测「讨论召回 bug 的技术流水」能靠字面重叠
        #       拿到 0.652 排第一。降到 0.3 后掉出前三，第一名让给真实记录。
        #     闲聊 ×0.6 —— 「拍我干嘛，还没睡呢」这类不该压过真实内容，
        #       但也不能全排除（问「昨晚聊什么」时还要它）。
        #     测试 ×0 —— 这个必须硬排除，测试句永远不该当答案。
        #     其余 ×1.0 —— 事实/约定/事件/情感 全部等权，不做区别。
        _kind = str(getattr(temp_mem, "kind", "") or "")
        _kw = _KIND_RECALL_WEIGHT.get(_kind, 1.0)
        # A guessed topic is not evidence of chitchat. Preserve explicit test/meta gates.
        if (getattr(temp_mem, "mem_type", "") == "episode"
                and _kind == "闲聊"
                and (getattr(temp_mem, "scene", None) or {}).get("theme_kind") != "known"):
            _kw = 1.0
        if _kw <= 0:
            continue
        base_score *= _kw

        # 2026-11-08 修（实测发现的真根因）：原来只看 tags：
        #     hit_count = len(query_entity_set & set(temp_mem.tags))
        #   但生产库 234 条的 tags 全是**类别标签**，不是实体：
        #     人设相关 113 / 核心记忆 65 / stable_profile 45 / 对话 43 / medium 39 ...
        #   而实体名（朋友 / 火锅 / 面 / 粥）在 tags 里的出现次数是 **0**。
        #   于是 hit_count 恒为 0、bonus 恒为 0 —— 这条加分路从上线起就没生效过，
        #   跟 session_init 传不传实体、entity_graph 接不接线都无关。
        #
        # 修法：实体命中既看 tags（万一以后有实体标签），**也看正文**。
        #   实测「用户说想吃火锅」：命中条从 0 条变成 55 条，
        #   排第 98 名的「唱歌要朋友给链接」被拉到第 2 名 —— 这才是这条加分该干的事。
        #
        # 注意上限：ENTITY_BONUS_MAX = 0.1，相对于 sim 的 0.80 权重仍是小量，
        #   不会让「提到朋友」的记忆挤掉真正相关的。宁小勿大。
        _entity_hits = query_entity_set & set(temp_mem.tags)
        _content = temp_mem.content or ""
        for _e in query_entity_set:
            # 已经靠 tags 命中过的就不重复计数（一条记忆同一个实体只加一次）
            if _e not in _entity_hits and _e in _content:
                _entity_hits.add(_e)
        hit_count = len(_entity_hits)
        bonus = min(hit_count * ENTITY_BONUS, ENTITY_BONUS_MAX)
        final_score = base_score + bonus
        # 2026-11-06 知识降权：外头学来的打 0.55 折，不挤掉经历过的
        if temp_mem.source in KNOWLEDGE_SOURCES:
            final_score *= KNOWLEDGE_DISCOUNT
        # 2026-11-10 分层降权（方案 A）：久远未召回的乘降权系数，只降权不截断。
        #   注意：乘在最后（知识降权之后），因为两个降权是独立维度，叠加相乘。
        final_score *= _layer_weight(temp_mem)
        from config import ACTIVE_WINDOW_BONUS, ACTIVE_WINDOW_MIN_SIM
        if sim >= ACTIVE_WINDOW_MIN_SIM and (temp_mem.effective_from is not None or temp_mem.effective_to is not None):
            final_score += ACTIVE_WINDOW_BONUS
        scored.append((mem, round(final_score, 4)))

    scored.sort(key=lambda x: x[1], reverse=True)
    results = []
    for orig_mem, score in scored[:top_k]:
        # ★ 2026-11-09：update_strength=False 时绝不能碰原对象。
        #
        #   calculate_current_strength 有副作用（改 strength + last_active），
        #   而这里传的是 orig_mem —— 就是 mgr.active_mems 里的真实对象。
        #   只读分析（评估 / 回放）必须走深拷贝分支。
        if update_strength:
            updated_mem, _ = calculate_current_strength(orig_mem)
        else:
            updated_mem = copy.deepcopy(orig_mem)
        results.append((updated_mem, score))

    # ★ 2026-11-10 第二步（R3/Q2=A）：印象候选**在 rerank 之后**补充。
    #
    # ⚠️ 2026-11-10 23:36 **默认关闭**（IMPRESSION_SUPPLEMENT_ENABLED = False）。
    #
    #   为什么关掉而不是修 —— 独立审查的核心判断，我认同：
    #
    #     召回槽位是稀缺资源（top_k=5）。印象候选要进来必然占一个槽，
    #     而三条路都不通（改 top_k 会炸契约 / 挤掉正常候选错 / 不满时才补=不跑）。
    #
    #   实测（用生产形态：results 已满 5 条）：
    #     supplement 追加 extras 后 `out[:top_k]` **从头部截断**，
    #     尾部 extras 全丢 ⇒ 兜底一次都不会执行。
    #     只有当 len(results) < top_k 时才生效，而生产里永远 >= top_k。
    #
    #   更根本：event_intensity 是正则推的，不可靠。
    #     用不可靠的输入触发会挤占召回槽的机制 ⇒ 结果随机。
    #
    #   ⚠️ 关掉是**显式 no-op**，不是静默失效：
    #     函数保留（第二步的资产）、测试保留、
    #     契约守卫见 test_impression_supplement_real.py。
    try:
        from config import IMPRESSION_SUPPLEMENT_ENABLED as _imp_on
    except Exception:
        _imp_on = False
    if _imp_on:
        results = supplement_impression_candidates(
            query_embedding=query_embedding,
            candidates=candidates,
            results=results,
            top_k=top_k,
        )

    return results


# ═══════════════════════════════════════════════════════════════════
# 印象候选补充（2026-11-10 第二步 · R3）
# ═══════════════════════════════════════════════════════════════════
#
# 【为什么放在 rerank 之后而不是加权公式里】
#   hybrid_rerank 的 sim×0.80 + strength×0.15 + emotion×0.05 是生产验证过的，
#   往里加第四项（impression）会改变**每一次**召回的排序，
#   包括那些根本没有印象层的（372 条里绝大多数）。回归风险不可控。
#   所以：主排序不动，印象层只作为**尾部补充**。
#
# 【量纲怎么对齐】
#   hybrid_rerank 的分数在 0~1（sim 主导），印象分也在 0~100。
#   折算方式：IMPRESSION_SCORE_CAP × (impression/100)，上限 0.30。
#   为什么封顶 0.30 而不是更高：
#     memory_manager 那段「身份特判溢出 top_k」的血泪注释记着 ——
#     当初特判项用 score=0.0 直接前置，结果那 2 条**永远占第 1、2 位**，
#     对身份类 query 主排序根本没参与前两槽竞争。
#     这里反过来：印象候选只拿 0~0.30，且**永远排在正常候选之后**，
#     保证它挤不掉高相关结果，最多是让「该想起来但细节淡了」的那条不消失。
#
# 【为什么不占 Top-K 名额】
#   任务书 7.2 风险 1：印象候选无上限 → Top-5 变 Top-10。
#   这里严格 `总条数 <= top_k`，且印象候选最多 IMPRESSION_MAX_EXTRA 条。

def _impression_rank_score(impr: float) -> float:
    """印象分（0~100）→ 折算成 0~IMPRESSION_SCORE_CAP 的补充分。"""
    try:
        v = float(impr)
    except (TypeError, ValueError):
        return 0.0
    v = max(0.0, min(100.0, v))
    return round(IMPRESSION_SCORE_CAP * (v / 100.0), 4)


def supplement_impression_candidates(
    query_embedding: List[float],
    candidates: List[MemoryItem],
    results: List[Tuple[MemoryItem, float]],
    top_k: int = RECALL_TOP_K,
    current_timestamp: float = None,
) -> List[Tuple[MemoryItem, float]]:
    """把「细节已淡、印象还在」的记忆补进召回结果（R3）。

    三条闸，缺一不可：
      ① 细节 < IMPRESSION_DETAIL_MAX（否则它本来就该走正常路径）
      ② 印象 >= IMPRESSION_RECALL_MIN
      ③ 语义相关 >= IMPRESSION_MIN_SIM（★ 不能只看印象不看相关性 ——
         否则查任何词都会把「他家人住院那次」捞出来，那是噪声不是记忆）

    去重语义（T8 的关键）：
      已经在 results 里的条目**不重复添加**，位置也不变；
      它的「细节已淡」标注由 impression_note() 在**渲染时**统一给，
      不经过这里。所以「呈现方式取决于它怎么进的 Top-5」这个不对称不存在。
    """
    if not results and not candidates:
        return results
    if current_timestamp is None:
        import time as _t
        current_timestamp = _t.time()

    have = {m.mem_id for m, _ in results}
    extras = []
    for mem in candidates:
        if mem.mem_id in have:
            # 已在正常候选里 → 位置与分数都不动（渲染层会给标注）
            continue
        try:
            detail = peek_detail_strength(mem, current_timestamp)
            impr = peek_impression(mem, current_timestamp)
        except Exception:
            continue
        if impr < IMPRESSION_RECALL_MIN:
            continue            # 没有印象层
        if detail >= IMPRESSION_DETAIL_MAX:
            continue            # 细节还清楚 → 走正常召回，不用补
        sim = cosine_similarity(query_embedding, getattr(mem, "embedding", []) or [])
        if sim < IMPRESSION_MIN_SIM:
            continue            # 不相关 → 不许因为"印象强"就冒出来
        extras.append((mem, sim, impr))

    if not extras:
        return results

    # 排序：印象高的优先，其次语义更相关的
    extras.sort(key=lambda x: (-x[2], -x[1]))
    extras = extras[:IMPRESSION_MAX_EXTRA]

    out = list(results)
    for mem, _sim, impr in extras:
        # 补充分 **永远低于** 正常候选的最低分（若可见），保证不插队。
        # 没有正常候选时（空结果）才用自己的折算分。
        if out:
            base = min(s for _, s in out)
        else:
            base = 0.0
        score = min(_impression_rank_score(impr), max(0.0, base))
        try:
            copy_mem = copy.deepcopy(mem)
        except Exception:
            copy_mem = mem
        out.append((copy_mem, round(float(score), 4)))

    # ★ 硬约束：总条数不超过 top_k（任务书 7.2 风险 1）
    if len(out) > top_k:
        out = out[:top_k]
    return out


def render_memory_line(mem: MemoryItem, current_timestamp: float = None) -> str:
    """把一条记忆渲染成注入文本 —— **含印象标注的唯一出口**（T4 / T8）。

    ★ 2026-11-10 第二步的核心决定：
      不管这条是从正常候选来的、还是从印象补充来的，都走这一个函数。
      「呈现方式取决于它怎么进的 Top-5」是不可接受的，
      因为同一条记忆会因此有时显示完整细节、有时显示印象标注。

    三档（判据在 decay_logic.impression_state，这里不重复写阈值）：
      intact         → 原文
      faded_detail   → 原文 + （细节已淡，只记得这件事发生过）
      erased_detail  → **不出现原文**，只给印象
                       ★ 任务书 T4 硬要求：「不得用已淡忘的 detail 描述细节，
                         否则等于编造」。detail < 20 时原文一个字都不该出现。
    """
    from decay_logic import impression_state
    content = str(getattr(mem, "content", "") or "").strip()
    if not content:
        return ""
    st = impression_state(mem, current_timestamp)
    if st == "erased_detail":
        # 只保留「有这么回事」的骨架：不复制原文，避免编造细节
        topic = "、".join(sorted(set(
            t for t in ("医院", "住院", "手术", "去世", "吵架", "生日",
                        "工作", "搬家", "生病") if t in content))[:3])
        tail = f"（和「{topic}」有关）" if topic else ""
        return f"【记得有这么回事】{tail}细节基本想不起来了，只记得这件事发生过"
    if st == "faded_detail":
        return f"{content}（细节已淡，只记得这件事发生过）"
    return content


def impression_recall_stats(candidates: List[MemoryItem],
                            current_timestamp: float = None) -> dict:
    """R6 可观测性：数一遍库里「印象强但细节已淡」的记忆（纯只读）。

    夜巡报告用它列出需要人工判断「要不要补记」的条目。
    """
    from decay_logic import impression_state
    if current_timestamp is None:
        import time as _t
        current_timestamp = _t.time()
    counts = {"none": 0, "intact": 0, "faded_detail": 0, "erased_detail": 0}
    faded = []
    for mem in candidates or []:
        try:
            st = impression_state(mem, current_timestamp)
        except Exception:
            continue
        counts[st] = counts.get(st, 0) + 1
        if st in ("faded_detail", "erased_detail"):
            faded.append({
                "mem_id": getattr(mem, "mem_id", ""),
                "state": st,
                "event_intensity": getattr(mem, "event_intensity", 0.0),
                "impression": round(peek_impression(mem, current_timestamp), 1),
                "detail": round(peek_detail_strength(mem, current_timestamp), 1),
                "content_head": str(getattr(mem, "content", "") or "")[:30],
            })
    faded.sort(key=lambda x: -x["impression"])
    return {"counts": counts, "faded": faded}


def recall_shortterm(
    query_embedding: List[float],
    candidates: List[MemoryItem],
    top_k: int = None,
    query_text: str = "",
) -> List[Tuple[MemoryItem, float]]:
    """短期记忆召回：语义相似度 + 平方衰减强度 + 24小时新鲜度加成 + topic 命中。

    与长期召回的区别：
      1. 强度用 calculate_shortterm_strength（平方加速衰减），不是线性
      2. 24 小时内的记忆额外 +0.15 新鲜度分（最近的事最相关）
      3. 强度 < SHORT_TERM_FORGET_THRESHOLD 的不召回（等于忘了）
      4. 2026-11-06：query 撞上记忆的 topic 标签也算命中（语义联想，不只看向量）
    """
    from config import (SHORT_TERM_FRESH_BONUS, SHORT_TERM_FORGET_THRESHOLD,
                        SHORT_TERM_RECALL_TOP_K)
    from decay_logic import calculate_shortterm_strength
    from schema import extract_topics
    if top_k is None:
        top_k = SHORT_TERM_RECALL_TOP_K
    import time as _time
    now = _time.time()
    query_topics = set(extract_topics(query_text))
    scored = []
    for mem in candidates:
        # 短期池没有 NON_RECALL_TYPES 过滤，这里明确尊重相同生命周期标记。
        if getattr(mem, 'mem_type', '') in ('superseded', 'unavailable'):
            continue
        temp = copy.deepcopy(mem)
        strength = calculate_shortterm_strength(temp, now)
        if strength < SHORT_TERM_FORGET_THRESHOLD:
            continue
        sim = cosine_similarity(query_embedding, temp.embedding)
        # 2026-11-06：topic 命中加分——query 里的词撞上这条记忆的话题，即使向量相似度不高也算相关
        mem_topics = set(extract_topics(getattr(temp, "content", "") or ""))
        topic_hit = len(query_topics & mem_topics) > 0
        # topic 命中时，语义相似度给一个保底（0.5 起），让「相关但不同词」也能捞到
        if topic_hit and sim < 0.5:
            sim = max(sim, 0.5)
        # 2026-11-06 修 bug：向量相似度=0 且 topic 不命中时，不该召回——
        #   即使强度高、新鲜，完全不相关的记忆也不该被捞出来。
        if sim < 0.35 and not topic_hit:
            continue
        strength_norm = strength / 100.0
        base = sim * WEIGHT_SIM + strength_norm * WEIGHT_STRENGTH
        last = getattr(temp, "last_mentioned_at", None) or getattr(temp, "create_time", now)
        if now - last <= 86400:
            base += SHORT_TERM_FRESH_BONUS
        scored.append((mem, round(base, 4)))

    scored.sort(key=lambda x: x[1], reverse=True)
    # 2026-11-06：读取上限——存量放开，读取收紧。
    #   先按条数限（top_k=5），再按总字数限（SHORT_TERM_RECALL_MAX_CHARS=1500）。
    #   存多少没关系，每轮读进 prompt 的必须少。
    from config import SHORT_TERM_RECALL_MAX_CHARS
    result = []
    used_chars = 0
    for mem, score in scored[:top_k]:
        cost = len(getattr(mem, "content", "") or "")
        if used_chars + cost > SHORT_TERM_RECALL_MAX_CHARS:
            # ★ 2026-11-09 P0：break → continue
            #
            #   原来 break：遇到第一条超预算的候选就整个停下。
            #   但 scored 是按分数降序的，后面的候选可能更短 ——
            #   它们本来放得下，却再也不会被检查。
            #
            #   实测场景：Top1 是一条 800 字的长记忆，预算剩 700 字，
            #   于是 break，而 Top2 只有 100 字、完全放得下，却被丢弃。
            #   结果是「上下文预算利用率」偏低，白白浪费注入位置。
            #
            #   改 continue 后：跳过放不下的那条，继续检查后面的。
            continue
        result.append((mem, score))
        used_chars += cost
    return result


# ═══════════════════════════════════════════════════════════════════
# 永久记忆专项检索（独立通道 B）
# ═══════════════════════════════════════════════════════════════════
# 只服务「你还记得……」「之前说过的……」这类明确回忆问法。
# 它绕过的只是普通召回门槛，**不绕过语义相关性**：无关的永久记忆
# 也不会被倒出来。
MEMORY_REMIND_HINTS = (
    "你还记得", "记得吗", "还记得", "上次", "那次", "以前", "之前说",
    "我跟你说过", "和你说过", "我说过的", "之前跟我说过", "跟我说过",
    "之前跟你说过", "跟你说过",
    "回忆", "想起来",
)


# 2026-11-13：内容类别 → 召回权重。
#
#   这里是**乘权重**，不是过滤。理由见 hybrid_rerank 里的注释：
#   按类硬过滤实测掉 7 个点（query 分类判不准），加权零损失且能压掉噪声。
#
#   kind 为空（未打标签的存量）→ 用 1.0 放行，不吃亏也不占便宜。
_KIND_RECALL_WEIGHT = {
    "事实": 1.0,
    "约定": 1.0,
    "事件": 1.0,
    "情感": 1.0,
    "闲聊": 0.6,
    "元讨论": 0.3,
    "测试": 0.0,
}


def is_remind_query(text: str) -> bool:
    t = str(text or "")
    return any(h in t for h in MEMORY_REMIND_HINTS)


# 2026-11-13：判断「这一问是不是在问系统本身」。
#
#   为什么需要：被标成 meta_only 的记忆（讨论召回 bug、阈值、排名的那种）
#   只有在用户问「系统怎么改的」「上次那个 bug 修了没」时才该被召回；
#   问「我在哪工作」时它们必须被挡掉。
#
#   判据和 schema.classify_for_gate 的 meta 判定同源，但对象是 query 不是记忆。
#   宁可判窄：漏判的后果是元问题答不上来，误判的后果是技术流水又混进普通问答。
_META_QUERY_HINTS = (
    "记忆系统", "记忆库", "召回", "检索", "向量", "embedding",
    "阈值", "打分", "排名", "排到", "共识", "巩固", "衰减",
    "长期库", "短期层", "情景档", "pending", "窗口账本",
    "这个 bug", "那个 bug", "修好了没", "改了没",
)


def is_meta_query(text: str) -> bool:
    """这一问是不是在问系统本身。永不抛。"""
    t = str(text or "").strip()
    if not t:
        return False
    # Asking whether memory contains one's attribute remains a factual question.
    # Explicit implementation/debugging language continues to use the meta route.
    if (re.search(r'(?:记忆库|记忆里|记忆中|记得).{0,16}(?:我|你|他|她|朋友|assistant)(?:的|在|几|多大|多少岁|生日|工作|职位)',t)
            and not re.search(r'代码|bug|字段|接口|算法|阈值|正则|单测|测试|实现|修复|排查',t,re.I)):
        return False
    if any(h in t for h in _META_QUERY_HINTS):
        return True
    # 「上次那个改动」「之前那样调」这类指代，配合系统词才成立。
    #   ⚠️ 第一版写成 r"(?:上次|之前|刚才).{0,6}(?:改|调|修|做)的"，
    #      要求动词后面紧跟「的」—— 但「上次那个改动做了吗」是「做 + 了」，
    #      直接漏判。实测踩过。现在只要求出现「上次/之前/刚才 + 改动类动词」。
    return bool(re.search(r"(?:上次|之前|刚才)[^，。？?]{0,8}(?:改|调|修|动|做)", t))


def recall_permanent(
    query_embedding: List[float],
    candidates: List[MemoryItem],
    top_k: int = 5,
    query_text: str = "",
    min_similarity: float = 0.45,
    exclude_ids=None,
) -> List[Tuple[MemoryItem, float]]:
    """按需检索 permanent_memory 条目；不改变任何记忆状态。"""
    if (not query_embedding
            or not any(isinstance(x, (int, float)) and x != 0 for x in query_embedding)):
        return []
    excluded = set(exclude_ids or [])
    hits = []
    for mem in candidates or []:
        if not getattr(mem, "permanent_memory", False):
            continue
        if getattr(mem, "mem_id", None) in excluded:
            continue
        if getattr(mem, "mem_type", "") in ("superseded", "unavailable"):
            continue
        sim = cosine_similarity(query_embedding, getattr(mem, "embedding", []) or [])
        if sim < float(min_similarity):
            continue
        hits.append((copy.deepcopy(mem), round(sim, 4)))
    hits.sort(key=lambda item: -item[1])
    return hits[:max(0, int(top_k))]


def recall_cold(
    query_embedding: List[float],
    candidates: List[MemoryItem],
    top_k: int = None,
    query_text: str = "",
    min_similarity: float = None,
    exclude_ids=None,
) -> List[Tuple[MemoryItem, float]]:
    """只读检索冷存：语义/明确词法相关才返回，不因高强度单独入选。

    冷存采用冻结快照，这里不做衰减结算，也不刷新召回时间。返回深拷贝；
    只有调用方实际采用某条结果后，才应通过 daily_consolidation 的持久化
    唤醒接口把它迁回活跃库。exclude_ids 可用于排除活跃库已有结果。
    """
    import re
    from schema import extract_topics

    if top_k is None:
        top_k = COLD_RECALL_TOP_K
    top_k = max(0, int(top_k))
    if top_k == 0 or not candidates:
        return []
    if min_similarity is None:
        min_similarity = COLD_RECALL_MIN_SIM
    excluded = set(exclude_ids or [])
    norm_query = re.sub(r"[\s\W_]+", "", str(query_text or ""))
    query_topics = set(extract_topics(query_text))
    scored = []

    for mem in candidates:
        if getattr(mem, "mem_id", None) in excluded:
            continue
        content = str(getattr(mem, "content", "") or "")
        sim = cosine_similarity(query_embedding, getattr(mem, "embedding", []) or [])
        norm_content = re.sub(r"[\s\W_]+", "", content)
        exact_hit = bool(norm_query and norm_query in norm_content)
        topic_hit = bool(query_topics & set(extract_topics(content)))
        if sim < float(min_similarity) and not exact_hit and not topic_hit:
            continue
        # 词法命中只提供相关性下限，不会绕过上面的过滤条件。
        relevance = max(sim, 0.75 if exact_hit else 0.0, 0.50 if topic_hit else 0.0)
        try:
            strength = min(100.0, max(0.0, float(getattr(mem, "strength", 0.0) or 0.0)))
        except (TypeError, ValueError):
            strength = 0.0
        score = round(relevance * 0.95 + (strength / 100.0) * 0.05, 4)
        scored.append((mem, score))

    scored.sort(key=lambda item: item[1], reverse=True)
    return [(copy.deepcopy(mem), score) for mem, score in scored[:top_k]]


def awake_cold_memory(cold_mem: MemoryItem, current_timestamp: float = None) -> MemoryItem:
    """唤醒单个对象：保留原强度和 L3，重置全部衰减/召回游标。

    这是纯内存状态转换；生产路径应使用 daily_consolidation.awaken_cold_memory
    完成 active/cold 的加锁迁移与持久化。
    """
    now = float(current_timestamp if current_timestamp is not None
                else datetime.now().timestamp())
    try:
        old_strength = float(getattr(cold_mem, "strength", 0.0) or 0.0)
    except (TypeError, ValueError):
        old_strength = 0.0
    cold_mem.strength = max(old_strength, float(COLD_AWAKE_STRENGTH))
    try:
        old_level = int(getattr(cold_mem, "consolidation_level", 2) or 2)
    except (TypeError, ValueError):
        old_level = 2
    cold_mem.consolidation_level = max(old_level, 2)
    cold_mem.last_active = now
    cold_mem.last_recalled_at = now
    cold_mem.strength_at = now
    # 冷存期间冻结各衰减轨；唤醒后从现在开始，绝不补扣整个冷存时段。
    cold_mem.impression_at = now
    cold_mem.emotion_at = now
    cold_mem.archived_at = None
    cold_mem.archive_reason = None
    cold_mem.awakened_at = now
    return cold_mem


# ═══════════════════════════════════════════════════════════════════
# RRF 融合（2026-11-08，T11）
#
# 问题：几路检索各自打分，**尺度完全不同** ——
#   向量分 0~1，IDF/词法分 0~几十，时间分又是另一套。
#   直接加权相加 → 谁尺度大谁碾压，调权重调到天亮也调不平。
#
# RRF（Reciprocal Rank Fusion）不分数值，只看**名次**：
#   总分 = Σ 1 / (k + 名次)     名次从 1 开始，k 默认 60
#   某一路第 1 名拿 1/61，第 10 名拿 1/70 —— 名次靠后的差距被压平，
#   于是「多路都排前面」的条目自然浮上来，单路爆分也翻不了天。
#
# 为什么 k=60：RRF 原论文（Cormack et al. 2009）的取值，也是 Elasticsearch 的默认。
#   调小 → 更看重各路的头名；调大 → 更平等地看待所有名次。
# ═══════════════════════════════════════════════════════════════════

def _rrf_id(item):
    """从一路排名里的一项取出 mem_id。

    接受三种写法（免得调用方为了用它先做一遍转换）：
        "mem_123"                       → 原样
        MemoryItem                      → item.mem_id
        (mem_id, score) / (MemoryItem, score) → 取第 0 个
    """
    if isinstance(item, str):
        return item
    if isinstance(item, (tuple, list)):
        if not item:
            return None
        return _rrf_id(item[0])
    mid = getattr(item, "mem_id", None)
    if mid is not None:
        return mid
    if isinstance(item, dict):
        return item.get("mem_id")
    return item


def rrf_fuse(rankings: List[list], k: int = RRF_K) -> List[Tuple]:
    """多路排名融合（Reciprocal Rank Fusion）。

    rankings: [[mem_id, mem_id, ...], ...]  —— 每一路必须是**排好序的**
              （不会替你排：排名是各路自己的事，这里只负责融合）
    返回:     [(mem_id, score), ...]  按 score 降序

    公式: score = Σ 1 / (k + rank)，rank 从 1 开始（第 1 名 → 1/(k+1)）。

    细节：
      · 同一条目在一路里出现多次，只算**最好那个名次**（不然重复能被刷分）
      · 每路内部按传入顺序编号；空路自动跳过
      · 同分时按「最先出现的顺序」排 —— 保证结果稳定（不然同样的数据两次跑出来不一样）
    """
    # 2026-11-08 防御：k 传 0 会除零，传负数会出现 1/0；最小钳到 1
    k = max(1, int(k)) if isinstance(k, (int, float)) else RRF_K

    scores = {}      # mem_id -> 累计分
    order = {}       # mem_id -> 首次出现序号（同分时的稳定排序键）

    for ranking in rankings or []:
        if not ranking:
            continue
        seen_this_route = set()
        for rank, item in enumerate(ranking, start=1):
            mid = _rrf_id(item)
            if mid is None:
                continue
            if mid in seen_this_route:      # 同一路里重复出现：只认最好名次
                continue
            seen_this_route.add(mid)
            if mid not in order:
                order[mid] = len(order)
            scores[mid] = scores.get(mid, 0.0) + 1.0 / (k + rank)

    fused = sorted(scores.items(), key=lambda kv: (-kv[1], order[kv[0]]))
    return [(mid, round(score, 6)) for mid, score in fused]


def rrf_selftest() -> None:
    """rrf_fuse 的自检（不依赖真实数据；跑 python recall_engine.py 会调它）。"""
    # ① 基础：两路各排 a,b,c / c,a,b —— a 和 c 都吃到两个名次，b 最差
    fused = rrf_fuse([['a', 'b', 'c'], ['c', 'a', 'b']])
    assert fused[0][0] in ('a', 'c'), f"a/c 应该在前面，实际 {fused}"
    assert fused[-1][0] == 'b', f"b 该垫底，实际 {fused}"
    # 逐条算清楚（名次从 1 开始）：
    #   a: 路1第1名 1/61 + 路2第2名 1/62 = 0.032522
    #   c: 路1第3名 1/63 + 路2第1名 1/61 = 0.032266
    #   b: 路1第2名 1/62 + 路2第3名 1/63 = 0.032002
    # ⇒ a > c > b：两路都靠前的 a 赢过「一路第一、一路垫底」的 c
    assert [m for m, _ in fused] == ['a', 'c', 'b'], f"顺序应该是 a,c,b，实际 {fused}"
    assert dict(fused)['a'] > dict(fused)['c'] > dict(fused)['b']

    # ② 只有一路 → 名次顺序不变
    one = rrf_fuse([['x', 'y', 'z']])
    assert [m for m, _ in one] == ['x', 'y', 'z']

    # ③ 多路都排第一的，必须赢过只在单路第一的
    both = rrf_fuse([['p', 'q'], ['p', 'r']])
    assert both[0][0] == 'p'

    # ④ 同一路里重复出现不许刷分
    dup = rrf_fuse([['a', 'a', 'a', 'b']])
    assert dict(dup)['a'] == dict(rrf_fuse([['a', 'b']]))['a'], "重复出现不该加分"

    # ⑤ 空输入 / 空路不崩
    assert rrf_fuse([]) == []
    assert rrf_fuse(None) == []
    assert rrf_fuse([[], []]) == []

    # ⑥ 也能吃 (mem_id, score) 和 MemoryItem
    mi = MemoryItem("朋友的生日是2月13日")
    mixed = rrf_fuse([[mi, ('m2', 0.9)], [mi]])
    assert mi.mem_id in dict(mixed), f"MemoryItem 形态没被认出来：{mixed}"

    # ⑦ k 参数生效：k 越小，头名优势越大
    small = rrf_fuse([['a', 'b', 'c'], ['c', 'a', 'b']], k=1)
    assert small[0][1] > rrf_fuse([['a', 'b', 'c'], ['c', 'a', 'b']], k=60)[0][1]

    # ⑧ 尺度无关：另一路分数放大 1000 倍，融合结果不变（这正是它存在的理由）
    r1 = ['a', 'b', 'c']
    r2 = [('c', 999.0), ('a', 1.0), ('b', 0.5)]
    assert [m for m, _ in rrf_fuse([r1, r2])] == [m for m, _ in rrf_fuse([r1, ['c', 'a', 'b']])]

    print("recall_engine.rrf_fuse selftest OK")
    print(f"  例：rrf_fuse([['a','b','c'],['c','a','b']]) → {rrf_fuse([['a','b','c'],['c','a','b']])}")

# ═══════════════════════════════════════════════════════════════════
# RRF 接线层（2026-11-08 11:20，评审 T11 接线）
#
# 这一层**不改 hybrid_rerank 的公式**，只是在它外面多一条可开关的路径。
#
# ── 量纲实测结论（238 条真实库 + bge-m3）──
#   rrf_fuse 的 Top5 内部分差 ≈ 0.0030
#   QUERY_ROUTE_BONUS 0.05 = 内部分差的 17 倍
#   ENTITY_GRAPH_WEIGHT 0.11 = 内部分差的 36 倍
#   ⇒ 任何「RRF 之后 + 原量纲 bonus」都会让名次失效
#
# ── 意图与相关性统计（238 条 x 8 个查询）──
#   命中意图类的平均相似度 vs 非命中类：平均只差 +0.0171
#   （最大 +0.0596，最小 -0.0027）
#   ⇒ 意图标签几乎不携带相关性信息，加成只能是「小幅助推」，不能当主信号
#   所以 RRF 之后的加成上限压到 0.0015（内部分差的一半），不是 0.05
# ═══════════════════════════════════════════════════════════════════

def _as_names(x) -> list:
    """把 entities 参数归一成名字列表（兼容 [str] / [{name}] / set）。"""
    out = []
    for it in (x or []):
        n = it.get("name") if isinstance(it, dict) else it
        if n and str(n) not in out:
            out.append(str(n))
    return out


def rrf_recall(
    query_embedding: List[float],
    query_entities: List[str],
    query_emotion: dict,
    candidates: List[MemoryItem],
    top_k: int = RECALL_TOP_K,
    query_text: str = "",
    use_entity: bool = True,
    use_route: bool = True,
    min_similarity: float = None,
) -> List[Tuple[MemoryItem, float]]:
    """RRF 多路融合召回（hybrid_rerank 的可开关替代路径）。

    三路各自排名，再用 rrf_fuse 融合：
        路1 语义       cosine(query, mem.embedding)
        路2 词法/实体  query 实体 vs mem 实体 + tags 命中
        路3 强度情绪   strength 归一 + 情绪匹配（保证老信号不被丢掉）

    加成放在**每一路内部**（RRF 之前，此时还是 0~1 量纲），理由见上方实测。

    ⚠️ 与 hybrid_rerank 的区别：
      · hybrid_rerank 是加权求和，分数可跨查询比较
      · 本函数输出的是 RRF 分（约 0.01~0.05），**只在本次召回内有意义**，别拿去跨查询比较
      · 不改任何 MemoryItem（打分阶段不污染候选，跟 hybrid_rerank 一致）
    """
    from entity_graph import entities_of, entity_score
    from query_route import route as _route, matches as _matches

    if not candidates:
        return []

    q_ents = set(_as_names(query_entities))
    emotion = query_emotion or {}
    q_valence = emotion.get("valence", "neutral")
    q_intensity = emotion.get("intensity", 50.0)

    # 问法路由（可选）：只给「同类记忆」一点助推
    route_kind, route_bonus = None, 0.0
    if use_route:
        try:
            info = _route(query_text)
            route_kind = info.get("kind")
            route_bonus = float(info.get("bonus") or 0.0)
        except Exception:
            route_kind, route_bonus = None, 0.0

    sem, lex, strg = {}, {}, {}
    boosted = {}
    # ★ 2026-11-13：meta_only 门控（跟 hybrid_rerank 同一套判据，见那边的长注释）
    #   rrf_recall 是 hybrid_rerank 的替代路径，门控必须一致 ——
    #   否则「走 RRF 时 meta_only 漏进答案池」又是一个只有某条路才有的 bug。
    try:
        _meta_q = bool(query_text) and is_meta_query(query_text)
    except Exception as _e:
        note_silent_error('is_meta_query', _e)
        _meta_q = False
    for mem in candidates:
        mid = mem.mem_id
        # meta_only / no 门控（跟 hybrid_rerank 同一套，见那边的长注释）
        try:
            from schema import is_recallable
            if not is_recallable(
                    getattr(mem, "content", "") or "",
                    getattr(mem, "source", "") or "",
                    query_is_meta=_meta_q):
                continue
        except Exception as _e:
            note_silent_error('is_recallable', _e)
        # 路1：语义
        similarity = cosine_similarity(query_embedding, getattr(mem, "embedding", []) or [])
        if min_similarity is not None and similarity < min_similarity:
            continue
        sem[mid] = similarity
        # 路2：词法（实体 + 标签）
        s = 0.0
        if use_entity:
            try:
                s += entity_score(entities_of(mem), q_ents)
            except Exception as _e:
                note_silent_error('entity_score', _e)
        hit = len(q_ents & set(getattr(mem, "tags", []) or []))
        s += min(hit * 0.25, 0.5)
        lex[mid] = min(1.0, s)
        # 路3：强度 + 情绪（0~1）
        temp, _ = calculate_current_strength(copy.deepcopy(mem))
        strength_norm = getattr(temp, "strength", 0.0) / 100.0
        emo_norm = _emotion_match_score(q_valence, q_intensity, temp) / 100.0
        strg[mid] = min(1.0, strength_norm * 0.8 + emo_norm * 0.2)
        # 路由助推（加在每一路内部，RRF 之前）
        b = 0.0
        if route_kind and route_bonus > 0:
            try:
                b = route_bonus if _matches(mem, route_kind) else 0.0
            except Exception:
                b = 0.0
        boosted[mid] = b

    order = lambda d: sorted(d, key=lambda i: -(d[i] + boosted.get(i, 0.0)))
    fused = rrf_fuse([order(sem), order(lex), order(strg)])

    byid = {m.mem_id: m for m in candidates}
    out = []
    for mid, score in fused[:top_k]:
        mem = byid.get(mid)
        if mem is None:
            continue
        # RRF 排序/返回不得修改候选池中的原始对象；实际强化由上层召回事务处理。
        updated = copy.deepcopy(mem)
        updated, _ = calculate_current_strength(updated)
        out.append((updated, round(score, 6)))
    return out


def rrf_recall_selftest() -> None:
    """rrf_recall 自检（不依赖真实数据）。"""
    m1 = MemoryItem("朋友的生日是2月13日")
    m2 = MemoryItem("朋友喜欢吃火锅")
    m3 = MemoryItem("今天天气不错")
    for m, v in ((m1, [1.0, 0, 0]), (m2, [0.9, 0.1, 0]), (m3, [0, 0, 1.0])):
        m.embedding = v

    r = rrf_recall([1.0, 0, 0], ["朋友", "生日"], {"valence": "neutral", "intensity": 0},
                   [m1, m2, m3], top_k=3, query_text="朋友的生日是什么时候")
    assert len(r) == 3, r
    assert r[0][0].content.startswith("朋友的生日"), "语义+实体双高的该第一"
    assert all(0 < s < 1 for _, s in r), "RRF 分数必须在 (0,1)"

    # 空候选不崩
    assert rrf_recall([1.0], [], {}, [], top_k=3) == []

    # 只有一路有内容也不崩
    r2 = rrf_recall([1.0, 0, 0], [], {"valence": "neutral"}, [m3], top_k=3)
    assert len(r2) == 1

    print("recall_engine.rrf_recall selftest OK")


if __name__ == "__main__":
    rrf_selftest()
    rrf_recall_selftest()
