import json
import os
from datetime import datetime
from filelock import FileLock

# is_singleton 是 filelock 3.12.3+ 才有的，老版本传这个 kw 会 TypeError。
try:
    import inspect as _inspect_singleton
    _FILELOCK_SINGLETON_KW = ({"is_singleton": True}
                              if "is_singleton" in _inspect_singleton.signature(FileLock).parameters
                              else {})
except Exception:
    _FILELOCK_SINGLETON_KW = {}
from typing import Dict, List, Optional

from config import (
    MOOD_FILE_PATH, MEMORY_MD_PATH, ROLE_FILE_PATH, WORKING_MEM_PATH,
    LONG_TERM_ACTIVE_PATH, LOCK_FILE_PATH,
    INIT_WORKING_TOP_K, INIT_LONG_TERM_TOP_K, CROSS_DAY_HOURS, RECALL_MAX_CHARS,
)
from schema import MemoryItem
from recall_engine import hybrid_rerank
from decay_logic import (
    calculate_current_strength, peek_strength,
    # 2026-11-10 第二步：无向量分支的印象兜底要用它（C-改）
    peek_impression,
)
# 印象判据常量：一律从 config 读，**不许在本文件写字面量**。
#   （写死过的教训见 _pick_impression_lines 里的注释）
from config import IMPRESSION_RECALL_MIN, IMPRESSION_DETAIL_MAX


# ═══════════════════════════════════════════════════════════════
# 2026-11-10 第二步 · 记忆行渲染的唯一入口
# ═══════════════════════════════════════════════════════════════
#
# 【为什么要有这个函数】
#   本文件原来有 4 处直接 `f"...：{mem.content}"` 拼字符串，全部
#   零标注、零印象层感知。而它是**新会话开局**的注入 ——
#   用户最先看到的那批记忆，全都不带任何「细节已淡」提示。
#
#   后果（产品方 2026-11-10 指出，确认成立）：
#     新会话开局 → session_init → 显示「完整细节」
#     聊两句之后 → recall        → 显示「细节已淡」
#   同一条记忆，前后自相矛盾。这是**正确性问题**，不是效果问题。
#
# 【为什么用 _render_mem_line 而不是各写各的】
#   「单一真相源」此前只在 recall 那条路上成立：
#     recall        → recall_engine.render_memory_line()   ✅ 有标注
#     memory_cli    → memory_manager.format_with_later_thought() ✅ 有标注
#     mcp_server    → 同上                                  ✅ 有标注
#     session_init  → 4 处手拼                              ❌ 没有
#     工作记忆      → 手拼（不衰减，本就没有印象层概念）
#   判据统一来自 decay_logic.impression_state()，本函数只负责排版。
#
# ⚠️ 与 recall 那两处的**排版**不同（前缀「背景记忆：」vs「【当时】」），
#    这是各自场景需要的，不改。但**判定**必须一致 —— 见
#    tests/test_injection_path.py::test_all_injection_paths_agree。

def _render_mem_line(mem, prefix: str) -> str:
    """按印象状态渲染一行注入文本（session_init 专用排版）。

      三档（判据唯一来源：decay_logic.impression_state）：
        intact        → f"{prefix}：{原文}"          （跟改动前逐字一致）
        faded_detail  → 原文 + （细节已淡…）
        erased_detail → **不出现原文**，只给「记得有这么回事」
                        ★ 任务书 T4：不得用已淡忘的 detail 描述细节

    ⚠️ 任何异常都退回原样输出 —— 注入路径绝不能因为新功能挂掉。
    """
    content = str(getattr(mem, "content", "") or "")
    try:
        from decay_logic import impression_state as _imp_state
        state = _imp_state(mem)
    except Exception:
        state = "intact"

    if state == "erased_detail":
        # 只保留「有这么回事」的骨架，原文一个字都不拼进去
        topic = "、".join(sorted(set(
            t for t in ("医院", "住院", "手术", "去世", "吵架", "生日",
                        "工作", "搬家", "生病") if t in content))[:3])
        tail = f"（和「{topic}」有关）" if topic else ""
        return f"{prefix}：【记得有这么回事】{tail}细节基本想不起来了，只记得这件事发生过"
    if state == "faded_detail":
        return f"{prefix}：{content}（细节已淡，只记得这件事发生过）"
    return f"{prefix}：{content}"


