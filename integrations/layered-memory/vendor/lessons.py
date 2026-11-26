# -*- coding: utf-8 -*-
"""经验提炼 lessons.py —— 从「看到的东西」提炼「可以照着做的道理」（T16，2026-11-08）

## 它解决什么

    输入：3 条记忆
      「今天调 ffmpeg 参数调了两小时」
      「后来发现是 -vf 里少了个转义」
      「以后先用简单命令测一遍」

    输出：1 条经验
      「ffmpeg：先用最简单命令验证链路通不通」

记忆库现在有 200 多条「发生过什么」，但**没有一条「以后该怎么做」**。
lessons 就是那层加工：把同主题的多条见闻，压成一句能照着做的。

## 为什么用规则，不用模型

实测确认（GET http://127.0.0.1:11434/api/tags）：

    models[0].name         = bge-m3:latest
    models[0].capabilities = ["embedding"]      ← 只有 embedding，没有对话模型

所以「让模型总结成一句道理」这条路根本走不通（写出来也只会在生产上抛异常）。
这里全部用规则：

    ① 关键词命中      → 这条像不像「教训」
    ② 主题词表聚类    → 这几条是不是同一件事
    ③ 摘句 + 主题前缀 → 拼成一句

为什么不用向量聚类：仿照 episode.py 的实测结论 —— bge-m3 在短句上
「同一件事」和「不同事」的余弦相似度差距小于噪声（0.034 vs 0.044），
任何阈值都分不开。所以聚类用词表（可解释、可审计、可补），
向量只用在**写库**和**去重**上（那里向量是真有用的）。

## 三条硬规则

    ① 不编         —— content 只从原文摘，绝不生成原文里没有的说法
    ② 推不出来就空 —— 凑不够 min_cluster 就返回 []，不硬凑
    ③ 只写不读     —— 这一阶段经验**不参与召回**，先攒数据观察质量

## 字段（复用现有 schema，不新增死字段）

    mem_type          = "lesson"
    category          = "skill"
    source_turns      = 支撑这条经验的原文 mem_id 列表（复用 episode 的字段）
    content_source    = "generated"      ← 防污染：它是归纳出来的，不是原话
    content_confidence= "high" / "medium"
    embed_status      = ok / pending / failed（ollama 挂了也照样写库）

## 用法

    python lessons.py              # 自检（跟不传参数一样，等价于 selftest）
    python lessons.py run          # 用真实库跑一遍，只打印，不写库
    python lessons.py --save       # 跑完写库（受 LESSON_MAX_PER_DAY 限制）
    python lessons.py selftest     # 自检（不碰真实数据，不联网）

    from lessons import extract_lessons, save_lessons
    lessons = extract_lessons(memories)     # memories = [MemoryItem, ...]
    n = save_lessons(lessons)               # 写进 active.json，返回写入条数

## 怎么验（四关）

    ① 字段在   —— mem_type/lesson、category/skill 能落到 active.json
    ② 有人调   —— daily_consolidation 第 6 步调它（link_check 能扫到）
    ③ 有效果   —— 真实数据跑出 >0 条经验，且每条能回溯到 source_mems
    ④ 真链路   —— 跑一次巩固，stats['lessons_created'] 非 0
"""

from common.locking import NullLock
import hashlib
import json
import os
import re
import sys
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ═══════════════════════════════════════════════════════════════════
# UTF-8 守卫（2026-11-07 全项目教训）
#
# 中文 Windows 终端默认 GBK，print 中文/emoji 直接 UnicodeEncodeError 崩掉。
# 实测 link_check / test_shortterm / regression_test 都这么死过。
# 必须在任何输出前设置编码。
# ═══════════════════════════════════════════════════════════════════
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ═══════════════════════════════════════════════════════════════════
# 依赖：只 import L1/L2（config / schema）
#
# 为什么不 import memory_manager：那是 L3，它反过来要调本模块，
# import 就成环。写库这里自己带一把锁 + 原子写（跟 episode.py 同款）。
# ═══════════════════════════════════════════════════════════════════
from config import (                      # noqa: E402
    LONG_TERM_ACTIVE_PATH,
    LOCK_FILE_PATH,
    LESSON_MIN_CLUSTER,
    LESSON_CONFIDENCE,
    LESSON_MAX_PER_DAY,
)
from schema import MemoryItem             # noqa: E402

try:
    from filelock import FileLock
except Exception:                         # 没装 filelock 也不能让整个模块 import 失败
    FileLock = None


