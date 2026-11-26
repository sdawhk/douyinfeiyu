# -*- coding: utf-8 -*-
"""候选池 candidate_pool.py —— 判不准的先进缓冲区，不直接进主库（2026-11-08，T07）

设计依据：《记忆系统-主设计.md》5.2「候选池（candidate pool / mark 档）」。

────────────────────────────────────────────────────────────────────
它解决什么问题
────────────────────────────────────────────────────────────────────
写入前先过三档判定：

    pass   → 明确该记（「我答应你永远不离开」）→ 由调用方写主库，**不进候选池**
    mark   → 拿不准（「明天十一点」「今天好累」）→ 进候选池，攒着观察
    block  → 明确不该记（纯应答 / 广告 / 元讨论）→ 丢弃，**不进候选池**

今天实测过的问题（这条是本模块存在的直接原因）：

    技术讨论「平方衰减怎么算」
      → classify_importance 判成 event 0.65（跟真实聊天的「他说：…；我回：…」同分）
      → 会进主库

也就是说，光靠 importance 分不出「他在讲我的记忆系统」和「他在跟我说话」。
所以补一层**元讨论词表**：命中技术词就知道这段是在讨论系统本身，不是生活。

────────────────────────────────────────────────────────────────────
⚠️ 本阶段只写不读（设计 1.2 / 1.3）
────────────────────────────────────────────────────────────────────
    写入 + 统计 = 有
    参与召回    = 没有（本模块不 import recall_engine / memory_manager）

理由：裁决逻辑（mark 该不该升成主库）需要真实样本才能定准，先跑 1-2 周攒数据，
      看候选池里都是什么，再决定怎么用。**这一版不接进 add_working_memory**，
      接线是另一个对话的事。

────────────────────────────────────────────────────────────────────
数据形状（state/candidates.jsonl，一行一条，只追加）
────────────────────────────────────────────────────────────────────
    {"kind": "candidate", "id": "cand_1730xxx_a1b2", "at": 1730xxx,
     "content": "明天十一点", "content_hash": "sha1…",
     "session_id": "private:1", "gate": "mark",
     "reason": "未匹配任何规则", "confidence": 0.25,
     "status": "pending",                 ← pending / merged / rejected（裁决用，现在恒 pending）
     "category": "date", "importance": 0.92,   ← classify_importance 的判定（观察用证据）
     "scrubbed": true,                     ← 这条有没有被脱敏过（安全审计位）
     "meta": {…}}                          ← 已清洗：敏感键删除、敏感值脱敏

    {"kind": "repeat", "content_hash": "sha1…", "at": 1730xxx}
                                          ← 重复计数事件
                                            （write_candidate 写入时自动计一次，也可由 bump_repeat 手动加）

为什么重复计数也放在同一个文件：验收脚本只删 candidates.jsonl，
   计数如果另开一个文件，跑第二遍就会接着上次的数（3 → 4 → 5）而误报。
   同一个文件 → 删掉文件就真归零。

────────────────────────────────────────────────────────────────────
依赖：只 import L1/L2（config / schema / features），绝不 import memory_manager
────────────────────────────────────────────────────────────────────
本模块没有任何「读回来喂召回」的函数 —— 这是刻意的，见上面的「只写不读」。
"""

from common.locking import NullLock
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
#
# 中文 Windows 终端默认 GBK，print 中文/emoji 直接 UnicodeEncodeError 崩掉。
# 实测 link_check / test_shortterm / regression_test 在 cmd 里都这么死过。
# 放在 import 之后立刻执行，保证后面任何 print 都不会因为编码炸。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ═══════════════════════════════════════════════════════════════════
# 一、路径与开关（只 import L1/L2）
#
# 路径统一从 config 拿（设计 3.4 第③条）。config 里还没有这个键时用默认值，
# 由本模块按 BASE_DIR 推出来 —— 这样 config 加没加都能跑，
# 加了我们自动跟随（有就读、没有就用默认，跟 episode.py 的做法一致）。
# ═══════════════════════════════════════════════════════════════════
from config import BASE_DIR  # noqa: E402
from schema import classify_importance  # noqa: E402
from features import on as _feature_on  # noqa: E402

# ★ 2026-11-08 修（重启后巡检抓出来的真 bug，我自己的错）：
#
#   原来这里写的是 from config import CANDIDATE_PATH，
#   而 config 里那个键实际叫 **CANDIDATE_POOL_PATH**。
#   import 失败走了 except 分支 ⇒ 我这边一直用自己拼的
#   <BASE_DIR>/state/candidates.jsonl，而 config / 夜巡用的是另一个路径。
#   结果：候选池写一处、夜巡数另一处，夜巡永远数到 0。
#
#   更糟的是这个失败是**静默的**：except 接住 ImportError 就当"config 没配"，
#   而"名字写错"和"没配"长得一模一样 —— 又一个"两种 0 混在一起"。
#   所以现在的规矩：**config 里配了就必须用配的**，只有确实没配才回落默认。
#
#   优先级（写在代码里，不再靠运气）：
#     ① config.CANDIDATE_POOL_PATH         ← 现有名，夜巡/巡检也读它
#     ② config.CANDIDATE_PATH              ← 别名，将来若改名
#     ③ <BASE_DIR>/state/candidates.jsonl  ← 兜底默认
try:
    from config import CANDIDATE_POOL_PATH as CANDIDATE_PATH  # noqa: E402
except Exception:
    try:
        from config import CANDIDATE_PATH  # noqa: E402
    except Exception:
        # 数据文件放 state/candidates.jsonl，目录不存在时由本模块自动创建
        CANDIDATE_PATH = os.path.join(BASE_DIR, "state", "candidates.jsonl")

# ═══════════════════════════════════════════════════════════════════
# ★ 2026-11-13：把「生产那个文件」定格下来
#
#   为什么需要：测试隔离靠改 CANDIDATE_PATH（指到 tmp）。而 write_candidate
#   里的测试护栏**从来不看写去哪儿** —— 只要调用栈里出现 test_*.py 就拦。
#   结果：测试把路径改到 tmp 之后，写入照样被挡（skipped='test'），
#         于是 test_candidate_pool.py 里 18 条「验证真实写入路径」的断言全红。
#
#   实测：
#     $ python test_probe_sim.py
#     _in_test_script() = True
#     judge_candidate('明天还要早起好烦', 'private:<owner-id>') → (True, 'weak_score')
#
#   护栏的目的是「别把测试垃圾写进生产」，不是「禁止测试写文件」。
#   所以：**目标不是生产那个文件 → 不拦**。
#   这个常量在模块加载时定格，测试之后怎么改 CANDIDATE_PATH 都不影响判断。
# ═══════════════════════════════════════════════════════════════════
_PROD_CANDIDATE_PATH = os.path.abspath(CANDIDATE_PATH)


def _is_prod_path() -> bool:
    """当前 CANDIDATE_PATH 是不是生产那个文件。

    判不出来时按生产处理（保守）—— 宁可多拦，不可漏拦。
    """
    try:
        return os.path.abspath(CANDIDATE_PATH) == _PROD_CANDIDATE_PATH
    except Exception:
        return True


# 保留天数（clear_old 的默认值）
CANDIDATE_KEEP_DAYS = 14
# 同一句重复几次算「该升级看一眼」
ESCALATE_AFTER = 3
# 单条 content 上限（候选里都是一句对话，500 字已经远超实际）
CONTENT_MAX_CHARS = 500
# meta 最多留几个键（meta 是补充说明，不是第二个库）
META_MAX_KEYS = 30
META_VALUE_MAX_CHARS = 500

FEATURE_NAME = "candidate_pool"

try:
    from filelock import FileLock
except Exception:                     # 没装 filelock 也不能让整个模块 import 失败
    FileLock = None


# ═══════════════════════════════════════════════════════════════════
# 二、元讨论词表（设计 5.2 的词表原文照抄；判定规则比原文多了两道 —— 见下）
#
# 命中说明：这段话是在讨论「记忆系统/代码/部署」本身，不是在过日子。
# 实测反例（本模块的立项原因）：技术讨论「平方衰减怎么算」被
# classify_importance 判成 event 0.65，跟真实聊天同分 —— 光看 importance 分不出来。
# ═══════════════════════════════════════════════════════════════════
META_WORDS: List[str] = [
    '记忆系统', '记忆库', '记忆契约', '候选池', '窗口账本', '情境段', '情景档',
    '衰减', 'consolidation', 'importance', 'embedding', '向量', '召回', '联想链',
    'bug', '死代码', '脚本', '接口', '参数', '阈值', '函数', '模块',
    'schema', 'jsonl', 'git', 'commit', '部署', '重启',
    # ★ 2026-11-13 补（都是**弱词**，需命中 >=2 个才 block）：
    #   实测漏网的一条（短期库 148 字）在讨论「怎么区分琐事和重要的事」——
    #   整段是元讨论，但一个技术词都没命中，于是落进 pass → 直接进主库。
    #   加这 3 个后只多 block 了那一条，长期库其余 520 条一条没动。
    '加权', '尺子', '被想起',
]

# ── 强技术词：**单独出现一个就够判元讨论**（下面会解释为什么必须分强/弱）
#
# 原写法是「命中 ≥2 个才 block」。实测不够用：
#     「平方衰减怎么算」→ 只命中「衰减」1 个 → 判成 mark → 进候选池 → 还会被当真事
# 而这句在真实语境里就是一句技术提问，多一个字都不会有。
# 所以：含义唯一、日常聊天不会出现的词算「强词」，命中 1 个就 block。
#
# 剩下的算「弱词」（脚本/接口/参数/模块/部署/重启…）：这些在生活对话里也可能随口出现，
# 只命中 1 个时不够硬 —— 让它们走 mark 进缓冲区，而不是直接丢。
# 宁可漏 block（进候选池还有救），不可错 block（真事丢了找不回来）。
META_STRONG = frozenset([
    '记忆系统', '记忆库', '记忆契约', '候选池', '窗口账本', '情境段', '情景档',
    '衰减', 'consolidation', 'importance', 'embedding', '向量', '召回', '联想链',
    'bug', '死代码', 'schema', 'jsonl', 'git', 'commit',
])

