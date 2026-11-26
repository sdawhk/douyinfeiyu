import threading
from typing import Callable

from schema import MemoryItem


class AsyncSummarizer:
    """后台异步压缩记忆组块，不阻塞主对话链路"""

    def __init__(self, summarize_func: Callable[[str], str]):
        self.summarize_func = summarize_func
        self.pool = []

    def submit_summarize(self, mem_item: MemoryItem, callback: Callable[[MemoryItem], None]):
        """提交异步摘要任务，完成后回调回写"""
        def _task():
            try:
                mem_item.content = self.summarize_func(mem_item.content)
            except Exception as e:
                print(f"异步摘要失败: {e}")
            finally:
                callback(mem_item)

        thread = threading.Thread(target=_task, daemon=True)
        thread.start()
        self.pool.append(thread)

    def wait_all(self):
        for t in self.pool:
            t.join()
        self.pool.clear()


def local_compress(text: str, head: int = 260, tail: int = 120) -> str:
    """FIX-1103-SUM：本地抽取式压缩（不需要 LLM）。

    记忆长这样：「他说：XXX；我回：YYY / 补充……」
    开头是对话的起因，结尾常是结论/决定，中间最可丢。
    ⇒ 保留 head + tail，中间用「…（中间省略 N 字）」折叠。

    比直接截断强：截断会把「我回：」的答复全砍掉，只剩对方的话。
    """
    t = (text or "").strip()
    if len(t) <= head + tail + 20:
        return t
    cut = len(t) - head - tail
    return t[:head] + f"…（中间省略 {cut} 字）…" + t[-tail:]