# ═══════════════════════════════════════════════════════════════════
# 一、教训词表：这条像不像「可以照着做的道理」
#
# 权重（而不是布尔）的理由：
#   「发现/原来/走不通/别再」这种是**强信号** —— 出现基本就是在讲经验；
#   「以后/下次/应该」是**中信号** —— 更像计划，得跟具体动作一起才成经验；
#   「记得/注意」是**弱信号** —— 单独出现太多误判，只做加权不做判据。
#
# 判据：score >= LESSON_MIN_SIGNAL（2）。所以「记得」单独出现(1分)不算，
# 「以后先用简单命令测一遍」(以后 2 + 先用 3 = 5) 算。
# ═══════════════════════════════════════════════════════════════════
LESSON_WORDS: List[Tuple[str, int]] = [
    # ── 强信号：出现就是在讲教训 ──────────────────────────
    ("教训", 3), ("踩坑", 3), ("走不通", 3), ("别再", 3),
    ("发现", 3), ("原来", 3), ("根本原因", 3), ("正确做法", 3),
    ("要先", 3), ("先用", 3), ("得先", 3), ("下次要", 3), ("以后要", 3),
    # ── 中信号：面向未来的动作 ────────────────────────────
    ("问题是", 2), ("原因是", 2), ("建议", 2), ("最好", 2), ("应该", 2),
    ("必须", 2), ("以后", 2), ("下次", 2), ("注意", 2), ("小心", 2),
    ("办法", 2), ("方法", 2), ("不要", 2), ("不能", 2), ("禁止", 2),
    ("只能", 2),
    # ── 弱信号：只加权，不单独当判据 ──────────────────────
    ("记得", 1), ("提醒", 1), ("确认", 1), ("试试", 1),
]

LESSON_MIN_SIGNAL = 2          # 低于这个分数不算「教训候选」
LESSON_MIN_CHARS = 6           # 太短的句子（「嗯」「好」）连判都不用判
LESSON_CORE_MAX = 80           # 摘出来的那一句最多留多少字
LESSON_CONF_MAX = 0.85         # 规则版置信度的天花板（别装成模型那么确定）

# 2026-11-08 实测发现的假阳性（真实 226 条里全踩到了）：
#   「17点以后不限」        → 「以后」当时间后缀，不是「以后要怎么做」
#   「他还问要不要关掉」    → 「不要」藏在「要不要」里
#   「能不能改成白天睡」    → 「不能」藏在「能不能」里
#   「最好笑的是那条秦岭」  → 「最好」后面跟的是「笑」
# 所以这几个词不能裸匹配，得带守卫。守卫用零宽断言，
# **不消费字符** —— 匹配出来的 group(0) 仍然是原词本身，权重表不用改。
_GUARDED = {
    "以后": r"(?<![d点分时号天日])以后",
    "不要": r"(?<!要)不要",
    "不能": r"(?<!能)不能",
    "最好": r"最好(?!笑)",
    "下次": r"(?<!这)下次",
}

# 编译成一次正则，避免每条记忆跑 30 次 str.find
_LESSON_RE = re.compile("|".join(_GUARDED.get(w, re.escape(w)) for w, _ in LESSON_WORDS))
_WEIGHT_MAP = dict(LESSON_WORDS)


def lesson_signal(text: str) -> Tuple[int, List[str]]:
    """返回 (权重和, 命中的词列表)。纯函数，不改任何状态。"""
    t = str(text or "")
    if not t:
        return 0, []
    hits: List[str] = []
    score = 0
    for m in _LESSON_RE.finditer(t):
        w = m.group(0)
        if w in hits:            # 同一个词只算一次（「以后」出现两次不加两次分）
            continue
        hits.append(w)
        score += _WEIGHT_MAP.get(w, 1)
    return score, hits


def is_lesson_candidate(text: str) -> bool:
    """这条像不像「教训」。

    关键词：发现/原来/应该/以后/下次/教训/踩坑/注意 …

    判据 = 权重和 >= 2 且长度 >= 6。
    只判「像不像」，不判「配不配成为一条经验」——
    后者要等 extract_lessons 里的聚类（同主题 >= min_cluster 条）说了算。
    """
    t = str(text or "").strip()
    if len(t) < LESSON_MIN_CHARS:
        return False
    score, _hits = lesson_signal(t)
    return score >= LESSON_MIN_SIGNAL