# 只命中 1 个强词时，**短文本**才 block；长文本降级成 mark。
#
# 这是拿真实库（260 条）跑出来的，不是拍脑袋：
#     「平方衰减怎么算」                   7 字 → 纯技术短句，block 对
#     「今天讨论记忆系统，也约好了下一次碰面的时间」
#                                       46 字 → 一条有情感的事件记录，只是提到了「记忆系统」
#     整条被 block ＝ 一段真的发生过的事没了 —— 这正是「宁可漏 block，不可错 block」。
#
# 阈值取 40：40 字以内才可能是纯技术讨论的一句问话；
# 超过 40 字基本是叙述/记录，技术词只是顺带出现。
# 降级不丢弃 —— 进 mark 档（候选池）还有救，将来裁决还能捞回来。
META_STRONG_SOLO_MAX_CHARS = 40


def _meta_hits(text: str) -> List[str]:
    """命中了哪些元讨论词。

    中文按子串匹配；英文按词边界匹配 ——
    否则「git」会命中「legit」、「bug」会命中「debuggingg」之类的噪音。
    """
    low = str(text or "").lower()
    hits: List[str] = []
    for w in META_WORDS:
        wl = w.lower()
        if wl.isascii():
            if re.search(r"(?<![a-z])" + re.escape(wl) + r"(?![a-z])", low):
                hits.append(w)
        elif wl in low:
            hits.append(w)
    return hits


# ═══════════════════════════════════════════════════════════════════
# 三、三档门控（设计 5.2 的判据）
# ═══════════════════════════════════════════════════════════════════

# ② 明确该记的
#
# ★★ 2026-11-13 重写：从「正则子串」改成「带上下文判定」（见 strong_signal）
#
#   为什么必须改（真实库实测，不是推演）：
#     短期库 100 条里 4 条被判 pass、长期库 521 条里 36 条（6.9%）——
#     抽查发现**全是子串误命中**：
#
#       「…我也没法跟你保证关成了…」      → 命中「保证」，实际是否定
#       「…我嘴上全答应了，答得又快又顺…」 → 命中「答应」，实际是回顾
#       「…一点半别忘了…」                → 命中「别忘了」，实际是提醒
#       「…12 项里 2 项永远是绿的…」       → 命中「永远」，实际是判断句
#       「…别把住哪、生日这种一起打了…」   → 命中「生日」，实际是元讨论举例
#
#   pass 档的实际后果（memory_manager.add_working_memory）：
#     mark → 进候选池缓冲；pass → **什么都不做，直接进主库**。
#   所以误判 pass = 日常话跳过缓冲区直接污染主库，比误判 mark 严重。
#
#   保留 STRONG_PATTERNS 作为**文档与兼容**（外部若有 import），
#   实际判定走 strong_signal。
STRONG_PATTERNS: List[str] = [
    r'答应|承诺|保证|永远|一定',       # 承诺
    r'生日|纪念日',                     # 日期
    r'我(不喜欢|讨厌|害怕)',            # 明确偏好
    r'记住|别忘了',                     # 明确要求
]

# ── 上下文挡板用的三张表 ──
# 否定词：出现在关键词**前面** → 这句不是在承诺
_NEG_RE = re.compile(
    r'(?:没法|没办法|不能|不会|不敢|不用|不必|不要|不想|不曾|没有|没|未|别|不)')
# 回顾标记：出现在关键词**前面** → 在回看已经发生的事，不是新承诺
_RETRO_RE = re.compile(r'(?:以前|曾经|当时|那时候|上次|那天|已经|全|都|早)')
# 时间点：出现在「别忘了」**前后** → 是提醒，不是要记的事
_TIME_RE = re.compile(r'\d|[一二三四五六七八九十]点|半|钟|分|:')

_NEG_WINDOW = 6        # 往前看几个字算「前面的否定」
_RETRO_WINDOW = 10     # 回顾标记往前看几个字


def _negated(text: str, pos: int, window: int = _NEG_WINDOW) -> bool:
    """pos 前面 window 个字里有没有否定词。"""
    return bool(_NEG_RE.search(text[max(0, pos - window):pos]))


def _retrospective(text: str, pos: int, window: int = _RETRO_WINDOW) -> bool:
    """pos 前面 window 个字里有没有回顾标记。"""
    return bool(_RETRO_RE.search(text[max(0, pos - window):pos]))


def _find_unblocked(text: str, word: str) -> bool:
    """这个词有没有**一次**出现是「非否定、非回顾」的。

    为什么不是「找第一个」：第一个出现可能正好被否定，后面还有真的。
      例：「我嘴上全答应了…现在我答应你以后不熬夜」
          → 第一个「答应」在回顾里，第二个才是真承诺。
    """
    start = 0
    while True:
        i = text.find(word, start)
        if i < 0:
            return False
        if not _negated(text, i) and not _retrospective(text, i):
            return True
        start = i + 1


def strong_signal(text: str) -> Tuple[bool, str]:
    """「明确该记」的判定。返回 (是否命中, 原因)。

    ★ 2026-11-13 新增。每条规则都对应一个真实误判现场，注释里标了反例。
      替代原来那句 `for p in STRONG_PATTERNS: re.search(p, ts)`。
    """
    ts = str(text or '')

    # ① 承诺动词：非否定、非回顾
    #    反例：「我也没法跟你保证关成了」「我嘴上全答应了」
    for w in ('答应', '承诺', '保证', '约定', '说好了'):
        if _find_unblocked(ts, w):
            return True, f'承诺({w})'

    # ② 永远/一定 + 动词
    #    反例：「12 项里 2 项永远是绿的」（「是」后面是判断句，不是承诺）
    #
    #    ★ 2026-11-13 补：「永远不 + 动词」有两种截然相反的意思 ——
    #      「永远不离开你」  = 承诺（该记）
    #      「永远不给你」    = **拒绝**（不该记，也不该判 pass）
    #    区别只在动词。原来 `[不都会要也得想肯愿]` 一刀切，
    #    于是「他说：永远不给我；我回：因为我不愿意…」被判成承诺 → pass。
    #
    #    判据：只有后面跟「维持关系/不改状态」类动词才算承诺。
    #    这些词是**穷举**出来的，不是猜的 —— 表外的动词一律当拒绝，
    #    宁可漏判（进候选池还有救），不可错判（pass 会跳过缓冲区直进主库）。
    _FOREVER_NEVER_OK = (
        '离开', '忘', '分开', '放弃', '背叛', '消失', '变', '走',
        '骗', '瞒', '丢下', '抛下', '不管', '不理',
    )
    for w in ('永远', '一定'):
        for m in re.finditer(w, ts):
            tail = ts[m.end():m.end() + 5]
            if not tail or tail.startswith('是'):
                continue
            # 「永远不X」：X 必须在承诺白名单里
            #   ⚠️ 中间可能夹一个「会」：「永远不会忘记你」——
            #      第一版只看 tail[1:] 直接比，于是「不会忘记」比不中「忘」，
            #      真承诺被判成 mark。这里先把「不[会]」剥掉再比。
            if tail.startswith('不'):
                body = tail[1:]
                if body.startswith('会'):
                    body = body[1:]
                if body.startswith(_FOREVER_NEVER_OK):
                    return True, f'承诺({w}不{body[:2]})'
                continue          # 「永远不给你」= 拒绝，不是承诺
            if re.match(r'[都会要也得想肯愿]', tail):
                return True, f'承诺({w}{tail[0]})'

    # ③ 生日/纪念日：必须带具体日期或安排
    #    反例：「别把住哪、生日这种一起打了」（元讨论里举例）
    if re.search(r'生日\s*(?:是|在|[:：])?\s*\d{1,2}\s*月', ts):
        return True, '日期(生日+月)'
    if '的生日' in ts:
        return True, '日期(的生日)'
    if re.search(r'纪念日\s*(?:是|在|[:：])?\s*\d', ts):
        return True, '日期(纪念日)'
    # 「生日那天我给你过」—— 没写日期但是明确安排，也是该记的
    if re.search(r'生日[^。]{0,10}(?:过|祝|送)', ts):
        return True, '日期(生日安排)'

    # ④ 明确偏好
    if re.search(r'我(?:不喜欢|讨厌|害怕)', ts):
        return True, '偏好'

    # ⑤ 明确要求
    if '记住' in ts:
        return True, '要求(记住)'
    for m in re.finditer('别忘了', ts):
        # 反例：「一点半别忘了」—— 前后带时间点的是**提醒**，不是要记的事
        if (_TIME_RE.search(ts[max(0, m.start() - 10):m.start()])
                or _TIME_RE.search(ts[m.end():m.end() + 8])):
            continue
        return True, '要求(别忘了)'

    return False, ''

# ③ 明显不该记的
WEAK_PATTERNS: List[str] = [
    r'^(嗯|哦|好|对|是|知道|收到)$',      # 单字应答
    r'^\[图片\]$|^\[表情\]$',            # 纯媒体
    r'点击|链接|下载|访问',               # 广告
]

# 「转瞬」信号：只为算 confidence，不参与档位判定（档位只看上面四段规则）
_TIME_HINT = re.compile(
    r'明天|后天|昨天|今天|今晚|待会|等下|马上|下次|以后|'
    r'周[一二三四五六日天]|\d{1,2}\s*[:：点]\d{0,2}|[一二三四五六七八九十两]+\s*[点點]'
)


