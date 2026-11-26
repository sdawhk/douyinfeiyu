# -*- coding: utf-8 -*-
"""记忆治理规则集中处（2026-11-07 新增）。

## 它解决什么问题

改造前，「这条记忆该怎么处理」的答案散在 4 个地方：

```
config.py            参数（阈值、权重、速率）
schema.py            分类正则（FACT / COMMITMENT / DATE）
decay_logic.py       地板、冷存判断、是否该删
daily_consolidation  三档分流（L3/L2/L1/drop）
```

改一个阈值要翻 4 个文件，而且容易漏改。

## 它是怎么做的（重要：不复制实现）

**policy.py 不重写逻辑，只做两件事：**

1. **集中导出参数**（从 config 转发，保持单一真源）
2. **提供「一条记忆该怎么处理」的统一问答**

具体怎么算（衰减、地板、冷存）**仍然在 decay_logic 里**，
policy 只是把「取哪个参数、按什么顺序判断」这件事集中起来。

**这样不会出现「policy 里有套规则、decay_logic 里有另一套」的双真源问题。**

## 用法

```python
from policy import (
    DECAY_RATES, FLOORS, COLD_STORAGE, COLD_AWAKE,
    DEDUP_SIM, RECALL_TOP_K, RECALL_MAX_CHARS,
    triage, how_to_handle,
)
```
"""

# ── 参数集中导出（从 config 转发，不复制值）──────────────────
# 注意：这里全部是「引用」不是「定义」。
# 要改参数还是去 config.py 改，这里自动跟着变。
from config import (
    DECAY_RATE_MAP as DECAY_RATES,
    COLD_STORAGE_THRESHOLD,
    COLD_AWAKE_STRENGTH,
    DEDUPLICATION_SIM_THRESHOLD as DEDUP_SIM,
    CONSOLIDATION_SCORE_THRESHOLD,
    RECALL_TOP_K,
    RECALL_MAX_CHARS,
    SHORT_TERM_WINDOW_DAYS,
    SHORT_TERM_FORGET_THRESHOLD,
    SHORT_TERM_RECALL_TOP_K,
    SHORT_TERM_RECALL_MAX_CHARS,
    SHORT_TERM_MENTION_BONUS,
)

# ── 地板规则（从 decay_logic 转发）───────────────────────────
# 地板的「算法」在 decay_logic.importance_floor，这里只暴露常量供查。
FLOORS_BY_LEVEL = {3: 35.0, 2: 15.0, 1: 0.0}

# ── 三档分流的阈值（daily_consolidation 用）──────────────────
# 巩固分数 → 等级
# 2026-11-08 修（巡检第七轮发现）：原来这里写死 60，跟 config 的
#   CONSOLIDATION_SCORE_THRESHOLD=60 和 daily_consolidation.py:571 的
#   硬编码 60 是三份独立的字面量 —— 改一处另外两处不跟着变，也不报错。
#   现在 L3 阈值统一从 config 读，L2/L1 也放 config（它们是 policy 独有，但仍应集中）。
from config import CONSOLIDATION_SCORE_THRESHOLD as TRIAGE_L3_MIN
from config import TRIAGE_L2_MIN, TRIAGE_L1_MIN
# < 20 → 丢弃

# ── 冷存/删除的 importance 分档（2026-11-07 定）─────────────
COLD_KEEP_IMPORTANCE = 0.85   # >= 这个：靠地板保住，不许进冷存
COLD_MIN_IMPORTANCE = 0.20    # < 这个：真噪音，直接删
# 0.20 ~ 0.85：进冷存（当档案，不召回）

# ── 可信度分档（2026-11-08 T06 信任度）──────────────────────
# 强度低的时候还要再问一句「它本来是不是真的」：
#   credibility >= 0.6  → 进冷存当档案（模糊但可能有用的，留着能翻）
#   credibility <  0.6  → 直接删（本来就不确定，又没有唤起价值，留着只是噪音）
#
# 为什么门槛是 0.6 而不是更高：
#   0.6 = 「好像/大概/可能」这种推测。推测虽然不确定，但常常是通向事实的线索
#   （「他好像在示例城市工作」→ 后面被证实或推翻都有用），值得留档。
#   0.4（听说）以下才属于「既不确定、也没人需要」。
CREDIBILITY_COLD_MIN = 0.6

# ── 候选池三档门控用到的元讨论词（extractor 用）─────────────
META_WORDS = (
    '记忆系统', '记忆库', '记忆契约', '候选池', '窗口账本', '情境段', '情景档',
    '衰减', 'consolidation', 'importance', 'embedding', '向量', '召回', '联想链',
    'bug', '死代码', '脚本', '接口', '参数', '阈值', '函数', '模块',
    'schema', 'jsonl', 'git', 'commit', '部署', '重启',
)


