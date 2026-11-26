# -*- coding: utf-8 -*-
r"""window 关键词回退搜索（P1）。

## 它解决什么

    桥接每轮把原话写进 data/window/<sid>/turns.jsonl（保留 30 天）。
    但 memory_cli 的 recall 分支**完全不读 window** —— 实测 43 行里 0 处提到。
    
    于是：
      第 1 天：进 shortterm（100 条）
      第 4 天：shortterm 里没了（3 天衰减）
      第 5 天：window 里还有全文，但**召回不到** ← 这里丢的
      第 31 天：window 也清了
      
    这个模块补的就是这段：在主召回结果不够/不够准时，
    去 window 里做一次关键词回退。

## 为什么不预先算 embedding

    实测：单条 33ms，505 条 17.3 秒，向量 20.2 KB/条
    → 30 天累计（15000 条）= 300 MB
    → 太贵，而且大部分轮次永远用不上

    关键词扫一遍 900 KB 文本 ≈ 几毫秒，零存储。

## 为什么不是「零漏判」

    关键词语义覆盖弱：
      问「上次吃火锅」 → window 里有「牛油锅底」 → 整句 LIKE 匹配不到
    → 所以它是「低成本覆盖一部分」，不是「全覆盖」。
    → 真正全覆盖要 embedding 语义搜索（代价见上），留到 P3 之后再评估。

## 约束（很重要）

    · **只读 window，不写**。不触发任何打分/续命 → 不会造反馈环
    · 超时兜底：超过 WINDOW_FALLBACK_TIMEOUT_MS 就放弃，不拖慢主召回
    · 不写回 shortterm / 不改 strength
"""

import os
import re
import sys
import time
import unicodedata



# 回退搜索的配置
WINDOW_FALLBACK_TIMEOUT_MS = 200      # 超时兜底（毫秒）
WINDOW_FALLBACK_TOP_K = 5             # 最多补几条
WINDOW_FALLBACK_LOOKBACK_DAYS = 30    # 往前找多少天（跟 WINDOW_KEEP_DAYS 一致）
WINDOW_FALLBACK_MIN_QUERY_CHARS = 2   # query 短于这个不搜（避免噪音）

# 中文停用词（query 里这些词不参与匹配，否则满屏命中）
STOPWORDS = {
    "的", "了", "是", "在", "和", "有", "我", "你", "他", "她", "它",
    "吗", "呢", "吧", "啊", "呀", "哦", "嗯", "这", "那", "什么", "怎么",
    "上次", "那次", "记得", "之前", "以前", "后来", "今天", "昨天",
    "一下", "一个", "可以", "没有", "还是", "就是", "因为", "所以",
}


def _norm(text: str) -> str:
    """归一化：全角转半角、小写、去多余空白。"""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", str(text))
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def extract_keywords(query: str) -> list:
    """从 query 里抽实词（不引入分词库，用字符二元组 + 停用词过滤）。

    为什么用二元组而不是分词：
      项目里没有 jieba 之类的依赖，加一个分词库会引入新依赖和新风险。
      而中文二元组对「火锅」「生日」「三点」这类实词效果够用。

    返回：按长度降序的关键词列表（长的优先，命中权重更高）
    """
    q = _norm(query)
    if not q:
        return []

    # 去掉标点
    q = re.sub(r"[\s，。！？、；：\"'（）()《》【】\[\]~～…\-_/,.;:!?]+", "", q)
    if len(q) < WINDOW_FALLBACK_MIN_QUERY_CHARS:
        return []

    kws = set()
    # ① 整句（如果够短，比如「火锅」两个字）
    if 2 <= len(q) <= 6:
        kws.add(q)

    # ② 二元组
    for i in range(len(q) - 1):
        bg = q[i:i + 2]
        if bg in STOPWORDS:
            continue
        # 纯停用字组成的二元组也丢
        if all(ch in STOPWORDS for ch in bg):
            continue
        if len(bg.strip()) < 2:
            continue
        kws.add(bg)

    # ③ 三元组（更精确，但要求不含停用词）
    for i in range(len(q) - 2):
        tg = q[i:i + 3]
        if any(ch in STOPWORDS for ch in tg):
            continue
        kws.add(tg)

    # 长的在前（更精确）
    return sorted(kws, key=lambda x: (-len(x), x))