def gate(content: str, source: str = 'auto') -> Tuple[str, str]:
    """三档门控。返回 (档位, 原因)，档位只有 'pass' / 'mark' / 'block'。

    判据顺序（先判的优先，命中就返回）：
        0. source=人工指定 → pass（他亲口让记的，门控不推翻人的明确指令）
        1. 太短（<4 字）  → block
        2. 元讨论         → block（命中 ≥2 个技术词，或命中 1 个强技术词）
        3. 明确该记       → pass
        4. 明显不该记     → block
        5. 其余           → mark（拿不准 → 进候选池）

    为什么 0 放在 1 前面：「嗯」「好」这类他明确说「记住这个」时也该留，
        但那种情况极罕见；真正的作用是让 manual_remember 不被任何规则推翻。
        证据链简单：谁让记的 > 内容长得像什么。
    """
    t = str(content or '')

    # ── 0. 来源优先：他亲口让记的，至少是 pass（跟 schema.classify_importance 同口径）
    src = (source or '').lower()
    if 'manual_remember' in src or '她自己记' in src:
        return 'pass', '来源=人工指定'

    # ── 1. 太短
    ts = t.strip()
    if len(ts) < 4:
        return 'block', '太短'

    # ── 2. 元讨论
    hits = _meta_hits(ts)
    if len(hits) >= 2:
        return 'block', f'元讨论（命中 {hits}）'
    strong = [w for w in hits if w in META_STRONG]
    if strong:
        # 实测「平方衰减怎么算」就走这条（原规则 ≥2 个会漏掉它 → 会进主库）
        if len(ts) <= META_STRONG_SOLO_MAX_CHARS:
            return 'block', f'元讨论（强技术词命中 {strong}）'
        # 长文本只中 1 个技术词：多半是「叙述里顺带提到」，不是技术讨论 → 留档不丢
        return 'mark', f'疑似元讨论（{len(ts)} 字只中 {strong}，留档）'

    # ── 3. 明确该记的（带上下文挡板，见 strong_signal 上面那段实测说明）
    _ok, _why = strong_signal(ts)
    if _ok:
        return 'pass', _why

    # ── 4. 明显不该记的
    for p in WEAK_PATTERNS:
        if re.search(p, ts):
            return 'block', f'匹配 {p}'

    # ── 5. 拿不准 → mark
    return 'mark', '未匹配任何规则'


def confidence_of(level: str, content: str) -> float:
    """这一条「属于该记」的把握（0~1）。写进候选记录的 confidence 字段。

    pass 高、block 低、mark 在 0.4 上下浮动：
        · 含时间词（转瞬即逝）→ 减一点
        · 太短（信息太薄）    → 再减一点
    这不是装饰：将来做「裁决」时，confidence 低的先看，高的先升。
    """
    if level == 'pass':
        return 0.90
    if level == 'block':
        return 0.10
    conf = 0.40
    t = str(content or '').strip()
    if _TIME_HINT.search(t):
        conf -= 0.10          # 转瞬
    if len(t) < 8:
        conf -= 0.05          # 信息太薄
    return round(max(0.05, conf), 2)


# ═══════════════════════════════════════════════════════════════════
# 四、敏感信息清洗
#
# 候选池是**唯一一个存原文的旁路文件**（主库存的是提炼过的记忆）。
# 一旦 chat 里出现 cookie / token（本项目的采集器、宿主、桥接天天在贴），
# 原样落盘就等于把它们写进一个没人管的 jsonl 里。
# 所以写入前统一过一遍：敏感**键**直接删，敏感**值**打码。
# ═══════════════════════════════════════════════════════════════════

_SENSITIVE_KEY_PARTS = (
    'password', 'passwd', 'pwd', 'token', 'secret', 'cookie',
    'auth', 'credential', 'api_key', 'apikey', 'access_key', 'private_key',
)

# key=value 形态的凭据（cookie: xxx / token=xxx / Authorization: xxx）
# 复数/变体一并算上（cookies= / tokens= / pwd: —— 实测 "cookies=abcdefgh" 原样漏了出去）
_SECRET_TEXT_RE = re.compile(
    r"((?:passwords?|passwd|pwd|tokens?|secrets?|cookies?|authorization|"
    r"api[_-]?keys?|access[_-]?keys?|session[_-]?id)\s*[:=]\s*)([^\s,;，；]{4,})",
    re.I,
)

REDACTED = '[已脱敏]'
DROPPED = '[已删除]'


def scrub_text(text: Any) -> str:
    """把字符串里像凭据的片段打码。其余一个字都不动。"""
    return scrub_text_with_flag(text)[0]


def scrub_text_with_flag(text: Any) -> Tuple[str, bool]:
    """同 scrub_text，但额外告诉调用方「这条有没有被改过」。

    返回 (清洗后文本, 是否脱敏过)。

    ★ 为什么要这个布尔值（2026-11-08 评审 提的）：
      脱敏是安全特性，一旦哪天有人把它改坏了（比如漏了某个正则、
      或者写了个新入口绕开清洗），**只看代码看不出来**，数据里也没痕迹。
      把「这条是不是被清洗过」写成 scrubbed 字段落盘，
      抽查时一眼就能看出「怎么这条没脱敏 —— 是不是哪里漏了」。
      这跟 content_source / embed_status 是同一个思路：状态要落盘，不能只在脑子里。
    """
    s = str(text if text is not None else '')
    new = _SECRET_TEXT_RE.sub(lambda m: m.group(1) + REDACTED, s)
    return new, new != s


def _is_sensitive_key(key: Any) -> bool:
    k = str(key or '').lower().replace('-', '_')
    return any(p in k for p in _SENSITIVE_KEY_PARTS)


def sanitize_meta(meta: Any) -> Dict[str, Any]:
    """清洗 metadata：删敏感键、值脱敏、压长度、保证 JSON 可序列化。

    被删掉的**键名**会记在 _dropped 里 —— 值不留，但「删过东西」要看得见，
    否则将来有人纳闷「我明明传了 token 字段，怎么没了」。
    """
    if meta is None:
        return {}
    if not isinstance(meta, dict):
        # 不是 dict 也收下（别静默丢），塞进 note 里
        return {'note': scrub_text(meta)[:META_VALUE_MAX_CHARS]}
    return _clean_dict(meta, depth=0)


def _clean_dict(d: Dict[str, Any], depth: int) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    dropped: List[str] = []
    for i, (k, v) in enumerate(d.items()):
        key = str(k)
        if _is_sensitive_key(key):
            dropped.append(key)
            continue
        if len(out) >= META_MAX_KEYS:
            dropped.append(key)
            continue
        out[key] = _clean_value(v, depth + 1)
    if dropped:
        out['_dropped'] = dropped
    return out


def _clean_value(v: Any, depth: int) -> Any:
    if depth > 3:
        return scrub_text(v)[:META_VALUE_MAX_CHARS]
    if isinstance(v, dict):
        return _clean_dict(v, depth)
    if isinstance(v, (list, tuple)):
        return [_clean_value(x, depth + 1) for x in list(v)[:META_MAX_KEYS]]
    if isinstance(v, str):
        return scrub_text(v)[:META_VALUE_MAX_CHARS]
    if v is None or isinstance(v, (int, float, bool)):
        return v
    # 其它对象（MemoryItem / datetime …）→ 转字符串，绝不把对象写进 JSON
    return scrub_text(v)[:META_VALUE_MAX_CHARS]


# ═══════════════════════════════════════════════════════════════════
# 五、落盘（只追加；清理时整文件原子重写）
# ═══════════════════════════════════════════════════════════════════

class _NullLock(NullLock):
    """空锁 —— 转发到 common.locking.NullLock（2026-11-09 收敛）。

    原来这里自己写了一份 6 行的空锁，跟另外 5 个模块各写一遍。
    """


def _state_dir() -> str:
    return os.path.dirname(os.path.abspath(CANDIDATE_PATH))


def _ensure_dir() -> None:
    d = _state_dir()
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)      # 目录自动创建（验收要求）


def _file_lock():
    """跟 memory_manager / 巩固流程同一把锁（2026-11-09 收敛到 common.locking）。"""
    from common.locking import state_lock
    return state_lock('candidates')