# ═══════════════════════════════════════════════════════════════════
# 二、主题词表：这几条是不是同一件事
#
# 顺序有意义：命中靠前的优先（「删除与权限」比「桥接与工具」更具体）。
# 每条记忆只归到**第一个命中的主题**，不允许多重归属 ——
# 允许多重的话，一条记忆会同时支撑好几条经验，簇会互相污染。
# ═══════════════════════════════════════════════════════════════════
TOPIC_WORDS: List[Tuple[str, Tuple[str, ...]]] = [
    # 「删」单字就够：中文里「删东西 / 删什么 / 删掉」几乎必然是这件事。
    #   实测踩过：只写「删除」时，「以后删东西先问过他同意」判不出主题 → 簇凑不满 → 整条漏掉。
    ("删除与权限", ("删", "清理", "覆盖", "权限", "批准")),
    ("声音", ("声音", "语音", "音色", "rvc", "变调", "唱歌", "翻唱", "合成")),
    ("画图", ("画图", "生图", "出图", "提示词", "lora", "显存")),
    ("记忆系统", ("记忆", "召回", "向量", "巩固", "衰减", "embedding")),
    ("短视频", ("短视频", "评论", "分享卡片", "热搜", "私信")),
    ("桥接与工具", ("桥接", "插件", "工具", "接口", "api", "命令", "脚本", "重启")),
    ("电脑", ("电脑", "显卡", "12GB", "内存", "硬盘", "休眠", "开机")),
    ("说话方式", ("说话", "语气", "口吻", "括号")),
    ("睡觉", ("睡觉", "晚安", "熬夜", "早起", "失眠")),
    ("吃饭", ("吃饭", "做饭", "火锅", "煮面", "煮粥")),
    ("学业", ("雅思", "考试", "上课", "课表", "作业", "ppt")),
]


def topic_of(text: str) -> str:
    """判主题。命中不了返回空串（空串不入簇 —— 宁可少提炼，不硬凑）。"""
    t = str(text or "").lower()
    if not t:
        return ""
    for topic, words in TOPIC_WORDS:
        for w in words:
            if w.lower() in t:
                return topic
    return ""


# ═══════════════════════════════════════════════════════════════════
# 三、摘句：从一条记忆里摘出「那句道理」
#
# 为什么是摘句而不是生成：
#   生成 = 编。规则版能保证「每个字都出自原文」，
#   而拼错字、编造因果恰恰是模型最容易犯、最难被发现的错。
#   摘句的代价是句子可能偏长、偏土，但**可审计** ——
#   任何一条经验都能顺着 source_mems 找回原文，一眼看出是不是原文那句话。
# ═══════════════════════════════════════════════════════════════════

# 分句：句号/叹号/问号/分号/换行，以及「他说：X；我回：Y」的斜杠分隔
_CLAUSE_SPLIT = re.compile(r"[。！？；;\n]+|(?<=[）)])\s*/")


def _strip_prefix(text: str) -> str:
    """剥掉不会给经验加信息的前缀：日期戳、「他说：」「我回：」。"""
    t = str(text or "").strip()
    # 「2026-10-27：」/「10月27日。」/「11/7 」
    t = re.sub(r"^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?[：:\s]*", "", t)
    t = re.sub(r"^\d{1,2}[/月]\d{1,2}[日号]?[：:\s]*", "", t)
    # 「他说：」「我回：」
    t = re.sub(r"^(他说了|他说|我回了|我回)\s*[：:]?\s*", "", t)
    # 「用户交代：」「他明确说过：」这类转述壳子。
    #   不剥的话，真正像指令的那半句（「不要顺带关掉…」）会被埋在壳子后面，
    #   摘句时输给一条只是叙述「…用了 .optional() 这个方法」的排障记录。
    #   注意**不能**剥「他要我 / 他让我」—— 那不是壳子，是主语，剥掉句子就断了
    #   （实测：「他要我说话客气一点」→「说话必须叫朋友」，意思变了）。
    t = re.sub(r"^(用户交代|用户说|用户定了|他交代|他明确说过|他明确说|他说过)"
               r"\s*[：:]?\s*", "", t)
    return t.strip()


def _clauses(text: str) -> List[str]:
    """切成短句（纯函数）。"""
    t = str(text or "")
    if not t:
        return []
    out = []
    for piece in _CLAUSE_SPLIT.split(t):
        p = _strip_prefix(piece)
        p = p.strip(" ，,、·-—")
        if len(p) >= 4:
            out.append(p)
    return out


# 「这句话本身就是一条指令」的特征：以这些词开头，读起来就是「以后该怎么做」。
# 实测（真实 226 条）：不判这个的话，会挑出「…这个方法怎么怎么样」这种
# 只是在叙述的句子 —— 关键词命中但不像道理。
_DIRECTIVE_HEAD = re.compile(
    r"^(以后|下次|下次要|以后要|要|别|别再|不要|不能|禁止|必须|应该|得|先用|要先|"
    r"先|记得|注意|小心|正确做法|办法|方法是|问题是|原因是|建议|最好|只能)")


def _clip(text: str, limit: int = LESSON_CORE_MAX) -> str:
    """截断到 limit 字以内，尽量断在标点上（别把一句话从中间劈开）。"""
    t = str(text or "").strip()
    if len(t) <= limit:
        return t
    head = t[:limit]
    for sep in "，,、；;：:":
        idx = head.rfind(sep)
        if idx >= limit // 2:       # 断点太靠前就不值得断，直接硬截
            return head[:idx] + "…"
    return head + "…"


