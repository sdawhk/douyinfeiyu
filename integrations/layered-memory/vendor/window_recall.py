# -*- coding: utf-8 -*-
r"""window 召回模块（window_recall.py）

## 它解决什么

    window 账本存了每轮对话原文（500 轮 / 30 天），但召回链路完全不读。
    超过短期层 3 天窗口的对话，原文还在磁盘上，却永远搜不到。

## 为什么现在能做

    实测成本：
      单条 embedding 29ms
      500 轮全量 14.7 秒（一次性）
      float16 缓存 1 MB

    而 window 没有 strength / tags，只能按「语义相似度 + 时间近远」打分。
    这跟长期库的 5 维打分不同，所以单独一个模块，不混进 hybrid_rerank。

## 设计约束

    ① **只读**。不写 window、不改任何字段、不续命。
    ② 向量缓存写单独文件，不塞进 turns.jsonl（避免文件膨胀 70 倍）。
    ③ 缓存按内容 hash 索引：内容没变就不重算。
    ④ 召回结果作为「补充通道」返回，不挤占长期库的 Top-K 名额。
"""

import os
import json
import time
import hashlib

# ★ 2026-11-11：这个文件在项目根目录（跟 window_ledger.py 同级），
#   所以数据根目录就是文件所在目录，**不要**再 dirname 一层 ——
#   第一版写成了 dirname(dirname(...))，结果扫到 0 轮
#   （路径指到 <user-home>\ 上去了）。
#   2026-11-18：统一走 config.BASE_DIR（唯一的路径真源，见 config.py）。
from config import BASE_DIR

# 缓存路径
WINDOW_EMBED_CACHE = os.path.join(BASE_DIR, "state", "window_embed_cache.json")

# 配置
WINDOW_RECALL_TOP_K = 3          # 最多补几条
# ★ 相似度门槛 0.58（2026-11-11 实测定的）
#
#   实测 bge-m3 在这批数据上的分布：
#     相关查询（睡眠设置/设备故障/记忆系统/吃饭/画图）：
#       最低 0.599，集中在 0.62~0.66
#     无关查询（量子物理/Rust编译器/K线图）：
#       最高 0.496，集中在 0.38~0.50
#
#   两段之间有明显空隙（0.50 ~ 0.60），取中点偏下 0.58：
#     · 挡住无关查询（最高才 0.496）
#     · 放过相关查询（最低 0.599）
#
#   ⚠️ 这条门槛是**实测出来的**，不是拍的。将来换 embedding 模型要重测。
WINDOW_RECALL_MIN_SIM = 0.58
WINDOW_TIME_DECAY_DAYS = 7.0     # 时间权重衰减天数


def _content_key(his: str, said: str) -> str:
    """内容指纹：内容没变就不重算向量。"""
    raw = (str(his or "") + "\x00" + str(said or "")).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:16]


_CACHE_MEMORY = {"key":None,"data":{}}

def _load_cache() -> dict:
    if not os.path.exists(WINDOW_EMBED_CACHE):
        return {}
    try:
        stamp=os.stat(WINDOW_EMBED_CACHE)
        key=(WINDOW_EMBED_CACHE,stamp.st_mtime_ns,stamp.st_size)
        if _CACHE_MEMORY['key']==key:return _CACHE_MEMORY['data']
        with open(WINDOW_EMBED_CACHE, "r", encoding="utf-8") as f:
            d = json.load(f)
        data=d if isinstance(d,dict) else {}
        _CACHE_MEMORY.update(key=key,data=data)
        return data
    except Exception:
        return {}


def _is_isolated_or_test(turns, embedding_func) -> bool:
    """测试/注入参数或隔离模式下不写生产 window_embed_cache.json。

    ★ 2026-11-18 修（回归 bug）：
      上一版判据是「turns is not None or embedding_func is not None」——
      但**生产路径本身就传 embedding_func**（recall_service.py:419 把它一路
      传下来，值来自 ollama_embedding.get_embedding）。结果生产也命中
      「不写缓存」，缓存从上线起就没被写过，每次召回都要重算全部向量。

    新判据：看**函数身份**而不是「是否传了」。
      · turns 显式传入       → 一定是测试（生产走 _read_window_turns）
      · embedding_func 是 ollama_embedding.get_embedding（或其包装） → 生产
      · 其它任何函数（lambda / 测试模块里的 fn）→ 测试
      · _test_isolation.ISOLATED 为真 → 测试
    """
    if turns is not None:
        return True
    if embedding_func is not None and not _is_production_embedding(embedding_func):
        return True
    try:
        import _test_isolation as _ti
        if getattr(_ti, "ISOLATED", False):
            return True
    except Exception:
        pass
    return False


