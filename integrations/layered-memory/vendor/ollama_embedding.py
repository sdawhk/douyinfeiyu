import os
import sys

import requests

from config import OLLAMA_EMBED_URL, EMBED_MODEL, EMBED_DIM

# 不走系统代理：宿主拉起的进程可能继承 HTTP_PROXY，访问 127.0.0.1 会失败→零向量
_SESSION = requests.Session()
_SESSION.trust_env = False
_DEBUG = None  # Optional explicit override; otherwise follow the active data directory.


def _log(msg: str):
    try:
        import config
        with open(_DEBUG or os.path.join(config.BASE_DIR, "embed_debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def get_embedding(text: str) -> list:
    """调用本地 Ollama 的 bge-m3 生成 1024 维向量；失败降级为零向量（会记日志）。"""
    try:
        resp = _SESSION.post(
            OLLAMA_EMBED_URL,
            json={"model": EMBED_MODEL, "prompt": text, "keep_alive": "30m"},
            timeout=30,
        )
        resp.raise_for_status()
        emb = resp.json().get("embedding")
        if not emb:
            _log("EMPTY query=%r" % text[:30])
            return [0.0] * EMBED_DIM
        return emb
    except Exception as e:
        _log("FAIL %s: %s" % (type(e).__name__, e))
        return [0.0] * EMBED_DIM