def _read_records(path: Optional[str] = None) -> Tuple[List[dict], int]:
    """读整个 jsonl。返回 (记录列表, 坏行数)。

    坏行（半个 JSON / 非对象）直接跳过并计数，绝不让一行脏数据炸掉整个模块 ——
    崩溃的进程可能留下写了一半的最后一行。
    """
    p = path or CANDIDATE_PATH
    records: List[dict] = []
    bad = 0
    if not os.path.exists(p):
        return records, bad
    # errors='replace'：万一有半个多字节字符，也不能读崩
    with open(p, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                bad += 1
                continue
            if isinstance(rec, dict):
                records.append(rec)
            else:
                bad += 1
    return records, bad


def _append_record(rec: dict) -> None:
    """追加一行（fsync，崩了也不丢）。"""
    _ensure_dir()
    line = json.dumps(rec, ensure_ascii=False) + '\n'
    with _file_lock():
        with open(CANDIDATE_PATH, 'a', encoding='utf-8') as f:
            f.write(line)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                pass


def _line_exists(record_id: str) -> bool:
    """回读确认这条记录真的落盘了（按 id 找）。

    为什么要回读而不是信任 _append_record：
      append 只保证「调用了 write」，不保证「真写到盘上」。
      磁盘满 / 权限被改 / 并发写坏 / 路径被换成只读 —— 都不抛异常。
      观察期数据丢一条就少一条样本，而且事后分不清「没写进去」和「判成 pass 没进池」。
    """
    rid = str(record_id or '')
    if not rid:
        return False
    try:
        records, _bad = _read_records()
    except Exception:
        return False
    return any(str(r.get('id') or '') == rid for r in records)

def _rewrite_records(records: List[dict]) -> None:
    """整文件原子重写：先写 tmp，fsync，再 os.replace。

    Windows 上直接 open('w') 写到一半被读 → 留下半个文件 → 读端全崩。
    照抄 memory_manager._atomic_write_json 的思路（不能 import 它，那是 L3）。
    """
    _ensure_dir()
    tmp = f"{CANDIDATE_PATH}.{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp"
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            for rec in records:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                pass
        last_err = None
        for attempt in range(8):       # 目标被读占用会 WinError 32，重试
            try:
                os.replace(tmp, CANDIDATE_PATH)
                return
            except OSError as e:
                last_err = e
                time.sleep(0.05 * (attempt + 1))
        raise last_err if last_err else RuntimeError('os.replace failed')
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def _switch_on() -> bool:
    """features.py 的开关。关掉 = 不写（等同今天的行为）。

    本模块**真的读**这个开关 —— 加了开关没人读就是死字段（项目第①号坑）。

    2026-11-08 改（评审 + 评审 讨论）：**fail-closed**。
      原来是 fail-open（features 挂了就照常写），理由是「开关系统挂了不该
      连带停掉写入」。但候选池的代价结构跟别的能力不一样：

        少写   → 观察期少几天数据，能补，而且**立刻看得出来**（没新条目）
        多写   → 假数据淹掉观察期，事后看不出（它们跟真候选长得一模一样）

      今天早上就吃了一次：258 条测试垃圾把池子灌满，没有一条真对话，
      而当时的症状只是「有数据」——看起来一切正常。

      所以这一个开关宁可少写。**其它开关不受影响**，保持 fail-open。
    """
    try:
        return bool(_feature_on(FEATURE_NAME))
    except Exception:
        return False        # fail-closed：开关系统挂了就不写，宁可少攒


# ═══════════════════════════════════════════════════════════════════
# 六、写入候选池
# ═══════════════════════════════════════════════════════════════════

def hash_of(content: Any) -> str:
    """内容指纹（sha1），bump_repeat 用它认「同一句」。"""
    return hashlib.sha1(str(content or '').strip().encode('utf-8')).hexdigest()


def _new_id(now: float) -> str:
    return f"cand_{int(now)}_{uuid.uuid4().hex[:4]}"


# ═══════════════════════════════════════════════════════════════════
# 测试隔离（2026-11-08 加，起因是一次真实事故）
#
# 事故：memory_manager.add_working_memory 接上 gate 之后，
#   test_working_memory.py 每跑一次就往**生产** state/candidates.jsonl
#   灌几十条假数据（「并发巩固0」「A 的记忆」「要巩固1」…）。
#   一个上午积了 258 条候选，**没有一条是真实对话**。
#   后果比想象的严重：观察期的全部意义就是「看待真实对话里能捞出什么」，
#   池子被 100% 假数据淹没，观察期直接作废，而且没人看得出不对
#   （它们长得跟真候选一模一样）。
#
# 根因：那个测试只隔离了 config.WORKING_MEM_PATH，没隔离候选池。
#   这不是测试的错 —— **数据文件默认落到生产路径，就是设计上的漏洞**。
#   新模块接进来时没人记得去改每一个测试。
#
# 所以修在模块内部：常见的测试会话标记一律不落生产盘。
#   宁可漏（真有人用 't' 当 session_id 也就是少存几条），
#   不可错（假数据淹掉观察期，且事后看不出来）。
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# 判据（2026-11-08 重写，评审 逐条用真实数据算出来的）
# ═══════════════════════════════════════════════════════════════════
#
# 旧版的问题（每条都有实证）：
#   ① 单条弱特征就判探针
#      → 「哦哦」「好」「去」这类短回复会得 3 分被判垃圾
#      → 而它们是真话
#   ② 「测试」这个词在 _TEST_CONTENT_HINTS 里
#      → 今天中午的技术讨论（「那个工作记忆的单测…」）会被判垃圾
#      → 而这恰恰是今天最核心的记录
#   ③ 只有「排除」，没有「保护」
#      → importance=0.92 的 date 类候选跟垃圾同分
#      → 判据的失效是静默的（删掉 → 没有反证）
#
# 现在的结构（两层）：
#   第一层：正向保护 —— 命中任一条直接判生产，不算分
#   第二层：弱特征判据 —— 需要 >= 2 条同时成立
#
# ★ 关键顺序：正向保护必须在弱特征之前
#   否则「好好好」会被 _is_placeholder 抓住（字符种类 < 2）
#   而 _COMPOSED 已经先豁免了它 —— 安全来自顺序，不是来自单个判据。

# ═══ 格式哨兵（不是保护）═══
#
# compose 的产物格式是「他说：X；我回：Y」。
#
# ★ 2026-11-08（评审 推导 + 评审 实测）：
#   composed 格式的 content **在数学上不可能**被弱特征判成探针：
#     最短 9 字（'他说：a；我回：b'）  → 极短判据不成立
#     必有『：』和『；』               → 无标点判据不成立
#     必有『他』和『我』               → 无人称判据不成立
#     9 字至少 6 种不同字符            → 占位判据不成立
#     最多 repeat 得 1 分              → 达不到阈值 2
#
#   实测：15 条真实 composed 数据，最高弱特征得分 = 0
#        关掉全部正向保护后判定不变 → 真正救下 0 条（count_rescued 验证）
#
#   所以这行**不是保护，是断言**：
#     「如果哪天这条 return 生效了，说明 compose 格式变了」
#   它不防误删 —— 它防的是「格式悄悄变了之后，判据还在按旧基准工作」。
#
#   ⚠️ 正则用 [\s\S] 不用 . —— . 默认不匹配换行，
#      哪天 compose 用 \n 拼就会静默击穿。
_COMPOSED_RE = re.compile(r'^他(说|问|发|叫)[:：][\s\S]+?[；;]\s*我(回|答)[:：]')

# ═══ 正向保护 ②：高重要度 / ③：日期承诺类 ═══
_PROTECT_IMPORTANCE = 0.8
_PROTECT_CATEGORIES = ('date', 'commitment')

# ═══ 正向保护 ④：生产会话前缀 ═══
_PROD_SESSION_PREFIXES = ('private:', 'group:', 'guild:', 'channel:', 'dm:')

# ═══ 弱特征判据用的常量 ═══
# session_id 的常见测试形态
_TEST_SESSION_RE = re.compile(
    r'^(?:t|s|u|p|probe|test|tmp|demo|foo|bar|baz|mock|dummy|sample|selftest)'
    r'[0-9A-Za-z_:：-]*$',
    re.I,
)
# 内容里的**强**测试固定串（这些真实对话不会说）
# ★ 注意：删掉了「测试」「test」两个泛词 —— 它们在技术讨论里会误杀
_TEST_CONTENT_STRONG = (
    '并发巩固', '要巩固', '只该有一条', '重启前', '字字字字',
    '唯一一条', '巩固后还在吗',
)
# 占位串的结构特征（不是名单 —— 名单会漏）
_PLACEHOLDER_WORD_RE = re.compile(r'^[中文内容测试abcxyz0-9\s]+$')

# 弱特征判据用的字符集
_PUNCT = '，。！？；：、,.!?;:'
_PRONOUNS = ('我', '他', '你', '她')


def _probe_declared() -> bool:
    """显式声明：有人主动说「这是测试」。**证据等级最高，能否决正向保护。**

    ★ 2026-11-08 拆自 _probe_mode（评审 指出）：
      原来 _probe_mode 把「显式 env」和「脚本名是 test*.py」合并成一个 True，
      但两者的证据等级不同：
        显式 env      → 主动声明，能证明「这次就是要测」
        脚本名 test*.py → 强旁证，能证明「正在跑测试脚本」
      合并之后，「脚本名是 test*.py」也能解除私聊保护 —— 那是让弱证据否决强证据。
    """
    import os as _os
    return _os.environ.get('DSH_MEMSYS_TEST') == '1'


def _in_test_script(caller_file=None) -> bool:
    """正在跑 test*.py —— **只用于解除私聊保护，不用于否决**。

    ⚠️ 2026-11-08（评审 指出两处问题，均已修）：

      问题 1：原来用 __main__.__file__ 判
        → 验证脚本叫 verify_*.py 时被判成测试环境
        → 私聊保护失效
        而 verify 脚本是「在生产数据上做验证」，读的就是真数据，不该算隔离环境。

      问题 2：改成调用栈后引入隐式假设
        「第一个不在本文件里的帧，就是调用方」
        如果判据被包一层（judge_all 在 _judge_helper.py 里），
        那个 helper 会成为「第一个外部帧」→ 判成不是测试
        → 即使真的在 test_working_memory.py 里跑

      修法（评审 建议 A 方案）：
        caller_file 显式传入优先；不传才走调用栈。
        因为「名字永远会骗人，调用关系不会」。

    caller_file: 调用方文件名。不传则用调用栈推断。
    """
    import os as _os
    import sys as _sys

    # 显式 env 优先
    if _os.environ.get('DSH_MEMSYS_TEST') == '1':
        return True

    def _is_test_name(path):
        n = _os.path.basename(path or '').lower()
        return (n.startswith('test') and n.endswith('.py')) or n.endswith('_test.py')

    # ① 显式传入（最可靠）
    if caller_file:
        return _is_test_name(caller_file)

    # ② 兜底：调用栈
    try:
        frame = _sys._getframe(1)
        this_file = _os.path.abspath(__file__)
        while frame is not None:
            f = _os.path.abspath(frame.f_code.co_filename or '')
            if f != this_file:
                return _is_test_name(f)
            frame = frame.f_back
    except Exception:
        pass
    return False

def _probe_mode() -> bool:
    """兼容旧接口。等价于「显式声明或正在跑测试脚本」。"""
    return _probe_declared() or _in_test_script()


def _is_placeholder(c: str) -> bool:
    """占位串的结构特征（不是内容名单）。

    ⚠️ 必须在 _COMPOSED_RE 豁免**之后**调用。
       否则「好好好」「行行行」会被 len(set) 判据抓住。
       安全来自调用顺序，不是来自本函数。
    """
    if not c or len(c) > 30:
        return False
    if len(set(c)) <= max(2, len(c) // 2):
        return True
    if _PLACEHOLDER_WORD_RE.match(c):
        return True
    if len(set(c)) == 1:
        return True
    return False


def judge_candidate(content, session_id, repeat=1,
                    importance=0.0, category='', probe=False,
                    caller_file=None) -> tuple:
    """判断一条候选是不是测试写的。返回 (is_probe, reason)。

    ★ 2026-11-08 重写（评审 指出三层顺序必须按证据强度排）：

      第 1 层  显式声明（最强证据，能否决一切）
      第 2 层  正向保护（宁可放过，证据中等）
      第 3 层  弱特征（间接推断，证据最弱，需要 >= 2 条）

      旧版把「显式声明」放在弱特征那层的 OR 里，
      等于让弱保护否决强声明 —— 顺序反了。

    reason 取值：
      'declared'    → 显式声明是测试
      'composed'    → 拼接格式，保护放过
      'importance'  → importance >= 0.8，保护放过
      'category'    → date/commitment，保护放过
      'private'     → 生产会话前缀，保护放过
      'strong'      → 命中强测试固定串，判探针
      'weak_score'  → 弱特征 >= 2，判探针
      'default'     → 0-1 弱特征，判生产
    """
    c = str(content or '').strip()
    sid = str(session_id or '').strip()

    # ═══ 第 1 层：显式声明（能否决一切）═══
    if probe or _probe_declared():
        return True, 'declared'

    # ═══ 第 2 层：正向保护（宁可放过）═══
    if _COMPOSED_RE.match(c):
        return False, 'composed'

    try:
        imp = float(importance or 0)
    except (TypeError, ValueError):
        imp = 0.0
    if imp >= _PROTECT_IMPORTANCE:
        return False, 'importance'

    if str(category or '') in _PROTECT_CATEGORIES:
        return False, 'category'

    # 私聊保护：只被「正在跑测试脚本」解除（不被显式声明解除 —— 那条已在第 1 层拦下）
    low = sid.lower()
    if any(low.startswith(p) for p in _PROD_SESSION_PREFIXES) \
            and not _in_test_script(caller_file):
        return False, 'private'

    # ═══ 第 3 层：强特征（单独成立）═══
    if any(h in c for h in _TEST_CONTENT_STRONG):
        return True, 'strong'

    # ═══ 第 4 层：弱特征（需要 >= 2 条）═══
    weak = 0
    if len(c) < 8:
        weak += 1
    if _is_placeholder(c):
        weak += 1
    if not any(ch in c for ch in _PUNCT):
        weak += 1
    if not any(p in c for p in _PRONOUNS):
        weak += 1
    try:
        if int(repeat or 1) >= 3:
            weak += 1
    except (TypeError, ValueError):
        pass

    if weak >= 2:
        return True, 'weak_score'
    return False, 'default'


def is_known_fixture(session_id, content):
    if str(session_id or '') not in ('u1','s1'):return False
    text=str(content or '')
    return (text == '表情😀🎉 特殊字符 \\ " \' \n\t 中文，标点。'
            or bool(re.fullmatch(r'第\d+轮对话内容，说的是同一件事',text)))


def is_persisted_fixture(row):
    # The process doing today's review is not evidence about who wrote an old
    # record. Never apply caller-stack / test-environment heuristics to history.
    meta=row.get('meta') or {}
    return bool(meta.get('probe') is True or meta.get('is_test') is True
                or is_known_fixture(row.get('session_id'),row.get('content')))


def _is_test_session(session_id: Any, content: Any = None,
                     caller_file: Any = None) -> bool:
    """兼容旧接口。"""
    # Proven literals from test5.d7 / working-memory loop fixtures, restricted
    # to synthetic session names; technical production dialogue is protected.
    if is_known_fixture(session_id,content):return True
    is_probe, _reason = judge_candidate(content, session_id,
                                        caller_file=caller_file)
    return is_probe

def _weak_score_only(content, repeat=1):
    """只算弱特征得分，不做任何正向保护。用于计算 rescued。"""
    c = str(content or '').strip()
    score = 0
    if len(c) < 8:
        score += 1
    if _is_placeholder(c):
        score += 1
    if not any(ch in c for ch in _PUNCT):
        score += 1
    if not any(p in c for p in _PRONOUNS):
        score += 1
    try:
        if int(repeat or 1) >= 3:
            score += 1
    except (TypeError, ValueError):
        pass
    return score


def judge_without_protection(content, session_id, repeat=1):
    """关掉全部正向保护，只走强特征 + 弱特征。用于计算 rescued。"""
    c = str(content or '').strip()
    if any(h in c for h in _TEST_CONTENT_STRONG):
        return True, 'strong'
    if _weak_score_only(c, repeat) >= 2:
        return True, 'weak_score'
    return False, 'default'


def count_rescued(candidates):
    """计算「真正被保护救下」的条数。

    ★ 2026-11-08（评审 推导 + 评审 实测）：
      原来想统计「保护放过比例」，但那是假数字：
        composed 格式的 content 在数学上不可能被判探针
        → 被标记为 composed 的条数 ≠ 被救下的条数
        → 实测 15 条 composed，真正救下 0 条

      正确算法：对每条跑两遍
        with_guard    = judge_candidate()           （带保护）
        without_guard = judge_without_protection()  （只走弱特征）
        两者判定不同 → 这条是「被保护救下」的

      这个数字才是「保护在工作」的证据。
      它从 0 涨到 >30% 时，说明上游（importance/category/compose 格式）变了。

    返回 (rescued, total, details)
    """
    rescued = 0
    total = 0
    details = []
    for d in candidates or []:
        if not isinstance(d, dict) or d.get('kind') != 'candidate':
            continue
        total += 1
        c = str(d.get('content') or '')
        sid = str(d.get('session_id') or '')
        rep = d.get('repeat', 1)
        imp = d.get('importance', 0)
        cat = d.get('category', '')

        a, ra = judge_candidate(c, sid, rep, imp, cat)
        b, rb = judge_without_protection(c, sid, rep)
        if a != b:
            rescued += 1
            details.append({'content': c[:50], 'with': ra, 'without': rb})
    return rescued, total, details

# ═══════════════════════════════════════════════════════════════════
# 反向断言：必须判探针的已知垃圾（2026-11-08）
# ═══════════════════════════════════════════════════════════════════
#
# 评审 指出：判据只有「排除规则」，没有「必须包含」的反向断言。
# 如果哪天有人改了 _is_placeholder 或弱特征阈值，
# 这些已知垃圾会被放过 —— 而没有任何东西会报。
#
# 这跟 IsolationGuard 的 MUST_MONITOR 是同一个模式：
#   排除规则可以随便放宽 → 放宽只影响「少判什么」
#   MUST_BE_PROBE 一断言 → 放宽到放过垃圾，立刻炸

# 必须判探针的已知垃圾
#   (content, session_id)  —— 只给这两项，repeat 由测试自己跑序列
MUST_BE_PROBE = [
    ('中文内容', '中文会话'),
    ('并发巩固0', 't11'),
    ('字字字字字字', 't'),
    ('只该有一条', 's1'),
]

# 必须判生产的真数据（2026-11-08 加，评审 指出只验证了一半）
#   这一组是「今天真正差点被误删的东西」
MUST_BE_PROD = [
    # 含「测试」但必须判生产（今天的真实技术讨论）
    ('他说：明天测试排班已经约好，午饭后请来办公室碰面；我回：好',
     'private:1', 0.65, 'event'),
    # 含「原子写」「测试」但必须判生产
    ('他说：排班表里安排两人分别检查原子写和测试记录；我回：对',
     'private:1', 0.65, 'event'),
    # 短但拼接格式 → 必须判生产
    ('他说：好呀；我回：下周见', 'private:1', 0.65, 'event'),
    # 高 importance 的 date 类
    ('五月第二周周六交稿', 'private:1', 0.92, 'date'),
]


# repeat 序列：测「结论不随 repeat 漂移」
_REPEAT_SEQ = (1, 2, 3, 5, 9, 20, 100)


def judge_selftest():
    """验证判据的两个方向都成立。

    ★ 2026-11-08 改（评审 指出两处）：
      ① 原来把 repeat 硬编码进样本 → 只测「某一次算对」
         真正该问的是「判据有没有可能因为 repeat 变化而改变结论」
         所以改成跑 repeat 序列，断言「结论不漂移」
      ② 原来只有 MUST_BE_PROBE → 只验证了「垃圾不被放过」
         但今天真正差点出事的是「真数据会不会被误删」
         所以要加 MUST_BE_PROD

    「只验证了一半的判据，比没验证更危险 —— 因为它看起来验证过了。」

    在 candidate_pool.selftest() 里调用；也可以单独跑：
        python -c "import candidate_pool as cp; cp.judge_selftest()"
    """
    failures = []

    # ═══ 方向 A：垃圾不会被放过（且结论不随 repeat 漂移）═══
    for content, sid in MUST_BE_PROBE:
        for rep in _REPEAT_SEQ:
            is_probe, reason = judge_candidate(content, sid, repeat=rep)
            if not is_probe:
                failures.append(
                    '判据漂移：%r repeat=%d 应判探针，实际判生产（reason=%s）'
                    % (content, rep, reason))
                break          # 这条已经失败，不用再试其它 repeat

    # ═══ 方向 B：真数据不会被误删 ═══
    for item in MUST_BE_PROD:
        content, sid, imp, cat = item
        for rep in _REPEAT_SEQ:
            is_probe, reason = judge_candidate(
                content, sid, repeat=rep, importance=imp, category=cat)
            if is_probe:
                failures.append(
                    '误删风险：%r repeat=%d importance=%s category=%s '
                    '被误判探针（reason=%s）'
                    % (content, rep, imp, cat, reason))
                break

    if failures:
        raise AssertionError('\n'.join(failures))
    return True






def write_candidate(content: str, session_id: str, reason: str,
                    meta: Optional[dict] = None, *, source: str = 'auto',
                    force: bool = False) -> dict:
    """把一条「拿不准」写进候选池。返回写入的记录（或没写的原因）。

    三条护栏（设计 5.2「注意：pass 和 block 不写这里」）：
        · 门控判成 pass  → 不写（那是主库的事）
        · 门控判成 block → 不写（明确不该记）
        · features 开关关 → 不写（设计 1.3：关掉就等同今天）
    没写时返回 {"written": False, "gate": …, "reason": …}，不抛异常 ——
    记忆链路里失败必须静默降级，不能把聊天打断。

    force=True 跳过门控与开关（自检 / 人工补录用）。
    """
    text = str(content or '').strip()
    if not text:
        return {'written': False, 'gate': 'block', 'reason': '空内容'}

    level, gate_reason = gate(text, source)
    if not force:
        if not _switch_on():
            return {'written': False, 'gate': level,
                    'reason': f'{FEATURE_NAME} 开关关闭', 'skipped': 'switch'}
        if level != 'mark':
            return {'written': False, 'gate': level, 'reason': gate_reason,
                    'skipped': 'gate'}
        # 测试隔离：单测/探针写进来的东西不进生产池（见 _is_test_session 的说明）
        # ★ 2026-11-13：**只在目标就是生产池时**才拦。
        #   护栏的目的是「别把测试垃圾写进生产」，不是「禁止测试写文件」。
        #   测试把 CANDIDATE_PATH 指到 tmp 之后，写 tmp 是无害的，应当放行 ——
        #   否则测试永远测不到真实写入路径，等于护栏反过来废掉了测试。
        #   （实测：不加这一条，test_candidate_pool.py 的 18 条写入断言全红）
        if _is_test_session(session_id, text) and _is_prod_path():
            return {'written': False, 'gate': level,
                    'reason': '测试会话或测试内容，不写生产候选池',
                    'skipped': 'test'}

    now = time.time()
    body, scrubbed = scrub_text_with_flag(text)
    truncated = len(body) > CONTENT_MAX_CHARS
    if truncated:
        body = body[:CONTENT_MAX_CHARS]

    # classify_importance 的判定**照样存下来**，它是观察期的关键证据：
    # 「这条被判成 event 0.65 却被门控拦下了」正是要收集的样本。
    try:
        category, importance = classify_importance(body, source)
    except Exception:
        category, importance = 'unknown', 0.0

    rec: Dict[str, Any] = {
        'kind': 'candidate',
        'id': _new_id(now),
        'at': now,
        'content': body,
        'content_hash': hash_of(body),
        'session_id': str(session_id or ''),
        'gate': level,
        'reason': str(reason or '').strip() or gate_reason,
        'confidence': confidence_of(level, body),
        'status': 'pending',          # pending / merged / rejected（裁决未实现，恒 pending）
        'category': category,
        'importance': importance,
        # ★ 安全审计位：这条有没有被脱敏过。没有它，「漏脱敏」在生产数据里
        #   跟「没凭据可脱」长得一模一样，出问题查不出来。
        'scrubbed': scrubbed,
        'meta': sanitize_meta(meta),
    }
    if truncated:
        rec['truncated'] = True

    # 「这条内容被写过一次」——重复计数在这里自动落，不用调用方操心。
    # 设计 5.2 的「同一句重复 3 次 → 升级」靠它：单看一句「明天还要早起好烦」
    # 都拿不准，但连着三天说，重复本身就是分量的证据。
    # ⚠️ write_candidate 已经计过数了，调用方**不要再**对同一条调 bump_repeat（会重复计）。
    try:
        n = bump_repeat(rec['content_hash'])
        rec['repeat'] = n
        if n >= ESCALATE_AFTER:
            rec['escalated'] = True
    except Exception as e:               # 计数失败绝不能影响写入本身
        rec['repeat'] = 0
        print(f"[candidate_pool] 重复计数失败（不影响写入）: {type(e).__name__}: {e}")

    # ── 写入并**回读验证**（2026-11-08，被 评审 的破坏性验证提醒到的）
    #
    #   原来这里是 _append_record(rec); out['written'] = True —— 只要没抛异常就报成功。
    #   实测破坏 _append_record 让它什么都不做，write_candidate 依然返回 written=True，
    #   调用方（memory_manager 的 gate 接线）完全看不出来。
    #   这正是今天在查的那类「假绿」：**函数说写成功了，文件里没有**。
    #
    #   候选池尤其不能这样：观察期全靠这批数据，静默丢一条就少一条样本，
    #   而且事后完全无法分辨「没写进去」和「判成 pass 没进池」。
    _append_record(rec)

    ok = _line_exists(rec['id'])
    if not ok:
        # 回读不到 → 老实说没写成，别骗调用方
        return {'written': False, 'gate': level, 'id': rec['id'],
                'reason': '写入后回读不到这条记录（磁盘/权限/并发问题）',
                'skipped': 'verify', 'content': body}

    out = dict(rec)
    out['written'] = True
    return out


# ═══════════════════════════════════════════════════════════════════
# 七、读候选池（只给人和 CLI 看，**不喂召回**）
# ═══════════════════════════════════════════════════════════════════

def adjudicate_candidates(limit: int = 500) -> dict:
    """Recheck pending records; queue clear facts, reject clear noise, retain uncertainty.

    Queued means durably handed to pending_longterm, not yet merged into memory.
    Never call this from the chat hot path.
    """
    from pending_longterm import append_pending
    report = {"seen": 0, "queued": 0, "rejected": 0, "pending": 0, "observed":0, "merged":0}
    with _file_lock():
        records, bad = _read_records()
        if bad:
            raise ValueError("candidate pool contains malformed lines; refusing rewrite")
        changed = False
        observations=[]
        import config
        existing={}
        for pool_path in (config.LONG_TERM_ACTIVE_PATH,config.LONG_TERM_COLD_PATH,config.SHORT_TERM_PATH):
            try:
                with open(pool_path,encoding='utf-8') as f:pool_rows=json.load(f).get('memories',[])
            except FileNotFoundError:continue
            for row in pool_rows:
                existing.setdefault(str(row.get('content') or ''),[]).append(row)
        from pending_longterm import read_pending
        jobs=read_pending(limit=None)
        queued_candidates={r.get('origin_candidate_id') for r in jobs}
        queued_operations={r.get('operation_id') for r in jobs}
        # Recover the final acknowledgement even if the previous process died
        # after committing the destination and before updating the candidate.
        from config import LONG_TERM_ACTIVE_PATH
        try:
            with open(LONG_TERM_ACTIVE_PATH, encoding='utf-8') as target_file:
                committed = json.load(target_file).get('_operation_receipts', {})
        except FileNotFoundError:
            committed = {}
        for rec in records:
            outcome = next((v for v in committed.values() if rec.get('id') and v.get('candidate_id') and v.get('candidate_id') == rec.get('id')), None)
            if outcome and rec.get('kind', 'candidate') == 'candidate' and rec.get('status') in ('pending', 'queued'):
                rec.update(status=outcome['state'], final_mem_ids=outcome.get('mem_ids', []),
                           finalized_at=outcome.get('at'))
                changed = True
        for rec in sorted(records, key=lambda r: float(r.get("reviewed_at") or 0)):
            if rec.get("kind", "candidate") != "candidate":
                continue
            if rec.get('status')=='queued':
                if rec.get('id') in queued_candidates or 'candidate:'+str(rec.get('id')) in queued_operations:
                    continue
                rec.update(status='pending',previous_status='queued',queue_reconciliation='no live job or final receipt; rechecked from preserved original')
                changed=True
            if rec.get('status')=='observed':
                from services.candidate_observations import fingerprint
                if (time.time()<float(rec.get('next_review_at') or 0)
                        and rec.get('observation_fingerprint')==fingerprint(rec)):continue
                rec['status']='pending'
            if rec.get("status", "pending") != "pending":
                continue
            if report["seen"] >= limit:
                break
            report["seen"] += 1
            rec["reviewed_at"] = time.time()
            changed = True
            content = str(rec.get("content") or "")
            targets=[r for r in existing.get(content,[]) if
                     r.get('session_id')==rec.get('session_id') and not r.get('deleted')
                     and not r.get('recall_excluded') and not r.get('corrected_by') and not r.get('superseded_by')
                     and abs(float(r.get('create_time') or 0)-float(rec.get('at') or 0))<5]
            if targets and not is_persisted_fixture(rec):
                from services.recall_policy import revision
                rec.update(status='merged',final_mem_ids=[r['mem_id'] for r in targets],
                           final_target_revisions={r['mem_id']:revision(r) for r in targets},
                           finalized_at=time.time(),decision_reason='same original text, session and event time already persisted')
                report['merged']+=1
                continue
            level, why = gate(content)
            cat, _ = classify_importance(content)
            if is_persisted_fixture(rec) or level == "block":
                rec["status"] = "rejected"
                report["rejected"] += 1
            elif level == "pass" and cat in ("commitment", "date", "fact"):
                from services.candidate_observations import private_context,fingerprint,REVIEW_INTERVAL
                if private_context(rec) or _COMPOSED_RE.search(content):
                    reason='dialogue context requires evidence review; not promoted by commitment keyword'
                    observations.append((dict(rec),reason))
                    rec.update(status='observed',decision_reason=reason,
                               observation_fingerprint=fingerprint(rec),next_review_at=time.time()+REVIEW_INTERVAL)
                    report['observed']+=1
                    continue
                if not append_pending(content, session_id=rec.get("session_id"),
                                      source="candidate_pool", category_at_write=cat,
                                      create_time=rec.get("at"),
                                      operation_id='candidate:' + str(rec['id']),
                                      origin_candidate_id=rec['id']):
                    report["pending"] += 1
                    continue
                rec["status"] = "queued"
                report["queued"] += 1
            else:
                from services.candidate_observations import fingerprint,REVIEW_INTERVAL
                reason='insufficient fact evidence; preserved verbatim for observation'
                observations.append((dict(rec),reason))
                rec.update(status='observed',decision_reason=reason,
                           observation_fingerprint=fingerprint(rec),next_review_at=time.time()+REVIEW_INTERVAL)
                report['observed']+=1
                continue
            rec["decided_at"] = time.time()
            rec["decision_reason"] = why
            changed = True
        if changed:
            if observations:
                from services.candidate_observations import archive
                archive(observations)
            _rewrite_records(records)
    return report


def list_candidates(limit: int = 50, include_repeats: bool = False) -> list:
    """按时间倒序列出候选。

    limit <= 0 表示全给（人工审计用）。重复计数事件默认不混进来。
    """
    records, _bad = _read_records()
    out = [r for r in records
           if include_repeats or r.get('kind', 'candidate') == 'candidate']
    out.sort(key=lambda r: float(r.get('at') or 0), reverse=True)
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 50
    return out[:n] if n > 0 else out


# ═══════════════════════════════════════════════════════════════════
# 八、重复计数（同一句重复 3 次 → 升级）
#
# 场景：他连着几天说「明天还要早起好烦」——单看都拿不准，
#       但重复本身就是「这件事对他有分量」的证据。
# 计数不挂在候选记录上，而是单独一种事件行：
#   ① 追加写，不用读改写，多进程也不会互相覆盖
#   ② 删文件就归零，可复现
# ═══════════════════════════════════════════════════════════════════

def _repeat_counts(records: Optional[List[dict]] = None) -> Dict[str, int]:
    recs = records if records is not None else _read_records()[0]
    counts: Dict[str, int] = {}
    for r in recs:
        if r.get('kind') != 'repeat':
            continue
        h = str(r.get('content_hash') or '')
        if h:
            counts[h] = counts.get(h, 0) + 1
    return counts


def bump_repeat(content_hash: str) -> int:
    """给一条内容记一次「又被判成候选了」，返回累计次数。

    ⚠️ write_candidate 内部已经对每条写入调过它了。
       只有「判成 mark 但这次没真写」的场景才需要外部自己调。
    """
    h = str(content_hash or '').strip()
    if not h:
        return 0
    _append_record({'kind': 'repeat', 'content_hash': h, 'at': time.time()})
    return _repeat_counts().get(h, 0)


def repeat_count(content_hash: str) -> int:
    """查一条内容被写过几次（不写）。"""
    return _repeat_counts().get(str(content_hash or '').strip(), 0)


# ═══════════════════════════════════════════════════════════════════
# 九、清理
# ═══════════════════════════════════════════════════════════════════

# 分层清理的两个阈值（2026-11-08 加）
#
# 为什么分层：
#   实测 305 条候选里，importance 的分布是：
#     0.35（misc）    20 条   ← 闲聊，14 天够了
#     0.65（event）  227 条   ← 大部分是日常对话
#     0.92（fact/date/commitment）58 条
#                          ← gate 拿不准但内容本身比较重要，值得留久一点
#   一刀切 14 天会把那 58 条也清掉，但它们正是「观察期最该看」的样本。
CANDIDATE_KEEP_DAYS_HIGH = 90     # importance >= 0.8 的保留天数
CANDIDATE_HIGH_IMPORTANCE = 0.8   # 高重要度阈值


def clear_old(days: int = None) -> int:
    """清掉过期的候选（连重复事件一起清）。返回清了几条。

    分层（2026-11-08）：
      · importance >= 0.8  → 保留 CANDIDATE_KEEP_DAYS_HIGH（90）天
      · 其余               → 保留 days（默认 CANDIDATE_KEEP_DAYS=14）天

    days=None 表示用默认值。显式传 days 时，**两层都用这个值**
    （调用方明确要求「全清到 N 天」时不该被分层拦住）。

    ⚠️ 重复事件（kind='repeat'）没有 importance，按普通层处理。
    """
    explicit = days is not None
    try:
        d = float(days) if explicit else float(CANDIDATE_KEEP_DAYS)
    except (TypeError, ValueError):
        d = float(CANDIDATE_KEEP_DAYS)
    d = max(0.0, d)

    now = time.time()
    cutoff_normal = now - d * 86400
    # 显式传 days 时不分层；用默认值时按 importance 分两层
    cutoff_high = cutoff_normal if explicit else (
        now - float(CANDIDATE_KEEP_DAYS_HIGH) * 86400)

    # 读-筛选-原子替换必须与 append 共用同一把锁；否则 append 可能在
    # 本函数读完旧快照后、rewrite 前发生，随后被旧快照覆盖丢失。
    with _file_lock():
        records, _bad = _read_records()
        if not records:
            return 0
        keep, removed = [], 0
        for r in records:
            try:
                at = float(r.get('at') or 0)
            except (TypeError, ValueError):
                at = 0.0
            try:
                imp = float(r.get('importance') or 0)
            except (TypeError, ValueError):
                imp = 0.0
            cutoff = cutoff_high if imp >= CANDIDATE_HIGH_IMPORTANCE else cutoff_normal
            if at >= cutoff:
                keep.append(r)
            else:
                removed += 1
        if removed:
            _rewrite_records(keep)
        return removed


# ═══════════════════════════════════════════════════════════════════
# 十、统计
# ═══════════════════════════════════════════════════════════════════

def stats() -> dict:
    """{total, today, by_reason, escalated} + 观察期用得上的几个附加项。"""
    records, bad = _read_records()
    cands = [r for r in records if r.get('kind', 'candidate') == 'candidate']

    now = time.time()
    lt = time.localtime(now)
    day_start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))

    reasons = Counter(str(r.get('reason') or '(空)') for r in cands)
    cats = Counter(str(r.get('category') or '?') for r in cands)
    reps = _repeat_counts(records)

    return {
        'total': len(cands),
        'today': sum(1 for r in cands if float(r.get('at') or 0) >= day_start),
        'by_reason': dict(sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))),
        'by_category': dict(sorted(cats.items(), key=lambda kv: (-kv[1], kv[0]))),
        'escalated': sum(1 for n in reps.values() if n >= ESCALATE_AFTER),
        'repeats': sum(reps.values()),
        'bad_lines': bad,
        'path': CANDIDATE_PATH,
    }


