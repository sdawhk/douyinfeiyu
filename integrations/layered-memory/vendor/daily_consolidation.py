import json
import os
import time          # 2026-11-08：run_reflection 算「昨天」要用 time.strftime，
                     #   本文件原来只 import 了 datetime，NameError 被 except 吃成
                     #   reflection_error，整条反思静默不产出（集成测试才抓到）。
from datetime import datetime
from filelock import FileLock
from typing import List

from config import (
    WORKING_MEM_PATH, LONG_TERM_ACTIVE_PATH, LONG_TERM_COLD_PATH,
    LOCK_FILE_PATH, CONSOLIDATION_SCORE_THRESHOLD, DEDUPLICATION_SIM_THRESHOLD,
    SHORT_TERM_PATH,
)
# 2026-11-09 补：打标清单留痕（state/episode_marks.log）要用
from config import BASE_DIR
# 2026-11-08 补：三档阈值统一从 config 读（原来这里写死 20/40/60）
from config import TRIAGE_L1_MIN, TRIAGE_L2_MIN

from schema import MemoryItem

from config import COLD_ARCHIVE_AFTER_DAYS

# ★ 2026-11-16 修：补 import config 模块本身。
#
#   事故：11-16 00:52 有人加了「工具卡提升」功能（daily_consolidation.py L1807
#   起），代码里写的是 getattr(config, "TOOL_CARD_PROMOTE_ENABLED", True)，
#   但本文件顶部一直是 `from config import X, Y, Z` 的写法，
#   从来没 import 过 config 这个模块对象。
#   → 每天 06:05 的巩固跑到那一步直接 NameError，整轮失败。
#   实测：11-16 08:03 跑巩固报
#     NameError: name 'config' is not defined（L1807）
#   而且因为它在 try 外面，不是被 except 吞掉，是直接崩。
#
#   为什么加这一行而不是改成 from config import TOOL_CARD_*：
#     ① 那个功能的常量可能还没写进 config.py（默认值 5/True 都是写在 getattr 里的）
#     ② 保持调用方原样，不猜作者意图
#     ③ 以后再有 config.X 的用法不会再崩
import config
from decay_logic import (
    calculate_current_strength, is_cold_storage, should_archive, should_drop,
    peek_strength,             # 2026-11-08 补：第 630 行一直在用，但从没导入过
    # 2026-11-10 第二步：另外两条轨的纯函数（都不拿锁、不改 last_active）
    peek_impression, peek_emotion_residue,
    # 2026-11-11 收敛：静默异常收集器统一从 decay_logic 导入，
    #   不再在本文档里各复制一份（否则两本账，汇总看不全）。
    note_silent_error, silent_error_summary,
)
from recall_engine import cosine_similarity, awake_cold_memory as _awake_cold_memory