def triage(score: float) -> str:
    """按巩固分数判等级。返回 'L3' / 'L2' / 'L1' / 'drop'。

    跟 daily_consolidation 里的分档逻辑完全一致（那边也会读这里的常量）。
    """
    if score >= TRIAGE_L3_MIN:
        return "L3"
    if score >= TRIAGE_L2_MIN:
        return "L2"
    if score >= TRIAGE_L1_MIN:
        return "L1"
    return "drop"


def level_of(triage_result: str) -> int:
    """'L3' → 3, 'L2' → 2, 'L1' → 1, 'drop' → 0"""
    return {"L3": 3, "L2": 2, "L1": 1}.get(triage_result, 0)


def how_to_handle(memory_item) -> dict:
    """统一回答：这条记忆现在该怎么处理。

    返回:
      {"action": "drop" | "cold" | "keep",
       "reason": "为什么",
       "level": 1|2|3|0,
       "floor": 强度地板,
       "credibility": 可信度（仅在强度低、进到冷存/删除判定时带上）}

    注意：**这个函数是只读的**，不修改 memory_item。
    真正的处置动作由 daily_consolidation 执行。
    """
    from decay_logic import importance_floor as _floor, peek_strength

    imp = float(getattr(memory_item, "importance", 0.0) or 0.0)
    level = int(getattr(memory_item, "consolidation_level", 2) or 2)
    strength = peek_strength(memory_item)      # 纯函数，不改状态
    floor = _floor(memory_item)
    # 2026-11-08 T06：可信度兜底（老数据可能没这个字段）
    cred = getattr(memory_item, "credibility", None)
    if cred is None:
        try:
            from schema import infer_credibility
            cred = infer_credibility(getattr(memory_item, "source", "") or "",
                                     str(getattr(memory_item, "content", "") or ""))
        except Exception:
            cred = 1.0
    try:
        cred = min(1.0, max(0.0, float(cred)))
    except (TypeError, ValueError):
        cred = 1.0

    # ① 空内容 → 直接删（bug，不是记忆）
    content = str(getattr(memory_item, "content", "") or "").strip()
    if not content:
        return {"action": "drop", "reason": "空内容", "level": level, "floor": floor}

    # ② importance 太低 → 真噪音
    if imp < COLD_MIN_IMPORTANCE:
        return {"action": "drop", "reason": f"importance {imp:.2f} < {COLD_MIN_IMPORTANCE}",
                "level": level, "floor": floor}

    # ③ 强度还够 → 留在活跃库
    if strength >= COLD_STORAGE_THRESHOLD:
        return {"action": "keep", "reason": f"强度 {strength:.1f} >= {COLD_STORAGE_THRESHOLD}",
                "level": level, "floor": floor}

    # ④ 强度低但 importance 高 → 靠地板保住，不许进冷存
    if imp >= COLD_KEEP_IMPORTANCE:
        return {"action": "keep",
                "reason": f"importance {imp:.2f} >= {COLD_KEEP_IMPORTANCE}，靠地板 (floor {floor:.0f}) 保住",
                "level": level, "floor": floor}

    # ⑤ 强度低 + 可信度也低 → 直接删（本来就不确定，已经没有留着的价值）
    #
    #   2026-11-08 T06 新增这一步。为什么放在冷存之前：
    #     冷存是「历史档案」—— 留着的前提是「它曾经是真的，只是一时想不起来」。
    #     一条「听说他好像要搬家」既想不起来、也不确定，进冷存只是把噪音挪个地方。
    #   注意：credibility 不随时间衰减，所以这条判断只看它「本来多确定」，
    #     跟放了多久无关 —— 三个月没提的明确事实（cred=1.0）照样进档案。
    #
    # ⚠️ 2026-11-08 实测（评审 核实）：**这条分支在当前真实数据上执行次数为 0。**
    #   实测 234 条记忆：
    #     · 地板 < 20（理论上才可能进到这一步）的只有 12 条
    #     · 这 12 条的 credibility 全是 1.0（没有一条含「好像/听说」）
    #     · 用真实数据跑 how_to_handle → {'keep': 234}，一次 cold/drop 都没走到
    #
    #   要真触发需要三个低概率事件相乘：
    #     ① 内容含不确定措辞（当前 0.43%，库里主体是工具知识/人设，本来就该 1.0）
    #     ② 分类落 speech（当前 12 条里 0 条）
    #     ③ 强度真掉到 20 以下（地板 ≥20 的压根到不了）
    #   → 实际上等于「永不触发」。
    #
    #   这不是 bug，也不是没接线 —— 是**等数据**。
    #   跟 context（没有读取者）、reflection（0 条）是同一类：
    #   读侧写对了，但写入侧还没产生足够的不确定措辞。
    #   真正的缺口在写入侧（识别「我朋友说他最近…」这类转述），不在这个分支。
    #   dataflow.py 里这个字段也标了「冷存分支当前不可达」，别看到 OK 就以为它在干活。
    if cred < CREDIBILITY_COLD_MIN:
        return {"action": "drop",
                "reason": f"强度 {strength:.1f} 低且可信度 {cred:.2f} < {CREDIBILITY_COLD_MIN}（本来就不确定）",
                "level": level, "floor": floor, "credibility": cred}

    # ⑥ 其余 → 进冷存当档案（可信但想不起来：是档案，不是噪音）
    return {"action": "cold",
            "reason": f"强度 {strength:.1f} 低、importance {imp:.2f} < {COLD_KEEP_IMPORTANCE}，但可信度 {cred:.2f} ≥ {CREDIBILITY_COLD_MIN} → 当档案",
            "level": level, "floor": floor, "credibility": cred}