def _list_session_dirs():
    """列出 window 下的会话目录。"""
    from window_ledger import WINDOW_DIR
    root = WINDOW_DIR
    if not os.path.isdir(root):
        return []
    out = []
    try:
        for name in os.listdir(root):
            if name.startswith("_"):        # _deleted / _admin 这类管理目录
                continue
            d = os.path.join(root, name)
            if os.path.isdir(d):
                out.append((name, d))
    except Exception:
        pass
    return out


def search_window(query: str, *, session_id: str = None,
                  top_k: int = WINDOW_FALLBACK_TOP_K,
                  lookback_days: int = WINDOW_FALLBACK_LOOKBACK_DAYS,
                  timeout_ms: int = WINDOW_FALLBACK_TIMEOUT_MS,
                  turns_by_session: dict = None) -> dict:
    """在 window 里做关键词回退搜索。

    参数：
        query              查询文本
        session_id         限定会话（None = 搜全部会话）
        top_k              返回几条
        lookback_days      往前找多少天
        timeout_ms         超时兜底
        turns_by_session   直接给轮次数据（测试用，不读文件）
                           {session_id: [turn_dict, ...]}

    返回：
        {
          "ok": bool,
          "reason": str,               # 没搜到/超时/query 太短 的原因
          "elapsed_ms": float,
          "items": [
            {"session_id":..., "said_at":..., "his":..., "said":...,
             "score": float, "hits": [命中的词]}
          ],
        }

    ★ 只读。不改任何状态。
    """
    t0 = time.time()
    out = {"ok": False, "reason": "", "elapsed_ms": 0.0, "items": []}

    kws = extract_keywords(query)
    if not kws:
        out["reason"] = "query 里没有可用关键词（太短或全是停用词）"
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    # 组装待搜的轮次
    sessions = {}
    if turns_by_session is not None:
        sessions = {sid: rows for sid, rows in turns_by_session.items()
                    if not session_id or sid == session_id}
    else:
        dirs = _list_session_dirs()
        if session_id:
            from window_ledger import _safe_sid
            directory = _safe_sid(session_id)
            dirs = [(n, d) for n, d in dirs if n == directory]
        for name, d in dirs:
            p = os.path.join(d, "turns.jsonl")
            if not os.path.exists(p):
                continue
            rows = []
            try:
                import json
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            rows.append(json.loads(line))
                        except Exception:
                            continue
            except Exception:
                continue
            if rows:
                sessions[session_id or name] = rows

    if not sessions:
        out["reason"] = "window 里没有会话数据"
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    cutoff = time.time() - max(1, int(lookback_days)) * 86400
    deadline = t0 + timeout_ms / 1000.0

    scored = []
    scanned = 0
    for sid, rows in sessions.items():
        for r in rows:
            # 超时兜底：立刻放弃，返回已找到的（不拖慢主召回）
            if time.time() > deadline:
                out["reason"] = "超时（已扫 %d 轮）" % scanned
                break
            scanned += 1
            at = r.get("said_at") or 0
            if at and at < cutoff:
                continue
            # 只搜生产来源（不要 probe/test）
            src = str(r.get("source") or "")
            if src and src not in ("bridge", "prod", ""):
                continue
            his = _norm(r.get("his") or "")
            said = _norm(r.get("said") or "")
            blob = his + "\n" + said
            if not blob.strip():
                continue

            hits = [k for k in kws if k in blob]
            if not hits:
                continue
            # 打分：命中的词越长越重；命中在 his（用户说的）里额外加分
            score = 0.0
            for k in hits:
                w = len(k) * 1.0
                if k in his:
                    w *= 1.5        # 用户自己说的词，相关性更强
                score += w
            scored.append({
                "session_id": sid,
                "said_at": at,
                "his": str(r.get("his") or "")[:200],
                "said": str(r.get("said") or "")[:300],
                "score": round(score, 2),
                "hits": hits[:6],
            })
        else:
            continue
        break       # 内层 break（超时）后也跳出外层

    if not scored:
        if not out["reason"]:
            out["reason"] = "扫了 %d 轮，没有命中任何关键词" % scanned
        out["elapsed_ms"] = (time.time() - t0) * 1000
        return out

    # 按分数降序，同分按时间新的在前
    scored.sort(key=lambda x: (-x["score"], -(x["said_at"] or 0)))
    out["ok"] = True
    out["items"] = scored[:top_k]
    out["scanned"] = scanned
    out["keywords"] = kws[:8]
    out["elapsed_ms"] = (time.time() - t0) * 1000
    return out