# __UTF8_STDOUT_GUARD__ (2026-11-07)
# 中文 Windows 终端默认 GBK，print 输出 emoji（✅❌⚠️）会 UnicodeEncodeError 直接崩。
# 实测：link_check / test_shortterm / regression_test 在 cmd 里跑不起来。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
def _load_json(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(path: str, data: dict) -> None:
    """FIX-1103-ATOMIC：原子写（先写 .tmp 再 os.replace）。

    原来直接写目标文件，写到一半被另一个进程读、或者两个进程同时写，
    就会留下半个 JSON（实测回归 30 次撞到 2 次 JSONDecodeError）。

    2026-11-08 修（巡检 巡检抓出来的两个洞，都对齐
    memory_manager._atomic_write_json 的实现）：

      ① **固定 tmp 名**：原来是 path + '.tmp'，两个进程同时写就抢同一个临时文件
         → Windows 直接 WinError 32（文件被占用），或者两边互相覆盖对方写了一半的内容。
         改成 path.<pid>.<6位随机>.tmp，各写各的。

      ② **零重试**：os.replace 在 Windows 上会因为目标正被别的进程读（杀软扫描、
         bridge 正在读 active.json）而失败（WinError 32/5）。
         原来一次失败就直接抛，整个巩固前功尽弃。改成重试 8 次、退避 0.05s×n
         （总计约 1.8s），足够熬过绝大多数瞬时占用。
    """
    import uuid as _uuid
    import time as _time
    tmp = f"{path}.{os.getpid()}.{_uuid.uuid4().hex[:6]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                pass
        last_err = None
        for attempt in range(8):
            try:
                os.replace(tmp, path)
                return
            except OSError as e:
                last_err = e
                _time.sleep(0.05 * (attempt + 1))
        raise last_err if last_err else RuntimeError("os.replace failed")
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def _dedupe_by_id(items: List[MemoryItem]) -> List[MemoryItem]:
    """按 mem_id 保留第一条；无 ID 的脏记录不互相吞并。"""
    seen = set()
    out = []
    for item in items:
        mid = getattr(item, "mem_id", None)
        if mid and mid in seen:
            continue
        if mid:
            seen.add(mid)
        out.append(item)
    return out


def _dedupe_rows_by_id(rows: list) -> list:
    """JSON 行版本的幂等去重，供跨文件 staging 写盘使用。"""
    seen = set()
    out = []
    for row in rows:
        mid = row.get("mem_id") if isinstance(row, dict) else None
        if mid and mid in seen:
            continue
        if mid:
            seen.add(mid)
        out.append(row)
    return out


def _save_active_cold_transition(active_data: dict, cold_data: dict,
                                 previous_active: dict, previous_cold: dict) -> None:
    """持久化双向迁移：先写目标副本，再收敛来源，失败也只重复、不丢失。

    active/cold 是两个独立文件，无法靠单次 os.replace 获得跨文件事务。
    有迁移时先写包含旧数据和新增目标副本的 staging 文件；随后才写最终列表。
    因此任意两次写盘之间失败，至少有一份副本存在，下次巩固可按 ID 收敛。
    """
    old_active_rows = list(previous_active.get("memories", []) or [])
    old_cold_rows = list(previous_cold.get("memories", []) or [])
    final_active_rows = list(active_data.get("memories", []) or [])
    final_cold_rows = list(cold_data.get("memories", []) or [])
    old_active_ids = {r.get("mem_id") for r in old_active_rows if r.get("mem_id")}
    old_cold_ids = {r.get("mem_id") for r in old_cold_rows if r.get("mem_id")}
    added_active = [r for r in final_active_rows
                    if r.get("mem_id") and r.get("mem_id") not in old_active_ids]
    added_cold = [r for r in final_cold_rows
                  if r.get("mem_id") and r.get("mem_id") not in old_cold_ids]

    if added_active or added_cold:
        staged_active = dict(previous_active)
        staged_cold = dict(previous_cold)
        staged_active["memories"] = _dedupe_rows_by_id(old_active_rows + added_active)
        staged_cold["memories"] = _dedupe_rows_by_id(old_cold_rows + added_cold)
        _save_json(LONG_TERM_ACTIVE_PATH, staged_active)
        _save_json(LONG_TERM_COLD_PATH, staged_cold)

    _save_json(LONG_TERM_ACTIVE_PATH, active_data)
    _save_json(LONG_TERM_COLD_PATH, cold_data)


def awaken_cold_memory(mem_id: str, current_timestamp: float = None, *, context=None) -> MemoryItem:
    """把实际采用的冷存命中迁回活跃库，并立即持久化。

    写活跃库在前、清冷存在后；若中途失败会暂时重复，不会丢唯一副本。
    若活跃库已经有同 ID（上次中断留下的状态），以活跃副本为准并收敛冷存。
    """
    if not mem_id:
        raise ValueError("mem_id 不能为空")
    with FileLock(LOCK_FILE_PATH):
        active_data = _load_json(LONG_TERM_ACTIVE_PATH)
        cold_data = _load_json(LONG_TERM_COLD_PATH)
        active = _dedupe_by_id([
            MemoryItem.from_dict(d) for d in active_data.get("memories", [])])
        cold = _dedupe_by_id([
            MemoryItem.from_dict(d) for d in cold_data.get("memories", [])])
        target = next((m for m in active if m.mem_id == mem_id), None)
        if target is None:
            target = next((m for m in cold if m.mem_id == mem_id), None)
        if target is None:
            raise KeyError("冷存与活跃库中都不存在该记忆: %s" % mem_id)

        if context is not None:
            from services.evidence_store import load
            from services.recall_policy import eligible
            sources = load()
            sources.update({m.mem_id: m for m in cold + active})
            if ((target.session_id and target.session_id != context.session_id)
                    or not eligible(target, context, pool="cold", sources=sources)):
                raise ValueError("cold record is unavailable in this session")
            if all(m.mem_id != mem_id for m in cold):
                return target

        if all(m.mem_id != mem_id for m in active):
            _awake_cold_memory(target, current_timestamp)
        final_active = [target if m.mem_id == mem_id else m for m in active]
        if all(m.mem_id != mem_id for m in final_active):
            final_active.append(target)
        final_cold = [m for m in cold if m.mem_id != mem_id]
        active_data["memories"] = [m.to_dict() for m in _dedupe_by_id(final_active)]
        cold_data["memories"] = [m.to_dict() for m in _dedupe_by_id(final_cold)]
        _save_json(LONG_TERM_ACTIVE_PATH, active_data)
        _save_json(LONG_TERM_COLD_PATH, cold_data)
        return target


def _calc_consolidation_score(mem: MemoryItem) -> float:
    """四维打分：频率 + 情绪 + 主动标记 + 重要性，总分 0~100

    FIX-1103（严重缺陷修复）：
      原来桥接自动写入的记忆（source=bridge_auto, chunk_priority=5,
      emotion_intensity=0, tags=["对话"]）只能得：
          15(频率) + 0 + 0 + 10 = 25 分
      而阈值是 60 ⇒ **自动对话记忆永远进不了长时库**，
      长时库只能靠迁移和手动 remember 增长（4 天只涨 7 条）。

      修法：给自动来源一个基础分 + 提高频率权重，让"反复出现的日常对话"
      也能自然沉淀；同时保留手动/重要标签的优先级。
    """
    freq_score = min(mem.chunk_priority * 4, 40)          # 原 ×3 上限 30 → ×4 上限 40
    # ★★★ 2026-11-10 独立审查抓出的严重回归（必须读）★★★
    #
    #   这一行原来是 `emotion_score = mem.emotion_intensity * 0.25`。
    #
    #   在 emotion_intensity 恒为 0 的年代（2026-11-10 之前），它永远贡献 0 分，
    #   所以上面 FIX-1103 的「auto_base 从 30 降到 10」才能真正把
    #   bridge_auto 挡在 L3 外面。
    #
    #   但 2026-11-10 的「情绪推断」上线后，emotion_intensity 有了真实值，
    #   而 infer_emotion 对「住院/手术/车祸/去世/辞职/崩溃」直接给 85~95 ⇒
    #
    #       emotion=80 → emotion_score=20 → 总分 40+20 = 60 → **正好够进 L3**
    #
    #   实测：
    #       emo   0 → score 40.0  留在 L2
    #       emo  75 → score 58.8  留在 L2
    #       emo  80 → score 60.0  ✅ 进 L3   ← 临界点
    #       emo  90 → score 62.5  ✅ 进 L3
    #
    #   也就是说：**一条只提了一嘴「他住院了」的 bridge_auto 流水对话，
    #   会一次性跳过「反复出现才沉淀」的设计，直接进核心库。**
    #   而 L3 地板是 35（几乎不会降级）—— 送进去就拿不回来了。
    #
    #   这正好是 FIX-1103 那条注释警告过的路径：
    #     「原来 30 太高，导致所有 bridge_auto 都保底 60 分 → 全进 L3 核心」
    #   情绪推断把这条口子原样开了回来。
    #
    #   【当前处置】先切断（宁可少沉淀，不可错误沉淀）：
    #     情绪不再参与巩固评分，回到改动前的行为。
    #
    #   【将来要接回来的前提】
    #     ① 给 emotion_score 设上限（建议 <= 10，且需要 freq 也高）
    #     ② 或把「情绪」变成 L3 的必要条件而不是加分项
    #     ③ 且必须有测试：emo=100 但 chunk_priority=5 的流水对话**不许**进 L3
    #
    #   ⚠️ 不要因为「情绪强的记忆值得记住」就把这行恢复成原样 ——
    #      情绪强度衡量的是「这件事有多重」，不是「这条记录有多该进核心库」。
    emotion_score = 0.0
    manual_score = 25 if mem.source == "manual_remember" else 0
    # 自动来源基础分：对话本来就该被记住一部分，不能一条都不算。
    # 2026-11-06 调：从 30 降到 10。原来 30 太高，导致所有 bridge_auto 都保底
    #   20(freq) + 30(base) + 10(importance) = 60 分 → 全进 L3 核心，
    #   边缘层永远是空的，「边缘记忆 + 打分遗忘」根本触发不了。
    #   降到 10 后：普通对话 40 分（进 L2 中），重要/手动记的靠 manual_score 拉开。
    auto_base = 10 if mem.source in ("bridge_auto", "auto", "manual") else 0
    important_tags = {"核心事件", "人设相关", "重要约定", "长期", "她记的"}
    importance_score = 20 if any(t in mem.tags for t in important_tags) else 10
    return min(100.0, freq_score + emotion_score + manual_score + auto_base + importance_score)


def _find_duplicate(new_mem: MemoryItem, long_term_list: List[MemoryItem]) -> int:
    """去重：优先向量相似度，向量不可用时退回文本比对，返回索引；无匹配返回 -1

    FIX-1103-DEDUP-FALLBACK（2026-11-03 实测发现）：
      原来只看向量。一旦 embedding 缺失 / 接口失败返回零向量 / 调用方没传
      embedding_func，cosine_similarity 恒为 0 ⇒ 去重永远失效 ⇒
      **同一条记忆反复巩固，长时库出现完全相同的副本**。
      （实测：新建一条工作记忆，连跑两次巩固 → 长时库 1 条变 2 条，内容一字不差）

      修法：
        ① 两边都有有效向量 → 走向量相似度
        ② 任一边没有有效向量 → 退回"内容完全相同"判断
        ③ 再兜一层：内容去掉标点空白后的前 60 字相同也算重复
    """

    def _has_valid_emb(vec) -> bool:
        if not vec:
            return False
        # 全零向量 = 嵌入失败，不能用来算相似度
        return any(x != 0 for x in vec)

    def _norm(text: str) -> str:
        import re as _re
        return _re.sub(r'[\s\W_]+', '', str(text or ''))

    new_norm = _norm(new_mem.content)

    for idx, mem in enumerate(long_term_list):
        # Similarity is not event identity. Keep revisions, subjects and days distinct.
        if getattr(mem,'corrected_by',None) or getattr(mem,'status','active')=='superseded':
            continue
        if getattr(new_mem,'corrects',None)==mem.mem_id or getattr(mem,'corrects',None)==new_mem.mem_id:
            continue
        if getattr(new_mem,'subject',None) and getattr(mem,'subject',None) and new_mem.subject!=mem.subject:
            continue
        if bool(getattr(new_mem,'is_private',False))!=bool(getattr(mem,'is_private',False)):
            continue
        sid_a,sid_b=str(getattr(new_mem,'session_id','') or ''),str(getattr(mem,'session_id','') or '')
        if (sid_a.startswith('group:') or sid_b.startswith('group:')) and sid_a!=sid_b:
            continue
        eventlike=(getattr(new_mem,'mem_type','')=='episode' or getattr(new_mem,'kind','') in ('事件','情感','闲聊'))
        if eventlike:
            from datetime import datetime as _clock
            date_a=_clock.fromtimestamp(new_mem.create_time).date()
            date_b=_clock.fromtimestamp(mem.create_time).date()
            if date_a!=date_b:
                continue
            msg_a=getattr(new_mem,'source_message_id','')
            msg_b=getattr(mem,'source_message_id','')
            if msg_a and msg_b and msg_a!=msg_b:
                continue
        import re as _dates
        dates_a=set(_dates.findall(r'今天|明天|后天|周末|下周|\d{1,2}月\d{1,2}[日号]|\d{1,2}点',new_mem.content or ''))
        dates_b=set(_dates.findall(r'今天|明天|后天|周末|下周|\d{1,2}月\d{1,2}[日号]|\d{1,2}点',mem.content or ''))
        if dates_a and dates_b and dates_a!=dates_b:
            continue
        # ① 向量可用时走向量
        if _has_valid_emb(new_mem.embedding) and _has_valid_emb(mem.embedding):
            if cosine_similarity(new_mem.embedding, mem.embedding) >= DEDUPLICATION_SIM_THRESHOLD:
                return idx
            continue
        # ② 向量缺失：内容完全一致
        if (new_mem.content or '').strip() == (mem.content or '').strip():
            return idx
        # ③ 兜底：规范化后前 60 字一致
        if new_norm and new_norm == _norm(mem.content):
            return idx
    return -1


def _reverse_mark_by_source_turns(active_list: list, shortterm_mems: list) -> tuple:
    """以 source_turns 为唯一真相，反向修正碎片标记。

    ★ 2026-11-08 从 run_episode_aggregation 里抽出来。

    ## 为什么需要

    mark_aggregated 打的是「本轮算出来的 id」。
    但「同主题替换」可能把那个档删了，或者档本来就因为别的原因
    没进 active_list —— 于是碎片指向一个不存在的 id。

    实测（20:52:43 那批 100 条打标）：
      10 条成了孤儿，而它们其实**已经被别的档收录**：
        mem_1794108818499_45b5 → ep_1794108173_2639 记着
        mem_1794113055474_a300 → ep_1794113055_58f0 记着
      → 「档说有，碎片说没有」，两边矛盾

    ## 做什么

    以 active_list 的 source_turns 为唯一真相，反向修正。兜住三类错位：
      ① 档里有、碎片没标     → 补上
      ② 碎片标了、档里没有   → 清掉
      ③ 碎片标了 A、实际在 B → 改成 B

    ## 为什么必须放在「所有改动做完、写盘之前」

    前面每一步（聚合、替换、去重）都可能改 active_list，
    只有「所有改动做完」这一刻的 source_turns 才是最终真相。

    ## 幂等

    跑几次结果一样（want 相同就跳过）。

    返回 (修了几条, 错误信息或None)。
    """
    try:
        src_owner = {}
        for e in active_list:
            if getattr(e, "mem_type", "") != "episode":
                continue
            for t in (getattr(e, "source_turns", None) or []):
                src_owner[str(t)] = e.mem_id

        n_fill = 0        # 碎片没标 → 补上归属
        n_clear = 0       # 碎片标了 → 档里没有 → 清掉
        n_move = 0        # 碎片标了 A → 实际在 B → 改成 B
        for m in shortterm_mems:
            want = src_owner.get(str(m.mem_id))
            have = getattr(m, "episode_id", None)
            if have == want:
                continue
            if want and not have:
                n_fill += 1
            elif not want and have:
                n_clear += 1
            else:
                n_move += 1
            m.episode_id = want
            # 有归属才留时间戳；没归属就清掉，免得留个孤零零的时间
            m.episode_at = getattr(m, "episode_at", None) if want else None
        return {
            "total": n_fill + n_clear + n_move,
            "fill": n_fill,
            "clear": n_clear,
            "move": n_move,
        }, None
    except Exception as e:
        return {}, "%s: %s" % (type(e).__name__, e)



def _new_stats() -> dict:
    """巩固统计字典（2026-11-08 抽出来）。

    ★ 所有计数键**必须在初始化时就存在**（评审 定的规矩）：
      `stats.get("x", 0)` 会把「键不存在」和「键=0」变成同一个值 ——
      于是「这段代码没跑」和「跑了但没结果」长得一模一样。
      预置所有键后，日志里每个 key 都会出现：
        值 = 0    → 跑了，没东西处理（正常）
        键不出现  → 这段代码没跑到（问题）
    """
    return {
        "consolidated": 0,      # 工作记忆→长期，新入库
        "updated": 0,           # 命中已有记忆，加强度
        "moved_to_cold": 0,     # 活跃→冷存
        "expired_cleared": 0,   # 工作记忆 TTL 过期清理
        "embed_healed": 0,      # 空向量被补上（反向巡检）
        "dropped_noise": 0,     # 空内容/真噪音被删（反向巡检）
        "rescued_from_cold": 0, # 冷存里不该冷的被捞回（反向巡检）
        "shortterm_promoted": 0,# 短期到期→长期
        "shortterm_dropped": 0, # 短期到期→删
        "shortterm_kept": 0,    # 短期未到期保留
        # 2026-11-08 情景档
        "episodes_created": 0,  # 第0步新生成的情景档条数
        "episodes_error": None, # None=跑通；字符串=没跑成及原因
        "episodes_embed_pending": 0,  # 生成成功但向量没算出来的条数
        "episode_embed_healed": 0,    # 本次给多少条情景档补上了向量
        "episodes_over_expected": 0,     # 超过「期望段数」多少（只告警，不截断）
        # 引用完整性（2026-11-08 加）：本次巩固写完盘后自检的结果。
        # 夜巡读这两个键 —— 否则就是「检查跑了但没人看」。
        "episodes_badowner_healed": 0,   # 坏归属标记清掉几条（档在、但 source_turns 不含它）
        "episodes_dup_healed": 0,        # 重复引用解掉几条（同碎片被多档记）
        # 保存环节对账（2026-11-08 加）：15:38 那次「生成 24 段只落盘 21 条」，
        # 日志完全看不出来，靠夜巡数 id 才发现。现在每次巩固都会自己对账。
        "episodes_dropped_in_save": 0,   # 生成段数 - 落库条数（应为 0）
        "episodes_lost_ids": [],         # 生成了但不在库里的 id（应为空）
        "episodes_integrity": None,      # dict：ok/orphans/missing/dup_refs/unmarked/stale
        "episodes_integrity_error": None,  # str：异常说明（None=正常）
        "episodes_orphan_healed": 0,     # 上次跑挂了留下的孤儿标记，本次清掉了几个
        # 2026-11-08 经验提炼 / 反思（T16 / T17）
        #   ★ 键全部预置，理由同本节开头：
        #     created=0 且 error=None → 「跑了，没凑够料」（正常）
        #     error 非空              → 「压根没跑成」（问题）
        #   两种必须一眼能分开，所以错误码用 None 而不是 ""。
        "lessons_created": 0,   # 第6步新写的经验条数
        "lessons_error": None,  # None=跑通；字符串=没跑成及原因
        "reflection_created": 0,
        "reflection_error": None,
    }


# ═══════════════════════════════════════════════════════════
# 情景档聚合（2026-11-08 B2 接线）
# ═══════════════════════════════════════════════════════════
#
# 为什么必须排在巩固清理之前：
#   巩固第 3.5 步会把短期记忆「提升到长期库」或「直接删掉」，
#   情景档的原料就是这些短期碎片。顺序反了 → 巩固先把料吃掉 → 情景档永远空。
#
# 所以顺序固定为：
#   第0步 情景档聚合（本函数）  → 给碎片打 episode_id 标记
#   第1步 工作记忆 → 长期        （现有）
#   第2步 短期升级/删            （现有，跳过已标记的）
#
# 标记，不删除：source_turns 指向原文，删了就回溯不到（设计文档 2.5）。
#
# 注意：episode.py 由另一个对话（B1）实现，这里按设计文档的接口调用。
#   它还没落地时，聚合这一步会抛 ImportError → 被下面的 except 接住 →
#   stats['episodes_error'] 记录原因，巩固其余步骤照常跑。
#   （episodes_created 保持 0 和 error 非空，能区分「没跑」和「跑了没货」）


# ⚠️ 01:39 那次线上事故，两个原因都记在这（别再踩）：
#   ① 打标跑在保存之前。保存那步（这里原本调 episode.save_episode）抛异常，
#      碎片身上已经带着 episode_id 了 —— 指向一条永远不存在的情景档。
#      这些碎片被当「已聚合」永久跳过，档却没生成 = 对话静默丢失。
#      ⇒ 现在打标只在情景档确实进 active_list 之后才做。
#   ② 锁。save_episode 自己会再拿一次 memory_data.lock，而巩固流程正持有它
#      ⇒ RuntimeError: Deadlock。
#      ⇒ 现在情景档直接进 active_list，由巩固流程统一写盘，不再嵌套拿锁。
#   另有兜底：每次聚合先把「指向不存在档的 episode_id」清掉（孤儿自愈），
#   就算上一次跑到一半崩了，碎片也不会被永久堵死。


def run_episode_aggregation(stats: dict, current_ts: float, active_list: list,
                            archived_episodes=None) -> list:
    """第0步：把短期记忆聚合成情景档，**就地**追加进 active_list。

    参数：
      stats       —— 巩固统计字典（本函数负责填 episodes_* 三个键）
      current_ts  —— 本次巩固的当前时间
      active_list —— 巩固已经读进来的活跃库（MemoryItem 列表）。
                     ★ 就地改，不走 episode.save_episode 的「读整个库再写回」，
                       原因见下面「为什么不在锁里调 save_episode」。

    成功时返回新建/更新的情景档 dict 列表。
      stats['episodes_created']       = 新生成的条数
      stats['episodes_error']         = None（成功）/ 失败原因（失败）
      stats['episodes_embed_pending'] = 生成了但向量没算出来的条数

    ★ 失败绝不抛出 —— 聚合挂了不能把整条巩固流程带崩。
    """
    stats["episodes_created"] = 0
    stats["episodes_error"] = None
    stats["episodes_reverse_marked"] = 0
    stats["episodes_reverse_error"] = None

    # ★ 2026-11-08 修：三个提前 return 都要留痕。
    #
    #   为什么：原来直接 return []，episodes_integrity 就停在初值 None。
    #   而 None 有两种含义 ——
    #     ① 真的没料可聚合（短期层空）
    #     ② 短期层文件正被别的进程写，读到空/半截
    #   两种在 stats 里长得一模一样，事后完全分不清。
    #   实测今天出现过 3 次 episodes_integrity: null。
    #
    #   修法：写 {"ok": None, "skipped": ...}。
    #   ok=None 明确表示「没跑」，不是「跑过了没问题」。
    if not os.path.exists(SHORT_TERM_PATH):
        stats["episodes_integrity"] = {"ok": None, "skipped": "shortterm_missing"}
        stats["episodes_error"] = "短期层文件不存在，跳过聚合"
        return []

    st_raw = [d for d in _load_json(SHORT_TERM_PATH).get("memories", [])
              if d.get("mem_type") not in ("superseded", "unavailable")]
    if not st_raw:
        # ★ 2026-11-09 加诊断：光说「为空」不够，要知道是哪种空。
        #   实测 00:26:30 那次报了 shortterm_empty，但文件明明有 100 条。
        #   所以这里把当时的真实状态记下来，下次能分清：
        #     · 文件真的只有 0 条
        #     · 文件有内容但 memories 字段缺失/为空
        #     · 文件大小异常
        _diag = {}
        try:
            _diag["exists"] = os.path.exists(SHORT_TERM_PATH)
            _diag["size"] = (os.path.getsize(SHORT_TERM_PATH)
                             if _diag["exists"] else -1)
            _raw = _load_json(SHORT_TERM_PATH)
            _diag["keys"] = sorted(_raw.keys())[:8] if isinstance(_raw, dict) else "not-dict"
            _diag["memories_type"] = type(_raw.get("memories")).__name__ if isinstance(_raw, dict) else "?"
            _diag["memories_len"] = len(_raw.get("memories") or []) if isinstance(_raw, dict) else -1
        except Exception as _de:
            _diag["diag_error"] = "%s: %s" % (type(_de).__name__, _de)
        print("[episode] ⚠️ 短期层为空，诊断: %s" % json.dumps(_diag, ensure_ascii=False))
        stats["episodes_integrity"] = {"ok": None, "skipped": "shortterm_empty",
                                       "diag": _diag}
        stats["episodes_error"] = "短期层为空（可能正被写入），跳过聚合"
        return []

    # 这里不构造 MemoryManager：它会把 6.7MB 的 active.json 整个读进来，
    # 而巩固流程后面自己会读一次。直接读短期层文件，内容等价、开销小。
    try:
        from episode import (aggregate_all, group_by_session,
                             mark_aggregated, attach_embedding)
    except Exception as e:
        # episode.py 还没写好（B1 未交付）或依赖缺失 —— 记下来，不阻断
        stats["episodes_error"] = f"import 失败: {type(e).__name__}: {e}"
        stats["episodes_integrity"] = {"ok": None, "skipped": "import_failed"}
        return []

    try:
        # 下面所有对象都来自同一个列表：group_by_session 只是重新分组，
        # 不复制对象，所以打标会直接落在这些实例上，最后一次性写回文件。
        shortterm_mems = [MemoryItem.from_dict(d) for d in st_raw]
        by_id = {m.mem_id: m for m in shortterm_mems}

        # ★ 先自愈坏标记（2026-11-08 实测踩到的坑，两次）
        #
        # 第一次（孤儿）：如果上一次聚合在「打标之后、落库之前」失败，
        #   碎片带着一个指向不存在情景档的 episode_id ——
        #   aggregate_session 会把它们当「已聚合」永远跳过，而档根本没生成，
        #   那段对话等于永久丢失。
        #
        # 第二次（坏归属，稳定死锁）：档**存在**，但它的 source_turns 里没这条碎片。
        #   实测现场：ep_..._1e05 的 source_turns 只有 1 条，却有 6 条碎片带着它的标。
        #   原因：那一轮聚合时后 5 条碎片刚写好、已经进了 by_id，
        #   但 aggregate_session 算段时它们是「未打标」的一部分——
        #   等等，真实原因是反过来的：打标用了**这一轮算出的 source_turns**，
        #   而写盘那条档却是**更早一轮**的（同 id，source_turns 只有 1 条）。
        #   无论如何结果一样：
        #     ① 碎片有标 → 聚合跳过 → 那段永远不重新聚合
        #     ② 档的 source_turns 里没有它们 → mark_aggregated 永远不会补
        #     ③ 下一轮同样跳过 → 永远重复 ①②
        #   实测 5 次采样数值完全不变，是稳定态，不是瞬时。
        #
        #   判据：碎片标的档在库里，但档的 source_turns 不含它 → 标记是坏的 → 清掉，
        #   让它重新参与聚合。清掉后下一轮会把它并进正确的段。
        known_episodes = active_list + list(archived_episodes or [])
        existing_ids = {m.mem_id for m in known_episodes}
        owned_by = {}          # 档 id → 它 source_turns 的集合
        for x in known_episodes:
            if getattr(x, "mem_type", "") == "episode":
                owned_by[x.mem_id] = set(getattr(x, "source_turns", None) or [])
        healed = 0
        bad_owner = 0
        for m in shortterm_mems:
            eid = getattr(m, "episode_id", None)
            if not eid:
                continue
            if eid not in existing_ids:
                m.episode_id = None
                m.episode_at = None
                healed += 1
            elif owned_by.get(eid) is not None and m.mem_id not in owned_by[eid]:
                m.episode_id = None
                m.episode_at = None
                bad_owner += 1
        stats["episodes_orphan_healed"] = healed
        stats["episodes_badowner_healed"] = bad_owner

        # ★ 修 dup_refs：同一条碎片被多条档同时记（2026-11-08 加）
        #
        # 为什么必须在聚合**之前**做，而不是在打标之后：
        #   实测死锁 —— 碎片带着标记 → aggregate_session 跳过 → episodes 为空
        #   → 「同主题替换」那段 for 循环一次都不进 → 替换规则再对也白跑。
        #   所以 dup 必须在进入聚合前就解掉，让碎片重新成为原料。
        #
        # 归属判据（「改记录不改事实」的又一次应用）：
        #   碎片身上的 episode_id = 它当前的归属声明（事实）
        #   档的 source_turns      = 派生记录
        #   两者冲突时，改记录。
        #
        # 三种情况：
        #   ① 碎片有标记，且标记的档确实记着它 → 保留那条，从别的档移除
        #   ② 碎片有标记，但标记的档不存在/没记它 → 标记已坏（上面刚清过），
        #      退而选「source_turns 多的那条」（更完整）保留
        #   ③ 碎片没标记 → 同样选最完整的那条
        dup_removed = 0
        if True:
            ref_map = {}          # 碎片 id → [记着它的档 id]
            for x in active_list:
                if getattr(x, "mem_type", "") != "episode":
                    continue
                for t in (getattr(x, "source_turns", None) or []):
                    ref_map.setdefault(str(t), []).append(x.mem_id)

            # 跑两轮：第一轮可能把某条档的 source_turns 清空，第二轮再收敛一次
            for _round in range(2):
                ep_by_id = {x.mem_id: x for x in active_list
                            if getattr(x, "mem_type", "") == "episode"}
                changed_any = False
                for frag_id, owners in list(ref_map.items()):
                    live = [o for o in owners if o in ep_by_id]
                    if len(live) < 2:
                        continue
                    frag = by_id.get(frag_id)
                    mark = str(getattr(frag, "episode_id", None) or "") if frag else ""
                    if mark in live:
                        keep = mark
                        why = "碎片身上的标"
                    else:
                        keep = max(live, key=lambda o: len(
                            getattr(ep_by_id[o], "source_turns", None) or []))
                        why = "source_turns 更完整"
                    for o in live:
                        if o == keep:
                            continue
                        e = ep_by_id[o]
                        srcs = [t for t in (getattr(e, "source_turns", None) or [])
                                if str(t) != frag_id]
                        e.source_turns = srcs
                        sc = getattr(e, "scene", None)
                        if isinstance(sc, dict):
                            sc["turn_count"] = len(srcs)
                        dup_removed += 1
                        changed_any = True
                        print(f"[episode] dup 解冲突: {frag_id} 从 {o} 移除（留 {keep}，依据：{why}）")
                    ref_map[frag_id] = [keep]
                if not changed_any:
                    break
        stats["episodes_dup_healed"] = dup_removed

        groups = group_by_session(shortterm_mems)   # 私聊/群聊不能混（设计 2.0b）
        # 传 known_sources：让 aggregate_session 校验「带标记的碎片是不是真被那条档记着」。
        #   owned_by 是上面刚算好的（清坏标记时顺手建的），不额外扫描。
        episodes = aggregate_all(groups, known_sources=owned_by) or []

        # ★ EPISODE_DAILY_EXPECTED 是「告警阈值」，不是硬上限（评审 11-08 裁决）。
        #   为什么不能截断：设计文档自己期望 45 条 → 11 段，而期望值是 10 ——
        #   硬截断会把第 11 段直接丢掉，而第 11 段恰恰常常是「做饭 8 条」被拆散的那一半，
        #   等于把设计的核心价值（一件事就是一条）砍掉。
        #   这个参数的意义只有一个：**今天是不是切太碎了，去看一眼**。
        try:
            from config import EPISODE_DAILY_EXPECTED as _EXPECT
        except Exception:
            _EXPECT = 10
        if _EXPECT and len(episodes) > _EXPECT:
            stats["episodes_over_expected"] = len(episodes) - _EXPECT
            print(f"[episode] 今天切出 {len(episodes)} 段，超过预期 {_EXPECT}，"
                  f"建议跑 memory_cli episode audit 看是不是切太碎（不截断，全部保存）")

        # 算向量（三级降级：ok / pending / failed —— 失败也照存）
        for ep in episodes:
            attach_embedding(ep)

        # ★ 打标放在「情景档确实进 active_list 之后」（见下面 saved 循环）。
        #   反过来（先打标再保存）踩过一次实亏：保存那步抛异常时，
        #   碎片身上已经打了 episode_id，指向一条永远不存在的情景档 ——
        #   孤儿标记会永久堵住这些碎片：它们被当成「已聚合」，
        #   以后再也不参与聚合，而档却没生成。等于这段对话彻底丢了。

        # ★ 绝不能在锁里调 episode.save_episode：它自己会再拿一次
        #   memory_data.lock，而这里（巩固流程）正持有同一把锁 ——
        #   filelock 抛出的是 RuntimeError: Deadlock（实测踩到，聚合全军覆没）。
        #   而且它每次都要把 6.7MB 的活跃库读进来再整个写回去，10 条档就是 10 次。
        #   所以：情景档直接追加进巩固已经读进来的 active_list，最后统一由
        #   本流程一次写盘。副作用是情景档也会走一遍巩固的巡检 —— 无害，
        #   它 strength=100 / importance≥0.65，不会被判冷存或丢弃。
        saved = 0
        for ep in episodes:
            if not ep or not ep.get("mem_id"):
                continue
            try:
                item = MemoryItem.from_dict(ep)
            except Exception:
                continue
            # ★ 同一件事只能有一条（2026-11-08 加，防 id 方案变更造成重复）
            #   为什么需要：episode 的 mem_id 一旦换了算法（比如从「墙钟」改成
            #   「事件时刻」），同一批碎片今天算出来的 id 就跟库里已有的那条不一样 ——
            #   「同 id 覆盖」失效，于是同一件事在库里存两遍。
            #   实测：换算法后第一次巩固，11 条变 22 条，source_turns 总量翻倍。
            #   判据不用 id，用**内容**：同会话 + 同自然日 + 同主题 + 碎片有交集
            #   → 认定是同一条，用新的替换旧的（旧的那条是过期算法留下的）。
            _sc = ep.get("scene") or {}
            _src = set(ep.get("source_turns") or [])
            # 诊断用：记录这条档进入保存环节时的状态，用于「生成 N 段落盘 M 条」对账
            _dbg_in = (item.mem_id, len(_src))
            _stale = []
            for old in active_list:
                if getattr(old, "mem_type", "") != "episode":
                    continue
                if old.mem_id == item.mem_id:
                    continue
                _osc = getattr(old, "scene", None) or {}

                # 2026-11-08 修（评审）：theme 不再是「必须相同」
                #
                # 原判据要求「同 session + 同 date + 同 theme + 碎片有交集」。
                # 但实测发现：同一批碎片在两次聚合里可能被切成两段，
                # theme 还不同 ——
                #   第一次：11 条，theme='临时:为什么我'
                #   第二次：9 条，theme='闲聊'
                # → theme 不同 → 替换逻辑跳过 → 两个档共存
                # → 碎片被两个档同时记 → dup_refs 16 条
                #
                # 为什么会切出不同 theme：compose_content 加了「摘原话」兜底后，
                # 同一批碎片提取出的文本变了，主题判定跟着变。
                #
                # 修法：theme 降级成「加分项」，真正判据是「碎片重叠率」。
                #   为什么用重叠率而不是「有交集」：
                #     有 1 条交集就替换，会误删「相邻但合法并存」的段
                #     （比如「早上做饭」和「晚上做饭」可能共享 1 条边界碎片）
                #   >= 50% 重叠：只有「同一批碎片被切了两次」才会触发。
                if (getattr(old, "session_id", None) != item.session_id
                        or _osc.get("date") != _sc.get("date")):
                    continue

                _osrc = set(getattr(old, "source_turns", None) or [])
                if not _osrc or not _src:
                    # 没有 source_turns 的档不参与替换（无法判断重叠）
                    # 但同 theme 的仍然算重复（退回旧行为）
                    if _osc.get("theme") == _sc.get("theme"):
                        _stale.append(old.mem_id)
                    continue

                _overlap = len(_src & _osrc)
                _denom = min(len(_src), len(_osrc))
                if _overlap and _denom and (_overlap / _denom) >= 0.5:
                    _stale.append(old.mem_id)
            if _stale:
                active_list[:] = [x for x in active_list if x.mem_id not in _stale]
            item.mem_type = "episode"
            # 稳定 id：同一条重跑时覆盖旧的，不产生重复（就地切片赋值，保持列表身份不变）
            active_list[:] = [x for x in active_list if x.mem_id != item.mem_id]
            active_list.append(item)
            saved += 1
            # 诊断：确认这条档真的进了列表（不是「以为加了」）
            if not any(x.mem_id == item.mem_id for x in active_list):
                print(f"[episode] ⚠️ 保存后列表里找不到 {item.mem_id}")
            if ep.get("embed_status") != "ok":
                stats["episodes_embed_pending"] += 1
            # 只有情景档真的进库了，才给碎片打标（标记 = 「这段已被收录」的承诺）
            #
            # ★ 打标集合必须**严格等于** source_turns（2026-11-08 实测修）。
            #   上面「同主题替换」那一步会把旧档从 active_list 里删掉，
            #   但**从不往回追**「之前打了旧档标的碎片」——
            #   它们于是悬空指向一个刚被删掉的 id。
            #   实测现场：ep_1794113103_d7fb 只写了 1 条 source_turns，
            #   却有 2 条碎片带着它的标（第 2 条来自更早一轮的旧档）。
            #   集成自检的 missing 类正好抓到这个。
            #
            #   所以：打标范围 == source_turns，两边永远同一个集合。
            #   源头的孤儿由 check_integrity 的 missing/orphans 报出来，
            #   而不是在这里「多打一点保险」—— 多打 = 制造新孤儿。
            ep_mems = [by_id[t] for t in (ep.get("source_turns") or []) if t in by_id]
            mark_aggregated(ep, ep_mems)

        # ★ 向量兜底（2026-11-08）：attach_embedding 用的默认嵌入是裸 get_embedding，
        #   失败时返回全零向量 → embed_status=pending、embedding=[]。
        #   巩固第 2 步的补空向量巡检跑在这段**之前**，新插入的情景档一条都补不到，
        #   实测 11 条全 pending —— 等于召不回、也去不了重。
        #   embed_func 传 None：_embed_func 是在下面第 2 步才取的，这里还拿不到；
        #   heal_episode_embeddings 内部会自己 from ollama_embedding import get_embedding，
        #   语义等价，且不依赖执行顺序。
        _healed_emb = heal_episode_embeddings(active_list, None)
        stats["episode_embed_healed"] = _healed_emb
        stats["episodes_embed_pending"] = max(0, stats["episodes_embed_pending"] - _healed_emb)

        # 反向重标：以 source_turns 为唯一真相
        #   实现见文件顶部的 _reverse_mark_by_source_turns()
        #
        #   ★ 2026-11-08 修：原来只统计「补上归属」的情况，
        #     「清掉孤儿标记」不计数 → 实测改了 10 条却报 0 条。
        #     现在分三类统计，任何一类非 0 都打日志。
        _rm, _rm_err = _reverse_mark_by_source_turns(
            active_list + list(archived_episodes or []), shortterm_mems)
        stats["episodes_reverse_marked"] = _rm.get("total", 0)
        stats["episodes_reverse_detail"] = _rm
        if _rm_err:
            stats["episodes_reverse_error"] = _rm_err
            print(f"[episode] ⚠️ 反向重标失败: {_rm_err}")
        elif _rm.get("total"):
            print(f"[episode] 反向重标 {_rm['total']} 条"
                  f"（补 {_rm.get('fill', 0)} / 清 {_rm.get('clear', 0)}"
                  f" / 改 {_rm.get('move', 0)}）")


        # 碎片打标结果落盘（内容没变，只是多了 episode_id/episode_at）
        #
        # ★ 2026-11-09 加诊断：记下「写之前有几条」和「磁盘上原本有几条」。
        #   如果写之前的条数比磁盘少，说明内存里的 shortterm_mems 被谁缩过了
        #   —— 那就是「写了空短期层」的根源。
        try:
            _before_cnt = len(shortterm_mems)
            _disk_before = len(_load_json(SHORT_TERM_PATH).get("memories", []))
            if _before_cnt < _disk_before:
                print("[episode] ⚠️ 短期层要缩水: 内存 %d 条 < 磁盘 %d 条"
                      % (_before_cnt, _disk_before))
            stats["episodes_shortterm_write"] = {
                "mem": _before_cnt, "disk_before": _disk_before}
        except Exception:
            pass
        _save_json(SHORT_TERM_PATH, {"memories": [m.to_dict() for m in shortterm_mems]})

        # ★ 2026-11-09 加「打标清单」留痕：
        #   问题是「孤儿反复出现」，但每次手动跑巩固都能清掉。
        #   要抓现场，就得知道「本次写了哪些 episode_id 到碎片上」，
        #   以及「这些 id 当时在 active_list 里吗」。
        #   记到 state/episode_marks.log，一行一批。
        try:
            _marks = {}
            for _m in shortterm_mems:
                _eid = getattr(_m, "episode_id", None)
                if _eid:
                    _marks[_eid] = _marks.get(_eid, 0) + 1
            _active_ids = {e.mem_id for e in active_list + list(archived_episodes or [])
                           if getattr(e, "mem_type", "") == "episode"}
            _not_in_active = sorted(set(_marks) - _active_ids)
            _log_path = os.path.join(BASE_DIR, "state", "episode_marks.log")
            os.makedirs(os.path.dirname(_log_path), exist_ok=True)
            with open(_log_path, "a", encoding="utf-8") as _lf:
                _lf.write("%s | 打标 %d 个 id | active 有 %d 个档 | 不在 active 的: %s\n"
                          % (time.strftime("%Y-%m-%d %H:%M:%S"),
                             len(_marks), len(_active_ids),
                             _not_in_active if _not_in_active else "无"))
            stats["episodes_marks_not_in_active"] = _not_in_active
        except Exception:
            pass

        # ★ 引用完整性自检（2026-11-08 加）
        #   为什么放在「本次巩固自己写完盘之后」：这样它检查的是**落盘后的真实状态**，
        #   不是内存里那份「我以为写对了」的副本。
        #   实测价值：夜巡靠人肉数「11 条打标 vs 4 条 source_turns」才发现的问题，
        #   这里每次巩固都会自己数一遍 —— 它自己会发现自己的错。
        #
        #   为什么不 raise：巩固的职责是「整理数据」，完整性检查是「诊断」。
        #   诊断失败不该让整理失败。但必须留痕进 stats，让夜巡读得到。
        try:
            from episode import check_integrity
            # ★ 2026-11-18：传入归档档 id 集合，让 stale 拆成活跃/归档两个口径。
            #
            #   为什么：冷区档的碎片天生不在短期层（3 天窗口早清掉了），
            #   所以冷区的 stale 只会单边上涨、永远降不下来。原来混成一个数
            #   （实测 965 = 活跃 130 + 冷区 835）会让人以为活跃库坏了 965 条。
            _archived_ids = {
                str(getattr(e, "mem_id", "") or (e.get("mem_id") if isinstance(e, dict) else "") or "")
                for e in (archived_episodes or [])
            }
            _archived_ids.discard("")
            integ = check_integrity(active_list + list(archived_episodes or []),
                                    shortterm_mems, archived_ids=_archived_ids)
            # ★ 2026-11-13 修（诊断把病因藏起来了）：
            #
            #   check_integrity 的 ok 是这样算的：
            #     ok = not (orphans or missing or dup_refs or unmarked
            #               or turn_mismatch or id_drift)      ← 6 类
            #   而这里原来只抄了 5 个计数，且其中一个是 stale（**不参与 ok**），
            #   真正参与 ok 的 turn_mismatch / id_drift **没抄**。
            #
            #   症状（实测）：
            #     [episode] ⚠️ 引用完整性异常: {'ok': False, 'orphans': 0,
            #        'missing': 0, 'dup_refs': 0, 'unmarked': 0, 'stale': 0}
            #   ok=False 但列出来的全是 0 —— 病因是 turn_mismatch 或 id_drift，
            #   而它们压根没被打印。看日志的人只会以为检查器自己坏了。
            #
            #   ⇒ 参与 ok 的六类一个不能少；stale 留着（它有诊断价值，
            #     但明确标注「不参与判定」，免得下次又有人以为它是病因）。
            stats["episodes_integrity"] = {
                "ok": integ.get("ok"),
                # 参与 ok 判定的六类
                "orphans": len(integ.get("orphans") or []),
                "missing": len(integ.get("missing") or []),
                "dup_refs": len(integ.get("dup_refs") or []),
                "unmarked": len(integ.get("unmarked") or []),
                "turn_mismatch": len(integ.get("turn_mismatch") or []),
                "id_drift": len(integ.get("id_drift") or []),
                # 仅诊断：档引用的碎片已不在短期层（3 天窗口清掉后属正常），
                # 不参与 ok
                "stale": len(integ.get("stale") or []),
                # ★ 2026-11-18 拆口径：stale 总和下面这两项
                #   active   = 活跃区档引用的（值得看一眼）
                #   archived = 归档/冷区档引用的（天生判不了，只会涨）
                "stale_active": len(integ.get("stale_active") or []),
                "stale_archived": len(integ.get("stale_archived") or []),
            }
            if not integ.get("ok"):
                # 把「到底是哪类」直接写进错误串 —— 别再让人对着全 0 猜
                _bad = [k for k in ("orphans", "missing", "dup_refs",
                                    "unmarked", "turn_mismatch", "id_drift")
                        if stats["episodes_integrity"].get(k)]
                stats["episodes_integrity_error"] = (
                    "引用完整性异常（%s）: %s"
                    % ("/".join(_bad) or "未知", stats["episodes_integrity"]))
                print(f"[episode] ⚠️ {stats['episodes_integrity_error']}")
        except Exception as e:
            stats["episodes_integrity_error"] = f"完整性检查自身崩溃: {type(e).__name__}: {e}"

        # ★「生成 N 段 → 落库 M 条」对账（2026-11-08 加）
        #
        # 为什么必须加：15:38 那次「生成 24 段、只落盘 21 条、10 条真实对话掉了」，
        #   而当时的日志只写着「新建:0 更新:9 清理:0」—— **根本看不出丢了 3 段**。
        #   日志看不出，就没人会去查；没人查，它就一直是「数据看起来是对的」。
        #
        # 为什么是 stats 而不只是 print：
        #   日志：人看到才会查。
        #   stats：会落盘进 last_consolidation.json，夜巡能读 → 主动发现问题。
        _n_ep = len(episodes)
        if _n_ep != saved:
            stats["episodes_dropped_in_save"] = _n_ep - saved
            print(f"[episode] ⚠️ 生成 {_n_ep} 段，实际落库 {saved} 条 —— "
                  f"有 {_n_ep - saved} 段在保存环节消失（不是被截断，是保存逻辑漏了）")
        else:
            stats["episodes_dropped_in_save"] = 0
            print(f"[episode] 对账 OK：生成 {_n_ep} 段 / 落库 {saved} 条")

        # ★ 更深一层：落库的 id 集合 == 生成的 id 集合？
        #   上面只比数量。数量相等也可能「丢了一条多了另一条」。
        _gen_ids = {e.get("mem_id") for e in episodes if e and e.get("mem_id")}
        _saved_ids = {x.mem_id for x in active_list
                      if getattr(x, "mem_type", "") == "episode"}
        _lost = _gen_ids - _saved_ids
        if _lost:
            stats["episodes_lost_ids"] = sorted(_lost)
            print(f"[episode] ⚠️ 这些档生成了但不在库里: {sorted(_lost)}")

        stats["episodes_created"] = saved
        return episodes
    except Exception as e:
        # 聚合本身失败：回滚计数，记原因，巩固继续
        #
        # ★ 2026-11-09 修（独立审计指出）：补写 episodes_integrity。
        #
        #   原来只写 episodes_error，episodes_integrity 停在初值 None。
        #   于是下游（夜巡 / 人工看 JSON）无法区分两种情况：
        #     · null + skipped=xxx  → 主动跳过（没料/文件不存在）
        #     · null 无 skipped     → 聚合炸了 ← 这就是二义性
        #
        #   实测踩过：episode_store 的 aggregate_session_safe 一直 NameError，
        #   异常就是从这里被吞的，而 JSON 里只看到 "episodes_error": "NameError: ..."，
        #   episodes_integrity 仍是 null —— 跟「没料可聚合」长得一模一样。
        #
        #   现在失败时明确写 {"ok": None, "skipped": "aggregate_failed"}，
        #   与「没料」的 skipped 值区分开。
        stats["episodes_created"] = 0
        stats["episodes_error"] = f"{type(e).__name__}: {e}"
        stats["episodes_integrity"] = {"ok": None, "skipped": "aggregate_failed"}
        print(f"[episode] ❌ 聚合失败（已记录，巩固继续）: "
              f"{type(e).__name__}: {str(e)[:80]}")
        return []


def heal_episode_embeddings(active_list: list, embed_func=None) -> int:
    """补算情景档的 embedding（设计 7.1 的降级路径），就地在 active_list 里改。

    为什么需要单独一个补算：
      episode.attach_embedding 拿到的是 ollama_embedding.get_embedding 的**默认行为** ——
      失败时返回全零向量（不是空列表），于是 embed_status 落成 pending、embedding=[]。
      如果不补，这些情景档永远没有向量：
        · 语义召回召不到（只能靠关键词）
        · 双向去重也对不上（cosine 恒 0）
      实测：11 条情景档全是 pending。

    这里的补算规则跟巩固第 2 步「补空向量」完全一致（空 / 全零 = 要补），
    只是把对象收窄到 mem_type == "episode"，并且返回补了几条好进统计。
    """
    if embed_func is None:
        try:
            from ollama_embedding import get_embedding as embed_func
        except Exception:
            return 0
    healed = 0
    for item in active_list:
        if getattr(item, "mem_type", "") != "episode":
            continue
        emb = getattr(item, "embedding", None)
        if emb and any(x != 0 for x in emb):
            # 已有真向量，但状态没跟上（巩固第 2 步的补空向量循环只改 embedding、
            # 不改 embed_status）→ 把状态补正，否则永远是「pending 却有向量」的假象，
            # 之后任何按 embed_status 判断的逻辑（补算、健康检查）都会做错决定。
            if getattr(item, "embed_status", "ok") != "ok":
                item.embed_status = "ok"
                healed += 1
            continue
        if not (item.content or "").strip():
            continue
        try:
            vec = embed_func(item.content)
            if vec and any(x != 0 for x in vec):
                item.embedding = vec
                item.embed_status = "ok"
                healed += 1
        except Exception:
            pass                          # 还是失败就留着 pending，明天再来
    return healed


# ═══════════════════════════════════════════════════════════
# 经验提炼 / 反思（2026-11-08 T16 / T17）
# ═══════════════════════════════════════════════════════════
#
# 为什么放在巩固里、而不是另挂一个定时任务：
#   巩固每天 06:10 已经跑一次，它本来就是「整理库」的时刻；
#   再挂一个任务就多一套调度、多一个失败点，收益为零。
#
# ★ 为什么这里**不调 save_lessons / save_reflection**：
#   本流程正持有 memory_data.lock（外层 with FileLock），
#   那两个函数内部还会再加同一把锁 → filelock 抛 RuntimeError: Deadlock。
#   （episode.save_episode 就踩过这个坑，注释见 run_episode_aggregation。）
#   所以走「纯函数拿 item → 自己 append 进 active_list → 由巩固统一写盘」。
#   两个模块都为此各提供一个不加锁的 build_*_item(s) 纯函数。


def run_lessons(stats: dict, active_list: list, current_ts: float, date: str = None) -> list:
    """第6步：从现有记忆里提炼经验，**就地**追加进 active_list 并返回它（函数式风格）。

    只吃开关 + 每日配额；失败绝不抛出（提炼挂了不能把巩固带崩）。
    """
    stats["lessons_created"] = 0
    stats["lessons_error"] = None
    try:
        from features import on as _on
        if not _on("lessons"):
            stats["lessons_error"] = "功能关闭（features.lessons=false）"
            return active_list
        from lessons import build_lesson_items, extract_lessons
        found = extract_lessons(active_list)
        if not found:
            return active_list            # 跑了，没凑够料（created=0，error=None）
        items = build_lesson_items(found, [m.to_dict() for m in active_list])
        for item in items:
            active_list.append(item)
        stats["lessons_created"] = len(items)
        return active_list
    except Exception as e:
        stats["lessons_created"] = 0
        stats["lessons_error"] = f"{type(e).__name__}: {e}"
        return active_list


def run_reflection(stats: dict, active_list: list, current_ts: float, date: str = None) -> list:
    """第7步：给「昨天」做一条反思，**就地**追加进 active_list。

    为什么是昨天不是今天：
      06:10 跑巩固时「今天」才过了 6 小时，事情还没发生完；
      昨天才是一整天完整的料。这也是生成式智能体里 reflection 的标准触发点。
    """
    stats["reflection_created"] = 0
    stats["reflection_error"] = None
    try:
        from features import on as _on
        if not _on("reflection"):
            stats["reflection_error"] = "功能关闭（features.reflection=false）"
            return active_list
        from reflection import (build_reflection_item, extract_reflection,
                                gather_day_memories, should_reflect)
        day = date or time.strftime("%Y-%m-%d", time.localtime(current_ts - 86400))
        day_mems = gather_day_memories(active_list, day)
        if not should_reflect(day_mems):
            return active_list            # 跑了，料不够（created=0，error=None）
        refl = extract_reflection(day_mems, day)
        if not refl:
            return active_list
        item = build_reflection_item(refl, [m.to_dict() for m in active_list])
        if item is None:
            return active_list            # 那天已有反思（幂等）
        active_list.append(item)
        stats["reflection_created"] = 1
        return active_list
    except Exception as e:
        stats["reflection_created"] = 0
        stats["reflection_error"] = f"{type(e).__name__}: {e}"
        return active_list


def _guess_trigger() -> str:
    """猜这次巩固是谁触发的。

    为什么要猜：巩固有 4 条调用路（计划任务 / 活动触发 / 手动 / 测试），
    出了问题时第一个要问的就是「哪条路跑的」。
    没有这个字段，只能翻遍所有日志反推。

    ★ 2026-11-09 加：来源分类
      scheduled  计划任务（06:10 的每日巩固任务）
      activity   maintenance_trigger 的活动触发
      manual     手动跑（命令行 / python -c）
      test       测试套件（数据目录被指向别处，或 pytest 环境）
      unknown    猜不出来
    """
    explicit = (os.environ.get("DSH_CONSOLIDATE_TRIGGER") or "").strip()
    if explicit:
        return explicit

    # 测试：测试套件会把数据目录搬到临时目录
    if os.environ.get("MEMORY_DATA_DIR"):
        return "test"
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return "test"

    # 计划任务：通过 .cmd 启动，argv[0] 是 python
    try:
        import sys as _sys
        if _sys.argv and _sys.argv[0].endswith("daily_consolidation.py"):
            # 有 --apply 参数 = 手动或计划任务
            if "--apply" in _sys.argv:
                # 看父进程命令行里有没有 .cmd
                try:
                    import subprocess
                    _ppid = os.getppid()
                    _out = subprocess.run(
                        ["wmic", "process", "where",
                         "ProcessId=%d" % _ppid, "get", "CommandLine"],
                        capture_output=True, text=True, timeout=3,
                        encoding="utf-8", errors="replace")
                    _cl = (_out.stdout or "").lower()
                    if ".cmd" in _cl or "scheduled" in _cl:
                        return "scheduled"
                    if "powershell" in _cl or "pwsh" in _cl:
                        return "manual"
                except Exception:
                    pass
                return "manual"
            return "manual"
    except Exception:
        pass

    # python -c 或 import 后直接调
    try:
        import sys as _sys
        if _sys.argv and _sys.argv[0] in ("-c", ""):
            return "manual"
    except Exception:
        pass

    return "unknown"


def process_working_memory_to_long_term(trigger: str = None) -> dict:
    """每日巩固主流程：读取独立工作记忆文件 → 筛选 → 去重 → 写入长时库 → 冷热迁移。

    只读写本系统自己的文件（working_mem.json / active.json / cold.json），
    绝不触碰宿主原有文件（social-v2.json 等）。

    ★ 2026-11-09 加：入口记 trigger + 耗时。

      为什么要有：
        今天踩过「巩固没跑却报 ok」的坑，靠 18 倍时间差才发现。
        有了 trigger 和耗时，一眼能看出：
          · 跑了没有（有没有「开始」这行）
          · 哪条路跑的
          · 跑了多久（异常的慢/快都能看出来）
          · 卡在哪一步（如果未来加分段计时）
    """
    import time as _time

    _trig = trigger or _guess_trigger()
    _t0 = _time.perf_counter()
    print("[consolidate] 开始 | trigger=%s pid=%d"
          % (_trig, os.getpid()))

    try:
        stats = _consolidate_locked()
    except Exception as _e:
        # 队列记录还没被确认时，失败只释放认领，不删数据。
        try:
            import pending_longterm as _pl
            _pl.release_pending(locals().get("_pending_claimed", []))
        except Exception:
            pass
        _elapsed = _time.perf_counter() - _t0
        print("[consolidate] ❌ 失败 | trigger=%s 耗时=%.1fs 异常=%s: %s"
              % (_trig, _elapsed, type(_e).__name__, str(_e)[:60]))
        raise

    _elapsed = _time.perf_counter() - _t0

    # ★ 2026-11-09 修（独立审计指出）：情景档失败要在这行直接标出来。
    #
    #   原来只打 `情景档=0` —— 分不出「没料可聚合」和「聚合炸了」。
    #   而实际情况是：`episode_store.py` 里 aggregate_session_safe 一直 NameError，
    #   异常被这里吞掉，巩固照样报 ok:true，看日志完全看不出来。
    #
    #   现在：失败时在括号里直接写异常类型，省得再去翻 last_consolidation.json。
    _ep_created = stats.get("episodes_created", 0)
    _ep_err = stats.get("episodes_error") or stats.get("episodes_failed")
    _ep_note = ""
    if _ep_err:
        # 异常可能是字符串（NameError: ...）或异常对象，统一取前 40 字
        _ep_note = "(失败:%s)" % str(_ep_err)[:40]
    print("[consolidate] 结束 | trigger=%s 耗时=%.1fs 新增=%s 更新=%s "
          "情景档=%s%s 普通冷迁=%s 情景档归档=%s"
          % (_trig, _elapsed,
             stats.get("new_long_term", 0),
             stats.get("updated", 0),
             _ep_created, _ep_note,
             stats.get("moved_to_cold", 0), stats.get("episodes_archived", 0)))

    # ★ 2026-11-11 加：冷存可观测性。
    #
    #   为什么加：冷存一直是 0 条，日志只写「冷迁=0」，
    #   看不出是「没到 180 天门槛」还是「判据坏了」。
    #   实测 11-11：最老才 3.34 天，还差 176.7 天 —— 机制正常，只是没到时间。
    #
    #   现在一眼能看出：
    #     「最老 3.3 天 / 门槛 180 天（还差 176.7 天）」  ← 正常，等着就行
    #     「最老 200 天但冷迁=0」                        ← 判据坏了，要查
    try:
        _oldest = float(stats.get("_oldest_inactive", 0.0) or 0.0)
        _thresh = float(COLD_ARCHIVE_AFTER_DAYS)
        if stats.get("moved_to_cold", 0) > 0:
            print("[consolidate] 普通记忆冷存 | 迁入 %d 条 | 门槛 %.0f 天"
                  % (stats.get("moved_to_cold"), _thresh))
        else:
            _gap = max(0.0, _thresh - _oldest)
            if _oldest > 0:
                print("[consolidate] 普通记忆冷存 | 待归档 0 条 | 最老未召回 %.1f 天 / "
                      "门槛 %.0f 天（还差 %.1f 天）"
                      % (_oldest, _thresh, _gap))
            else:
                print("[consolidate] 普通记忆冷存 | 待归档 0 条 | 门槛 %.0f 天（库里没有条目）"
                      % _thresh)
            # 异常告警：已经超过门槛却没归档，说明判据失效
            if _oldest >= _thresh:
                print("[consolidate] ⚠️ 异常：最老 %.1f 天已超门槛 %.0f 天，"
                      "但冷迁=0 —— should_archive 判据可能失效，要查"
                      % (_oldest, _thresh))
    except Exception as _ce:
        pass

    # ★ 2026-11-18 迁移说明：
    #   这里原来挂过 recall_audit.prune() / window_recall.prune_cache()，
    #   已统一收到 _consolidate_locked() 的出口（stats 落盘之前）那一段。
    #
    #   为什么不放在这里：本函数是**外层包装**，除了 12:25 的定时巩固，
    #   maintenance_trigger.run_now() 也会走它（maintenance_trigger.py:157），
    #   而 maintenance_trigger 由 memory_cli 在高频路径里调用。
    #   把清理放在内层出口 => 一次巩固只清一次，不会重复，字段名也只有一套。

    # 把 trigger 和耗时也写进 stats，方便程序读
    try:
        stats["trigger"] = _trig
        stats["elapsed_sec"] = round(_elapsed, 2)
    except Exception:
        pass

    # ★ 2026-11-10 静默异常汇总：把本次巩固里被吞掉的异常报出来。
    #
    #   为什么放在这里：这是巩固的唯一出口，所有 _consolidate_locked 里的
    #   note_silent_error 都会累计到这里。
    #   为什么只在非空时打印：正常情况下是 0，打印空行会让日志变成噪音。
    try:
        _silent = silent_error_summary()
        if _silent:
            stats["silent_errors"] = _silent
            _total = sum(_silent.values())
            print("[consolidate] ⚠️ 静默异常 %d 次: %s"
                  % (_total, list(_silent.items())[:3]))
    except Exception:
        pass

    return stats


def _consolidate_locked() -> dict:
    """巩固的实际逻辑（2026-11-08 从 process_working_memory_to_long_term 抽出来）。

    抽出来的唯一原因：真实数据测试要能搬着数据文件去临时目录跑**完整流程**。
    原来逻辑直接写死在 with lock 里，想测一遍就只能动生产库 ——
    那属于「测试造参数」，测出来不算数。
    """
    _pending_claimed = []
    _pending_committed = False
    try:
      with FileLock(LOCK_FILE_PATH):
        working_data = _load_json(WORKING_MEM_PATH)
        active_data = _load_json(LONG_TERM_ACTIVE_PATH)
        cold_data = _load_json(LONG_TERM_COLD_PATH)

        # 读取所有会话的工作记忆（独立文件结构：{"sessions": {会话ID: {working_memory: [...]}}}）
        # 老桥接没有给条目写 session_id，会话键是唯一可信的归属来源。
        working_list = []
        sessions_dict = working_data.get("sessions", {})
        for _session_key, sess_info in sessions_dict.items():
            for d in sess_info.get("working_memory", []):
                _wm = MemoryItem.from_dict(d)
                if not getattr(_wm, "session_id", None):
                    _wm.session_id = _session_key
                working_list.append(_wm)

        # 与 MemoryManager / recall_shortterm 保持同一生命周期排除规则。
        # 被更正/不可用的原始记录继续留档，但不参与巩固、聚合或重新激活。
        active_list = [MemoryItem.from_dict(d) for d in active_data.get("memories", [])
                       if d.get("mem_type") not in ("superseded", "unavailable")]
        cold_list = [MemoryItem.from_dict(d) for d in cold_data.get("memories", [])
                     if d.get("mem_type") not in ("superseded", "unavailable")]
        current_ts = datetime.now().timestamp()
        stats = _new_stats()

        # FIX-1107-EMBED-HEAL：巩固时要补空向量，这里拿一下嵌入函数。
        #   拿不到就跳过（不因为 ollama 挂了让整个巩固失败）。
        _embed_func = None
        try:
            from ollama_embedding import get_embedding as _ge
            _embed_func = _ge
        except Exception as _e:
            note_silent_error('拿embedding函数', _e)

        # ═══ 第 -1 步：先自愈碎片标记（2026-11-09 加）═══
        #   为什么在聚合之前：
        #     桥接运行期间会不断产生两类脏数据（实测跑前 10 条孤儿 / 15 条漏记）：
        #       · 孤儿：碎片有 episode_id，但那个档不存在
        #       · 漏记：碎片带着档的标，但档的 source_turns 没记它
        #     而聚合只在「本轮到料」时才顺带修；本轮没聚合就一直是脏的。
        #     所以单独做一次，不依赖聚合。
        #
        #   为什么放在最前面：
        #     聚合会读碎片（group_by_session），脏标记会干扰分段。
        #     先洗干净，聚合看到的是干净数据。
        #
        #   失败不影响后面任何一步。
        try:
            _st = _load_json(SHORT_TERM_PATH)
            _st_rows = [d for d in (_st.get("memories", []) or [])
                        if d.get("mem_type") not in ("superseded", "unavailable")]
            if _st_rows:
                _st_mems = [MemoryItem.from_dict(d) for d in _st_rows]
                _pre, _pre_err = _reverse_mark_by_source_turns(
                    active_list + cold_list, _st_mems)
                if _pre_err:
                    stats["episodes_pre_heal_error"] = _pre_err
                elif _pre and _pre.get("total"):
                    stats["episodes_pre_healed"] = _pre["total"]
                    print("[episode] 开头痛点自愈 %d 条（补 %d / 清 %d / 改 %d）"
                          % (_pre["total"], _pre.get("fill", 0),
                             _pre.get("clear", 0), _pre.get("move", 0)))
                    _save_json(SHORT_TERM_PATH,
                               {"memories": [m.to_dict() for m in _st_mems]})
        except Exception as _pe:
            stats["episodes_pre_heal_error"] = "%s: %s" % (
                type(_pe).__name__, _pe)
            print("[episode] ⚠️ 开头痛点自愈失败（不影响后续）: %s" % _pe)

        # pending 只在这里认领；长期库真正写成功后才 commit。
        # 中途任何异常都在本函数 finally 释放本批，绝不提前清空。

        # ═══ 第0步：情景档聚合（2026-11-08 新增）═══
        #   ★ 必须排在所有清理之前。巩固第 3.5 步会把短期碎片提升/删除，
        #     顺序反了情景档就没原料了（设计文档 4.1）。
        #   失败不影响下面任何一步。
        run_episode_aggregation(stats, current_ts, active_list, cold_list)

        # 第0.5步：情景档活跃容量控制。
        # 临时主题共桶；每会话每日上限由 EPISODE_ACTIVE_PER_DAY 配置。
        # 超额或超过保留期的完整档案迁入冷存，保留 source_turns。
        # 先保存冷存，再保存活跃库；归档来源仍参与碎片归属校验。
        try:
            from episode_store import cleanup_episodes as _clean_eps
            _eps_all = [m for m in active_list
                        if getattr(m, "mem_type", "") == "episode"]
            if _eps_all:
                _eps_count = len(_eps_all)
                _cr = _clean_eps(_eps_all, now=current_ts, apply=True)
                _moved = len(_cr.get("would_move") or [])
                stats["episodes_cleaned"] = _moved
                stats["episodes_archived"] = _moved
                stats["episode_archive_ids"] = [e.mem_id for e in (_cr.get("would_move") or [])]
                stats["episodes_buckets"] = len(_cr.get("buckets") or {})
                if _moved:
                    # Preserve the complete archive, including source references.
                    for _ep in _cr["would_move"]:
                        _ep.archive_reason = "episode_retention"
                        if not any(m.mem_id == _ep.mem_id for m in cold_list):
                            cold_list.append(_ep)
                    _move_ids = {id(e) for e in (_cr.get("would_move") or [])}
                    active_list[:] = [m for m in active_list
                                      if id(m) not in _move_ids]
                    print("[episode] 归档计划 | 活跃档 %d → %d（完整转入冷库 %d 条，%d 个桶超阈值）"
                          % (_eps_count, _eps_count - _moved,
                             _moved, _cr.get("over_threshold", 0)))
        except Exception as _ce:
            stats["episodes_clean_error"] = "%s: %s" % (type(_ce).__name__, _ce)
            print("[episode] ⚠️ 档清理失败（不影响后续）: %s" % _ce)

        # 1. 筛选达标记忆写入长时库
        # 2026-11-06「边缘记忆」改造：不再用「≥60 才进」的硬门槛（原来 59 分直接丢，太粗暴）。
        # 改成按巩固分数分档，全部进（只有 <20 的纯噪音才丢）：
        #   ≥60  → level 3（慢衰减，核心）
        #   40~59 → level 2（中衰减）
        #   20~39 → level 1（快衰减 = 边缘记忆，能想起但很快淡出）
        #   <20  → 丢弃（纯噪音）
        # 这样「短期记忆直接进边缘层，靠 level 决定遗忘速度」，而不是二选一。
        _working_done_ids = set()
        for new_mem in working_list:
            # 已确认进入长期库的内容不再重复巩固；来源仍留在工作台直到过期/淘汰。
            if "_已巩固" in (new_mem.tags or []):
                _working_done_ids.add(new_mem.mem_id)
                continue
            score = _calc_consolidation_score(new_mem)
            # 2026-11-08 修（巡检第九轮发现）：原来这里是字面量 20，
            #   跟 config.TRIAGE_L1_MIN / COLD_STORAGE_THRESHOLD 同值但各自独立。
            #   更要紧的是紧邻的 if/elif 链半个读常量、半个写字面量 ——
            #   改 config 会静默错位且不报错。
            if score < TRIAGE_L1_MIN:
                stats["expired_cleared"] += 1   # 纯噪音，直接不写
                continue
            # 分数 → 巩固等级（决定衰减速度） + 初始强度（决定当前清晰度）
            # 2026-11-08 修（巡检第七轮发现）：这里原来硬编码 60，
            #   而第 12 行已经从 config import 了 CONSOLIDATION_SCORE_THRESHOLD
            #   —— import 了却不用，改 config 不会生效，也不报错。
            if score >= CONSOLIDATION_SCORE_THRESHOLD:
                level, init_strength = 3, 80.0
            elif score >= TRIAGE_L2_MIN:
                level, init_strength = 2, 55.0
            else:
                level, init_strength = 1, 35.0
            dup_idx = _find_duplicate(new_mem, active_list)
            if dup_idx >= 0:
                exist_mem = active_list[dup_idx]
                exist_mem.strength = min(100.0, exist_mem.strength + 15)
                exist_mem.last_active = current_ts
                exist_mem.tags = list(set(exist_mem.tags + new_mem.tags))
                stats["updated"] += 1
            else:
                new_mem.mem_type = "long_term"
                new_mem.strength = init_strength
                new_mem.consolidation_level = level
                new_mem.last_active = current_ts
                # ★ 2026-11-11 修：写入长期库时必须补上 category 字段。
                #
                #   问题：原来这里**从来没写过 category**，于是凡是从
                #   bridge_auto 走巩固进库的内容，category 全是空的。
                #
                #   实测（483 条长期库）：
                #     category 空: 310 条（64%）
                #     其中分类器判成 commitment/date/fact 的有 168 条
                #     → 这些真正重要的内容，跟普通 long_term 一样对待，
                #       查「有多少承诺」永远是 0，也无法按类别保护。
                #
                #   为什么只有 legacy 迁移和 manual_remember 有 category：
                #     那两条路径手写了这个字段，巩固这条忘了写。
                #
                #   修法：这里用 classify_importance 判一次，写进 category。
                #     · 已经有 category 的（manual/legacy 进来的）不覆盖
                #     · 判成 event/misc/speech 也照实写，不假装重要
                if not (getattr(new_mem, "category", "") or "").strip():
                    try:
                        from schema import classify_importance as _cls
                        _cat, _ = _cls(
                            str(getattr(new_mem, "content", "") or ""),
                            str(getattr(new_mem, "source", "") or ""))
                        if _cat and _cat not in ("empty",):
                            new_mem.category = _cat
                    except Exception:
                        # 判不了就留空，不阻断写入
                        pass
                active_list.append(new_mem)
                stats["consolidated"] += 1
            # 去重更新也算已处理；标记只控制生命周期，不改变记忆语义。
            _working_done_ids.add(new_mem.mem_id)

        # ── 2026-11-10 提级方案（T3）：处理待巩固队列 ─────────────────
        #
        #   背景：工作记忆挤掉承诺类时，短期层拒收它（classify 挡住），
        #   它被写进 state/pending_longterm.jsonl 等这里重新判定。
        #
        #   为什么在这里重新 classify：
        #     写入时的分类准确率只有 50-60%（见 pending_longterm.py 注释），
        #     直接照写会导致误判固化进长期库。
        #     这里重新跑一次 classify_importance：
        #       · 两次一致 → 按正常流程打分进长期库
        #       · 两次不一致 → 说明写入时是误判，降级当普通内容（走 40 分 L2）
        #
        #   为什么放在 working 处理之后：
        #     先处理 working（每日必走的正常通道），再补 pending，
        #     pending 里的内容跟 working 一样走「打分 → 分级 → 去重」。
        #
        #   失败绝不影响巩固主体 —— 队列读失败最多等于这批承诺类暂缓一天。
        try:
            import pending_longterm as _pl
            from schema import classify_importance as _cls_imp, MemoryItem as _MI
            from candidate_pool import adjudicate_candidates
            stats["candidate_decisions"] = adjudicate_candidates()
            _pending_rows = _pl.claim_pending()
            _pending_claimed = list(_pending_rows)
            stats["pending_seen"] = len(_pending_rows)
            _pending_promoted = 0
            _pending_demoted = 0
            _pending_receipts = active_data.setdefault('_operation_receipts', {})
            for _p in _pending_rows:
                _receipt_key = 'pending:' + str(_p.get('pending_id'))
                if _receipt_key in _pending_receipts:
                    continue
                _pending_receipts[_receipt_key] = {
                    'candidate_id': _p.get('origin_candidate_id'), 'state':'rejected',
                    'mem_ids':[], 'at':current_ts}
                _p_content = str(_p.get("content") or "").strip()
                if not _p_content:
                    continue
                # 重新分类（关键：不照抄写入时的 category）
                _recat, _ = _cls_imp(
                    _p_content,
                    str(_p.get("source") or "auto"))
                # 构造一个 MemoryItem，打上分类对应的 level/strength
                _pm = _MI(
                    _p_content,
                    mem_type="working",
                    tags=list(_p.get("tags") or ["对话"]),
                    source=str(_p.get("source") or "auto"),
                    chunk_priority=int(_p.get("chunk_priority") or 5),
                    session_id=_p.get("session_id"),
                    create_time=_p.get("create_time"),
                )
                _score = _calc_consolidation_score(_pm)
                if _p.get("reason") == "shortterm_capacity" and _p.get("memory"):
                    _pm = _MI.from_dict(_p["memory"])
                    from schema import is_recallable
                    if not is_recallable(_pm.content, _pm.source):
                        _pending_demoted += 1
                        continue
                    _score = _calc_consolidation_score(_pm)
                    # Capacity evictions are real source records, not uncertain
                    # classifications. Preserve them through ordinary triage.
                    level = 3 if _score >= CONSOLIDATION_SCORE_THRESHOLD else 2 if _score >= TRIAGE_L2_MIN else 1
                    init_strength = {3: 80.0, 2: 55.0, 1: 35.0}[level]
                    _pending_promoted += 1
                elif _recat in ("commitment", "date", "fact"):
                    # 两次一致 → 重要内容，按高等级进长期库
                    # 分数可能只有 40（bridge_auto 默认），但 category 本身够重，
                    # 这里提到 L3 起步，保证承诺类不跟闲聊同寿命。
                    level, init_strength = 3, 80.0
                    _pending_promoted += 1
                else:
                    # ★ 2026-11-11 修（重要）：重判后不是承诺/日期/事实的，
                    #   **直接丢弃，不再写进长期库**。
                    #
                    #   为什么：写入时被短期层拒收，是因为当时 classify 判它
                    #   是 commitment/date/fact。但重判后发现它其实是 event
                    #   （普通对话流水）—— 比如「用户指挥我修系统」的元对话，
                    #   里面出现「12:44」「必须写」「不许跑」被误判成重要。
                    #
                    #   原来这里的 else 分支会按打分把它写进长期库 L2/L3，
                    #   导致元对话流水污染长期库（实测 pending 17 条全是这类）。
                    #
                    #   正确的语义：pending 是「承诺类暂存区」，重判后确认
                    #   **不是**承诺类，说明当时是误判 —— 这条本来就不该进
                    #   任何长期库，直接丢（它要真是普通对话，应该已经在
                    #   短期层/window 里，不欠它这一次）。
                    _pending_demoted += 1
                    # 不 continue 的话会往下走 _find_duplicate 把它塞进 active_list，
                    # 所以这里必须 continue 跳过写入。
                    stats["pending_dropped"] = stats.get("pending_dropped", 0) + 1
                    continue

                _dup_idx = _find_duplicate(_pm, active_list)
                if _dup_idx >= 0:
                    _exist = active_list[_dup_idx]
                    _pending_receipts[_receipt_key].update(state='merged', mem_ids=[_exist.mem_id])
                    _exist.strength = min(100.0, _exist.strength + 15)
                    _exist.last_active = current_ts
                    stats["updated"] += 1
                else:
                    _pm.mem_type = "long_term"
                    _pm.strength = init_strength
                    _pm.consolidation_level = level
                    _pm.last_active = current_ts
                    # ★ 2026-11-11 修：同 working 那条，必须补 category。
                    #   pending 里进来的都是被短期层拒收的承诺类，
                    #   能走到这里说明 _recat 就是 commitment/date/fact
                    #   （不是的已经在上面 continue 丢掉了）。
                    if _recat and not (getattr(_pm, "category", "") or "").strip():
                        _pm.category = _recat
                    active_list.append(_pm)
                    _pending_receipts[_receipt_key].update(state='committed', mem_ids=[_pm.mem_id])
                    stats["consolidated"] += 1
            stats["pending_promoted"] = _pending_promoted
            stats["pending_demoted"] = _pending_demoted
            # 此处只完成内存处理；不能在长期库落盘前删队列。
            # 去重合并/主动丢弃都等 active 文件确认写入后一起提交。
            if _pending_rows:
                print(f"[consolidate] pending 处理 {len(_pending_rows)} 条 | "
                      f"两次一致提升 {_pending_promoted} | 误判降级 {_pending_demoted}")
        except Exception as _pe:
            # A partially processed batch must remain retryable. Never commit
            # unseen records merely because the active-file save later succeeds.
            if _pending_claimed:
                _pl.release_pending(_pending_claimed)
                _pending_claimed = []
            stats["pending_error"] = f"{type(_pe).__name__}: {_pe}"
            print(f"[consolidate] ⚠️ pending 处理失败（不影响巩固）: {_pe}")

        # 2. 长时记忆衰减巡检 + 冷热迁移
        #
        # FIX-1107-EMBED-HEAL（2026-11-07）：顺手补空向量。
        #   实测发现 mem_1793961395093_0047（"今天用户说要吃火锅"）写入时
        #   ollama 恰好不可用，embedding 留空 —— 而**没有任何机制会去补它**。
        #   后果：这条记忆永远参与不了向量去重、召回、联想（相似度恒 0），
        #   等于占着位置但完全失效，还污染"向量完整"检查。
        #   这里在每日巡检时顺手补上（只补空/全零的，正常向量不动）。
        #
        # ⚠️ 2026-11-08 修（重大）：这里原来调 calculate_current_strength(mem, current_ts)
        #   那个函数**有副作用** —— 最后两行是
        #       memory_item.strength = round(current_strength, 2)
        #       memory_item.last_active = current_timestamp
        #   于是「遍历全库做巡检」变成了「把全库的 last_active 刷成现在」。
        #
        #   连锁后果（实测 204/238 条中招，173 条挤在同一分钟）：
        #     · last_active 从「最后一次被想起」变成「最后一次跑巩固」
        #     · strength 永远不衰减（衰减按 last_active 算天数，天数恒 0）
        #     · 冷存永远 0 条（strength 永远 >= 20）
        #     · should_drop 永远 False（同上）
        #     · 库只涨不降
        #
        #   修法：巡检用 peek_strength 算强度（纯函数，不碰 last_active），
        #        但**算出来的强度要写回 mem.strength** ——
        #        因为后面的 should_drop / is_cold_storage 读的是 mem.strength，
        #        不写回就等于没衰减（实测：a2 算出 6.0，判冷存时读的却还是 25.0）。
        #
        #        ⚠️ 区别就在这：
        #          strength    → 要写回（它反映「现在还剩多少」，衰减必须落地）
        #          last_active → 不写回（它反映「最后一次被想起」，巡检不算「想起」）
        remain_active = []
        for mem in active_list:
            # 算当前强度，只写回 strength，不碰 last_active
            _cur_strength = peek_strength(mem, current_ts)
            mem.strength = round(float(_cur_strength), 2)
            # 本次已完成结算；推进独立锚点，避免下次重复扣除同一时间段。
            mem.strength_at = current_ts
            # ★ 2026-11-10 第二步：另外两条轨**各自独立结算、各自独立推进游标**。
            #
            #   ⚠️ 绝不能合并成一次结算：
            #     · 印象轨速率 0.25/天，细节轨 2~8/天，用同一个 Δt 算没问题，
            #       但**游标必须分开推进** —— 否则某次只结算一条轨时，
            #       另一条轨的时间段会被吞掉（S01 就是被"顺手刷新"害的）。
            #     · 两条轨写的是不同字段：strength/strength_at vs
            #       impression_strength/impression_at。互不交叉。
            #
            #   为什么在这里（巩固里）做而不是在召回路径做：
            #     召回路径只碰 Top-K，全库 372 条里大部分一年才轮一次。
            #     巩固是每天一次的全库结算，是唯一能保证"每条都被结算"的地方。
            #
            #   ★ 关键：这里**不再拿锁**。_consolidate_locked() 全程持有
            #     memory_data.lock，下面只做纯内存计算 + 直接改对象字段，
            #     绝不调 save_* / memory_lock()（否则 RuntimeError: Deadlock）。
            try:
                peek_imp = peek_impression(mem, current_ts)
                if getattr(mem, "impression_strength", 0.0):
                    # 有印象层 → 落地印象衰减
                    mem.impression_strength = round(float(peek_imp), 2)
                    mem.impression_at = current_ts
            except Exception as _ie:
                stats["impression_error"] = "%s: %s" % (type(_ie).__name__, _ie)
            try:
                if getattr(mem, "current_intensity", None) is not None:
                    _res = peek_emotion_residue(mem, current_ts)
                    mem.current_intensity = round(float(_res), 2)
                    mem.emotion_at = current_ts
            except Exception as _ee:
                stats["emotion_residue_error"] = "%s: %s" % (type(_ee).__name__, _ee)
            # 补空向量（失败就算了，下次再试，不能因为补向量卡住巩固）
            emb = getattr(mem, "embedding", None)
            if (not emb) or (not any(x != 0 for x in emb)):
                try:
                    if _embed_func is not None and (mem.content or "").strip():
                        vec = _embed_func(mem.content)
                        if vec and any(x != 0 for x in vec):
                            mem.embedding = vec
                            stats["embed_healed"] = stats.get("embed_healed", 0) + 1
                except Exception as _e:
                    note_silent_error('补空向量', _e)
            # 2026-11-07：先判「该不该彻底删」（空内容 / importance<0.20 的真噪音），
            #   再判「该不该进冷存档案」。顺序不能反 ——
            #   空内容是 bug，不该占档案位。
            if should_drop(mem):
                stats["dropped_noise"] = stats.get("dropped_noise", 0) + 1
                continue
            if should_archive(mem, current_ts):
                mem.archived_at = current_ts
                mem.archive_reason = "inactive_%gd" % float(COLD_ARCHIVE_AFTER_DAYS)
                cold_list.append(mem)
                stats["moved_to_cold"] += 1
                # ★ 2026-11-11 加：记录「为什么归档」，便于事后核查
                if len(stats.setdefault("_archived_samples", [])) < 5:
                    stats["_archived_samples"].append({
                        "mem_id": mem.mem_id,
                        "days": round(float(__import__("decay_logic").inactive_days(mem, current_ts)), 1),
                        "importance": float(getattr(mem, "importance", 0) or 0),
                        "content": str(getattr(mem, "content", "") or "")[:40],
                    })
            else:
                remain_active.append(mem)
                # ★ 2026-11-11 加（可观测性）：记录「最老的未召回天数」。
                #
                #   为什么需要：冷存一直是 0 条，但日志里只有「冷迁=0」——
                #   看不出是「没到 180 天门槛」还是「判据坏了」。
                #   实测（11-11）：全库最老才 3.34 天，还差 176.7 天，
                #   机制完全正常，只是没到时间。但光看日志看不出来。
                #
                #   现在每次巩固都会记下最老的那条，一眼能看出：
                #     「最老 3.3 天 / 门槛 180 天（还差 176.7 天）」← 正常
                #     「最老 200 天但冷迁=0」                        ← 判据坏了
                try:
                    import decay_logic as _dl
                    _d = float(_dl.inactive_days(mem, current_ts))
                    if _d > stats.get("_oldest_inactive", 0.0):
                        stats["_oldest_inactive"] = _d
                        stats["_oldest_inactive_mem"] = str(getattr(mem, "content", "") or "")[:40]
                except Exception:
                    pass

        # 2.5 冷存反向巡检：按同一个未召回策略检查旧档案。
        #   被明确保护的旧冷存记忆走统一唤醒转换，而不是任意把强度改成 35。
        rescue = []
        keep_cold = []
        for m in cold_list:
            if (getattr(m, "archive_reason", "") in ("episode_retention", "historical_recovery")):
                keep_cold.append(m)
                continue
            if should_drop(m):
                stats["dropped_noise"] = stats.get("dropped_noise", 0) + 1
                continue
            if should_archive(m, current_ts):
                keep_cold.append(m)
            else:
                rescue.append(_awake_cold_memory(m, current_ts))
                stats["rescued_from_cold"] = stats.get("rescued_from_cold", 0) + 1
        cold_list = keep_cold
        remain_active.extend(rescue)

        # 3. 按会话清理过期工作记忆；已巩固项先标记，淘汰时不再降级。
        new_sessions_dict = {}
        for sess_id, sess_info in sessions_dict.items():
            valid_working = []
            for d in sess_info.get("working_memory", []):
                mem = MemoryItem.from_dict(d)
                if mem.mem_id in _working_done_ids and "_已巩固" not in (mem.tags or []):
                    mem.tags = list(mem.tags or []) + ["_已巩固"]
                if current_ts - mem.create_time <= mem.ttl:
                    valid_working.append(mem.to_dict())
                else:
                    stats["expired_cleared"] += 1
            sess_info["working_memory"] = valid_working
            new_sessions_dict[sess_id] = sess_info
        working_data["sessions"] = new_sessions_dict

        # 3.5 短期记忆层体检（2026-11-07 新增）
        #
        #   背景：短期记忆是 3 天平方衰减，强度掉到 30 以下就不再被召回。
        #   但原来**没有任何一步**在它到期前把「聊得重要但没被提起」的内容捞出来 ——
        #   3 天后就无声无息没了（数据还在文件里，但永远召回不到）。
        #
        #   现在每天 06:10 巩固时顺便体检：
        #     · 强度 >= FORGET 阈值      → 留着（还很新鲜）
        #     · 强度 < 阈值 且 是重要形态 → 提升强度后并入长期库（不丢）
        #     · 强度 < 阈值 且 是噪音形态 → 直接删（该忘就忘）
        #
        #   判定用 classify_importance 的**分类**，不看字数 ——
        #   「他不吃香菜」只有 6 个字但属于 about_him，按字数会被误杀。
        from schema import classify_importance as _classify
        from decay_logic import calculate_shortterm_strength as _st_strength
        from config import SHORT_TERM_PATH as _ST_PATH, SHORT_TERM_FORGET_THRESHOLD as _ST_FORGET
        # 2026-11-07（与 评审 对齐）：按分类分档，**字数完全不参与**。
        #   「他不吃香菜」只有 6 个字但属于 about_him，按字数会被误杀；
        #   一段 200 字的吐槽反而是低价值流水。字数跟重要性是两个维度。
        #
        #   分档依据（巩固等级 → 衰减速率 / 地板）：
        #     L3 核心：commitment / date / fact  → 衰减 2/天，地板 35（几乎不忘）
        #     L2 中层：event / about_him / tool / manual → 衰减 5/天，地板 15
        #     不进长期：speech / misc / empty → 删（该忘就忘）
        KEEP_CATS_L3 = {"commitment", "date", "fact"}
        KEEP_CATS_L2 = {"event", "about_him", "tool", "manual"}
        # 当前库里真实存在的情景档 id（给下面判「孤儿标记」用）
        _active_ids = {m.mem_id for m in remain_active} | {m.mem_id for m in cold_list}
        st_data = _load_json(_ST_PATH) if os.path.exists(_ST_PATH) else {"memories": []}
        st_keep = []
        st_aggregated_kept = []   # 已被情景档聚合的碎片（原样留着）
        st_promoted = 0
        st_dropped = 0

        # ═══ 第 2 步前置：成功的工具卡 → 长期库（2026-11-16 加）═══
        #
        #   为什么单独做这一步（实测依据）：
        #     工具卡是「她实际做了什么」的唯一记录，格式已经很有用：
        #       [工具] report_writer [操作] 导出报告 [状态] succeeded
        #       [产物] 报告已保存为 report.txt
        #              格式: 文本 页数: 3
        #     拿这行字喂给蒸馏，能直接提炼出完整的 skill
        #     （实测：工具名/参数/结果都对，required_tools 也合法）。
        #
        #     但它原来是普通短期记忆，3 天窗口一到就被清掉。
        #     而蒸馏间隔算下来正好 3 天 —— 晚一天跑，这次的「做法」就永远丢了。
        #
        #   做法：
        #     · 只提升 status == 'succeeded' 的（失败的没有做法可学）
        #     · 按「工具名 + 动作」去重，同一种做法只留最近 N 条
        #       （同一次出图跑 5 遍不该在长期库留 5 条）
        #     · 提升后分类记成 'procedure'，蒸馏靠这个识别「这是做法」
        #     · 已经在长期库里的同 key 记录，只更新最后时间，不重复插入
        _tool_promoted = 0
        _tool_skipped = 0
        if getattr(config, "TOOL_CARD_PROMOTE_ENABLED", True):
            try:
                from collections import defaultdict as _dd
                _keep_per = int(getattr(config, "TOOL_CARD_PROMOTE_KEEP_PER_ACTION", 1))
                _proc_cat = getattr(config, "TOOL_CARD_PROMOTE_CATEGORY", "procedure")

                # 收集候选：成功的工具卡
                _cands = []
                for d in st_data.get("memories", []):
                    if str(d.get("source") or "") != "tool_result":
                        continue
                    tr = d.get("tool_result") or {}
                    if str(tr.get("status") or d.get("status") or "") != "succeeded":
                        continue
                    if not str(d.get("content") or "").strip():
                        continue
                    _tool = str(tr.get("tool") or "")
                    _act = str(tr.get("action") or "")
                    # 没有结构化字段的老卡片，从文本里恢复工具名与动作名
                    if not _tool or not _act:
                        import re as _re
                        if not _tool:
                            _m = _re.search(r"\[工具\]\s*([a-z_][a-z0-9_]*)", str(d.get("content")))
                            _tool = _m.group(1) if _m else ""
                        if not _act:
                            _ma = _re.search(r"\[操作\]\s*([^\[\n]+)", str(d.get("content")))
                            _act = _ma.group(1).strip() if _ma else ""
                    if not _tool:
                        continue
                    _cands.append((d, _tool, _act))

                if _cands:
                    import re as _re2
                    def _extract_proc_key(obj):
                        tr_obj = getattr(obj, "tool_result", None) if not isinstance(obj, dict) else obj.get("tool_result")
                        tr_obj = tr_obj if isinstance(tr_obj, dict) else {}
                        t_val = str(tr_obj.get("tool") or "")
                        a_val = str(tr_obj.get("action") or "")
                        txt = str((obj.get("content") if isinstance(obj, dict) else getattr(obj, "content", "")) or "")
                        if not t_val:
                            m1 = _re2.search(r"\[工具\]\s*([a-z_][a-z0-9_]*)", txt)
                            t_val = m1.group(1) if m1 else ""
                        if not a_val:
                            m2 = _re2.search(r"\[操作\]\s*([^\[\n]+)", txt)
                            a_val = m2.group(1).strip() if m2 else ""
                        return (t_val, a_val) if t_val else None

                    # 按工具+动作分组，每组保留最新的 N 条
                    _groups = _dd(list)
                    for item in _cands:
                        _groups[(item[1], item[2])].append(item)
                    _picked = []
                    for _k, _items in _groups.items():
                        _items.sort(key=lambda x: float(x[0].get("create_time") or 0), reverse=True)
                        _picked.extend(_items[:_keep_per])
                        _tool_skipped += max(0, len(_items) - _keep_per)

                    # 已在长期库里的同 key 记录（避免重复插入，命中时刷新已有卡片的 last_active）
                    _existing_by_key = {}
                    _existing_ids = set()
                    for _r in remain_active:
                        _existing_ids.add(str(getattr(_r, "mem_id", "") or ""))
                        if str(getattr(_r, "category", "") or "") == _proc_cat:
                            _rk = _extract_proc_key(_r)
                            if _rk:
                                _existing_by_key[_rk] = _r

                    for _d, _tool, _act in _picked:
                        try:
                            _sm = MemoryItem.from_dict(_d)
                        except Exception:
                            continue
                        # 去重：同 mem_id 或同 (tool, action) 已经存在时，只刷新已有卡片时间并跳过
                        _k = (_tool, _act)
                        _ex = _existing_by_key.get(_k)
                        if str(_sm.mem_id or "") in _existing_ids or _ex is not None:
                            if _ex is not None:
                                try:
                                    _ex.last_active = max(
                                        float(getattr(_ex, "last_active", 0) or 0),
                                        float(_sm.create_time or current_ts),
                                    )
                                except Exception:
                                    pass
                            _tool_skipped += 1
                            continue
                        _sm.mem_type = "long_term"
                        _sm.category = _proc_cat
                        _sm.strength = max(46.0, min(100.0, float(_sm.strength or 60.0)))
                        _sm.last_active = current_ts
                        _sm.consolidation_level = max(int(_sm.consolidation_level or 2), 2)
                        if "工具卡提升" not in (_sm.tags or []):
                            _sm.tags = list(_sm.tags or []) + ["工具卡提升"]
                        remain_active.append(_sm)
                        _existing_ids.add(str(_sm.mem_id or ""))
                        _existing_by_key[_k] = _sm
                        _tool_promoted += 1
            except Exception as _e:
                stats["tool_card_promote_error"] = type(_e).__name__
        stats["tool_card_promoted"] = _tool_promoted
        stats["tool_card_skipped"] = _tool_skipped

        for d in st_data.get("memories", []):
            if d.get("mem_type") in ("superseded", "unavailable"):
                continue
            try:
                sm = MemoryItem.from_dict(d)
            except Exception:
                continue
            # 2026-11-08：已经被情景档吃掉的碎片，不再走「升级到长期 / 删除」。
            #   理由：它的事件已经被聚合成一条情景档了，再单独提升一次
            #   就是同一件事在库里存两遍（碎片 + 情景档）。
            #   碎片只保留到短期窗口结束；情景档及 source_turns 引用继续保留。
            #
            #   ★ 反向检查（纵深防御）：_run_episode_aggregation 开头已经清过一遍孤儿，
            #     这里再判一次「那个档真的在库里吗」。
            #     单向标记必须配反向检查 —— 这个项目已经因为单向逻辑踩过两次坑
            #     （冷存单向迁移、strength=0 单向修复）。
            #     万一档没了（陈旧快照覆盖 / 手动删档），碎片必须能回到正常巩固流程，
            #     否则就是「既没被巩固、也没档接管」，3 天后静默消失。
            _eid = getattr(sm, "episode_id", None)
            if _eid:
                if _eid in _active_ids:
                    # 已聚合只是「不再单独转长期」，不代表永久免清理。
                    cur = _st_strength(sm, current_ts)
                    if cur >= _ST_FORGET:
                        st_aggregated_kept.append(sm.to_dict())
                    else:
                        st_dropped += 1
                        stats["shortterm_aggregated_expired"] = (
                            stats.get("shortterm_aggregated_expired", 0) + 1)
                    continue
                sm.episode_id = None
                sm.episode_at = None
                stats["episodes_orphan_healed"] = stats.get("episodes_orphan_healed", 0) + 1
                # 不 continue —— 往下走正常的 promoted/dropped 判定
            cur = _st_strength(sm, current_ts)
            if cur >= _ST_FORGET:
                st_keep.append(sm.to_dict())
                continue
            # 到期了：看它是什么形态（不看字数）
            cat, _imp = _classify(sm.content or "", sm.source or "")
            if cat in KEEP_CATS_L3 or cat in KEEP_CATS_L2:
                target_level = 3 if cat in KEEP_CATS_L3 else 2
                sm.mem_type = "long_term"
                # 强度抬到对应档位的可用水平（L3 高一些，因为它衰减慢、地板高）
                sm.strength = max(70.0 if target_level == 3 else 46.0,
                                  min(100.0, sm.strength))
                sm.last_active = current_ts
                sm.consolidation_level = max(int(sm.consolidation_level or 2), target_level)
                if "短期转长期" not in (sm.tags or []):
                    sm.tags = list(sm.tags or []) + ["短期转长期"]
                remain_active.append(sm)
                st_promoted += 1
            else:
                st_dropped += 1
        # 未到期的写回文件；到期已处理的（promoted 去了长期库 / dropped 丢弃）不再保留。
        # 已聚合碎片到期后从短期池移除；档的 source_turns 保留为历史来源引用。
        _excluded_st_rows = [d for d in st_data.get("memories", [])
                             if d.get("mem_type") in ("superseded", "unavailable")]
        from services.evidence_store import preserve as preserve_evidence
        _retained_st_ids = {r.get('mem_id') for r in st_keep + st_aggregated_kept + _excluded_st_rows}
        preserve_evidence([r for r in st_data.get('memories', [])
                           if r.get('mem_id') not in _retained_st_ids])
        _save_json(_ST_PATH, {"memories": st_keep + st_aggregated_kept + _excluded_st_rows})
        stats["shortterm_promoted"] = st_promoted
        stats["shortterm_dropped"] = st_dropped
        stats["shortterm_kept"] = len(st_keep) + len(st_aggregated_kept)

        # 6. 经验提炼 + 7. 反思（2026-11-08 T16/T17）
        #   两个都「只写不读」：写进活跃库，但不参与召回
        #   （MemoryManager._load_active_mems 会把 lesson / reflection 滤掉，见那边注释）。
        #   放在写盘之前，所以它们也走了一遍上面的巡检 —— 无害：
        #   strength=100 / importance>=0.70 不会被判冷存或丢弃。
        remain_active = run_lessons(stats, remain_active, current_ts)
        remain_active = run_reflection(stats, remain_active, current_ts)

        # 4. 回写本系统文件
        #   写盘前最后收敛一次：每个 ID 在一个库里至多一份，且不能跨库重复。
        _before_final_dedupe = len(remain_active) + len(cold_list)
        remain_active = _dedupe_by_id(remain_active)
        _final_active_ids = {m.mem_id for m in remain_active if m.mem_id}
        cold_list = _dedupe_by_id([
            m for m in cold_list if not m.mem_id or m.mem_id not in _final_active_ids])
        stats["deduplicated_ids"] = stats.get("deduplicated_ids", 0) + (
            _before_final_dedupe - len(remain_active) - len(cold_list))

        # 被排除记录保留原貌供审计，但不进入 remain_active 的衰减/迁移/复活流程。
        _excluded_active_rows = [d for d in active_data.get("memories", [])
                                 if d.get("mem_type") in ("superseded", "unavailable")]
        active_data["memories"] = [m.to_dict() for m in remain_active] + _excluded_active_rows
        cold_data["memories"] = [m.to_dict() for m in cold_list]
        _save_json(WORKING_MEM_PATH, working_data)
        # Save the destination before removing records from the source.
        _save_json(LONG_TERM_COLD_PATH, cold_data)
        _save_json(LONG_TERM_ACTIVE_PATH, active_data)

        # 先让长期库成为事实，再移除已处理的 pending。
        # 如果这里失败，异常会继续向上抛，由入口释放而不是丢队列。
        if _pending_claimed:
            import pending_longterm as _pl
            _pl.commit_pending(_pending_claimed)
            _pending_committed = True
            # Candidate acknowledgement is recoverable from the pool receipt.
            try:
                from candidate_pool import adjudicate_candidates
                adjudicate_candidates(limit=0)
            except Exception as ack_error:
                stats['candidate_ack_error'] = str(ack_error)
            stats["pending_committed"] = len(_pending_claimed)
        else:
            stats["pending_committed"] = 0

        # ★ 2026-11-09 加：落盘后回读验证（方案 P1-1）
        #
        #   为什么必须回读：
        #     `_save_json` 返回不代表写成功 —— 它内部 catch 了异常。
        #     今天踩过「巩固没跑却报 ok」（靠 18 倍时间差才发现）
        #     和「fsync 失败当成功」（写完了但没落盘）。
        #     日志只记「我保存了 N 条」，救不了这些。回读能。
        #
        #   怎么做：
        #     写盘前记下 active_data 里的全部 episode id，
        #     写盘后从磁盘重新读一遍，比对：
        #       · 磁盘上的档数 == 写盘前的档数  → OK
        #       · 少了 → 报出来（真正落盘失败的证据）
        #
        #   ⚠️ 第一版用了 `new_eps` 这个变量 —— 它根本不存在（我编的），
        #      导致验证等于没做。现在改成从 active_data 实时算。
        try:
            _want_ids = {str(m.get("mem_id"))
                         for m in active_data.get("memories", [])
                         if m.get("mem_type") == "episode"}
            _after = _load_json(LONG_TERM_ACTIVE_PATH)
            _got_ids = {str(m.get("mem_id"))
                        for m in _after.get("memories", [])
                        if m.get("mem_type") == "episode"}
            _missing = sorted(_want_ids - _got_ids)
            stats["episodes_verify"] = {
                "want": len(_want_ids),
                "got": len(_got_ids),
                "missing": len(_missing),
            }
            if _missing:
                stats["episodes_missing_after_save"] = _missing[:10]
                print("[episode] ⚠️ 落盘后回读缺失 %d/%d 条: %s"
                      % (len(_missing), len(_want_ids), _missing[:3]))
            # 正常路径不刷屏（方案 P1 验收要求）
        except Exception as _e:
            stats["episodes_verify_error"] = "%s: %s" % (type(_e).__name__, _e)
            print("[episode] ⚠️ 落盘后回读失败: %s" % _e)

        # ═══ 第 5 步：R6 可观测性 —— 印象层体检（2026-11-10 第二步）═══
        #
        #   任务书 R6：「夜巡报告应能列出印象强但细节已淡的记忆，
        #   供人工判断是否该补记。」
        #
        #   为什么在写盘之后、且单独 try：
        #     · 它只读 remain_active / cold_list（已经是最终状态）
        #     · 它失败绝不能影响巩固本身（跟统计落盘同一个原则）
        #   ⚠️ 这里**不拿锁**（巩固全程已持有 memory_data.lock）。
        try:
            from recall_engine import impression_recall_stats as _imp_stats
            _all_after = list(remain_active) + list(cold_list)
            _rpt = _imp_stats(_all_after, current_ts)
            stats["impression_counts"] = _rpt["counts"]
            # 只留前 20 条给报告读（全量列表可能几百条，塞进 stats 没意义）
            stats["impression_faded"] = _rpt["faded"][:20]
            stats["impression_faded_total"] = len(_rpt["faded"])
        except Exception as _re:
            stats["impression_report_error"] = "%s: %s" % (type(_re).__name__, _re)

        # Report committed destinations separately from ordinary age-based moves.
        _archived_ids = set(stats.get("episode_archive_ids") or [])
        _cold_ids = {r.get("mem_id") for r in _load_json(LONG_TERM_COLD_PATH).get("memories", [])}
        stats["episodes_archived"] = len(_archived_ids & _cold_ids)
        stats["episode_archive_missing_ids"] = sorted(_archived_ids - _cold_ids)
        stats["archive_verified"] = not stats["episode_archive_missing_ids"]
        stats["moved_to_cold_total"] = stats.get("moved_to_cold", 0) + stats["episodes_archived"]
        from config import SHORT_TERM_MAX_ITEMS as _SHORT_CAP, SHORT_TERM_PATH as _SHORT_PATH
        stats["shortterm_capacity"] = int(_SHORT_CAP)
        stats["shortterm_count"] = len(_load_json(_SHORT_PATH).get("memories", []))
        try:
            from distillation import maintain as _maintain_cards
            stats["distillation_maintenance"] = {scope: _maintain_cards(scope)
                                                 for scope in ('main',)}
        except Exception as exc:
            stats["distillation_maintenance_error"] = type(exc).__name__

        # ★ 2026-11-18：巩固出口统一清理（审计日志 + 窗口缓存）
        #
        #   为什么收在这里（而不是 process_working_memory_to_long_term 那层）：
        #     · _consolidate_locked() 才是「真正跑巩固」的唯一执行体；
        #       外层那个函数还会被 maintenance_trigger.run_now() 走一遍
        #       （maintenance_trigger.py:157），挂在外面会重复清理。
        #     · 放在 stats 落盘之前 => 清理结果能写进这次巩固的统计里。
        #
        #   为什么各自单独 try：
        #     清理是维护动作，任何一步失败都不该影响巩固本身。
        #     prune() 内部已拿 state_lock("recall_audit") 跨进程锁，
        #     与 MCP 的 append 互斥；prune_cache() 走原子写。
        #
        #   为什么每天一次就够：
        #     recall_audit 保留 30 天、窗口缓存按 30 天窗口剪枝，
        #     一天一次的粒度远小于阈值，多清只是浪费 IO。
        try:
            import recall_audit as _ra
            stats["audit_pruned"] = int(_ra.prune())
        except ModuleNotFoundError:
            pass
        except Exception as exc:
            # 不抛，但必须留痕（静默失败比失败更糟）
            stats["audit_prune_error"] = "%s: %s" % (type(exc).__name__, exc)
        try:
            import window_recall as _wr
            _wc = _wr.prune_cache()
            stats["window_cache_pruned"] = int(_wc.get("removed", 0))
        except Exception as exc:
            stats["window_cache_prune_error"] = "%s: %s" % (type(exc).__name__, exc)

        # ★ 巩固结果落盘（2026-11-08 加）
        #   为什么放在最后、且单独 try：
        #     · 放在最后 → 写的是「这次巩固跑完后的最终状态」
        #     · 单独 try → 统计落盘失败绝不能影响巩固本身（它是附属产物）
        #   读者：nightly_patrol 读 episodes_integrity / episodes_integrity_error。
        try:
            from config import CONSOLIDATION_STATS_PATH as _STATS_PATH
            payload = dict(stats)
            payload["_finished_at"] = current_ts
            payload["_finished_at_str"] = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(current_ts))
            _save_json(_STATS_PATH, payload)
        except Exception as e:
            print(f"[consolidation] 统计落盘失败（不影响巩固）: {type(e).__name__}: {e}")

        return stats
    finally:
        if _pending_claimed and not _pending_committed:
            import pending_longterm as _pl
            _pl.release_pending(_pending_claimed)