def _is_production_embedding(fn) -> bool:
    """判断一个 embedding 函数是不是「生产那份」（而不是测试塞的假函数）。

    认可两种情况：
      ① 就是 ollama_embedding.get_embedding 本身
      ② 定义在 ollama_embedding 模块里（防止包装/别名导致身份不同）
    其余一律当测试。
    """
    if fn is None:
        return False
    try:
        from ollama_embedding import get_embedding as _prod
        if fn is _prod:
            return True
    except Exception:
        pass
    mod = str(getattr(fn, "__module__", "") or "")
    qual = str(getattr(fn, "__qualname__", "") or "")
    if qual == "<lambda>":
        return False
    return mod == "ollama_embedding"


def _save_cache(cache: dict, live_keys: set = None, expected_dim: int = None) -> None:
    """原子写，顺便剪枝失效 key 与维度不符的假向量。失败不抛。"""
    try:
        to_save = cache
        if live_keys is not None or expected_dim is not None:
            from services.evidence_semantics import valid_vector
            to_save = {
                k: v for k, v in cache.items()
                if (live_keys is None or k in live_keys)
                and valid_vector(v, expected_dim)
            }
        os.makedirs(os.path.dirname(WINDOW_EMBED_CACHE), exist_ok=True)
        tmp = WINDOW_EMBED_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(to_save, f, ensure_ascii=False)
        os.replace(tmp, WINDOW_EMBED_CACHE)
        _CACHE_MEMORY.update(key=None, data={})
    except Exception:
        pass


def prune_cache(days: int = 30, expected_dim: int = 1024) -> dict:
    """清理 window_embed_cache.json 中已过期的 key 与假向量。"""
    cache = _load_cache()
    if not cache:
        return {"before": 0, "after": 0, "removed": 0}
    rows = _read_window_turns(session_id=None, days=days)
    live_keys = {
        _content_key(str(r.get("his") or ""), str(r.get("said") or ""))
        for r in rows
    }
    from services.evidence_semantics import valid_vector
    pruned = {
        k: v for k, v in cache.items()
        if k in live_keys and valid_vector(v, expected_dim)
    }
    if len(pruned) != len(cache):
        _save_cache(pruned)
    return {
        "before": len(cache),
        "after": len(pruned),
        "removed": len(cache) - len(pruned),
    }


def _read_window_turns(session_id=None, days=30):
    """读 window 轮次（只读）。"""
    import glob
    rows = []
    pattern = os.path.join(BASE_DIR, "window", "*", "turns.jsonl")
    cutoff = time.time() - max(1, int(days)) * 86400
    for path in glob.glob(pattern):
        sid = os.path.basename(os.path.dirname(path))
        if sid.startswith("_"):
            continue
        if session_id:
            from window_ledger import _session_dir
            expected=os.path.basename(_session_dir(session_id))
            if sid not in (session_id,expected):continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        t = json.loads(line)
                    except Exception:
                        continue
                    src = str(t.get("source") or "")
                    if src and src not in ("bridge", "prod"):
                        continue
                    at = t.get("said_at") or 0
                    if at and at < cutoff:
                        continue
                    t["_sid"] = session_id or sid
                    rows.append(t)
        except Exception:
            continue
    return rows