def _pick_impression_lines(active_list, exclude_ids, limit: int = 2,
                           current_ts: float = None) -> list:
    """无向量分支专用：单独挑「印象最高」的几条（C-改，2026-11-10）。

    ═══════════════════════════════════════════════════════════
    为什么需要这个函数（以及为什么不用 max(strength, impression) 排序）
    ═══════════════════════════════════════════════════════════
    问题：无向量分支只能按 peek_strength 排序取前 2 条。
      细节地板释放后，有印象层的记忆 strength 掉到 13~19，
      **排不进前 2 名**。实测（21 条模拟库，target 是 180 天前的高情绪事件）：
          单轨: strength 45.00，排第 12/21  → 本来就进不了
          双轨: strength 15.75，排第 21/21  → 更进不了
      所以不是「双轨更差」，是「双轨把本来就弱的路放大了」。

    方案对比（产品方 2026-11-10 定的 C-改）：
      ✗ B  按 max(strength, impression) 排序
           → 把两个**不同量纲、不同语义**的数塞进一根轴比大小。
             这跟 hybrid_rerank 里「sim/strength/emotion 加权」是同类错误，
             而且会让「强度」失去「多鲜活」的独立含义。
      ✓ C-改（本函数）正常排序**原样不动**，另外**单独**挑印象最高的几条，
              **分节呈现、排在正常结果之后**，并明确标注这是「印象」不是「相关召回」。

    为什么分节而不是混排：无向量分支**没有相关性信息**。
      混排会让人以为「这几条跟这次话题有关」，那是假的。
      分节（「背景记忆：…」/「印象里的：…」）不假装有相关性。

    ⚠️ 这里**不做语义筛选**（没有向量可用），只按印象分取 top N。
       这是这条路径的固有局限，不是遗漏。
    """
    if not active_list:
        return []
    if current_ts is None:
        from datetime import datetime as _dt
        current_ts = _dt.now().timestamp()

    ex = set(exclude_ids or ())
    scored = []
    for m in active_list:
        if getattr(m, "mem_id", None) in ex:
            continue
        try:
            imp = peek_impression(m, current_ts)
        except Exception:
            continue
        # 只挑「确实有印象层」且「细节已经淡了」的 —— 细节还清楚的那些
        # 本来就在正常排序里排得上去，不需要兜底
        #
        # ⚠️ 2026-11-10 修（产品方指出）：原来这里写死 40.0 / 30.0 两个字面量，
        #    而同样的阈值在 config 里已经有常量（IMPRESSION_RECALL_MIN /
        #    IMPRESSION_DETAIL_MAX），decay_logic / recall_engine 都在读常量。
        #    这里写死 = 将来改 config 时漏掉这一处，形成新的不一致。
        #    （本项目已有前科：TRIAGE_L1_MIN 与字面量 20 并存那次。）
        if imp < IMPRESSION_RECALL_MIN:
            continue
        try:
            detail = peek_strength(m, current_ts)
        except Exception:
            detail = 0.0
        if detail >= IMPRESSION_DETAIL_MAX:
            continue
        scored.append((imp, m))

    scored.sort(key=lambda x: -x[0])
    return [m for _imp, m in scored[:max(0, int(limit))]]



# __UTF8_STDOUT_GUARD__ (2026-11-07)
# 中文 Windows 终端默认 GBK，print 输出 emoji（✅❌⚠️）会 UnicodeEncodeError 直接崩。
# 实测：link_check / test_shortterm / regression_test 在 cmd 里跑不起来。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ═══════════════════════════════════════════════════════════
# 注入块 marker（2026-11-08，T15）
# ═══════════════════════════════════════════════════════════
#
# 解决什么：同一段内容被注入两次 —— 既烧 token，也会被理解成「两件事」。
# 真实场景就三种：
#   ① 桥接拼提示词时把初始化上下文拼了两遍（重试 / 重连）
#   ② 进程重启后重新 init，但旧的那份还挂在会话里
#   ③ 手动调试时反复贴同一段
#
# 做法：注入的块用一对 HTML 注释包起来。
#   · 注释对模型**是无害的**（DeepSeek / 大多数模型都忽略 HTML 注释）
#   · 但它是**可定位的**：下次注入前先把旧的整块删掉，再放新的
#   · 用注释而不是【标记】这种可见文字，是因为可见文字会被模型当内容复述
#
# 硬规则：**没有 marker 的文本原样返回**。
#   开关关掉 / 老格式没有标记时，strip_old_block 必须是纯粹的空操作，
#   否则「打开开关」就等于「改了别人的提示词」。

BLOCK_START = '<!--MEM_START-->'
BLOCK_END = '<!--MEM_END-->'


def _drop_markers(text) -> str:
    """只摘掉 marker 记号本身，**内容全部保留**。

    跟 strip_old_block 的区别（这个区别很关键，写错过一次）：
      strip_old_block  删「整块」（marker + 里面的内容）← 用来替换旧块
      _drop_markers    只删「记号本身」                ← 用来防止套层

    wrap_with_marker 如果误用 strip_old_block，把一段已经包好的内容再包一次时，
    里层的内容会**连同标记一起被删掉**，结果得到一个空块 —— 内容静默消失。
    """
    text = "" if text is None else str(text)
    return text.replace(BLOCK_START, "").replace(BLOCK_END, "")