def format_fallback_block(result: dict, max_chars: int = 600) -> str:
    """把回退结果渲染成 prompt 文本块。

    格式刻意跟主召回不同 —— 让模型知道这是「从原话里翻出来的」，
    不是「记忆库里召回的」。
    """
    if not result or not result.get("ok") or not result.get("items"):
        return ""
    lines = ["【翻到的原话】（从最近 30 天的对话记录里按关键词找到的，不是记忆库召回）"]
    used = len(lines[0])
    for it in result["items"]:
        at = it.get("said_at") or 0
        when = time.strftime("%m-%d %H:%M", time.localtime(at)) if at else "?"
        said = (it.get("said") or "").replace("\n", " / ")
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
    print("=" * 72)
    print("window 回退 selftest")
    print("=" * 72)

    # ① 关键词抽取
    kws = extract_keywords("上次吃火锅那次")
    assert "火锅" in kws, "应该抽出「火锅」: %s" % kws
    assert "吃火" in kws or "火锅" in kws, kws
    print("  OK ① 关键词抽取：%s" % kws[:6])

    kws2 = extract_keywords("嗯")
    assert not kws2, "单字应该抽不出关键词: %s" % kws2
    print("  OK ② 太短不抽词")

    # ③ 停用词过滤
    kws3 = extract_keywords("你吃饭了吗")
    assert "吃饭" in kws3, kws3
    print("  OK ③ 停用词过滤：%s" % kws3[:5])

    # ④ 用假数据搜
    fake = {
        "s1": [
            {"said_at": time.time() - 100, "his": "他说：今天吃了牛油火锅",
             "said": "辣得直冒汗", "source": "bridge"},
            {"said_at": time.time() - 200, "his": "他说：你好",
             "said": "嗯", "source": "bridge"},
            {"said_at": time.time() - 300, "his": "他说：吃火锅吗",
             "said": "好啊", "source": "probe"},   # probe 该被排除
        ]
    }
    r = search_window("火锅", turns_by_session=fake)
    assert r["ok"], "应该搜到: %s" % r.get("reason")
    assert len(r["items"]) == 1, "probe 应该被排除，实际 %d" % len(r["items"])
    assert "火锅" in r["items"][0]["hits"][0] or "火锅" in r["items"][0]["hits"]
    print("  OK ④ 搜到 %d 条（probe 已排除）" % len(r["items"]))

    # ⑤ 太老的不要
    fake_old = {
        "s1": [{"said_at": time.time() - 40 * 86400,
                "his": "他说：很久以前的火锅", "said": "嗯", "source": "bridge"}]
    }
    r2 = search_window("火锅", turns_by_session=fake_old, lookback_days=30)
    assert not r2["ok"], "40 天前的应该被排除"
    print("  OK ⑤ 超窗口的不返回")

    # ⑥ 渲染格式
    blk = format_fallback_block(r)
    assert "【翻到的原话】" in blk, blk
    assert "不是记忆库召回" in blk, blk
    print("  OK ⑥ 渲染格式正确")

    # ⑦ 空结果渲染空串
    assert format_fallback_block({"ok": False}) == ""
    print("  OK ⑦ 无结果返回空串")

    print()
    print("window_fallback selftest OK")


if __name__ == "__main__":
    selftest()
