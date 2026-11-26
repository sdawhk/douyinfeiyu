import copy
import json
import os
import time
from datetime import datetime   # FIX-1107: 短期层去重要用它刷时间戳
from typing import Callable, List, Optional

from filelock import FileLock

from config import (
    LOCK_FILE_PATH, WORKING_MEM_PATH, LONG_TERM_ACTIVE_PATH, LONG_TERM_COLD_PATH,
    WORKING_MEM_MAX_CHUNKS, WORKING_MEM_CHUNK_MAX_TOKEN,
)
from schema import MemoryItem
from recall_engine import hybrid_rerank
from decay_logic import reinforce_on_recall, note_silent_error
from session_init import build_session_init_context
from async_summarizer import AsyncSummarizer



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
# 原子写（2026-11-08 收敛到 atomic_io.py）
# ═══════════════════════════════════════════════════════════
#
# 原来这里自己有一份 _atomic_write_json + _sweep_stale_tmp，
# 另外 episode / handover / lessons / reflection 各抄了一份几乎一样的。
#
# 为什么必须收敛：2026-11-08 审计实测，8 次重试 / 1.8s 窗口在并发下会穿透
#   （4 线程 × 60 次写 → 2 次 PermissionError）。修的时候得去 5 个文件里各改一遍 ——
#   漏一个就留下一个「看起来也是原子写」的假象。这就是重复的代价。
#
# 现在逻辑全在 atomic_io.py（只依赖标准库，任何层级都能安全 import，不会循环依赖）。
# 这里保留 _atomic_write_json / _sweep_stale_tmp 两个名字，是因为本文件里有 9 处调用，
# 且外部脚本可能也在用 —— 改成转发，行为完全不变。
from atomic_io import atomic_write_json as _atomic_write_json_impl, \
    sweep_stale_tmp as _sweep_stale_tmp_impl


def _sweep_stale_tmp(path: str, older_than: float = 3600.0) -> int:
    """转发到 atomic_io.sweep_stale_tmp（保留本文件内的旧名字）。"""
    return _sweep_stale_tmp_impl(path, older_than)


def _atomic_write_json(path: str, data: dict) -> None:
    """原子写 JSON —— 转发到 atomic_io.atomic_write_json。

    ★ sweep=True：只有本模块会顺手清陈旧 tmp。
      其余四个调用方（episode / handover / lessons / reflection）保持 sweep=False，
      行为跟收敛前完全一样 —— 「要不要把清扫铺到那三处」维护者还没定。
    """
    _atomic_write_json_impl(path, data, sweep=True)


# ═══════════════════════════════════════════════════════════
# 感受分层（T05）：当时感受 vs 后来再想
# ═══════════════════════════════════════════════════════════
#
# 《主系统设计》26.x：同一件事的意义会随后来的经历变化，但**原始记录不改**。
#
#   ❌ 错的：把当时的「委屈 80」改成「其实没什么」→ 这是篡改
#   ✅ 对的：保留「委屈 80」，追加一条「后来知道原因，不怪他了」
#
# 字段分工（固定不变）：
#   content / emotion_valence / emotion_intensity  = 「当时」，写死，谁都不许改
#   later_thought = [{"at": ts, "thought": str, "reason": str}, ...]  = 「后来」，只追加
#
# 为什么不能合并成一句：合并会丢掉「当时真的很难过」这个真实经历。
# 注入时必须两层都出现。

LATER_THOUGHT_MAX = 20      # 单条记忆最多留 20 次「后来再想」（防无限增长）
LATER_THOUGHT_MAX_CHARS = 300   # 单条 thought 的字数上限


def _now_ts() -> float:
    return datetime.now().timestamp()


def add_later_thought_on_item(mem, thought: str, reason: str = "",
                              at: Optional[float] = None) -> bool:
    """给**内存里的** MemoryItem 追加一条「后来再想」。

    这是核心实现（纯内存、不碰磁盘），add_later_thought 和测试都走它。
    分离出来是因为：测试要能不污染 active.json 地验证写入逻辑。

    硬规则（不满足就返回 False，绝不半途改一半）：
      · 不改 content / emotion_valence / emotion_intensity
      · 只往 later_thought 里 push 一条 {at, thought, reason}
    """
    if mem is None:
        return False
    text = str(thought or "").strip()
    if not text:
        return False
    text = text[:LATER_THOUGHT_MAX_CHARS]
    # 防御：老数据/外部 dict 可能没有这个属性，或不是 list
    arr = getattr(mem, "later_thought", None)
    if not isinstance(arr, list):
        arr = []
    arr = list(arr)          # 拷贝，避免改到调用方的列表对象
    arr.append({
        "at": float(at) if at is not None else _now_ts(),
        "thought": text,
        "reason": str(reason or "").strip(),
    })
    # 只留最近 N 条：改名/改想法太多次时，最早的已经不重要了
    arr = arr[-LATER_THOUGHT_MAX:]
    mem.later_thought = arr
    return True