def wrap_with_marker(text) -> str:
    """给注入块加 marker。

    幂等：wrap_with_marker(wrap_with_marker(x)) 等于 wrap_with_marker(x)
    —— 里层的记号先摘掉（内容留着），所以永远不会套成两层。
    """
    body = _drop_markers(text).strip()
    return BLOCK_START + "\n" + body + "\n" + BLOCK_END


def strip_old_block(prompt_text) -> str:
    """删掉旧的注入块（如果有）。

    如果同一段 prompt 被反复加，这个能防止重复。
    三种情况都要处理：
      · 正常成对：BLOCK_START … BLOCK_END 整段删
      · 半写断裂：只有 BLOCK_START 没有 BLOCK_END（进程被杀在写一半）
        → 从 START 起到结尾全删（它本来就是要被下一块替换掉的）
      · 孤零零的 BLOCK_END（前面被截断）→ 单独删掉这个标记

    **没有任何 marker 时原样返回**（不做 strip、不改空白）。
    """
    text = "" if prompt_text is None else str(prompt_text)
    if BLOCK_START not in text and BLOCK_END not in text:
        return text

    out = text
    changed = False
    while True:
        i = out.find(BLOCK_START)
        if i < 0:
            break
        j = out.find(BLOCK_END, i + len(BLOCK_START))
        if j < 0:
            # 半写断裂：后面没有闭合标记，直接截断
            out = out[:i]
            changed = True
            break
        out = out[:i] + out[j + len(BLOCK_END):]
        changed = True

    # 孤立的 BLOCK_END（没有配对的 START）
    if BLOCK_END in out:
        out = out.replace(BLOCK_END, "")
        changed = True

    return out.strip() if changed else out


def inject_block(prompt_text, block_text) -> str:
    """先删旧的，再加新的。

    返回：`<基础提示词>\n\n<新块>`
    —— 保证最终只有一块，且是**最新的**那一块。
    """
    base = strip_old_block(prompt_text).rstrip()
    block = wrap_with_marker(block_text)
    if not base:
        return block
    return base + "\n\n" + block


def _feature_on(name: str) -> bool:
    """查开关。模块缺失时返回 False（安全默认：不认识的能力不启用）。"""
    try:
        from features import on
        return bool(on(name))
    except Exception:
        return False


def _query_entities(opening_text: Optional[str]) -> List[str]:
    """从开场白里抽实体名，给 hybrid_rerank 的实体加分用。

    2026-11-08：**降级成薄包装**（方案 B）。
      抽取 + 取名字 + 去重的逻辑收进 entity_graph.extract_entity_names，
      这里只负责「要不要用」（features 开关）和「炸了怎么办」。

    为什么开关留在这里、不放 entity_graph：
      开关是**调用方**的决策 —— 同一个模块，init 想用、别处不想用是合法的。
      底层函数永远正常干活，单测就不用先摆开关。

    为什么宁缺毋滥：
      抽不到就返回空列表。hybrid_rerank 里 bonus = len(空集 & tags) * BONUS = 0，
      跟没有实体加分等价 —— 也就是说「这次没抽到」不会引入错误加分。

    实测（真实开场白）：
      「今天好累啊」                     → []            （本来就没实体）
      「用户说想吃火锅」                 → 朋友 / 火锅
      「他说：你做吧；我回：那我下个面」 → 面
    """
    text = (opening_text or "").strip()
    if not text:
        return []
    if not _feature_on("entity_graph"):
        return []
    try:
        from entity_graph import extract_entity_names
        return list(extract_entity_names(text) or [])
    except Exception:
        # 模块缺失 / 抽取炸了：退化成旧行为（空列表），绝不因为加分失败影响初始化
        return []