def recall_window(query, *, session_id=None, top_k=WINDOW_RECALL_TOP_K,
                  min_sim=WINDOW_RECALL_MIN_SIM,
                  embedding_func=None, days=30,
                  turns=None, context=None):
    """在 window 里做语义召回。

    返回：
        {
          "ok": bool,
          "reason": str,
          "items": [{"said_at","his","said","sim","time_w","score"}...],
          "elapsed_ms": float,
          "stats": {"turns": int, "cached": int, "computed": int},
        }

    ★ 只读。不写 window、不改字段、不续命。
    """
    t0 = time.time()
    out = {"ok": False, "reason": "", "items": [], "elapsed_ms": 0.0,
           "stats": {"turns": 0, "cached": 0, "computed": 0}}

    q = str(query or "").strip()
    if not q:
        out["reason"] = "query 为空"
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    embedding_func_was_none = embedding_func is None
    if embedding_func is None:
        from ollama_embedding import get_embedding as embedding_func

    rows = turns if turns is not None else _read_window_turns(session_id, days)
    if not rows:
        out["reason"] = "window 里没有轮次"
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    out["stats"]["turns"] = len(rows)

    # query 向量
    try:
        qv = embedding_func(q)
    except Exception as e:
        out["reason"] = "query embedding 失败: %s" % type(e).__name__
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out
    from services.evidence_semantics import valid_vector
    if not valid_vector(qv):
        out["reason"] = "query 向量为空"
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    cache = _load_cache()
    now = time.time()
    scored = []

    from recall_engine import cosine_similarity

    for r in rows:
        from recall_exclusions import excluded_turn
        from services.recall_policy import eligible, RecallContext
        policy_row = dict(r, content="他说：%s；我回：%s" % (r.get('his',''), r.get('said','')),
                          session_id=r.get('_sid') or session_id)
        if not eligible(policy_row, context or RecallContext(q, session_id or '')):
            continue
        if excluded_turn(r, session_id):
            continue
        his = str(r.get("his") or "")
        said = str(r.get("said") or "")
        from schema import is_recallable
        from recall_engine import is_meta_query
        if not is_recallable("他说：%s；我回：%s" % (his, said),
                             str(r.get("source") or ""), query_is_meta=is_meta_query(q)):
            continue
        if not his.strip() and not said.strip():
            continue
        key = _content_key(his, said)
        vec = cache.get(key)
        if not valid_vector(vec,len(qv)):
            try:
                # 存的内容跟长期库格式一致：他说…我回…
                text = ("他说：%s；我回：%s" % (his, said)) if his else said
                vec = embedding_func(text)
                cache[key] = vec
                out["stats"]["computed"] += 1
            except Exception:
                continue
        else:
            out["stats"]["cached"] += 1

        if not valid_vector(vec,len(qv)):
            continue

        sim = float(cosine_similarity(qv, vec))
        if sim < min_sim:
            continue

        # 时间权重：越近越高，7 天内线性
        at = float(r.get("said_at") or 0)
        age_days = max(0.0, (now - at) / 86400.0) if at else 0.0
        time_w = max(0.0, 1.0 - age_days / WINDOW_TIME_DECAY_DAYS)

        # 最终分：以语义为主（0.8），时间是辅助（0.2）
        score = sim * 0.8 + time_w * 0.2
        scored.append({
            "said_at": at,
            "his": his[:200],
            "said": said[:300],
            "sim": round(sim, 4),
            "time_w": round(time_w, 3),
            "score": round(score, 4),
            "session_id": r.get("_sid"),
        })

    if out["stats"]["computed"] and not _is_isolated_or_test(turns, None if embedding_func_was_none else embedding_func):
        # ★ 2026-11-18：传入本次扫到的 live_keys，让 _save_cache 顺带剪枝。
        #
        #   为什么不图省事只传 expected_dim：
        #     只按维度过滤的话，已经失效的 key（window 里那轮早被 30 天窗口
        #     清掉了）会一直留在缓存里。实测清完后 498 条里仍有 11 条失效。
        #     传 live_keys 后，每次召回写盘都是一次顺带剪枝，永远不需要
        #     单独跑 prune_cache。
        #
        #   为什么不会让下次召回重算大量向量：
        #     live_keys 是「本次真正扫到的轮次」，它们的 key 一个都不会被删；
        #     被删的只是「已经不在 window 里」的 key —— 那些本来也算不到。
        #     所以剪枝只会减少无用条目，不会增加任何一次重算。
        _live = {_content_key(str(r.get("his") or ""), str(r.get("said") or ""))
                 for r in rows}
        _save_cache(cache, live_keys=_live, expected_dim=len(qv))

    if not scored:
        out["reason"] = "扫了 %d 轮，没有达到相似度门槛 %.2f 的" % (
            len(rows), min_sim)
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    scored.sort(key=lambda x: -x["score"])
    out["ok"] = True
    out["items"] = scored[:top_k]
    out["elapsed_ms"] = (time.time() - t0) * 1000
    return out


def format_window_hits(result, max_chars=500):
    """把 window 召回结果渲染成 prompt 文本块。"""
    if not result or not result.get("ok") or not result.get("items"):
        return ""
    lines = ["【更早的原话】（从最近 30 天的对话记录里按语义找到的）"]
    used = len(lines[0])
    for it in result["items"]:
        at = it.get("said_at") or 0
        when = time.strftime("%m-%d %H:%M", time.localtime(at)) if at else "?"
        said = str(it.get("said") or "").replace("\n", " / ")
        line = "- %s：%s" % (when, said[:150])
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line)
    if len(lines) == 1:
        return ""
    return "\n".join(lines) + "\n"


def selftest():
    """自检：不依赖真实数据。"""
    print("window_recall selftest")
    # 假向量函数：按文本长度造可区分的向量
    def fake_embed(text):
        n = len(str(text))
        return [float((n + i) % 10) / 10.0 for i in range(8)]

    fake_turns = [
        {"said_at": time.time() - 3600, "his": "我想吃火锅", "said": "那晚上吃？",
         "source": "bridge", "_sid": "s1"},
        {"said_at": time.time() - 7200, "his": "今天天气不错", "said": "是挺好的",
         "source": "bridge", "_sid": "s1"},
    ]
    r = recall_window("火锅", turns=fake_turns, embedding_func=fake_embed,
                      min_sim=0.0)
    assert r["stats"]["turns"] == 2, r
    print("  ✅ 扫到 2 轮")

    r2 = recall_window("", turns=fake_turns, embedding_func=fake_embed)
    assert not r2["ok"] and "为空" in r2["reason"], r2
    print("  ✅ 空 query 拒绝")

    r3 = recall_window("x", turns=[], embedding_func=fake_embed)
    assert not r3["ok"], r3
    print("  ✅ 空 turns 拒绝")

    blk = format_window_hits(r, max_chars=300)
    assert "【更早的原话】" in blk, blk
    print("  ✅ 渲染格式正确")

    assert format_window_hits({"ok": False}) == ""
    print("  ✅ 无结果返回空串")

    print("window_recall selftest OK")


if __name__ == "__main__":
    selftest()