def selftest() -> None:
    """自检：不依赖真实数据，造几条 MemoryItem 验证判断。"""
    from schema import MemoryItem

    # ① 空内容 → drop
    m = MemoryItem("   ", mem_type="long_term")
    assert how_to_handle(m)["action"] == "drop", "空内容应 drop"

    # ② importance 太低 → drop
    m = MemoryItem("随便一句话", mem_type="long_term", importance=0.1)
    assert how_to_handle(m)["action"] == "drop", "低 importance 应 drop"

    # ③ 强度够 → keep
    m = MemoryItem("正常的记忆", mem_type="long_term", strength=80, importance=0.5)
    assert how_to_handle(m)["action"] == "keep", "强度够应 keep"

    # ④ 强度低但 importance 高 → keep（靠地板）
    m = MemoryItem("重要的记忆", mem_type="long_term", strength=5, importance=0.92)
    m.last_active = m.create_time
    r = how_to_handle(m)
    assert r["action"] == "keep", f"高 importance 应 keep，实际 {r['action']} ({r['reason']})"

    # ⑤ 强度低 + importance 中 → 看地板是否挡住了
    #    2026-11-07 实测发现：importance=0.5 的地板是 30，> 冷存阈值 20
    #    ⇒ 这类记忆根本掉不到 20 以下 ⇒ 永远进不了冷存（keep）
    #    这跟「冷存永远空」是同一个原因，不是 bug，是地板设计的结果。
    m = MemoryItem("中等记忆", mem_type="long_term", strength=5, importance=0.5)
    m.last_active = m.create_time
    r = how_to_handle(m)
    floor_val = r["floor"]
    if floor_val >= COLD_STORAGE_THRESHOLD:
        assert r["action"] == "keep", f"地板({floor_val})挡住冷存，应 keep，实际 {r['action']}"
    else:
        assert r["action"] == "cold", f"地板({floor_val})挡不住，应 cold，实际 {r['action']}"

    # ⑥ 强度低 + 可信度低 → drop（2026-11-08 T06）
    #    需要一条地板挡不住、importance 又够的记忆：
    #    speech（0.22）地板 13.2 < 20，正好能掉进冷存区间。
    m = MemoryItem("听说他好像要搬家", mem_type="long_term", strength=3, importance=0.22)
    m.last_active = m.create_time
    r = how_to_handle(m)
    assert r["credibility"] < CREDIBILITY_COLD_MIN, f"应有低可信度，实际 {r.get('credibility')}"
    assert r["action"] == "drop", f"低可信应 drop，实际 {r['action']} ({r['reason']})"

    # ⑦ 强度低但可信度高 → cold（当档案，不能删）
    #    同样是 speech 级、同样快忘了，唯一的区别是「它是明确说过的」。
    m = MemoryItem("他说他以前养过一只白猫", mem_type="long_term", strength=3, importance=0.22)
    m.last_active = m.create_time
    r = how_to_handle(m)
    assert r["credibility"] >= CREDIBILITY_COLD_MIN, f"应有高可信度，实际 {r.get('credibility')}"
    assert r["action"] == "cold", f"可信应 cold，实际 {r['action']} ({r['reason']})"

    # ⑧ triage 分档
    assert triage(80) == "L3"
    assert triage(50) == "L2"
    assert triage(25) == "L1"
    assert triage(10) == "drop"
    assert level_of("L3") == 3
    assert level_of("drop") == 0

    print("policy.py selftest OK")
    print(f"  分档阈值: L3>={TRIAGE_L3_MIN} L2>={TRIAGE_L2_MIN} L1>={TRIAGE_L1_MIN}")
    print(f"  冷存阈值: 强度 < {COLD_STORAGE_THRESHOLD}")
    print(f"  importance 分档: <{COLD_MIN_IMPORTANCE} 删, "
          f"{COLD_MIN_IMPORTANCE}~{COLD_KEEP_IMPORTANCE} 进档案, >={COLD_KEEP_IMPORTANCE} 地板保住")
    print()
    print("  ⚠️ 已知事实：importance >= 0.34 的记忆地板 >= 20，")
    print("     永远掉不到冷存阈值以下 ⇒ 冷存实际上只会收到 importance < 0.34 的。")
    print("     这跟「冷存永远空」是同一个原因，是地板设计的结果，不是 bug。")


if __name__ == "__main__":
    selftest()