def selftest() -> bool:
    """自检（不依赖外部数据，5 秒内跑完）。"""
    # 1. 没有 marker 的文本原样返回（空操作）
    assert strip_old_block("基础提示词") == "基础提示词"
    assert strip_old_block("") == ""
    assert strip_old_block(None) == ""

    # 2. 加 marker
    w = wrap_with_marker("记忆块1")
    assert w.startswith(BLOCK_START) and w.endswith(BLOCK_END), w
    assert "记忆块1" in w

    # 3. wrap 幂等（不会套两层）
    assert wrap_with_marker(w) == w, "wrap 不幂等，会套层"
    assert wrap_with_marker(w).count(BLOCK_START) == 1

    # 4. 注入两次只有最新的那块（这是本功能的唯一目的）
    p1 = inject_block("基础提示词", "记忆块1")
    assert "MEM_START" in p1
    p2 = inject_block(p1, "记忆块2")
    assert "记忆块1" not in p2, "旧的没删掉！"
    assert "记忆块2" in p2
    assert p2.count(BLOCK_START) == 1 and p2.count(BLOCK_END) == 1
    # 基础提示词不能被吃掉
    assert p2.startswith("基础提示词"), p2[:20]

    # 5. 连注 5 次仍然只有一块
    p = "基础提示词"
    for i in range(5):
        p = inject_block(p, "第%d块" % i)
    assert p.count(BLOCK_START) == 1, "连注多次出现了 %d 个 START" % p.count(BLOCK_START)
    assert "第4块" in p and "第0块" not in p

    # 6. 半写断裂（只有 START）能被清掉
    broken = "基础提示词\n\n" + BLOCK_START + "\n写了一半就断电了"
    cleaned = strip_old_block(broken)
    assert BLOCK_START not in cleaned, "半写断裂没清掉"
    assert "写了一半" not in cleaned
    assert cleaned == "基础提示词"

    # 7. 孤立 END 能被清掉
    assert BLOCK_END not in strip_old_block("提示词\n" + BLOCK_END)

    # 8. 空块也能处理
    assert inject_block("", "") == BLOCK_START + "\n\n" + BLOCK_END

    print("session_init.py marker selftest OK")
    return True

def _read_file(path: str) -> str:
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()


