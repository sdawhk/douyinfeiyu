# -*- coding: utf-8 -*-
r"""短期记忆「两档存储」模拟实现（独立模块，不碰真实代码/真实库）。

两档：
  摘要档 summary  —— 普通闲聊，只留摘要+话题+情绪，单条 ≤ 60 字
  整段档 full     —— 重要对话（争执/承诺/约定/在意的事），留原话，单条 ≤ 300 字

上限 + 淘汰：
  摘要档：每天最多 300 条，超了按 strength 淘汰最旧
  整段档：每天最多 30 条，超了按 importance 淘汰（重要的优先留）
"""

import re
import time
from typing import List, Dict, Optional


# 判断「重要对话」的关键词（该进整段档）
#
# 只保留与「事件量级」相关的判据：争执、承诺、人生大事。原来的第一行是一组
# 原先的第一组关键词随已移除的图层一起删除，只保留事件量级判据。
IMPORTANT_PATTERNS = [
    r"生气|吵|分手|滚|烦死|别理我",           # 争吵 / 情绪重
    r"我答应|承诺|保证|说定|约定|永远",        # 承诺 / 约定
    r"生日|纪念日|生病|发烧|住院|吃药|手术",   # 重要健康与日期
    r"考试|面试|辞职|分手|搬家|秘密|梦想",     # 人生大事
]

SUMMARY_MAX_LEN = 60     # 摘要档单条上限
FULL_MAX_LEN = 300       # 整段档单条上限
SUMMARY_DAILY_MAX = 300  # 摘要档每天上限条数
FULL_DAILY_MAX = 30      # 整段档每天上限条数


def is_important(text: str) -> bool:
    """判断这条对话该进整段档还是摘要档。"""
    for pat in IMPORTANT_PATTERNS:
        if re.search(pat, text):
            return True
    return False


def make_summary(text: str) -> str:
    """摘要档：压成一句带话题+情绪的短摘要（≤60字）。"""
    # 简单做法：截断 + 去多余
    s = text.strip()
    if len(s) > SUMMARY_MAX_LEN:
        s = s[:SUMMARY_MAX_LEN - 1] + "…"
    return s


def make_full(text: str) -> str:
    """整段档：留原话（≤300字，超了截断）。"""
    s = text.strip()
    if len(s) > FULL_MAX_LEN:
        s = s[:FULL_MAX_LEN - 1] + "…"
    return s


class ShortTermDetailStore:
    """两档短期记忆存储（模拟）。"""

    def __init__(self):
        self.summary_mems: List[Dict] = []  # 摘要档
        self.full_mems: List[Dict] = []     # 整段档

    def add(self, text: str, importance: float = 0.5, ts: Optional[float] = None):
        ts = ts or time.time()
        if is_important(text):
            # 整段档
            entry = {"content": make_full(text), "importance": importance,
                     "created_at": ts, "last_mentioned_at": ts, "strength": 100.0}
            self.full_mems.append(entry)
            # 上限：超了按 importance 淘汰（留重要的）
            if len(self.full_mems) > FULL_DAILY_MAX:
                self.full_mems.sort(key=lambda x: x["importance"], reverse=True)
                self.full_mems = self.full_mems[:FULL_DAILY_MAX]
        else:
            # 摘要档
            entry = {"content": make_summary(text), "importance": importance,
                     "created_at": ts, "last_mentioned_at": ts, "strength": 100.0}
            self.summary_mems.append(entry)
            # 上限：超了按 strength 淘汰（留新鲜的）
            if len(self.summary_mems) > SUMMARY_DAILY_MAX:
                self.summary_mems.sort(key=lambda x: x["strength"], reverse=True)
                self.summary_mems = self.summary_mems[:SUMMARY_DAILY_MAX]

    def total_chars(self) -> int:
        return sum(len(m["content"]) for m in self.summary_mems) + \
               sum(len(m["content"]) for m in self.full_mems)

    def recall_full(self, query: str) -> List[str]:
        """召回整段档（原话一起带上）。"""
        return [m["content"] for m in self.full_mems]

    def recall_summary(self, query: str) -> List[str]:
        return [m["content"] for m in self.summary_mems]


if __name__ == "__main__":
    store = ShortTermDetailStore()
    store.add("他说：今天好累，工作到很晚", importance=0.3)
    store.add("我答应你永远不离开", importance=0.92)  # 承诺 → 整段档
    store.add("（那次聊到很晚）心里有点酸", importance=0.7)  # → 整段档
    store.add("随便聊了聊天气", importance=0.3)
    print("摘要档条数:", len(store.summary_mems))
    print("整段档条数:", len(store.full_mems))
    print("总字数:", store.total_chars())
    print()
    print("整段档内容（原话）:")
    for m in store.full_mems:
        print("  -", m["content"])
    print("摘要档内容（摘要）:")
    for m in store.summary_mems:
        print("  -", m["content"])
