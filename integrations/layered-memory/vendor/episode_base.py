# -*- coding: utf-8 -*-
"""情景档 · 基础层（2026-11-09 从 episode.py 拆出）

## 这里放什么

**零依赖的工具函数和常量**——它们被 episode.py 的其他所有部分用到，
自己却不依赖任何业务逻辑。

    · 属性/字段读取的容错封装  _attr / _ts_of / _content_of / _id_of
    · 段（Segment）的访问器      _seg_mems / _seg_get
    · 文本清洗                  _strip_quotes
    · 日期                      date_of
    · 常量                      主题猜测 / 动作提取 / 噪声过滤 / 召回的阈值

## 为什么先拆这一层

episode.py 原来 3038 行，67 个函数互相纠缠：
    _attr      被 16 个函数调
    _ts_of      被  9 个
    _is_episode 被  6 个
    _content_of 被  5 个
    _id_of      被  5 个

按「业务功能」拆会让每个新模块都得 import 一堆小工具。
按**依赖层次**拆：先把最底层的零依赖部分抽出来，
上面的模块全部单向依赖它，不会产生循环。

## 稳定性

这些函数的行为**一个字都没改**——是从原文件按行原样切过来的。
拆分只是搬家，不是重构。
"""
import math
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

# 兜底主题名。**必须永远有值** —— 见 theme_of 的注释。
FALLBACK_THEME = "闲聊"


# 「猜」主题前缀：一眼能看出这条是词表外的话题，方便 audit 时抓出来补词。
GUESS_PREFIX = "临时:"


# 猜主题时先剥掉的对话壳子 / 人称 / 语气词。
# 顺序有意义：长词在前（「我们」必须在「我」前面，否则被切成「们…」）。
_GUESS_PREFIXES = (
    "我们", "咱们", "你们", "他们", "她们", "朋友", "我爸",
    "你", "我", "他", "她",
    "那", "就", "要不", "然后", "还是",
    "嗯", "哦", "啊", "噢", "唉",
)


# 结尾语气词：猜主题时去掉，让「看电影吧」→「看电影」
_GUESS_TAIL = "吧呀呢啊哦嘛啦哟哈呗么了"



def _strip_quotes(text: str) -> str:
    """剥掉被引用的那部分（[引用 xxx] / 方括号 / 方头括号 / 书名号）。

    只用于**判主题**，不用于展示 —— 原文一个字都不改。
    """
    t = str(text or "")
    t = re.sub(r"\[[^\]]*\]", "", t)
    t = re.sub(r"【[^】]*】", "", t)
    t = re.sub(r"「[^」]*」", "", t)
    return t



# 猜主题时**不算信息**的东西：纯应答词、工具产物、时间。
#
# 为什么必须挡：
#   真实数据里「他说：[拍一拍] <owner-id> 戳了戳 你；我回：收到提醒后记下了时间」
#   洗出来是「2154」—— 这是 用户 ID，不是话题。
#   不挡的话它会被判成「临时话题」，而 guess 是「只要出现就切」，
#   于是一条纯应答把整晚的对话切得七零八落（实测把连续 4 条睡段切成 3 段）。
#   挡掉之后它落到 fallback「闲聊」，按规则不切，正确并入上一段。
_GUESS_NOISE_RE = re.compile(
    r"^\d+$"                        # 纯数字（用户 ID / 时间 / 编号）
    r"|[0-9]{5,}"                    # 长数字串
    r"|拍一拍|戳了戳|图片|表情|语音|视频|文件|转发|撤回"
    r"|早|晚安|嗯|哦|啊|哈|呀|好|是|对|行|可以|谢谢|没事"
)


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        v = obj.get(name, default)
    else:
        v = getattr(obj, name, default)
    return default if v is None else v



def _content_of(m: Any) -> str:
    return str(_attr(m, "content", "") or "")



def _ts_of(m: Any) -> float:
    try:
        return float(_attr(m, "create_time", 0) or 0)
    except (TypeError, ValueError):
        return 0.0



def _id_of(m: Any) -> str:
    return str(_attr(m, "mem_id", "") or "")



def date_of(m: Any) -> str:
    """本地自然日 'YYYY-MM-DD'。

    跨天判定必须用**自然日**，不能用时间差 ——
    23:59「晚安」和 00:01「睡不着」时间差只有 2 分钟，
    但它们是两天的事，用 gap 判会合成一件。（问题4 的修复）
    """
    return time.strftime("%Y-%m-%d", time.localtime(_ts_of(m)))


CHAT_SEG_MAX = 10        # 「闲聊」段最多 10 条（config 里没有对应项，留在这里）