# ═══════════════════════════════════════════════════════════════════
# 十一、自检（不依赖真实数据，5 秒内跑完）
#
# 全程写在临时目录里（顺带验证「state 目录不存在时自动创建」），
# 绝不碰 state/candidates.jsonl 的真实数据。
# ═══════════════════════════════════════════════════════════════════

def selftest() -> None:
    global CANDIDATE_PATH
    saved_path = CANDIDATE_PATH
    tmpdir = tempfile.mkdtemp(prefix='cand_selftest_')
    # 故意用一个**还不存在**的子目录 → 验证自动建目录
    CANDIDATE_PATH = os.path.join(tmpdir, 'state', 'candidates.jsonl')

    from features import disable as _feat_off, enable as _feat_on, on as _is_on
    was_on = _is_on(FEATURE_NAME)
    try:
        # ── ① 门控：验收用例逐条过（这 8 条是需求里写死的）
        cases = [
            ('我答应你永远不离开', 'pass'),
            ('我生日是2月13日', 'pass'),
            ('我不喜欢吃香菜', 'pass'),
            ('嗯', 'block'),
            ('平方衰减怎么算', 'block'),          # ← 实测问题的那一条
            ('记忆系统的候选池设计', 'block'),
            ('明天十一点', 'mark'),
            ('今天好累', 'mark'),
        ]
        for text, expect in cases:
            got, reason = gate(text)
            assert got == expect, f"门控不符：{text!r} 期望 {expect}，实际 {got}（{reason}）"

        # ── ② 门控的边角
        assert gate('') == ('block', '太短')
        assert gate(None)[0] == 'block'                       # None 不能炸
        assert gate('   ')[0] == 'block'
        assert gate('嗯嗯')[0] == 'block'                     # 2 字也算太短
        # 单个弱技术词 ≠ 元讨论（宁可进候选池，不可错杀真事）
        assert gate('接口怎么调')[0] == 'mark', gate('接口怎么调')
        assert gate('接口和参数都要改')[0] == 'block'          # 两个词就够
        # 强技术词一个就够（原「≥2」规则的反例）
        assert gate('衰减')[0] == 'block'
        # 但长文本只中 1 个技术词 → mark 留档，不 block
        #   （真实库里「他在周五讨论记忆系统」46 字，
        #     整条 block 就等于把一件事弄丢了）
        long_tech = ('周五下午大家在小会议室一起聊了一个小时的记忆系统，'
                     '散会以前还约好下周先去图书馆见面商量各自准备的讲稿和安排')
        assert len(long_tech) > META_STRONG_SOLO_MAX_CHARS, len(long_tech)
        lv, why = gate(long_tech)
        assert lv == 'mark' and '只中' in why, (len(long_tech), lv, why)
        # 同样提到「记忆系统」，但句子短到阈值以内 → 又回到 block（长度就是唯一区别）
        short_tech = '周五讨论记忆系统'
        assert len(short_tech) <= META_STRONG_SOLO_MAX_CHARS
        assert gate(short_tech)[0] == 'block', gate(short_tech)
        # 英文词边界：git 不能命中 legit
        assert 'git' not in _meta_hits('that is legit')
        assert 'git' in _meta_hits('git commit 一下')
        # 人工指定直接 pass，不被元讨论推翻
        assert gate('记住这个 bug 怎么解', 'manual_remember') == ('pass', '来源=人工指定')
        # 档位只有三种，穷举一批输入
        for s in ('', None, '嗯', '我答应你', '今天好累', '平方衰减怎么算', '点击这里下载'):
            lv, _r = gate(s)
            assert lv in ('pass', 'mark', 'block'), f"{s!r} → {lv}"

        # ── ③ confidence 在 0~1，且 mark 落在 0.4 附近
        assert 0.0 <= confidence_of('mark', '明天十一点') < 0.4
        assert confidence_of('pass', '我答应你') == 0.90
        assert confidence_of('block', '嗯') == 0.10

        # ── ④ 开关关掉就不写（开关必须能被读到，否则就是死字段）
        _feat_off(FEATURE_NAME)
        try:
            r = write_candidate('今天好累', 's1', '开关测试')
            assert r['written'] is False and r.get('skipped') == 'switch', r
            assert list_candidates() == [], "开关关掉时不该落盘"
        finally:
            if was_on:
                _feat_on(FEATURE_NAME)

        # ── ⑤ 写入 + 读回（目录自动创建）
        # ⚠️ 这里必须用**生产形态**的 session_id。
        #   用 'test' 会被 _is_test_session 挡掉（skipped='test'），
        #   一跑 selftest 就红 —— 这正是隔离规则在起作用，不是 bug。
        SID = 'private:selftest'
        assert _is_test_session('test', '明天十一点') is True, "测试 session 必须被挡"
        assert _is_test_session(SID, '明天十一点') is False, "生产 session 不能被挡"
        r1 = write_candidate('明天十一点', SID, '未匹配')
        assert r1['written'] is True and r1['gate'] == 'mark'
        # 写入自动计数：第一次就是 1（计数不是死字段，不用调用方操心）
        assert r1.get('repeat') == 1, r1.get('repeat')
        for f in ('id', 'at', 'content', 'content_hash', 'session_id', 'gate',
                  'reason', 'confidence', 'status', 'category', 'importance', 'meta'):
            assert f in r1, f"候选记录缺字段 {f}"
        assert r1['status'] == 'pending'
        assert os.path.exists(CANDIDATE_PATH), "state 目录/文件应自动创建"

        r2 = write_candidate('今天好累', SID, '未匹配')
        assert r2['written'] is True
        lst = list_candidates()
        assert len(lst) == 2, f"应写入 2 条，实际 {len(lst)}"
        assert lst[0]['content'] == '今天好累', "应按时间倒序（最新的在前）"

        # ── ⑥ pass / block 不进候选池（设计 5.2 的核心约束）
        n_before = len(list_candidates())
        assert write_candidate('我答应你永远不离开', SID, 'x')['written'] is False
        assert write_candidate('嗯', SID, 'x')['written'] is False
        assert write_candidate('', SID, 'x')['written'] is False
        assert len(list_candidates()) == n_before, "pass/block/空内容都不该落盘"
        # force 能绕过门控（补录场景）
        assert write_candidate('我答应你永远不离开', SID, '补录', force=True)['written'] is True
        assert len(list_candidates()) == n_before + 1

        # ── ⑦ 敏感信息清洗
        r3 = write_candidate(
            '帮我看看 token=abcdefgh123456 这个',
            SID, '清洗测试',
            meta={'token': 'sk-xxx', 'cookie': 'sessionid=1', 'note': 'cookies=abcdefgh',
                  'safe': '保留我'},
            force=True,
        )
        m = r3['meta']
        assert 'token' not in m and 'cookie' not in m, m
        assert m.get('safe') == '保留我'
        assert m.get('note') == 'cookies=' + REDACTED, m.get('note')
        assert set(m.get('_dropped') or []) >= {'token', 'cookie'}, m.get('_dropped')
        assert 'abcdefgh123456' not in r3['content'], "content 里的凭据也要脱敏"
        assert REDACTED in r3['content']
        # scrubbed 是安全审计位：脱敏了就 true，干净的就是 false
        assert r3['scrubbed'] is True, r3.get('scrubbed')
        assert r2['scrubbed'] is False, "没凭据的条目 scrubbed 应为 False"
        assert 'scrubbed' in r1, "scrubbed 必须落盘（否则漏脱敏查不出来）"
        # scrub_text_with_flag 的布尔值要准
        assert scrub_text_with_flag('cookies=abcdefgh') == ('cookies=' + REDACTED, True)
        assert scrub_text_with_flag('今天好累') == ('今天好累', False)

        # ── ⑧ 重复计数：第 3 次返回 3（验收用例）
        h = hash_of('abc123')
        for i in (1, 2, 3):
            assert bump_repeat(h) == i, f"第 {i} 次 bump 应返回 {i}"
        assert repeat_count(h) == 3
        # 同一句真的被写 3 次 → 自动升级（不用外部调 bump_repeat）
        for _ in range(3):
            rr = write_candidate('明天还要早起好烦', SID, '未匹配')
        assert rr['repeat'] == 3 and rr.get('escalated') is True, rr
        assert bump_repeat('') == 0 and bump_repeat(None) == 0, "空 hash 不该计数"
        # 重复事件不混进候选列表
        assert all(x.get('kind') == 'candidate' for x in list_candidates(limit=0))
        assert any(x.get('kind') == 'repeat' for x in list_candidates(limit=0, include_repeats=True))

        # ── ⑨ 统计（不写死条数：写入会自动计数，"明天还要早起好烦" 写了 3 次）
        n_now = len(list_candidates(limit=0))
        st = stats()
        # ⑤2 条 + ⑥force 1 条 + ⑦清洗 1 条 + ⑧重复 3 条 = 7
        assert n_now == 7, n_now
        assert st['total'] == n_now, st
        assert st['today'] == n_now, st                  # 刚写的都在今天
        assert st['by_reason'], st
        # 到 3 次的有两条：⑧ 手工 bump 的 'abc123'、⑧ 写了 3 次的「明天还要早起好烦」
        assert st['escalated'] == 2, st
        # 7 次写入各计 1 次 + 手工 bump 3 次 = 10
        assert st['repeats'] == 7 + 3, st
        assert st['bad_lines'] == 0, st
        assert st['path'] == CANDIDATE_PATH

        # ── ⑩ 清理：20 天前的那条要被清掉，新的留着
        old_at = time.time() - 20 * 86400
        _append_record({'kind': 'candidate', 'id': 'cand_old', 'at': old_at,
                        'content': '很久以前的一句', 'reason': '未匹配任何规则',
                        'category': 'misc', 'status': 'pending'})
        _append_record({'kind': 'repeat', 'content_hash': 'old_hash', 'at': old_at})
        assert stats()['total'] == n_now + 1
        removed = clear_old(14)
        assert removed == 2, f"应清掉 2 条（1 候选 + 1 重复），实际 {removed}"
        assert stats()['total'] == n_now

        # ── ⑪ 坏行不能炸（模拟崩溃留下的半行）
        with open(CANDIDATE_PATH, 'a', encoding='utf-8') as f:
            f.write('{"kind": "candidate", "content": "半个 js\n')
        st2 = stats()
        assert st2['bad_lines'] == 1, st2
        assert st2['total'] == n_now, "坏行不该被当成候选"

        # ── ⑫ 写入回读验证：静默失败不能报成功（2026-11-08 加）
        #   这是「破坏性验证」：把 _append_record 换成什么都不做的函数，
        #   模拟「写入静默失败但没抛异常」。没有这条断言，
        #   write_candidate 会永远报 written=True —— 正是今天在查的假绿。
        #
        #   为什么必须真去破坏：光看代码只能知道「有没有能红的结构」，
        #   只有破坏一次才知道「真的会红」。（评审 的静态审查结论）
        _orig_append = globals()['_append_record']
        try:
            globals()['_append_record'] = lambda rec: None
            bad = write_candidate('今天好累', SID, '未匹配')
            assert bad['written'] is False and bad.get('skipped') == 'verify', bad
        finally:
            globals()['_append_record'] = _orig_append
        assert write_candidate('今天好累', SID, '未匹配')['written'] is True, '恢复后应正常'

        # ── ⑬ 只写不读：绝不把召回层拖进来（设计 1.2 / 3.4 第②条）
        for forbidden in ('memory_manager', 'recall_engine', 'associate_engine',
                          'daily_consolidation'):
            assert forbidden not in sys.modules, f"候选池不该 import {forbidden}"

        print("candidate_pool.py selftest OK")
        print(f"  门控 {len(cases)} 条验收用例全过 | 元讨论词 {len(META_WORDS)} 个"
              f"（强词 {len(META_STRONG)}）")
        print(f"  写入/读回/清洗/计数/清理 全过 | 重复阈值 {ESCALATE_AFTER} 次"
              f" | 保留 {CANDIDATE_KEEP_DAYS} 天")
    finally:
        CANDIDATE_PATH = saved_path
        if was_on:
            try:
                _feat_on(FEATURE_NAME)
            except Exception:
                pass
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    selftest()