def add_later_thought(mem_id: str, thought: str, reason: str = "") -> bool:
    """给一条记忆追加「后来再想」（写磁盘版）。

    按 mem_id 在活跃库（active.json）里找，找到就追加并原子写回。
    不修改原 content、不改 emotion_valence/intensity —— 见上面的规则说明。

    返回 True = 真的写进去了（能找到 + 内容非空 + 落盘成功）。
    返回 False = 找不到这条 / 内容为空 / 写盘失败。调用方必须区分这两种，
    不能「没找到也当成功」（那就是假解决）。

    ⚠️ 只走活跃库。冷存档案（cold.json）不在这里追加：
      冷存的定义是「不再参与当前生活的旧事」，给它补「后来再想」没有场景。
       真要补，先把它捞回活跃库。
    """
    mid = str(mem_id or "").strip()
    if not mid or not str(thought or "").strip():
        return False
    if not os.path.exists(LONG_TERM_ACTIVE_PATH):
        return False
    lock = FileLock(LOCK_FILE_PATH)
    with lock:
        try:
            with open(LONG_TERM_ACTIVE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return False
        mems = data.get("memories") or []
        target = None
        for d in mems:
            if str(d.get("mem_id") or "") == mid:
                target = d
                break
        if target is None:
            return False
        # 在 dict 上直接追加（不重建 MemoryItem 再序列化 —— 
        #   那会把整条记忆的所有字段重算一遍，等于顺手改了别的字段）
        obj = MemoryItem.from_dict(target)
        if not add_later_thought_on_item(obj, thought, reason):
            return False
        target["later_thought"] = obj.later_thought
        try:
            _atomic_write_json(LONG_TERM_ACTIVE_PATH, data)
        except Exception:
            return False
    return True


def later_thought_lines(mem, include_time: bool = True) -> List[str]:
    """只返回【后来】那几行（列表）。没有就返回空列表。

    单独拆出来，是为了让「注入」不用重写一遍格式：
      · format_with_later_thought  = 【当时】一行 + 这里的行
      · memory_cli 召回注入        = 在已有那一行下面缩进追加这里的行
    两处共用同一份格式，改一次两边都对。
    """
    items = getattr(mem, "later_thought", None) or []
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            # 容错：万一存成了纯字符串
            t = str(it).strip()
            if t:
                out.append(f"【后来】{t}")
            continue
        thought = str(it.get("thought") or "").strip()
        if not thought:
            continue
        tail = ""
        at = it.get("at")
        if include_time and at:
            try:
                tail += datetime.fromtimestamp(float(at)).strftime("%m-%d") + " 补充"
            except (ValueError, OSError, OverflowError, TypeError):
                pass
        reason = str(it.get("reason") or "").strip()
        if reason:
            tail = (tail + "：" if tail else "") + reason
        out.append(f"【后来】{thought}" + (f"（{tail}）" if tail else ""))
    return out


def format_with_later_thought(mem, include_time: bool = True) -> str:
    """把一条记忆渲染成「双层」文本，供注入 prompt 用。

    输出形状（两层都出现，不合并）：
        【当时】他说要去外地 —— 我很难过（强度 70）
        【后来】原来只是出差三天，白担心了（11-07 补充：他说只去三天）

    没有 later_thought 时只输出【当时】那一行 —— 这样调用方可以无脑对所有
    记忆调它，不需要先判断有没有「后来」。

    ★ 2026-11-10 第二步：**印象标注也从这里出**（T8 的落点）。

      为什么必须接在这里：T8 要求「同一条记忆的呈现方式不能取决于它是
      怎么进的 Top-5」。而实际注入路径是 memory_cli → 本函数，
      如果只在 recall_engine.render_memory_line 里加标注，
      真实注入根本走不到那里 —— 那就是「测试绿了但生产没接」。
      所以两个入口共用同一个判定（decay_logic.impression_state）。

    三档（判据唯一来源：decay_logic.impression_state）：
      intact         → 原文（不加任何东西，跟以前完全一样）
      faded_detail   → 原文 +（细节已淡，只记得这件事发生过）
      erased_detail  → **不出现原文**，只给「记得有这么回事」
                       ★ 任务书 T4 硬要求：不得用已淡忘的 detail 描述细节
    """
    content = str(getattr(mem, "content", "") or "").strip()
    if not content:
        return ""

    # ★ 2026-11-10：细节基本没了 → 不许复述原文（会变成编造）
    _state = None
    try:
        from decay_logic import impression_state as _imp_state
        _state = _imp_state(mem)
    except Exception:
        _state = None

    if _state == "erased_detail":
        from recall_engine import render_memory_line as _render
        return _render(mem)

    # ── 【当时】层：永远是原样 ──
    line = f"【当时】{content}"
    valence = str(getattr(mem, "emotion_valence", "neutral") or "neutral")
    # ★ 2026-11-10：这里读 event_intensity（当时的情绪），
    #   不是会衰减的 current_intensity。否则一年后的记忆会显示
    #   「强度 30」，而它当时的强度是 90 —— 那是在改写历史。
    try:
        _raw = getattr(mem, "event_intensity", None)
        intensity = float(_raw if _raw is not None
                          else (getattr(mem, "emotion_intensity", 0) or 0))
    except (TypeError, ValueError):
        intensity = 0.0
    mood_word = {"positive": "我还挺高兴", "negative": "我很难过"}.get(valence)
    if mood_word and intensity > 0:
        line += f" —— {mood_word}（强度 {intensity:.0f}）"
    elif intensity > 0:
        # 中性但有意强度：不硬编情绪词，只报数字（不替她编感受）
        line += f"（强度 {intensity:.0f}）"

    # ★ 2026-11-10：细节淡了 → 追加标注（跟 render_memory_line 同源）
    try:
        from decay_logic import impression_note as _imp_note
        _note = _imp_note(mem)
        if _note:
            line += _note
    except Exception:
        pass

    # ── 【后来】层：一条一行，按时间顺序，全部列出 ──
    return "\n".join([line] + later_thought_lines(mem, include_time=include_time))


class MemoryManager:
    """记忆系统统一管理器。

    数据文件全部独立（working_mem.json / active.json / cold.json），
    绝不读写宿主原有的 social-v2.json。
    """

    def __init__(
        self,
        summarize_func: Optional[Callable[[str], str]] = None,
        embedding_func: Optional[Callable[[str], List[float]]] = None,
    ):
        self.lock = FileLock(LOCK_FILE_PATH)
        self.summarizer = AsyncSummarizer(summarize_func) if summarize_func else None
        self.embedding_func = embedding_func
        # Capture the stamp before loading so a concurrent write is checked on recall.
        self._pool_stamps = {pool: self._pool_stamp(pool)
                             for pool in ('active', 'shortterm', 'cold')}
        # 先占位：_load_active_mems 会填它（不参与召回的原始行，写回时要带回去）
        self._non_recall_rows = []
        self.active_mems = self._load_active_mems()
        # 短进程也必须把延迟的召回强化落盘；原来只有注释，没有注册。
        # 标记本进程有未完成写入；hook 在真正做过召回后才存在。
        self._flush_registered = False
        # 2026-11-06 短期记忆层：独立加载
        self.shortterm_mems = self._load_shortterm_mems()
        # 2026-11-10 冷存层：只读加载，供 recall_cold 补充检索
        self.cold_mems = self._load_cold_mems()

    # ---------- 短期记忆层（2026-11-06）----------
    def _load_shortterm_mems(self) -> List[MemoryItem]:
        from config import SHORT_TERM_PATH
        from services.vector_cache import load_pool
        try:
            data = load_pool(SHORT_TERM_PATH)
        except FileNotFoundError:
            return []
        return [MemoryItem.from_dict(d) for d in data.get("memories", [])]

    def add_shortterm(self, content: str, **kwargs) -> MemoryItem:
        """写入短期记忆层。会先判「承诺/约定/日期/事实」——命中就不进短期层，返回 None（由调用方转长期库）。

        2026-11-07 修（评审 指出）：原来只挡 commitment / date，**漏了 fact**。
          实测这几条会被判成 fact 却漏进短期层，跟着 3 天衰减归零：
            · 我住在示例城市
            · 禁止碰系统文件
            · 他告诉过我他不喜欢甜的
            · 必须先问他同意
          这些跟承诺、日期一样是硬事实，凭什么等 3 天被忘掉？
          ⇒ 现在 fact 也一并挡住，直接归长期库（受 L3 地板保护，一天都不衰减）。

        ★ 2026-11-09 P0：本方法改为**薄包装**，真正的逻辑在 add_shortterm_ex()。

          为什么拆：
            原实现在「满池淘汰」后仍无条件返回 new_mem —— 调用方收到对象，
            但磁盘上没有它。这是「假成功」：上层以为存住了，实际丢了。

          现在：
            add_shortterm_ex()  返回 {saved, reason, mem_id, content}
            add_shortterm()     保持旧签名（返回 MemoryItem 或 None），
                                但**被淘汰时返回 None**，不再假成功。

          ⚠️ 兼容性影响：以前「被淘汰但仍返回对象」的场景，现在返回 None。
            调用方若把「返回非 None」当作「落盘成功」，行为会更正确；
            但若有调用方依赖那个假对象，需要相应调整（见 P0修复报告）。
        """
        r = self.add_shortterm_ex(content, **kwargs)
        if not r.get("saved"):
            # 被拒收（fact/date/commitment）或 被容量淘汰 —— 都不该返回对象
            return None
        # 保存成功：返回落盘的那条，便于调用方拿 mem_id
        return self._shortterm_find(r.get("mem_id"))

    def _shortterm_find(self, mem_id):
        """在内存缓存里按 mem_id 找一条短期记忆（找不到返回 None）。"""
        if not mem_id:
            return None
        for m in (getattr(self, "shortterm_mems", None) or []):
            if getattr(m, "mem_id", None) == mem_id:
                return m
        return None

    def add_shortterm_ex(self, content: str, **kwargs) -> dict:
        """写入短期记忆层，返回**结构化结果**（不返回可能不存在的对象）。

        返回：
            {"saved": True,  "reason": "created",          "mem_id": ...}
            {"saved": True,  "reason": "dedup_updated",    "mem_id": ...}
            {"saved": False, "reason": "rejected_fact",    "mem_id": None}
            {"saved": False, "reason": "capacity_evicted","mem_id": ...}

        ★ 2026-11-09 P0 三处改动：
          ① 容量淘汰排序键：持久化 strength → create_time（保留最新的 N 条）
             原因：strength 被「召回加分」污染过，用它排等于让被刷分的条目
                   永远留下来、新条目永远进不去。
          ② 被淘汰时明确返回 saved=False，不再假成功。
          ③ 去重分支：不再给 strength 加分；last_mentioned_at /
             mention_count / mention_history 三者同步更新。
             原因：三字段不同步会造成 count 与 history 长度不一致
                   （实测存在 count=126 / hist=124 的条目）。
        """
        from services.deletion_service import excluded
        if excluded(dict(kwargs,content=content)):
            return {'saved':False,'reason':'source_deleted','mem_id':None}
        from config import SHORT_TERM_PATH
        from services.write_receipts import previous, record
        operation_id = kwargs.pop("operation_id", None)
        from schema import classify_importance

        # ★ 2026-11-09 P0：容量上限从**运行时读取**。
        #
        #   ⚠️ 审计指出（2026-11-09 独立复核）：
        #     第一版写成「旧名非 None 就优先旧名」，但 config.py 里
        #     `SHORT_TERM_DAILY_MAX = SHORT_TERM_MAX_ITEMS` —— 旧名**永远不是 None**，
        #     于是永远走旧名分支，新名被完全忽略。
        #
        #     实测（改前）：
        #       只改新名=2、旧名=100 → 写 5 条，池内 5 条（没生效）
        #       只改旧名=2、新名=100 → 写 5 条，池内 2 条（生效）
        #
        #     我在注释里写「import 时把值绑死所以要运行时读」，
        #     结果下一行又造了同一个病。这是审计说得最准的一处。
        #
        #   正确顺序：**先判新名；新名存在就用新名**。
        #   旧名只在「新名不存在」时兜底（兼容还没改名的旧配置）。
        #
        # ★ 2026-11-09 再修（独立审计 4.5）：**缺正数校验**。
        #   原来直接把配置值 int() 了事，于是：
        #     max_items = 0  → `mems[-0:]` 等价于 `mems[0:]` → **保留整个列表，
        #                      容量限制完全失效**（-0 == 0 是 Python 的经典坑）
        #     max_items < 0  → `mems[-(-3):]` = `mems[3:]` → 非预期地砍掉前几条
        #
        #   现在：非正整数一律回退默认值并留痕，绝不允许「静默失效」。
        _DEFAULT_MAX_ITEMS = 100
        try:
            import config as _cfg
            _max_new = getattr(_cfg, "SHORT_TERM_MAX_ITEMS", None)
            if _max_new is not None:
                max_items = int(_max_new)
            else:
                max_items = int(getattr(_cfg, "SHORT_TERM_DAILY_MAX",
                                        _DEFAULT_MAX_ITEMS))
        except Exception:
            max_items = _DEFAULT_MAX_ITEMS
        if max_items <= 0:
            # 0 / 负数都会让切片语义失效（甚至反向），必须挡掉
            print("[shortterm] ⚠️ 容量配置非法（%r），回退默认 %d 条"
                  % (max_items, _DEFAULT_MAX_ITEMS))
            max_items = _DEFAULT_MAX_ITEMS

        # 先判重要内容：承诺/约定/日期/事实 直接不进短期层
        cat, _imp = classify_importance(content, kwargs.get("source", "auto"))
        if cat in ("commitment", "date", "fact"):
            return {"saved": False, "reason": "rejected_%s" % cat,
                    "mem_id": None, "content": (content or "")[:60]}

        # ★ 2026-11-09 P0（审计指出）：允许显式注入 create_time。
        #
        #   审计实测：MemoryItem 原来不接受 create_time（写死 now()），
        #   于是新条目 create_time 恒为全池最新 → 按时间保留最新 N 条时
        #   **永远不会被淘汰** → capacity_evicted 分支不可达。
        #
        #   实测（修前）：容量 3 连写 8 条，reason 全是 created。
        #
        #   现在：从 kwargs 里取出 create_time（若有），显式传给 MemoryItem。
        #   这让「新记忆比池内更旧」这个场景能被真实构造，淘汰路径可测。
        _inject_ct = kwargs.pop("create_time", None)

        new_mem = MemoryItem(content, mem_type="short_term",
                             create_time=_inject_ct, **kwargs)
        # 2026-11-13：写入时就打召回门控标签，不在召回时反复猜。
        #   测试句/元讨论不进答案池 —— 实测它们会靠字面重叠抢到第一名。
        try:
            from schema import classify_for_gate as _cfg, classify_kind as _ck
            _gate = _cfg(content, kwargs.get("source", "auto"))
            new_mem.recallable = _gate["recallable"]
            new_mem.type_tagged_by = _gate["tagged_by"]
            # kind：7 类内容分类，召回时按它加权（不是过滤）
            new_mem.kind = _ck(content, kwargs.get("source", "auto"))
        except Exception as _te:
            # ★ 2026-11-18（P2）：原来是 `pass`，打标失败完全无痕。
            #   后果：这条记忆的 recallable / kind 停在默认值（"" = 未打标），
            #   后续巩固可能把它归错类，而且**没有任何记录能回查**。
            #   实测踩到同款：recall_audit.prune 里 NameError 被 pass 吞掉，
            #   函数返回成功但文件一个字没改 —— 静默失败比失败更糟。
            #   这里改成：留痕 + 打一行告警，但**不影响写入**（写入是主职责）。
            self._last_tag_error = "%s: %s" % (type(_te).__name__, _te)
            try:
                print("[shortterm] ⚠️ 打标失败（记忆照常写入，标记留空）: %s"
                      % self._last_tag_error)
            except Exception:
                pass
        if self.embedding_func:
            new_mem.embedding = self.embedding_func(content)

        with self.lock:
            if os.path.exists(SHORT_TERM_PATH):
                with open(SHORT_TERM_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
            else:
                data = {"memories": []}
            prior = previous(data, operation_id, content)
            if prior is not None:
                return prior
            mems = [MemoryItem.from_dict(d) for d in data.get("memories", [])]

            # ── 去重分支 ─────────────────────────────────────
            # 2026-11-07 补的：同一句对话写两次就存两条。
            # 2026-11-09 P0：三个「提及」字段必须同步，且不再动 strength。
            dup = next((m for m in mems
                        if (m.content or "").strip() == (content or "").strip()),
                       None)
            if dup is not None:
                _now = datetime.now().timestamp()
                # ⚠️ 不再改 dup.strength —— 强度只由时间派生，见 decay_logic
                dup.last_mentioned_at = _now
                dup.mention_count = int(dup.mention_count or 0) + 1
                _hist = list(getattr(dup, "mention_history", None) or [])
                _hist.append(_now)
                dup.mention_history = _hist
                data["memories"] = [m.to_dict() for m in mems]
                record(data, operation_id, content, {"saved": True, "reason": "dedup_updated", "mem_id": dup.mem_id})
                _atomic_write_json(SHORT_TERM_PATH, data)
                self.shortterm_mems = mems
                return {"saved": True, "reason": "dedup_updated",
                        "mem_id": dup.mem_id, "content": (content or "")[:60]}

            # ── 新条目 ───────────────────────────────────────
            mems.append(new_mem)
            evicted = None
            if len(mems) > max_items:
                # 按「创建时间」从旧到新，保留最新的 N 条
                #
                # ★ 原来按 strength 排（`mems.sort(key=lambda m: m.strength)`）。
                #   strength 会被召回加分刷高（本次已删掉那条路径），
                #   用被污染过的字段做淘汰依据，会让老条目永不被淘汰、
                #   新条目的初始 strength=60 永远垫底 → 满池后一条新记忆都进不来。
                #   实测：池内 100 条最低 90 分，新记忆 60 分，写入后立即被踢。
                #
                #   改用 create_time：语义上「短期池 = 最近窗口」，
                #   淘汰最老的才是对的。
                #
                # ★ 2026-11-10 二阶修复：淘汰排序键加 priority 权重。
                #
                #   为什么（今天踩出来的坑）：
                #     工作记忆降级到短期层时，我们**保留了原 create_time**，
                #     免得旧内容伪装成新的（时间戳造假）。
                #     但短期层淘汰用 `sort(create_time)` 只保留最新的 N 条，
                #     于是「降级进来的旧 priority=10 承诺」反而**最先被挤** ——
                #     它时间老，排在队头，满池就被踢。
                #
                #     这等于「把重要的旧内容降级进来，然后立刻挤出去」，
                #     降级白做了，跟直接丢没区别。
                #
                #   修法：排序键 = (chunk_priority, create_time)。
                #     · priority 高的排后面（不会被先挤）
                #     · 同 priority 仍按时间，最新在最后
                #   这样：
                #     priority=3 寒暄 → 最先挤（本来就该先挤）
                #     priority=5 普通 → 其次
                #     priority=10 承诺 → 最后挤，即使 create_time 老
                #     同 priority 内不永久占坑（老的一条仍会被同级的更新的挤掉）
                mems.sort(key=lambda m: (
                    int(getattr(m, "chunk_priority", 5) or 5),
                    float(getattr(m, "create_time", 0) or 0)))
                keep = mems[-max_items:]
                kept_ids = {getattr(m, "mem_id", None) for m in keep}
                # Persist before removing anything. A failed handoff aborts the
                # write, leaving the previous short-term file intact.
                from pending_longterm import append_pending
                from services.recall_policy import revision as source_revision
                dropped_rows=[]
                for dropped in mems:
                    if dropped.mem_id in kept_ids:
                        continue
                    if not append_pending(
                            dropped.content, session_id=dropped.session_id,
                            source=dropped.source, category_at_write=dropped.category,
                            chunk_priority=dropped.chunk_priority,
                            create_time=dropped.create_time, memory=dropped.to_dict(),
                            reason="shortterm_capacity",
                            operation_id='shortterm_capacity:'+str(dropped.mem_id)+':'+source_revision(dropped)):
                        raise OSError("short-term overflow handoff failed")
                    dropped_rows.append(dropped.to_dict())
                # A later merge can keep a different destination ID. Preserve
                # the original source identity before removing its short copy.
                from services.evidence_store import preserve as preserve_sources
                if dropped_rows:preserve_sources(dropped_rows)
                if getattr(new_mem, "mem_id", None) not in kept_ids:
                    evicted = new_mem
                mems = keep

            data["memories"] = [m.to_dict() for m in mems]
            record(data, operation_id, content, {"saved": evicted is None, "reason": "capacity_evicted" if evicted else "created", "mem_id": new_mem.mem_id})
            _atomic_write_json(SHORT_TERM_PATH, data)
        self.shortterm_mems = mems

        if evicted is not None:
            return {"saved": False, "reason": "capacity_evicted",
                    "mem_id": evicted.mem_id,
                    "content": (content or "")[:60]}
        return {"saved": True, "reason": "created",
                "mem_id": new_mem.mem_id, "content": (content or "")[:60]}

    def refresh_shortterm(self):
        self.shortterm_mems = self._load_shortterm_mems()

    def save_shortterm(self) -> None:
        """把内存里的短期记忆写回磁盘（2026-11-07）。

        「被提起」时会 +10 分并重置 last_mentioned_at，这些改动只在内存里，
        不落盘的话下次读文件又是旧值 —— 和 FIX-1103-RECALL-SAVE 是同一类坑。

        ★ 2026-11-09 修：**整库覆盖会丢掉别的进程新增的碎片**。
          实测：桥接的 recall 写回时用的是内存副本；这期间巩固新增了碎片
          （还给它们打上了 episode_id），一次覆盖就全抹掉。
          表现是「巩固说落库了，但碎片上的标记指向不存在的档」。

          修法跟 active.json 一样：写前重读，按 mem_id 三方合并
          （磁盘有内存没有 → 补进来；两边都有 → 用内存的；
            磁盘没有内存有 → 保留内存的，因为内存是刚改过的）。
        """
        from config import SHORT_TERM_PATH
        try:
            with self.lock:
                rows = [m.to_dict() for m in self.shortterm_mems]
                from common.io import merge_write_json
                info = merge_write_json(SHORT_TERM_PATH, rows, verbose=False)
                if info.get("added"):
                    print("[shortterm] 合并了 %d 条磁盘新增（防止覆盖）: %s"
                          % (len(info["added"]), info["added"][:5]))
                    # 把补进来的也同步进内存，否则下次又不知道
                    try:
                        from schema import MemoryItem
                        known = {m.mem_id for m in self.shortterm_mems}
                        for r in rows:
                            if r.get("mem_id") and r["mem_id"] not in known:
                                self.shortterm_mems.append(MemoryItem.from_dict(r))
                    except Exception:
                        pass
        except Exception as e:
            print(f"[shortterm] 写回失败: {e}")

    # ---------- 长时记忆缓存 ----------
    # 2026-11-08：哪些 mem_type 存在库里但**不参与召回**。
    #
    # 为什么必须有这张表（不是可选项）：
    #   lesson / reflection 是「只写不读」阶段的新类型 —— 设计上明确写了
    #   「先攒数据观察质量，先不参与召回」。但 _load_active_mems 是无条件全读，
    #   所以只要往 active.json 里写一条，它下一轮就会被 recall_engine 打分召回，
    #   「只写不读」当场就破了。过滤放在这里，是因为它是**唯一的口子**：
    #   召回候选全部来自这个方法（recall / init / associate 都走它）。
    #
    # 以后要启用它们参与召回时：把名字从这里删掉即可 —— 数据一直都在，不用迁移。
    NON_RECALL_TYPES = {"lesson", "reflection", "superseded", "unavailable"}

    def _load_active_mems(self) -> List[MemoryItem]:
        from services.vector_cache import load_pool
        try:
            data = load_pool(LONG_TERM_ACTIVE_PATH)
        except FileNotFoundError:
            data = {"memories": []}
        out = []
        kept = []
        for d in data.get("memories", []):
            mt = str(d.get("mem_type") or "")
            if mt in self.NON_RECALL_TYPES:
                # ★ 2026-11-08 实测抓到的数据丢失 bug：
                #   只过滤、不保留原文，写回时（recall 的批量落盘 / flush）
                #   会把 active_mems 序列化后整个覆盖 active.json ——
                #   于是 lesson / reflection **被永久删掉**。
                #   实测：造一条 lesson 入库 → flush 一次 → 库里没了。
                #   所以过滤出来的行必须原样留一份，写回时带回去。
                kept.append(d)
                continue
            out.append(MemoryItem.from_dict(d))
        self._non_recall_rows = kept
        # 用于字段级三方合并：召回只允许写它实际修改的字段，不能用整条
        # 常驻内存副本覆盖巩固、later_thought 等其它进程的更新。
        self._active_field_baseline = {
            str(m.mem_id): dict(m.to_dict()) for m in out if m.mem_id
        }
        self._active_write_fields = {}
        # 基线只记录本进程加载时确实存在的 ID。之后磁盘缺失的基线记录
        # 才能判定为外部删除；本进程新建、尚未落盘的记录不能误删。
        self._active_baseline_ids = {
            str(d.get("mem_id") or "") for d in data.get("memories", [])
            if isinstance(d, dict) and d.get("mem_id")
        }
        return out

    def _serialize_active(self) -> list:
        """序列化当前活跃库，并尊重加载后发生的外部删除。

        合并规则：
          * 两边都有：以内存版本为准（本进程的召回/巩固更新）
          * 只在磁盘：保留（其他进程新增）
          * 只在内存且属于加载基线：视为外部删除，不复活
          * 只在内存且不属于加载基线：本进程新建，必须保留

        如果基线非空但磁盘文件突然消失，拒绝写回而不是猜测这是删除，
        避免短暂文件缺失/路径错误导致整库清空或复活。
        """
        # 调用方在写回时先合并磁盘，非召回原始行以磁盘为准。
        rows = [m.to_dict() for m in self.active_mems]
        rows.extend(getattr(self, '_non_recall_rows', []) or [])
        baseline = set(getattr(self, '_active_baseline_ids', set()) or set())
        if not os.path.exists(LONG_TERM_ACTIVE_PATH):
            if baseline:
                raise FileNotFoundError(
                    "active memory file disappeared after load; refusing stale-cache write")
            return rows

        from common.io import load_json
        disk = load_json(LONG_TERM_ACTIVE_PATH, None)
        if not isinstance(disk, dict) or not isinstance(disk.get("memories"), list):
            raise ValueError("active memory file is unreadable; refusing stale-cache write")
        disk_rows = disk.get("memories", [])
        disk_by_id = {str(r.get("mem_id") or ""): r for r in disk_rows
                      if isinstance(r, dict) and r.get("mem_id")}
        disk_ids = set(disk_by_id)

        # 同 ID 不是「内存全对、磁盘全旧」。只把本进程登记过的字段合并进
        # 当前磁盘行；其它字段以磁盘为准。例如召回不写 content/later_thought。
        field_baseline = getattr(self, '_active_field_baseline', {}) or {}
        write_fields = getattr(self, '_active_write_fields', {}) or {}
        rows_by_id = {str(r.get("mem_id") or ""): r for r in rows if r.get("mem_id")}
        for mid, row in rows_by_id.items():
            disk_row = disk_by_id.get(mid)
            if disk_row is None or mid not in baseline:
                continue
            fields = set(write_fields.get(mid) or [])
            if not fields:
                # 这条记忆本次没被召回，不能把长期缓存覆盖到当前磁盘。
                row.clear()
                row.update(copy.deepcopy(disk_row))
                continue
            base = field_baseline.get(mid) or {}
            for field in fields:
                value = row.get(field)
                if value != base.get(field):
                    disk_row[field] = copy.deepcopy(value)
            row.clear()
            row.update(copy.deepcopy(disk_row))

        # 删除只对加载时已存在的条目生效；新建但未落盘的本地记忆不能被误判删除。
        filtered = []
        dropped = []
        for row in rows:
            mid = str(row.get("mem_id") or "")
            if (mid and mid in baseline and mid not in disk_ids
                    and True):
                dropped.append(mid)
                continue
            filtered.append(row)

        added = []
        filtered_ids = {str(r.get("mem_id") or "") for r in filtered}
        for dr in disk_rows:
            if not isinstance(dr, dict):
                continue
            mid = str(dr.get("mem_id") or "")
            if not mid or mid in filtered_ids:
                continue
            filtered.append(dr)
            filtered_ids.add(mid)
            added.append(mid)

        if dropped:
            print("[serialize] 尊重外部删除，阻止记忆复活 %d 条: %s"
                  % (len(dropped), dropped[:5]))
        if added:
            print("[serialize] 合并磁盘新增 %d 条: %s" % (len(added), added[:5]))
        return filtered

    def _mark_active_saved(self, rows: list) -> None:
        """成功落盘后更新基线；仅在原子写成功后调用。"""
        self._active_baseline_ids = {
            str(r.get("mem_id") or "") for r in rows
            if isinstance(r, dict) and r.get("mem_id")
        }

    def refresh_active_cache(self):
        # 刷新不是丢弃本进程未保存改动的理由；先合并写回，失败则保留旧缓存。
        with self.lock:
            if getattr(self, '_active_write_fields', None) and not self.flush():
                print('[refresh] 有待写改动且写回失败，保留当前缓存，不刷新')
                return False
            stamp = self._pool_stamp('active')
            self.active_mems = self._load_active_mems()
            self._pool_stamps['active'] = stamp
        return True

    def _load_cold_mems(self) -> List[MemoryItem]:
        """冷存层只读加载（2026-11-10 归档重设计）。

        冷存是冻结快照，这里只加载、不做衰减结算、不刷新任何游标。
        供 recall_service 里的 recall_cold 补充检索使用。
        """
        from services.vector_cache import load_pool
        try:
            data = load_pool(LONG_TERM_COLD_PATH)
        except FileNotFoundError:
            return []
        return [MemoryItem.from_dict(d) for d in data.get("memories", [])]

    def _pool_path(self, pool):
        from config import SHORT_TERM_PATH
        return {'active': LONG_TERM_ACTIVE_PATH,
                'cold': LONG_TERM_COLD_PATH, 'shortterm': SHORT_TERM_PATH}[pool]

    def _pool_stamp(self, pool):
        try:
            st = os.stat(self._pool_path(pool))
        except FileNotFoundError:
            return None
        return st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size

    # ---------- 会话初始化 ----------
    def init_session(self, session_id: Optional[str] = None, query_embedding: Optional[List[float]] = None,
                     *, profile_mode=None, opening_text=None):
        return build_session_init_context(session_id, query_embedding, opening_text, profile_mode=profile_mode)

    # ---------- 工作记忆写入（独立文件） ----------
    def add_working_memory(self, session_id: str, content: str, **kwargs) -> None:
        # 2026-11-08 修（评审，test_working_memory T5 暴露）：
        #   这个方法**从来没检查过内容是否为空** —— 空串和纯空格都会照常写进库，
        #   占满 8 个组块名额，还会被召回、被巩固。实测 T5「空内容拒绝」直接失败。
        if not str(content or '').strip():
            return

        from services.deletion_service import excluded
        if excluded(dict(kwargs,content=content,session_id=session_id)):
            raise ValueError('source_deleted')
        if kwargs.get("category") == "private" or kwargs.get("is_private") is True:
            kwargs = dict(kwargs)
            kwargs["is_private"] = True
            from services.memory_tools import add_active
            operation_id = kwargs.pop("operation_id", None)
            return add_active(self, content, session_id, kwargs, operation_id)

        if kwargs.pop("durable", False):
            from services.memory_tools import add_active
            operation_id = kwargs.pop("operation_id", None)
            return add_active(self, content, session_id, kwargs, operation_id)

        if kwargs.get("effective_from") is not None or kwargs.get("effective_to") is not None:
            from services.memory_tools import add_active
            operation_id = kwargs.pop("operation_id", None)
            return add_active(self, content, session_id, kwargs, operation_id)

        # ── 2026-11-08 加（巡检第七轮发现：gate 判了但不写）────────────
        #   背景：candidate_pool.gate() 早就写好了，返回 pass/mark/block 三档，
        #   但**没有任何写入路径调它**，于是 state/candidates.jsonl 从没被创建过。
        #   「门判了，但没照着判的结果写」比「门没装」更危险：
        #   gate 返回 mark 时看起来系统在工作，实际结果被丢掉了。
        #
        #   现在的策略（观察期，可回滚）：
        #     · 调 gate，把判定**记录下来**（写进候选池）
        #     · 但**不改变现有行为** —— 内容照常进工作记忆
        #     · 只有 features.gate_triage 打开时，block/mark 才真的拦下
        #
        #   为什么先只记录：直接拦截可能丢数据（gate 判错就没了），
        #   先攒 1-2 周数据看准确率，再决定要不要真拦。
        try:
            from features import on as _on
            if _on("candidate_pool"):
                from candidate_pool import gate as _gate, write_candidate as _wc
                _verdict, _reason = _gate(content, kwargs.get("source", "auto"))
                # 2026-11-08 修（评审，巡检抓出来的污染）：
                #   原来这里写的是 in ("block", "mark") —— 但 write_candidate
                #   自己对 block/pass 是**拒绝写入**的（设计 5.2：只有 mark 进池）。
                #   于是 block 的每一条都白调一次，多一层没用的判断。
                #   更糟的是：mark 那一支会把**测试**写的内容也收进池子 ——
                #   test_working_memory.py 只隔离了 WORKING_MEM_PATH，没隔离候选池，
                #   跑一次单测就往 state/candidates.jsonl 灌几十条「并发巩固0」「A 的记忆」。
                #   实测：一上午积了 258 条候选，全部是测试垃圾，没有一条真实对话。
                #
                #   两道修法：
                #     ① 这里只对 mark 调写入（block 本来就不该进池，省一次调用）
                #     ② ⚠️ 测试环境必须隔离 —— 见 candidate_pool._is_test_session()
                if _verdict == "mark":
                    _wc(content, session_id, _reason,
                        meta={"verdict": _verdict, "source": kwargs.get("source", "")})
                # 只有显式打开 gate_triage 才真的拦
                if _on("gate_triage") and _verdict == "block":
                    return
        except Exception:
            pass   # 候选池出问题不能影响主流程
        from services.write_receipts import previous, record
        operation_id = kwargs.pop("operation_id", None)
        receipt_payload = kwargs.pop("receipt_payload", content)
        with self.lock:
            if not os.path.exists(WORKING_MEM_PATH):
                data = {"sessions": {}}
            else:
                with open(WORKING_MEM_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)

            prior = previous(data, operation_id, receipt_payload)
            if prior is not None:
                return prior
            sessions = data.setdefault("sessions", {})
            session = sessions.setdefault(session_id, {"working_memory": [], "last_active": 0})
            new_mem = MemoryItem(content, mem_type="working", session_id=session_id, **kwargs)
            # 2026-11-13：工作记忆同样在写入时打门控标签 + kind
            try:
                from schema import classify_for_gate as _cfg2, classify_kind as _ck2
                _g2 = _cfg2(content, kwargs.get("source", "auto"))
                new_mem.recallable = _g2["recallable"]
                new_mem.type_tagged_by = _g2["tagged_by"]
                new_mem.kind = _ck2(content, kwargs.get("source", "auto"))
            except Exception as _te2:
                # ★ 2026-11-18（P2）：同 add_shortterm_ex，原来也是纯 pass。
                #   留痕但**不影响写入** —— 工作记忆该存还是要存。
                self._last_tag_error = "%s: %s" % (type(_te2).__name__, _te2)
                try:
                    print("[working] ⚠️ 打标失败（记忆照常写入，标记留空）: %s"
                          % self._last_tag_error)
                except Exception:
                    pass

            if self.embedding_func:
                new_mem.embedding = self.embedding_func(content)

            mem_list = [MemoryItem.from_dict(d) for d in session["working_memory"]]
            if len(mem_list) >= WORKING_MEM_MAX_CHUNKS:
                mem_list.sort(key=lambda x: x.chunk_priority)
                evicted = mem_list.pop(0)
                from schema import classify_importance
                from pending_longterm import append_pending
                category, _ = classify_importance(evicted.content, evicted.source)
                handed_off = '_已巩固' in (evicted.tags or [])
                handoff_id = 'working-overflow:' + evicted.mem_id
                if not handed_off and category not in ('fact', 'date', 'commitment'):
                    outcome = self.add_shortterm_ex(
                        evicted.content, session_id=session_id, source=evicted.source,
                        tags=list(evicted.tags or []) + ['_从工作记忆降级'],
                        chunk_priority=evicted.chunk_priority, create_time=evicted.create_time,
                        effective_from=getattr(evicted, 'effective_from', None),
                        effective_to=getattr(evicted, 'effective_to', None),
                        operation_id=handoff_id)
                    handed_off = outcome.get('saved') or outcome.get('reason') == 'capacity_evicted'
                if not handed_off:
                    handed_off = append_pending(
                        evicted.content, session_id=session_id, source=evicted.source,
                        category_at_write=category, chunk_priority=evicted.chunk_priority,
                        create_time=evicted.create_time, memory=evicted.to_dict(),
                        operation_id=handoff_id, reason='working_capacity')
                if not handed_off:
                    raise OSError('working overflow handoff failed; previous workbench retained')

            mem_list.append(new_mem)
            session["working_memory"] = [m.to_dict() for m in mem_list]
            session["last_active"] = new_mem.last_active

            # 2026-11-08 修（评审 + 评审 发现，评审 核实）：
            #   这里原来是 open(WORKING_MEM_PATH, 'w') + json.dump —— **非原子写**。
            #
            #   为什么是遗漏不是设计：_atomic_write_json 是 11-03 为修
            #   「回归测试连跑 30 次撞到 2 次 JSONDecodeError」加的，当时只改了报错那几处。
            #
            #   崩溃窗口：open(path,'w') 会瞬间把文件截断成 0 字节，
            #   json.dump 才开始逐字节写。中间任何中断（宿主重启 / 结束进程 /
            #   磁盘满 / 断电）都会留下 0 字节或半截 JSON → 下次读取 JSONDecodeError
            #   → **全部工作记忆丢失**。
            #
            #   危险被放大：regression_test.py 的 #10 每次跑批都整文件重写这个路径
            #   （8 线程并发 add），等于在反复摩擦一个没有保护的文件。
            result = {"written": True, "mem_id": new_mem.mem_id, "pool": "working"}
            record(data, operation_id, receipt_payload, result)
            _atomic_write_json(WORKING_MEM_PATH, data)

            # 单条超阈值触发异步摘要（异常兜底，防死锁）
            if self.summarizer and len(content) > WORKING_MEM_CHUNK_MAX_TOKEN * 1.5:
                def _callback(updated_mem):
                    try:
                        with self.lock:
                            if not os.path.exists(WORKING_MEM_PATH):
                                return
                            with open(WORKING_MEM_PATH, "r", encoding="utf-8") as f:
                                data = json.load(f)
                            for item in data["sessions"][session_id]["working_memory"]:
                                if item["mem_id"] == new_mem.mem_id:
                                    item["content"] = updated_mem.content
                                    break
                            # 2026-11-08 修：同上，改成原子写。
                            #   这条是异步摘要回调，它跑在后台线程里，
                            #   崩溃窗口比主路径更危险（因为没人看着）。
                            _atomic_write_json(WORKING_MEM_PATH, data)
                    except Exception as e:
                        print(f"异步回写失败: {e}")

                self.summarizer.submit_summarize(new_mem, _callback)

    # ---------- 冷存储：不自动唤醒（2026-11-07 决策）----------
    #
    # 关于 awake_cold_memory：
    #   它原来只有 test4.py 在调，生产环境无人使用。我一度给它接了
    #   「召回时全扫冷存、命中就唤醒」，后来撤回了 —— 理由（评审 指出）：
    #
    #     ① 性能：冷存可能有几千条，每轮全扫会把召回拖慢
    #     ② 语义：冷存的定义就是「忘了」。如果它还能被自动想起，
    #        那它就不该进冷存。
    #
    #   所以现在的立场是：**冷存不自动唤醒**。
    #   真要捞回某条，走「人工/topic 触发」路径（尚未实现），不靠每轮扫描。
    #   awake_cold_memory 函数保留，供将来的显式触发用。
    #
    # 配套（同一天决定）：重要东西不许进冷存。
    #   见 decay_logic.is_cold_storage：强度 < 20 且 importance < 0.85 才算冷存。
    #   0.92 的承诺/日记靠地板保住，永远不会躺在冷存里等死。

    # ---------- 长时记忆召回 ----------
        return result

    def recall(
        self,
        query_embedding: List[float],
        entities: List[str],
        emotion: dict,
        active_mems: Optional[List[MemoryItem]] = None,
        persist: bool = True,
        force_flush: bool = False,
        query_text: str = "",
        reinforce: bool = False,
    ):
        """召回长时记忆。

        FIX-1103-RECALL-SAVE：原来这里算完就 return，两件事都没做——
          ① 被召回的条目没有"提取强化"（用一次更强），只掉不涨
          ② last_active 在内存里刷新了，但**从不写回磁盘** ⇒ 下次读文件又是旧值 ⇒ 刷新白做

        现在：召回 Top-K 后调用 reinforce_on_recall（+5 分左右、刷新时间），
        并把整个活跃库写回 active.json（persist=True 时）。

        ★ 2026-11-09 修 API 缺陷：persist 和 reinforce 是两个独立的东西。

          原来只有 persist 一个参数，而它**只管最后写不写盘**。
          reinforce_on_recall() 是无条件执行的，会改五个字段：
              strength / last_active / mention_count
              / mention_history / decay_slowdown

          实测后果：评估脚本传了 persist=False 以为「只读」，
          结果内存里 245 处字段被改 —— 其中 last_active 最要命：
          衰减计时器被重置，本该归档的记忆一直被续命。

          ⚠️ 这个接口设计本身就是陷阱：
             「不持久化」听起来像「不改状态」，但它只管磁盘。
             下次谁写脚本都会踩。

          所以拆成两个参数：
             persist=False    不写磁盘
             reinforce=False  不做提取强化（不改任何 memory 字段）

          评估 / 回放 / 只读分析必须两个都传 False。
          生产召回（memory_cli / bridge）保持默认 True，行为不变。
        """
        target_mems = active_mems if active_mems is not None else self.active_mems
        from services.recall_policy import RecallContext, select
        context = getattr(self, '_request_context', RecallContext(query_text))
        from services.evidence_store import load as load_evidence
        sources = load_evidence()
        sources.update({m.mem_id: m for m in self.cold_mems + self.shortterm_mems + self.active_mems})
        target_mems = select(target_mems, context, sources=sources)

        # ★ 2026-11-13：召回前先按门控标签过滤。
        #
        #   为什么放在这里（而不是排序之后）：
        #     被标 meta_only / no 的记忆**根本不该参与打分**。
        #     只在排序后剔除，它们仍会占掉 Top-K 名额，把正确记忆挤下去 ——
        #     实测起点案例「讨论我在哪工作这个 bug」就是靠 0.935 分抢到第一名。
        #
        #   为什么未打标签（recallable 为空）的按 yes 处理：
        #     存量 484 条目前全都是空值。若空值按 no 处理，一次上线会把整个库
        #     从答案池里清空。所以「空 = 未判定 = 放行」，回填之后才真正收紧。
        #
        #   为什么失败时放行：
        #     门控是优化，不是安全边界。判不出来时宁可多给一条，
        #     也不能因为异常让整次召回空掉。
        try:
            from schema import is_recallable as _is_recallable
            from recall_engine import is_meta_query as _is_meta_q
            _q_is_meta = False
            try:
                _q_is_meta = bool(_is_meta_q(query_text))
            except Exception:
                _q_is_meta = False
            _kept = []
            _gated = 0
            for _m in target_mems:
                _flag = str(getattr(_m, "recallable", "") or "")
                if not _flag:
                    _kept.append(_m)
                    continue
                if _flag == "no":
                    _gated += 1
                    continue
                if _flag == "meta_only" and not _q_is_meta:
                    _gated += 1
                    continue
                _kept.append(_m)
            target_mems = _kept
            if _gated:
                print("[recall] 门控排除 %d 条（meta_only/no）" % _gated)
        except Exception as _e:
            print("[recall] 门控异常，放行全部: %s" % type(_e).__name__)

        # 2026-11-08 11:20 T11 接线：RRF 多路融合（可开关）
        #
        # 为什么用开关而不是直接换掉：
        #   量纲实测显示 RRF 分只有 0.01~0.05，跟 hybrid_rerank 的 0~1 完全不同。
        #   两套分数不能混用，所以是「二选一」而不是「叠加」。
        #   出问题把 RECALL_USE_RRF 改成 False 就回到接线前的行为，不用改代码。
        #
        # query_text 用来做问法路由；没有它路由就判不出意图（不影响其他两路）。
        _use_rrf = False
        try:
            from config import RECALL_USE_RRF as _use_rrf
        except Exception:
            _use_rrf = False

        from config import RECALL_SEMANTIC_MIN_SIM
        min_similarity = RECALL_SEMANTIC_MIN_SIM if getattr(self, "_request_context", None) is not None else None
        if _use_rrf:
            try:
                from recall_engine import rrf_recall
                results = rrf_recall(
                    query_embedding, entities, emotion, target_mems,
                    query_text=query_text or "", min_similarity=min_similarity,
                )
            except Exception as exc:
                # RRF 这条新路炸了，退回已验证的 hybrid_rerank —— 绝不因为新功能让召回挂掉
                print(f"[recall] rrf_recall 失败，退回 hybrid_rerank: {exc}")
                results = hybrid_rerank(query_embedding, entities, emotion, target_mems,
                                         update_strength=reinforce,
                                         query_text=query_text or "", min_similarity=min_similarity)
        else:
            results = hybrid_rerank(query_embedding, entities, emotion, target_mems,
                                         update_strength=reinforce,
                                         query_text=query_text or "", min_similarity=min_similarity)

        # 身份问法 → 补充 stable_profile 候选（只保留泛化住址匹配，避免过拟合）。
        try:
            _IDENTITY_HINTS = (
                (("住哪", "住在", "哪里人", "哪个城市", "在哪儿", "人在哪",
                  "哪里的", "在哪个区"),
                 ("住在", "城市", "市区", "地址", "家在", "定居"),
                 ("日记", "日志")),
            )
            _qt = str(query_text or "")
            if _qt and len(_qt) <= 12:
                _matched = []
                for _qw, _expect, _neg in _IDENTITY_HINTS:
                    if any(h in _qt for h in _qw):
                        _matched.append((_expect, _neg))
                if _matched:
                    _have = {m.mem_id for m, _ in results}
                    _extras = []
                    for _m in target_mems:
                        if getattr(_m, "category", "") != "stable_profile":
                            continue
                        # 身份特判是「普通召回」的一部分，必须遵守沉睡规则；
                        # 否则 on_demand 的永久记忆会从这里被偷偷带出来。
                        if getattr(_m, "recall_mode", "active") == "on_demand":
                            continue
                        if _m.mem_id in _have:
                            continue
                        _content = str(getattr(_m, "content", "") or "")
                        _expect, _neg = _matched[0]
                        # 负向词命中 → 直接排除（比如「日记」不该算生日）
                        if any(w in _content for w in _neg):
                            continue
                        # 必须命中「期望词」里至少一个（先过负向词）
                        _hits = sum(1 for w in _expect if w in _content)
                        if _hits == 0:
                            continue
                        _extras.append((_hits, _m))
                    if _extras:
                        # 命中词多的优先
                        _extras.sort(key=lambda x: -x[0])
                        _picked = [(m, 0.0) for _, m in _extras[:2]]
                        # ★ 2026-11-09 修：身份特判溢出 top_k（真 bug）
                        #
                        #   原来：
                        #       results = _picked + list(results)
                        #   原 results 是 top_k=5 条，追加最多 2 条
                        #   → 实际返回最多 7 条
                        #
                        #   它毁了什么：
                        #     评估脚本只取 res[:5] → 测的是 5 槽系统
                        #     生产环境拿全部     → 跑的是 7 槽系统
                        #     今晚所有 A/G/D 对比都在这两个系统上横跳。
                        #
                        #   更狠的一层：特判项是 score=0.0 前置，
                        #   所以那 2 条永远占第 1、2 位 ——
                        #   对身份类 query，主排序根本没参与前两槽竞争。
                        #
                        #   修法选「截断」而不是「把 top_k 改大」：
                        #     recall(top_k=5) 这个签名承诺了返回 <= 5，
                        #     下游都在依赖它，改契约牵一发动全身。
                        #
                        #   ⚠️ 副作用：截断后丢掉的是原 results 里
                        #     分数最低的 1~2 条。已实测确认不影响边界 query。
                        #
                        #   ⚠️ top_k 从 config 读，recall() 自身没有这个参数
                        _tk = 5
                        try:
                            from config import RECALL_TOP_K as _tk
                        except Exception:
                            _tk = 5
                        results = (_picked + list(results))[:_tk]
                        print("[recall] 身份问法 → 补充 %d 条 stable_profile"
                              "（命中 %s 个词）"
                              % (len(_picked), _extras[0][0]))
        except Exception:
            pass          # 特判失败绝不影响主召回

        # ① 提取强化：想起来一次就更牢
        #
        # ★ 2026-11-09：加了 reinforce 开关。
        #
        #   原来这里无条件执行 —— 而它改的五个字段里，last_active 是正确性问题：
        #   一条记忆只要被「只读的」分析脚本跑过一次，衰减计时器就被重置，
        #   本该归档的一直被续命。
        #
        #   评估 / 回放 / 只读分析传 reinforce=False 就能完全跳过。
        if reinforce:
            for mem, _score in results:
                try:
                    reinforce_on_recall(mem)
                    self._active_write_fields.setdefault(mem.mem_id, set()).update({
                        'strength', 'strength_at', 'last_active', 'last_recalled_at',
                        'mention_count', 'mention_history', 'decay_slowdown',
                        'impression_strength',
                    })
                except Exception as _e:
                    note_silent_error('reinforce_on_recall', _e)

        # ② 写回磁盘（只有对 self.active_mems 生效；传了外部列表就不写）
        #
        # FIX-1103-SMART-SAVE（2026-11-03）：原来每次召回都无条件重写整个库。
        #   实测库 5.1 MB → 单次 recall 253ms，其中绝大部分花在序列化+写盘；
        #   一天 100 轮就是 0.5 GB 磁盘写入，纯浪费（而且 SSD 有寿命）。
        #
        #   现在改成「攒够再写」：
        #     · 记下这次强化改了多少条、上次写盘是什么时候
        #     · 满足任一条件才真写：累积改动 ≥ 20 条 / 距上次写 ≥ 5 分钟 / 强制 flush
        #     · 进程退出时（atexit）兜底 flush 一次，不会丢
        #   强度是小幅渐进变化的量（每次 +6~24），晚写几分钟完全不影响体验。
        if reinforce and persist and active_mems is None and results:
            if reinforce and not self._flush_registered:
                import atexit
                atexit.register(self.flush)
                self._flush_registered = True
            self._dirty_count = getattr(self, '_dirty_count', 0) + len(results)
            now = time.time()
            last = getattr(self, '_last_save_at', 0.0)
            need_flush = (self._dirty_count >= 20) or ((now - last) >= 300) or force_flush
            if need_flush:
                try:
                    with self.lock:
                        # 2026-11-08：改用 _serialize_active —— 它还会带上
                        #   lesson / reflection 那些「不参与召回」的原始行，
                        #   否则一次召回就把它们从库里覆盖没了。
                        _rows_to_save = self._serialize_active()
                        _atomic_write_json(LONG_TERM_ACTIVE_PATH,
                                           {"memories": _rows_to_save})
                        self._mark_active_saved(_rows_to_save)
                        self._active_write_fields.clear()
                    self._dirty_count = 0
                    self._last_save_at = now
                except Exception as e:
                    print(f"[recall] 写回失败，保留待重试状态: {e}")
                    self._last_save_error = str(e)


        # ★ 2026-11-09 加：召回审计（1% 采样）
        #
        #   为什么：改排序之前和之后，都需要能回答「改好了吗」。
        #   现在系统没有任何生产侧质量观测 —— 改完只能拿 30 条正例自欺。
        #
        #   记什么：query / top5 的 mem_id + score + cos + strength / 时间
        #   为什么带 cos：区分「embedding 判错」和「排序压掉」，
        #     这两种失败改排序能救的只有后者。
        #
        #   为什么在这里重算 cos（而不是让 hybrid_rerank 返回）：
        #     hybrid_rerank 的返回值是 (mem, score) 二元组，所有调用方都依赖它。
        #     改返回值风险大；重算 5 次余弦约 0.1ms，可忽略。
        #
        #   为什么隔离模式下不记：
        #     评估脚本会把数据目录搬到临时目录（MEMORY_DATA_DIR），
        #     那种情况下记的是「评估查询」不是「她真实被问的」，
        #     会把审计日志刷满假数据。
        try:
            # ★ 2026-11-09 修：判断依据从环境变量改成模块标记。
            #
            #   原来读 os.environ.get("MEMORY_DATA_DIR") —— 永远是 None，
            #   因为 _test_isolation.isolate() 只改模块常量，不设环境变量。
            #   于是评估的 query 全进了审计日志（实测 46 条里混着）。
            #
            #   现在读 _test_isolation.ISOLATED（模块事实，不是外部约定）。
            #
            #   ⚠️ 这是第三次同一个模式的漏洞：
            #     ① persist=False 挡不住 reinforce_on_recall
            #     ② reinforce=False 挡不住 calculate_current_strength
            #     ③ MEMORY_DATA_DIR 挡不住 isolate()
            #     共同点：「我以为关掉了，其实只是关掉了一条路径」。
            _iso_flag = False
            try:
                import _test_isolation as _ti
                _iso_flag = bool(getattr(_ti, "ISOLATED", False))
            except Exception:
                pass
            if not _iso_flag:
                from recall_audit import record as _audit_record
                from recall_engine import cosine_similarity as _cos_sim
                _audit_rows = []
                for _m, _sc in results[:5]:
                    try:
                        _c = _cos_sim(query_embedding, _m.embedding) \
                            if query_embedding is not None else None
                    except Exception:
                        _c = None
                    _audit_rows.append((_m, _sc, _c))
                _audit_record(query_text, _audit_rows, source="recall")
        except Exception:
            pass          # 审计失败绝不影响召回


        # ★ 2026-11-09 加：契约断言。
        #
        #   今天第七个同类问题（改了一处，别处的假设没跟上）。
        #   让它自己证明自己：返回条数永不超过 top_k。
        #
        #   ⚠️ 注意：recall() 自己没有 top_k 参数 —— top_k 是
        #      hybrid_rerank 的参数，默认取 config.RECALL_TOP_K。
        #      所以这里也要读同一个来源，否则断言会 NameError。
        #      （第一次写的时候我就漏了这点，跑起来才炸。）
        #
        #   为什么用 assert 而不是 if+警告：
        #     这是内部契约违反，属于代码 bug，不是运行时可恢复的状态。
        #     静默截断会让问题再藏三个月。
        _tk = 5
        try:
            from config import RECALL_TOP_K as _tk
        except Exception:
            _tk = 5
        assert len(results) <= _tk, (
            "recall() 返回 %d 条，超过 RECALL_TOP_K=%d —— 契约被破坏"
            % (len(results), _tk))

        return results

    def confirm_used(self, mem_ids, current_timestamp=None, *, request_id=None,
                     session_id=None, evidence='explicit'):
        from services.feedback_service import confirm
        self.last_feedback_report = confirm(self, mem_ids, request_id=request_id,
                                            session_id=session_id, evidence=evidence,
                                            now=current_timestamp)
        return self.last_feedback_report['confirmed']

    def flush(self):
        """把本进程登记过的字段写盘；没有改动时绝不重写整库。"""
        if not getattr(self, '_active_write_fields', None):
            return False
        try:
            with self.lock:
                # 2026-11-08：同 recall —— 必须带上不参与召回的原始行，否则丢数据
                _rows_to_save = self._serialize_active()
                _atomic_write_json(LONG_TERM_ACTIVE_PATH,
                                   {"memories": _rows_to_save})
                self._mark_active_saved(_rows_to_save)
            self._dirty_count = 0
            self._active_write_fields.clear()
            self._last_save_at = time.time()
            return True
        except Exception as e:
            print(f"[flush] 写回失败: {e}")
            return False