def _seg_mems(seg: Any) -> List[Any]:
    if isinstance(seg, dict):
        return list(seg.get("mems") or [])
    return list(getattr(seg, "mems", []) or [])



def _seg_get(seg: Any, key: str, default: Any = None) -> Any:
    if isinstance(seg, dict):
        return seg.get(key, default)
    return getattr(seg, key, default)


# ``_seg_date`` 传错类型时要不要立刻炸。
#   2026-11-08 加（会话F 验收发现）：第一版因为 NameError 被除吞掉了，导致
#   跨天守卫永远不生效；第二版又有「传裸 list → getattr 拿不到 mems → 静默空」。
#   两次都是「兜底吞掉编程错误」。
#
#   折中：开发/测试期默认 raise（立刻暴露），生产可设 ``DSH_EPISODE_STRICT=0`` 关掉。
#   注意：空段 / 段里没有可用时间戳 → 仍然返回 ""（这是合法的「判不出」）。
_STRICT_TYPES = os.environ.get("DSH_EPISODE_STRICT", "1") != "0"



# 主题标签的优先级：判得准的压过判不准的。
#   known（词表命中）> guess（字面猜的）> fallback（根本没判出来）
#
# 为什么不能纯按票数：实测 20:04~20:06 那一段 4 条里，
#   吃饭 ×1、做饭 ×1、闲聊 ×2 —— 纯多数票会标成「闲聊」。
#   但这一整段明明就是在说「你吃完了吗 / 汤都喝光了」。
#   「闲聊」不是一种主题，它是「我没判出来」，拿它去赢真主题是错的。
#   改成：先按 kind 分层，同层内再比票数；票数相同取先出现的（结果可复现）。
_KIND_RANK = {"known": 0, "guess": 1, "fallback": 2}


ACTION_MAX_COUNT = 3          # 一条 content 最多挂几个动作，多了读不下去


ACTION_MIN_LEN = 4            # 括号里短于 4 字的当语气，不是动作


ACTION_MAX_LEN = 40           # 长于 40 字的括号是整段描写，塞进去太肥


_ACTION_RE = re.compile(r"[（(]([^（）()]{2,80})[）)]")


SPARSE = "sparse"          # content_source 取值：这条档没摘到任何有信息量的内容


# 「有信息量」的门槛：去掉元信息后至少剩这么多字才算不漏
MIN_CONTENT_CHARS = 12


# 纯语气 / 纯应答：整句都是这些字就算没信息量
_FILLER_CHARS = set("嗯哦啊呀哈是的对好行可以谢谢没事吧呢吗嘛啦哟呗么了在就都还也都和吧")


# 摘句时先剥掉的对话壳子（与 _clean_for_guess 同源，但这里要保留正文）
_SPEAKER_RE = re.compile(r"他\s*说\s*[:：]?|我\s*回\s*[:：]?|你\s*说\s*[:：]?")


_QUOTE_RE = re.compile(r"\[[^\]]*\]|【[^】]*】|「[^」]*」")


# 「拍一拍」这类系统消息：用户 ID + 戳了戳 你 / 拍了拍 你。
# 实测摘句会摘出「<owner-id> 戳了戳 你；那我先躺着…」——
# 前半截是平台噪声，不是对话内容，塞进 content 等于污染情景档。
_SYSNOISE_RE = re.compile(r"\d{5,}\s*(戳了戳|拍了拍|戳|拍)?\s*你?")


_SYS_NOISE_SEG_RE = re.compile(r"戳了戳|拍了拍|\[图片\]|\[表情\]|^\d{5,}$")


LEGACY_GROUP = "legacy"

def _cosine(vec1, vec2) -> float:
    """余弦相似度 0~1；长度不匹配 / 空 / 零向量一律返回 0.0。

    为什么在这里重写一遍而不 import recall_engine：
        episode 是 L2，recall_engine 是 L3 —— import 它就把依赖方向弄反了
        （recall_engine 的上游会回头 import 我，成环）。
    语义跟 recall_engine.cosine_similarity **逐条对齐**：
      长度不等 → 0；任一侧范数为 0 → 0；结果负数钳到 0。
    """
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    n1 = math.sqrt(sum(a * a for a in vec1))
    n2 = math.sqrt(sum(b * b for b in vec2))
    if n1 == 0 or n2 == 0:
        return 0.0
    return max(0.0, dot / (n1 * n2))

def _embedding_of(ep) -> list:
    """取档的向量。拿不到 / 全零 → 返回 []（表示「判不了相似度」）。"""
    vec = _attr(ep, "embedding", None)
    if not vec:
        return []
    try:
        if not any(float(x) != 0.0 for x in vec):
            return []
        return list(vec)
    except (TypeError, ValueError):
        return []