def _print_dry_run() -> None:
    """只读预演：把「会做什么」打出来，一个字节都不写。

    为什么不复用 _consolidate_locked：那个函数内部有 _save_json，跑一遍必然写盘。
    这里从头读一遍数据、按同样口径数一遍，只统计不落盘。
    """
    working_data = _load_json(WORKING_MEM_PATH)
    active_data = _load_json(LONG_TERM_ACTIVE_PATH)
    cold_data = _load_json(LONG_TERM_COLD_PATH)
    st_data = _load_json(SHORT_TERM_PATH) if os.path.exists(SHORT_TERM_PATH) else {"memories": []}

    sessions = working_data.get("sessions", {})
    n_working = sum(len(s.get("working_memory", [])) for s in sessions.values())
    n_active = len(active_data.get("memories", []))
    n_cold = len(cold_data.get("memories", []))
    n_st = len(st_data.get("memories", []))
    n_eps = len([m for m in active_data.get("memories", [])
                 if m.get("mem_type") == "episode"])

    # 短期层里「还能被聚合」的原料（没打标 + 有内容）
    aggregatable = 0
    for d in st_data.get("memories", []):
        try:
            m = MemoryItem.from_dict(d)
        except Exception:
            continue
        if getattr(m, "episode_id", None):
            continue
        if (m.content or "").strip():
            aggregatable += 1

    print("=" * 60)
    print("预演模式（dry-run）：只读，不写任何文件")
    print("=" * 60)
    print("  工作记忆      : %d 条（会话 %d 个）" % (n_working, len(sessions)))
    print("  长时库        : %d 条（其中情景档 %d 条）" % (n_active, n_eps))
    print("  冷存库        : %d 条" % n_cold)
    print("  短期层        : %d 条（其中可聚合原料 %d 条）" % (n_st, aggregatable))
    print("")
    print("  第0步   情景档聚合      : 预计处理 %d 条碎片" % aggregatable)
    print("  第1步   工作记忆→长期   : 预计检查 %d 条" % n_working)
    print("  第2步   长时巡检/冷热    : 预计检查 %d 条" % n_active)
    print("  第3.5步 短期体检        : 预计检查 %d 条" % n_st)
    print("")
    print("  要真跑请加 --apply")
    print("=" * 60)