def _load_json(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _is_cross_day(last_time: float) -> bool:
    if not last_time:
        return True
    return (datetime.now().timestamp() - last_time) / 3600 >= CROSS_DAY_HOURS


def get_mood_line() -> str:
    """⚠️ 已废弃（2026-11-07）—— 不要用它，也别接它。

    原来想用它把心情拼进上下文，但**这件事 mood-provider 插件已经做了，而且做得更好**：

      dsh-mood-provider/lib/index.js:1506
        agent.ctx.systemPrompt.context({...})
      （插件注释原文：按设置把心情告诉目标会话，systemPrompt.context，保住 DeepSeek 前缀缓存）

    对比：
      · 插件走 systemPrompt.context 官方钩子，**保住 DeepSeek 前缀缓存**
      · 本函数手动拼 "当前情绪状态：X/100" 字符串塞进上下文，会破坏前缀缓存
      · 两套并存 = 心情被注入两遍

    所以心情注入的唯一来源是插件。本函数保留仅为兼容历史调用，
    链检查（link_check.py）会把它标成「无人调用」，这是**预期的**，不是缺陷。

    什么时候可以删：确认没有外部脚本 import 它之后。
    """
    mood_data = _load_json(MOOD_FILE_PATH)
    try:
        moods = mood_data.get("moods", {})
        last_active = mood_data.get("lastActive", "__default__")
        cur = moods.get(last_active, moods.get("__default__", {}))
        mood_val = cur.get("mood", 50)
        reason = cur.get("lastReason", "")
        return f"当前情绪状态：{mood_val}/100。" + (f"原因：{reason[:120]}" if reason else "")
    except Exception:
        return "当前情绪：平静"



def _bound_init(text, budget, *, unit="bytes"):
    def clip(value, size):
        if unit == "characters":
            return value[:size]
        return value.encode("utf-8")[:size].decode("utf-8", errors="ignore")

    if clip(text, budget) == text:
        return text
    if not (text.startswith(BLOCK_START) and text.endswith(BLOCK_END)):
        return clip(text, budget)
    body = text[len(BLOCK_START):-len(BLOCK_END)].strip()
    head = clip(body, budget - len(BLOCK_START + BLOCK_END) - 2)
    return BLOCK_START + "\n" + head.rstrip() + "\n" + BLOCK_END


def _compact_init(session_id, budget):
    role = _bound_init(_read_file(ROLE_FILE_PATH), 400)
    core = "" if str(session_id or "").startswith("group:") else _read_file(MEMORY_MD_PATH)
    handover = ""
    if session_id and _feature_on("handover"):
        from handover import build_inject_text, read_latest_handover
        overview = read_latest_handover(prefer_session_id=session_id)
        if overview and overview.get("session") == session_id:
            handover = build_inject_text(overview) or ""
    context = "\n".join(part for part in ("【人格卡】", role, handover, "【记忆库】", core) if part)
    marked = _feature_on("inject_marker")
    context = _bound_init(wrap_with_marker(context) if marked else context, budget)
    return {"context": context, "estimated_token": len(context.encode("utf-8")),
            "is_new_session": session_id is None, "is_cross_day": None, "marker": marked,
            "handover_reconstructed": False}


def build_session_init_context(
    session_id: Optional[str] = None,
    query_embedding: Optional[List[float]] = None,
    opening_text: Optional[str] = None,
    *, profile_mode=None,
) -> Dict:
    """构建会话初始化上下文：身份锚（核心记忆）+ 情绪锚 + 事件锚 + 长时记忆召回。

    只读本系统文件与 mood-provider / 记忆.md，绝不触碰社交库。

    2026-11-08 修（评审 核查 + 巡检日志第 4 条）：
      原来 hybrid_rerank 的第二个参数（query_entities）**写死成 []**：
          top_mems = hybrid_rerank(query_embedding, [], {...}, active_list, TOP_K)
      后果是 entity 加分整条路恒为 0：
          hit_count = len(set([]) & tags) = 0
          bonus = min(0 * ENTITY_BONUS, ENTITY_BONUS_MAX) = 0
      也就是说 ENTITY_BONUS 在这里**从来没生效过**，跟 entity_graph 接没接线无关。

      修法：多收一个 opening_text（开场白原文），用 entity_graph.extract_entities
      抽出实体，交给 hybrid_rerank。抽不到就传空列表 —— 那跟旧行为一致，不会更差。
    """
    # ★ 2026-11-08 修 Deadlock：必须跟 handover / memory_manager 用同一个 singleton 锁对象。
    #   filelock 的非 singleton 实例在同一线程被二次 acquire 会直接抛 Deadlock；
    #   而只有「双方都用 is_singleton=True」时才会拿到同一个锁对象、才能重入。
    #   实测三种组合：
    #     外普通 + 内 singleton -> Timeout
    #     外 singleton + 内 singleton -> 重入 OK   ← 只有这种行
    #     外 singleton + 内普通 -> Timeout
    from config import INIT_DEFAULT_PROFILE, INIT_MAX_TOKEN, INIT_MAX_TOKEN_COMPACT
    profile_mode = INIT_DEFAULT_PROFILE if profile_mode is None else profile_mode
    if profile_mode not in ("compact", "companion"):
        raise ValueError("invalid profile_mode")
    if profile_mode == "compact":
        return _compact_init(session_id, INIT_MAX_TOKEN_COMPACT)
    lock = FileLock(LOCK_FILE_PATH, **_FILELOCK_SINGLETON_KW)
    with lock:
        # 1. 身份锚：核心记忆文件
        role_card = _read_file(ROLE_FILE_PATH)[:6000]
        memory_core = _read_file(MEMORY_MD_PATH)[:4000]

        # 2. 情绪锚
        mood_line = get_mood_line()

        # 3. 事件锚：独立工作记忆文件
        event_lines = []
        working_data = _load_json(WORKING_MEM_PATH)
        active_list = [MemoryItem.from_dict(d) for d in _load_json(LONG_TERM_ACTIVE_PATH).get("memories", [])]

        from services.recall_policy import RecallContext, select
        context_policy = RecallContext(opening_text or '', session_id or '')
        from services.evidence_store import load as load_evidence
        source_lookup = load_evidence()
        source_lookup.update({m.mem_id: m for m in active_list})
        active_list = select(active_list, context_policy, sources=source_lookup)
        if str(session_id or '').startswith('group:'):
            memory_core = ''

        is_new_session = session_id is None
        is_cross_day = True
        # 提到分支外初始化：交接单那段（L377 附近）要用它判断「间隔多久」，
        # 而这里原本只在 if 分支里赋值 —— 走 else 分支时它是未定义的。
        last_time = 0

        if session_id and session_id in working_data.get("sessions", {}):
            sess = working_data["sessions"][session_id]
            last_time = sess.get("last_active", 0)
            is_cross_day = _is_cross_day(last_time)
            sess_mems = select([MemoryItem.from_dict(d) for d in sess.get("working_memory", [])],
                               context_policy, sources=source_lookup)

            if not is_cross_day:
                sess_mems.sort(key=lambda x: x.chunk_priority, reverse=True)
                for mem in sess_mems[:INIT_WORKING_TOP_K]:
                    # ★ 2026-11-10 第二步：工作记忆**显式跳过**印象标注，不是漏掉。
                    #
                    #   为什么跳过：工作记忆走的是 calculate_shortterm_strength
                    #   （平方加速衰减，3 天窗口），它不是长期库里那套
                    #   strength/impression 双轨 —— 它**没有印象层概念**。
                    #   无脑给它加标注会造出一个本来不存在的问题：
                    #   工作记忆的 impression_strength 恒为 0，判出来永远是
                    #   "none"，标注为空，看起来"正确"，但它是靠巧合正确。
                    #
                    #   所以这里直接拼原文，并写明白为什么不走 _render_mem_line。
                    event_lines.append(f"近期对话线索：{mem.content}")
            else:
                event_lines.append("注：距离上次对话已超过一天，仅保留核心事件")
                if sess_mems:
                    top_mem = max(sess_mems, key=lambda x: x.chunk_priority)
                    # 同上：工作记忆，显式跳过印象标注
                    event_lines.append(f"上次对话约定：{top_mem.content}")
        else:
            event_lines.append("注：这是新对话，仅携带核心背景记忆")

        # 4. 长时记忆锚点（按开场白向量召回，无向量则取最高强度）
        if active_list:
            if query_embedding:
                # 2026-11-08：实体从开场白抽，不再写死空列表（见函数 docstring）。
                query_ents = _query_entities(opening_text)
                top_mems = hybrid_rerank(
                    query_embedding, query_ents,
                    {"valence": "neutral", "intensity": 50},
                    active_list, INIT_LONG_TERM_TOP_K,
                    # ★ 2026-11-13：传 query_text —— hybrid_rerank 要用它判断
                    #   「用户是不是在问系统本身」，决定 meta_only 那批要不要放行。
                    #   开场白就是这一轮的唯一 query，直接给。
                    query_text=opening_text or "",
                )
                for mem, _ in top_mems:
                    # ★ 2026-11-10 第二步：长时记忆 → 走统一渲染（带印象标注）。
                    #
                    #   ⚠️ 这条路径尤其重要：上面的 hybrid_rerank 现在会
                    #      **自动补印象候选**（Q2=A 的接线），也就是说
                    #      「细节已淡但印象还在」的记忆会从这里被带进来 ——
                    #      如果这里不标注，它就会以「完整细节」的形态出现，
                    #      正好是第二步要修的那个错误。
                    event_lines.append(_render_mem_line(mem, "背景记忆"))
            else:
                # ⚠️ 2026-11-08 修（last_active 副作用）：
                #   原来这里是:
                #       active_list.sort(key=lambda x: x.strength, reverse=True)
                #       for mem in active_list[:TOP_K]:
                #           mem, _ = calculate_current_strength(mem)   # ← 会刷 last_active
                #
                #   两个问题：
                #     ① 排序用的是磁盘上的 strength（旧值，没算衰减）→ 排出来的可能不是真该排前面的
                #     ② calculate_current_strength 会把这几条的 last_active 刷成 now
                #        ——但「开场列出来给你看」不等于「被想起」，
                #          真正的「想起」是召回命中（recall_engine 里已经处理）
                #
                #   修法：先用 peek_strength 算当前强度、按它排序，只读不改。
                _scored = [(m, peek_strength(m)) for m in active_list]
                _scored.sort(key=lambda x: x[1], reverse=True)
                _picked = _scored[:INIT_LONG_TERM_TOP_K]
                for mem, _s in _picked:
                    event_lines.append(_render_mem_line(mem, "背景记忆"))

                # ★ 2026-11-10 第二步（C-改）：无向量分支的**印象兜底**。
                #
                #   诊断（实测，21 条模拟库，target 是 180 天前的高情绪事件）：
                #     单轨: strength 45.00，排第 12/21  → 本来就进不了前 2
                #     双轨: strength 15.75，排第 21/21  → 更进不了
                #   细节地板释放后，有印象层的记忆 strength 掉到 13~19，
                #   按强度排序这条路上**必然排不进去**。
                #
                #   修法（产品方 2026-11-10 选的 C-改）：
                #     ① 上面的正常排序**原样不动**（它简单、可预测，不动它）
                #     ② 额外**单独**挑印象最高的 2 条，**分节排在后面**
                #     ③ 用不同的前缀「印象里的」，明确表示这不是相关召回
                #
                #   为什么不按 max(strength, impression) 排序：那是把两个
                #   不同量纲的数塞进一根轴，跟 hybrid_rerank 里加权是同类错误。
                #   为什么不混排：这条分支没有相关性信息，混排等于假装有关。
                try:
                    _extra = _pick_impression_lines(
                        active_list,
                        exclude_ids={m.mem_id for m, _ in _picked},
                        limit=2, current_ts=None)
                    if _extra:
                        event_lines.append("印象里的（不是这次话题相关，是我一直记得的事）：")
                        for _m in _extra:
                            event_lines.append(_render_mem_line(_m, "印象"))
                except Exception:
                    # 兜底失败绝不影响开局注入
                    pass

        # 2026-11-06：召回记忆的截断（两级）
        #   ① 单条超长（如 657 字的画图模板）先截到 500 字 + 「…」，别让一条挤掉别的
        #   ② 全部记忆合计仍受 RECALL_MAX_CHARS 约束，超了从末尾丢
        single_max = 500
        trimmed = []
        for line in event_lines:
            if line.startswith('注：'):   # 说明性文字不截，保留
                trimmed.append(line)
                continue
            if len(line) > single_max:
                line = line[:single_max] + '…'
            trimmed.append(line)
        event_lines = trimmed

        recall_budget = int(RECALL_MAX_CHARS)
        kept_lines = []
        used = 0
        for line in event_lines:
            cost = len(line)
            if used + cost > recall_budget:
                break
            kept_lines.append(line)
            used += cost
        event_lines = kept_lines

        # ══ 2026-11-08 交接单读侧（T09 接线）═══════════════════════
        # 换会话时带一张 80 字状态快照：聊到哪 / 什么情绪 / 没说完什么 / 在烦什么小事
        #
        # 为什么在这里读：
        #   · 交接单本来就是「跨会话边界」才有意义的东西（旧会话写，新会话读）
        #   · 它不是记忆条目，不进召回打分，只是「临走留的纸条」
        #   · 所以单独一段，放在【记忆线索】之后、【注入块 marker】之前
        #
        # 读不到就什么都不加（newbie 会话 / 从没写过交接单）：
        #   绝不能因为没交接单就改变输出结构 —— 那会让「打开开关」变成「改了输出」。
        handover_text = ""
        _pending_reconstruct = False      # 锁外补记用（见 with 之后那段）
        if _feature_on("handover"):
            try:
                from handover import (read_latest_handover, build_inject_text,
                                      should_reconstruct, reconstruct_handover)
                h = read_latest_handover(prefer_session_id=session_id)

                # ★ 读不到 → 记下「待补」，**但不在锁里补**（见文件末尾那段）。
                #   为什么不在锁里补：本函数整个 body 在 with FileLock(LOCK_FILE_PATH)
                #   里面，而 write_handover 也要拿同一把锁 —— filelock 的实例不共享
                #   重入计数，同一线程用不同实例锁同一文件直接抛 Deadlock。
                #   实测表现是「写侧接了但从来不生效」，被 except 吞掉看不见。
                #   交接单补记只需要 session_id / last_time，不依赖锁里读出来的东西，
                #   所以完全可以挪到锁外做。
                if not h and should_reconstruct(session_id, last_active=last_time):
                    _pending_reconstruct = True

                if h:
                    handover_text = build_inject_text(h) or ""
            except Exception as exc:
                # 交接单是锦上添花，读不到不能影响主流程
                try:
                    print(f"[session_init] handover 读取失败: {exc}", file=__import__("sys").stderr)
                except Exception:
                    pass
                handover_text = ""

        # ★ 2026-11-08 修：交接单必须放在【情绪基线】**之前**。
        #
        #   为什么：桥接 buildHumanMemoryInit（bridge.js:13699-13702）只取
        #     t.slice(t.indexOf('【情绪基线】'))  再 tail.slice(0, 1500)
        #   交接单原本拼在最末尾，**记忆线索一长就被 1500 字直接切掉**。
        #
        #   实测（造 5 条各 500 字的记忆线索）：
        #     tail 长 1832，交接单 index 1751  ->  slice(0,1500) 后一字不剩
        #   而正常情况下 tail 只有 ~480 字，所以【平时不丢，但没有任何结构保护】。
        #
        #   放在【情绪基线】之前就彻底不受这个切片影响了。
        #   也更符合设计 8.5.5「交接单在最前」。
        # 2026-11-08 修：交接单放在【情绪基线】之后、记忆线索之前。
        #
        #   这个位置是两个约束夹出来的，两边都实测过：
        #     1) 桥接 buildHumanMemoryInit 只取 t.slice(t.indexOf(情绪基线)) 再 slice(0,1500)
        #        放在【情绪基线】之前  -> 测过：根本不会被传过去
        #        放在最末尾          -> 记忆线索一长（1832 字）就被 1500 切掉
        #     2) 放在【情绪基线】之后、记忆线索之前 -> 两个问题都没有
        # 交接单前后各留一个空行：
        #   实测发现直接 join 会让【交接单】最后一行和「当前情绪状态…」粘在一起
        #   （交接单是多行文本，join 只在元素之间插一个换行）。
        #   "" 元素在 join 后产生的是「空行」，所以交接单要单独夹在两个 "" 之间。
        _ho_block = ["", handover_text, ""] if handover_text else []
        tail = ["", "【情绪基线】", mood_line] + _ho_block + ["【记忆线索】"] + event_lines
        overhead = len("\n".join([BLOCK_START, "【人格卡】", "", "", "【记忆库】", "", *tail, BLOCK_END]).encode("utf-8"))
        available = max(0, INIT_MAX_TOKEN - overhead)
        role_bytes = len(role_card.encode("utf-8"))
        core_bytes = len(memory_core.encode("utf-8"))
        if role_bytes + core_bytes > available:
            role_budget = available * role_bytes // (role_bytes + core_bytes)
            role_card = _bound_init(role_card, role_budget)
            memory_core = _bound_init(memory_core, available - role_budget)
        context = "\n".join(["【人格卡】", role_card, "", "【记忆库】", memory_core, *tail])

        # ★ 格式断言（2026-11-08 加）：交接单段和下一段之间必须有空行。
        #   为什么要断言：这种「格式退化」不报错，只能靠人眼看出来 —— 而人不一定看。
        #   实测踩过一次：join 直接在元素间插一个换行，交接单最后一行和
        #   「当前情绪状态…」粘成了一行，读着像同一个字段。
        if handover_text:
            _idx = context.find(handover_text)
            if _idx >= 0:
                _tail = context[_idx + len(handover_text):]
                assert _tail.startswith("\n\n") or _tail.startswith("\n"), \
                    ("交接单段后缺空行（会跟下一段粘连）: %r"
                     % _tail[:40])

        # ══ 2026-11-08 注入块 marker（T15）═════════════════════════
        # 开关打开时，把一个 marker 对塞在最前面，这样：
        #   · 桥接再拼一遍这几个段落时，strip_old_block() 能整块删掉旧的
        #     （不再出现「同一段记忆线索注入两次、模型当两件事」）
        #   · 拔掉 marker 就什么都没了 —— 中间内容一个字没动
        #
        # ★ 只加 marker，**不删除中间那几段现有结构**：
        #   test4 的 T4 断言【人格卡】【记忆库】【情绪基线】都在，
        #   桥接也是按「【情绪基线】」这个锚点切片的。结构一改就全线崩。
        #
        # · 开关关掉         → 连 marker 都不加，输出跟今天一字不差
        # · 打开（默认）     → 内容不变，只是外面多了一对注释
        marker_applied = False
        if _feature_on("inject_marker"):
            marked = wrap_with_marker(context)
            if marked != context:
                context = marked
                marker_applied = True

        # ── 锁外的部分（记在 _pending 里的补记在这里做）─────────────
        #   为什么必须在 with 外面：write_handover 要拿同一把 memory_data.lock，
        #   而 filelock 不允许同线程用不同实例重入（会抛 Deadlock）。
        #   实测过一次：写侧明明接好了，但每次都被 except 吞掉，表现为从不生效。
    _reconstructed = False
    if _pending_reconstruct:
        try:
            from handover import reconstruct_handover, build_inject_text
            _h = reconstruct_handover(session_id)
            if _h:
                _reconstructed = True
                _txt = build_inject_text(_h) or ""
                if _txt:
                    # 插到【情绪基线】之后、记忆线索之前（跟锁内那段同一位置）。
                    #   位置理由见 context 拼接处注释：
                    #   放前面桥接取不到，放末尾会被 slice(0,1500) 切掉。
                    #   而且必须在 marker 里面，否则 strip_old_block 删不到，每轮多一份。
                    # 插到【情绪基线】整段之后、记忆线索之前。
                    #   注意【情绪基线】和 mood_line 是两行，不能只跳过锚点那一行。
                    #   实测踩过：只跳到锚点行后，交接单插进了
                    #   【情绪基线】和「当前情绪状态…」之间，看起来像字段错乱。
                    _nxt = context.find("【记忆线索】")
                    if _nxt < 0:
                        _nxt = context.find(BLOCK_END)
                    if _nxt >= 0:
                        context = (context[:_nxt].rstrip() + "\n\n"
                                   + _txt + "\n\n" + context[_nxt:])
                    elif BLOCK_END in context:
                        _idx = context.rfind(BLOCK_END)
                        context = (context[:_idx].rstrip() + "\n\n"
                                   + _txt + "\n" + context[_idx:])
                    else:
                        context = context.rstrip() + "\n\n" + _txt
                    marker_applied = _feature_on("inject_marker")
                try:
                    print("[session_init] 交接单已补记（跨天写侧）",
                          file=__import__("sys").stderr)
                except Exception:
                    pass
        except Exception as exc:
            try:
                print(f"[session_init] 交接单补记失败: {exc}",
                      file=__import__("sys").stderr)
            except Exception:
                pass

    context = _bound_init(context, INIT_MAX_TOKEN)
    estimated_token = len(context.encode("utf-8"))

    return {
        "context": context,
        "estimated_token": estimated_token,
        "is_new_session": is_new_session,
        "is_cross_day": is_cross_day,
        # 2026-11-08：这一份上下文有没有带注入块 marker。
        # 多返回一个键是安全的（JSON 加键不会破坏老调用方），
        # 但它让「marker 到底有没有生效」变成可以查的事实，
        # 而不是靠读代码猜 —— 项目踩过的第一个坑就是「加了字段但没人用」。
        "marker": marker_applied,
        # 这一轮有没有现场补记交接单（写侧）。跟 marker 一样，
        # 让「到底补没补」变成可以查的事实，而不是读代码猜。
        "handover_reconstructed": _reconstructed,
    }