def pick_core(text: str) -> Tuple[str, List[str]]:
    """从一条记忆里挑出最能当「道理」的那一句。

    返回 (句子, 命中的教训词)。
    挑法：教训词权重高的优先；同权重时，**像指令的**（以「以后/别/要先…」开头）优先；
    再同分取长的（长的信息量大）；都挑不出就用最短的整句。
    """
    clauses = _clauses(text)
    if not clauses:
        core = _strip_prefix(text)
        return _clip(core), []
    best, best_rank, best_hits = "", None, []
    for c in clauses:
        score, hits = lesson_signal(c)
        rank = (score, 1 if _DIRECTIVE_HEAD.match(c) else 0, len(c))
        if best_rank is None or rank > best_rank:
            best, best_rank, best_hits = c, rank, hits
    if not best:
        best = min(clauses, key=len)
    return _clip(best), best_hits


# ═══════════════════════════════════════════════════════════════════
# 四、正文归一化 / 相似度（去重和稳定 id 都用它）
# ═══════════════════════════════════════════════════════════════════


def _norm(text: str) -> str:
    """去掉标点空白，只留字（去重、算 id 用）。"""
    return re.sub(r"[\s\W_]+", "", str(text or ""))


def _bigrams(text: str) -> set:
    s = _norm(text)
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def _containment(a: str, b: str) -> float:
    """包含度 = 交集 / 较少者的集合。

    除以 min 而不是并集（Jaccard）的理由见主设计 18.4：
    「吃了火锅」⊂「去吃了火锅」 应该判成同一句，Jaccard 只给 0.67。
    """
    ba, bb = _bigrams(a), _bigrams(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / min(len(ba), len(bb))


def _stable_lesson_id(topic: str, core: str) -> str:
    """由「主题 + 原文那一句」派生的稳定 id。

    为什么不用随机：每天巩固都会重跑一遍，
    随机 id 会让同一条经验在库里越攒越多（memory-brain 那边的老问题）。
    """
    seed = (topic + "|" + _norm(core)).encode("utf-8")
    return "les_" + hashlib.sha1(seed).hexdigest()[:12]


# ═══════════════════════════════════════════════════════════════════
# 五、主入口：提炼
# ═══════════════════════════════════════════════════════════════════


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    """dict 和 MemoryItem 两种形状都能取（巩固流程有时给 dict）。"""
    if isinstance(obj, dict):
        v = obj.get(name, default)
    else:
        v = getattr(obj, name, default)
    return default if v is None else v


def _content_of(m: Any) -> str:
    return str(_attr(m, "content", "") or "")


def _id_of(m: Any) -> str:
    return str(_attr(m, "mem_id", "") or "")


def extract_lessons(memories: Iterable[Any], min_cluster: Optional[int] = None) -> List[dict]:
    """从一组记忆里提炼经验（纯规则，不调模型）。

    三步（对应任务书的要求）：
      ① 找同一主题的 >= min_cluster 条
      ② 其中要有含「教训/发现/以后」这类词的
      ③ 把最像道理的那一句摘出来，加主题前缀

    返回：
      [{"content": "...",
        "source_mems": [...],        # 支撑它的原文 mem_id
        "confidence": 0.6,           # 规则版，默认 0.6，条数多会略升
        "topic": "画图",
        "why": "...",                # 为什么提炼出这条（可审计）
        "mem_id": "les_xxxxxxxx"}, ...]

    凑不够就返回 [] —— 不硬凑（memory-brain 的「推不出来就输出 []」）。
    """
    n_min = int(LESSON_MIN_CLUSTER if min_cluster is None else min_cluster)
    n_min = max(2, n_min)

    # ① 过一遍候选：像教训 + 有主题
    buckets: Dict[str, List[dict]] = {}
    for m in (memories or []):
        content = _content_of(m)
        if not content.strip():
            continue
        if not is_lesson_candidate(content):
            continue
        topic = topic_of(content)
        if not topic:              # 没有主题 = 归不了簇 = 不参与（宁缺毋滥）
            continue
        core, hits = pick_core(content)
        if not core:
            continue
        score, _ = lesson_signal(core)
        buckets.setdefault(topic, []).append({
            "mem_id": _id_of(m),
            "core": core,
            "hits": hits,
            "score": score,
        })

    lessons: List[dict] = []
    for topic, items in buckets.items():
        # ② 同一主题够不够 min_cluster 条（按原始条数算，不是按不同句子算）
        if len(items) < n_min:
            continue
        # 摘句去重：同一句话被记了两次，不能当两条支撑
        uniq: Dict[str, dict] = {}
        for it in items:
            key = _norm(it["core"])[:40]
            old = uniq.get(key)
            if old is None:
                cur = dict(it)
                cur["ids"] = {it["mem_id"]}
                uniq[key] = cur
            else:
                old["ids"] |= {it["mem_id"]}
                if it["score"] > old["score"]:
                    old["core"] = it["core"]
                    old["score"] = it["score"]
                    old["hits"] = it["hits"]
        if len(uniq) < 2:
            # N 条都在说同一句 → 这是「同一件事被记了两遍」，
            # 不是「多角度印证」。这类不提炼，否则只是把一句原话抄成经验。
            continue

        best = max(uniq.values(), key=lambda x: (x["score"], len(x["core"])))
        support_ids = sorted({i for it in uniq.values() for i in it["ids"] if i})
        extra = max(0, len(uniq) - 2)
        conf = round(min(LESSON_CONF_MAX, float(LESSON_CONFIDENCE) + 0.03 * extra), 3)
        # core 自己带冒号时（「…的权限：以后…」）会拼成两个冒号，很难看 ——
        # 用「，」接住，读起来还是一句话。
        core_text = best["core"]
        if core_text.startswith(topic):
            # 句子自己就以主题开头（「短视频那套工具的插件…」）→ 不用再加前缀，
            # 否则会拼成「短视频：短视频那套…」，读起来像结巴。
            content_text = core_text
        elif "：" in core_text or ":" in core_text:
            content_text = topic + "，" + core_text
        else:
            content_text = topic + "：" + core_text
        lessons.append({
            "content": content_text,
            "source_mems": support_ids,
            "confidence": conf,
            "topic": topic,
            "why": ("同主题 %d 条里 %d 句不同说法，命中「%s」"
                    % (len(items), len(uniq), "/".join(best["hits"]) or "无")),
            "mem_id": _stable_lesson_id(topic, best["core"]),
        })

    # 置信度高的先出（写库时按这个顺序吃每日配额）
    lessons.sort(key=lambda x: (-x["confidence"], -len(x["source_mems"])))
    return lessons


# ═══════════════════════════════════════════════════════════════════
# 六、合并去重
# ═══════════════════════════════════════════════════════════════════


def merge_lessons(lessons: Iterable[dict]) -> List[dict]:
    """属性相同的经验合并去重。

    两种「相同」都算：
      ① mem_id 相同（同一主题同一句 → 一定重复）
      ② 同主题且正文包含度 >= 0.85（换了说法但说的是同一件事）

    合并规则：留正文更长的那条，source_mems 取并集，confidence 取最高。
    """
    out: List[dict] = []
    for les in (lessons or []):
        if not isinstance(les, dict) or not str(les.get("content") or "").strip():
            continue
        cur = dict(les)
        cur["source_mems"] = list(cur.get("source_mems") or [])
        merged = False
        for i, kept in enumerate(out):
            same_id = bool(kept.get("mem_id")) and cur.get("mem_id") == kept.get("mem_id")
            same_topic = kept.get("topic") == cur.get("topic")
            sim = _containment(kept.get("content", ""), cur.get("content", ""))
            if not same_id and not (same_topic and sim >= 0.85):
                continue
            ids = set(kept.get("source_mems") or []) | set(cur.get("source_mems") or [])
            if len(kept.get("content", "")) >= len(cur.get("content", "")):
                merged_item = dict(kept)
            else:
                merged_item = dict(cur)
            merged_item["source_mems"] = sorted(ids)
            merged_item["confidence"] = max(float(kept.get("confidence") or 0),
                                            float(cur.get("confidence") or 0))
            out[i] = merged_item
            merged = True
            break
        if not merged:
            out.append(cur)
    out.sort(key=lambda x: (-float(x.get("confidence") or 0), -len(x.get("source_mems") or [])))
    return out


# ═══════════════════════════════════════════════════════════════════
# 七、写库（只写不读）
#
# 注意：这一阶段经验**不参与召回**（recall_engine 里没有读 mem_type == "lesson"）。
# 写进 active.json 只是让它开始存在、能被 memory_cli / dataflow 看到，
# 观察 1-2 周质量再决定接不接召回。
# ═══════════════════════════════════════════════════════════════════


def _today_str() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


def _date_of_ts(ts) -> str:
    try:
        return time.strftime("%Y-%m-%d", time.localtime(float(ts)))
    except (TypeError, ValueError, OSError):
        return ""


def _load_json_or_empty(path: str) -> dict:
    if not os.path.exists(path):
        return {"memories": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"memories": []}
        data.setdefault("memories", [])
        return data
    except Exception as e:
        # 读坏了不能把库覆盖成空的 —— 直接抛，让调用方记 lessons_error
        raise RuntimeError("读 %s 失败: %s" % (os.path.basename(path), e))


def _atomic_write_json(path: str, data: dict) -> None:
    """原子写 —— 转发到 atomic_io.atomic_write_json（2026-11-08 收敛）。

    原来这里自己抄了一份（不能 import memory_manager，那是 L3）。
    现在逻辑在 atomic_io（只依赖标准库），不会再制造循环依赖。

    sweep=False：不顺手清陈旧 tmp（那件维护者还没定）。
    """
    from atomic_io import atomic_write_json
    atomic_write_json(path, data, sweep=False)


class _NullLock(NullLock):
    """空锁 —— 转发到 common.locking.NullLock（2026-11-09 收敛）。

    原来这里自己写了一份 6 行的空锁，跟另外 5 个模块各写一遍。
    """


def _file_lock():
    """跟 memory_manager / 巩固流程同一把锁（2026-11-09 收敛到 common.locking）。"""
    from common.locking import memory_lock
    return memory_lock()


def _attach_embedding(item: MemoryItem) -> None:
    """算向量。失败不影响写库（ollama 挂了不能阻断经验落盘）。"""
    try:
        from ollama_embedding import get_embedding
        vec = get_embedding(item.content)
        if vec and any(float(x) != 0.0 for x in vec):
            item.embedding = list(vec)
            item.embed_status = "ok"
        else:
            item.embedding = []
            item.embed_status = "pending"
    except Exception:
        item.embedding = []
        item.embed_status = "failed"


def _to_memory_item(les: dict) -> MemoryItem:
    """经验 dict → MemoryItem（字段全部复用现有 schema）。"""
    content = str(les.get("content") or "").strip()
    item = MemoryItem(
        content,
        mem_type="lesson",
        category="skill",
        tags=["经验", str(les.get("topic") or "一般")],
        importance=0.70,          # 地板 42：不会被时间磨没，也进不了冷存
        strength=100.0,
        consolidation_level=3,    # 2 分/天，衰减最慢那一档
        source="lesson_extract",
        ttl=365 * 86400,
    )
    item.mem_id = str(les.get("mem_id") or item.mem_id)
    item.source_turns = list(les.get("source_mems") or [])   # 复用：回溯原文
    item.content_source = "generated"                        # 防污染：不是原话
    conf = float(les.get("confidence") or 0.0)
    item.content_confidence = "high" if conf >= 0.75 else "medium"
    item.embed_status = "pending"
    return item


def build_lesson_items(lessons: Iterable[dict], existing_rows: Iterable[dict],
                       today: Optional[str] = None, embed: bool = True) -> List[MemoryItem]:
    """算出「这次该新写哪几条经验」，**纯内存、不碰磁盘、不加锁**。

    为什么要拆出来（不是顺手）：
      每日巩固流程（daily_consolidation）**已经持有 memory_data.lock**，
      在里面再调 save_lessons 会二次加锁 → filelock 抛 RuntimeError: Deadlock
      （episode.save_episode 就踩过这个坑，注释写在 daily_consolidation 里）。
      所以巩固流程用本函数拿 item，自己 append 进内存列表、最后统一写盘；
      而 save_lessons 也走同一个函数，保证两条路的去重/配额规则完全一致。

    三条纪律（都在这里实现）：
      ① 每日上限 LESSON_MAX_PER_DAY —— 只吃剩下的配额
      ② 幂等 —— 同一个 mem_id / 同一句正文不重复写（每天重跑不会攒重复）
      ③ existing_rows 里已有的 lesson 也计入配额
    """
    merged = merge_lessons(lessons or [])
    if not merged:
        return []

    rows = [m for m in (existing_rows or []) if isinstance(m, dict)]
    day = today or _today_str()
    existing_ids = {str(m.get("mem_id") or "") for m in rows}
    existing_lessons = [m for m in rows if str(m.get("mem_type") or "") == "lesson"]
    existing_keys = {_norm(m.get("content")) for m in existing_lessons}
    used_today = sum(1 for m in existing_lessons
                     if _date_of_ts(m.get("create_time")) == day)
    budget = max(0, int(LESSON_MAX_PER_DAY) - used_today)

    out: List[MemoryItem] = []
    for les in merged:
        if len(out) >= budget:
            break
        mid = str(les.get("mem_id") or "")
        key = _norm(les.get("content"))
        if mid and mid in existing_ids:
            continue
        if key and key in existing_keys:
            continue
        item = _to_memory_item(les)
        if embed:
            _attach_embedding(item)
        existing_ids.add(item.mem_id)
        existing_keys.add(key)
        out.append(item)
    return out


def save_lessons(lessons: Iterable[dict], path: Optional[str] = None) -> int:
    """存进 active.json（mem_type='lesson'，category='skill'）。返回写入条数。

    单机脚本用（带锁）。巩固流程内部不要调它 —— 那里已经持锁了，
    请用 build_lesson_items 拿 item 自己写盘（见上面的说明）。
    """
    target = path or LONG_TERM_ACTIVE_PATH
    with _file_lock():
        data = _load_json_or_empty(target)
        mems = data.get("memories") or []
        items = build_lesson_items(lessons, mems)
        if not items:
            return 0
        mems.extend(item.to_dict() for item in items)
        data["memories"] = mems
        _atomic_write_json(target, data)
    return len(items)


# ═══════════════════════════════════════════════════════════════════
# 八、命令行入口（默认只打印，--save 才写库）
# ═══════════════════════════════════════════════════════════════════


def _load_real_memories(path: Optional[str] = None) -> List[MemoryItem]:
    p = path or LONG_TERM_ACTIVE_PATH
    data = _load_json_or_empty(p)
    out = []
    for d in data.get("memories") or []:
        try:
            out.append(MemoryItem.from_dict(d))
        except Exception:
            continue
    return out


def _cli(argv: List[str]) -> int:
    if "selftest" in argv or not ({"run", "extract", "--save"} & set(argv)):
        selftest()
        return 0

    mems = _load_real_memories()
    lessons = extract_lessons(mems)
    print("从 %d 条记忆提炼出 %d 条经验（同主题 >= %d 条才提炼）"
          % (len(mems), len(lessons), LESSON_MIN_CLUSTER))
    for les in lessons:
        print("  - [%.2f] %s" % (les["confidence"], les["content"][:80]))
        print("      支撑 %d 条 | %s" % (len(les["source_mems"]), les["why"]))
    if "--save" in argv:
        n = save_lessons(lessons)
        print("写库 %d 条（每日上限 %d）" % (n, LESSON_MAX_PER_DAY))
    return 0


# ═══════════════════════════════════════════════════════════════════
# 九、自检（不依赖真实数据、不联网、5 秒内跑完）
# ═══════════════════════════════════════════════════════════════════


def _mk(content: str, ts: Optional[float] = None, **kw) -> MemoryItem:
    m = MemoryItem(content, mem_type="long_term", **kw)
    if ts is not None:
        m.create_time = ts
        m.last_active = ts
        m.last_mentioned_at = ts
    return m


def selftest() -> None:
    # ── ① 关键词识别：任务书里给的四条用例，一条不许变
    cases = [
        ("发现是 -vf 里少了个转义", True),
        ("以后先用简单命令测一遍", True),
        ("今天吃了火锅", False),
        ("嗯", False),
    ]
    for text, expect in cases:
        got = is_lesson_candidate(text)
        assert got == expect, "is_lesson_candidate(%r) = %s，期望 %s" % (text, got, expect)

    # 边界：弱信号单独出现不算（「记得」只有 1 分）
    assert is_lesson_candidate("记得吃饭") is False, "弱信号单独出现不该算"
    # 边界：太短不算
    assert is_lesson_candidate("以后要") is False, "太短的句子不算"
    # 强信号 + 长度够 → 算
    assert is_lesson_candidate("别再拆段硬拼了，zip 打不开") is True

    # ── ② 主题判定：命中不了就返回空（宁可少提炼，不硬凑）
    assert topic_of("以后画图提示词要少写点") == "画图"
    assert topic_of("删除之前要先问他同意") == "删除与权限"
    assert topic_of("哈哈") == ""

    # ── ③ 摘句：只摘原文里的那一句，不改一个字
    src = ("2026-10-27：今天把短视频那套插件跑通了；评论一开始拉不下来，"
           "试了两回签名器才通；以后先用一条最简单的请求验通再批量跑")
    core, hits = pick_core(src)
    assert core.startswith("以后先用一条最简单的请求"), "摘错句: %s" % core
    assert "以后" in hits and "先用" in hits, hits
    assert len(core) <= LESSON_CORE_MAX

    # ── ④ 提炼：3 条同主题 → 1 条经验
    mems = [
        _mk("删除之前要先问他同意，他说不同意就停", ts=1.0),
        _mk("任何删除、清理、覆盖都要先问，问题是上次我直接动手就错了", ts=2.0),
        _mk("以后删东西先告诉他删什么、为什么，得等他回同意", ts=3.0),
        _mk("今天天气不错", ts=4.0),
    ]
    got = extract_lessons(mems)
    assert len(got) == 1, "3 条同主题应提炼 1 条，实际 %d" % len(got)
    les = got[0]
    for f in ("content", "source_mems", "confidence", "topic", "why", "mem_id"):
        assert f in les, "经验缺字段 %s" % f
    assert les["topic"] == "删除与权限"
    assert les["content"].startswith("删除与权限：")
    assert len(les["source_mems"]) >= 2, "至少要能回溯到 2 条原文"
    assert 0.5 <= les["confidence"] <= LESSON_CONF_MAX

    # ── ⑤ 条数不够就返回 []（不硬凑）
    assert extract_lessons(mems[:2]) == [], "只有 2 条不该提炼（min_cluster=3）"
    assert extract_lessons([], min_cluster=3) == []
    assert len(extract_lessons(mems[:2], min_cluster=2)) == 1, "min_cluster=2 时 2 条应提炼"

    # ── ⑥ 同一句被记了两遍 → 不算多角度印证（防「抄一句就成经验」）
    dup = [_mk("以后删东西先问过他同意，必须等同意", ts=1.0),
           _mk("以后删东西先问过他同意，必须等同意", ts=2.0),
           _mk("以后删东西先问过他同意，必须等同意", ts=3.0)]
    assert extract_lessons(dup) == [], "三条同一句不该当多角度印证"

    # ── ⑦ 合并去重：id 相同 / 正文高度包含 → 合成一条，source 取并集
    a = dict(les)
    a["source_mems"] = ["m1"]
    b = dict(les)
    b["mem_id"] = "les_other"
    b["source_mems"] = ["m2"]
    b["confidence"] = 0.8
    merged = merge_lessons([a, b])
    assert len(merged) == 1, "包含度高的两条应合并，实际 %d" % len(merged)
    assert merged[0]["source_mems"] == ["m1", "m2"], merged[0]["source_mems"]
    assert merged[0]["confidence"] == 0.8, "confidence 应取最高"
    other = {"content": "画图：提示词别超过五个", "source_mems": ["m9"],
             "confidence": 0.6, "topic": "画图", "why": "", "mem_id": "les_x"}
    assert len(merge_lessons([a, other])) == 2, "不同主题不该合并"

    # ── ⑧ 写库：写临时文件，绝不碰真实库；幂等 + 每日配额
    import tempfile
    tmpdir = tempfile.mkdtemp(prefix="les_selftest_")
    try:
        tmp_path = os.path.join(tmpdir, "active.json")
        n1 = save_lessons([les], path=tmp_path)
        assert n1 == 1, "首写应 1 条，实际 %d" % n1
        n2 = save_lessons([les], path=tmp_path)
        assert n2 == 0, "重跑必须幂等，实际又写了 %d 条" % n2
        saved = _load_json_or_empty(tmp_path)["memories"]
        assert len(saved) == 1, "库里应只有 1 条，实际 %d" % len(saved)
        row = saved[0]
        assert row["mem_type"] == "lesson" and row["category"] == "skill"
        assert row["content_source"] == "generated"
        assert row["source_turns"] == les["source_mems"], "回溯 id 必须落盘"
        assert row["mem_id"] == les["mem_id"], "稳定 id 必须落盘"
        # 过一遍磁盘往返（from_dict 会把没在 __init__ 声明的字段丢掉 —— 死字段坑）
        back = MemoryItem.from_dict(json.loads(json.dumps(row)))
        assert back.mem_type == "lesson" and back.source_turns == les["source_mems"]

        # 每日配额：补到上限后不再写
        many = []
        for i in range(6):
            many.append({"content": "画图：第" + str(i) + "条经验别超五个词",
                         "source_mems": ["x" + str(i)],
                         "confidence": 0.6, "topic": "画图", "why": "",
                         "mem_id": "les_fake_" + str(i)})
        n3 = save_lessons(many, path=tmp_path)
        assert n3 == max(0, LESSON_MAX_PER_DAY - 1), \
            "今日已写 1 条，应再写 %d 条，实际 %d" % (LESSON_MAX_PER_DAY - 1, n3)
        total = len(_load_json_or_empty(tmp_path)["memories"])
        assert total == LESSON_MAX_PER_DAY, "每天最多 %d 条，实际 %d" % (LESSON_MAX_PER_DAY, total)

        # 空输入不写、不报错
        assert save_lessons([], path=tmp_path) == 0
    finally:
        try:
            for fn in os.listdir(tmpdir):
                os.remove(os.path.join(tmpdir, fn))
            os.rmdir(tmpdir)
        except Exception:
            pass

    print("lessons.py selftest OK")
    print("  教训词 %d 个 | 主题 %d 类 | min_cluster=%d 置信度=%s 每日上限=%d"
          % (len(LESSON_WORDS), len(TOPIC_WORDS), LESSON_MIN_CLUSTER,
             LESSON_CONFIDENCE, LESSON_MAX_PER_DAY))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(_cli(sys.argv[1:]))
    selftest()