if __name__ == "__main__":
    import sys as _sys
    # ★ 2026-11-08 改（巡检 巡检抓出来的事故）：
    #   原来直接运行本文件就会真跑巩固 —— 别人只是想「跑一下看看」，
    #   结果把生产库整个重写了一遍（实测：226→234 条、删 11 条旧情景档、改 370 个字段）。
    #   「python xxx.py」不等于自检。现在改成：
    #       不带参数 / --dry-run → 预演（只读，不写一个字节）
    #       --apply              → 真跑
    if "--apply" in _sys.argv:
        res = process_working_memory_to_long_term()
    elif "--dry-run" in _sys.argv or len(_sys.argv) == 1:
        _print_dry_run()
        _sys.exit(0)
    else:
        print("用法: python daily_consolidation.py [--dry-run | --apply]")
        print("  --dry-run  只读预演（默认）")
        print("  --apply    真的执行巩固（会写 active.json 等）")
        _sys.exit(2)
    print(f"巩固完成 | 新增:{res['consolidated']} 更新:{res['updated']} 普通冷迁:{res['moved_to_cold']} 情景档归档:{res.get('episodes_archived', 0)} 过期清理:{res['expired_cleared']}")
    print(f"短期容量 | {res.get('shortterm_count', 0)}/{res.get('shortterm_capacity', 0)}")
    # 情景档单独打一行：created=0 且 error=None 是「跑了没货」，
    # error 非空才是「压根没跑成」—— 这两种必须能一眼分开。
    _ep_err = res.get("episodes_error")
    print(f"情景档    | 新建:{res.get('episodes_created', 0)}"
          + (f" | 失败: {_ep_err}" if _ep_err else " | 聚合正常"))
    # 经验 / 反思同理：created=0 且没错误 = 「跑了没凑够料」，
    # 有错误才是「压根没跑成」。两种在日志里必须长得不一样。
    _les_err = res.get("lessons_error")
    print(f"经验提炼  | 新增:{res.get('lessons_created', 0)}"
          + (f" | 未跑: {_les_err}" if _les_err else " | 正常"))
    _refl_err = res.get("reflection_error")
    print(f"反思      | 新增:{res.get('reflection_created', 0)}"
          + (f" | 未跑: {_refl_err}" if _refl_err else " | 正常"))
