"""Scan release sources using generic patterns. Keep personal blocklists offline.

Run python tools/privacy_scan.py [directory] [--strict] [--json | --show-text].
Default reports contain locations and rule names only.
"""

from __future__ import annotations

import json
import os
import re
import sys

RULES = [
    ("个人账号", re.compile(r"(?i)(?:qq|account|user[_-]?id)\s*['\x22:= ]*\d{7,12}(?!\d)"),
     "真实 QQ 账号"),
    ("手机号", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
     "疑似手机号"),

    # ── 本机路径 ──
    ("用户目录", re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+", re.I),
     "本机用户目录"),
    ("旧环境变量", re.compile(r"\bDSH_" r"(?:MEMORY_DATA_DIR|ROOT)\b"), "旧环境变量名"),
]

# ── 软规则（提示，不阻断；--strict 时升级）─────────────────────────────────
#
# 注意 --strict 的**升级范围**：只有 PRIVACY_RISK_RULES 里的软规则会被升级成
# 失败。理由见 STRICT_EXEMPT_SOFT。
SOFT_RULES = [
    ("开发日期", re.compile(r"(?<!\d)20\d\d-\d\d-\d\d(?!\d)"),
     "注释里的开发日期"),
    ("凭据", re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"), "疑似凭据"),
]

#: ``--strict`` 会升级成失败的软规则。
#:
PRIVACY_RISK_RULES = {"凭据"}

#: 这些目录不是「产品内容」，不参与扫描。
SKIP_DIRS = {
    "__pycache__", ".git", ".venv", "venv", "node_modules",
    "data", "state", "patrol", "logs", ".pytest_cache", ".mypy_cache",
}

#: 这些后缀是二进制或非源码，直接跳过。
SKIP_EXT = {
    ".pyc", ".pyo", ".so", ".dll", ".exe", ".png", ".jpg", ".jpeg",
    ".gif", ".webp", ".mp4", ".mp3", ".wav", ".zip", ".gz", ".7z",
    ".db", ".sqlite", ".safetensors", ".ckpt", ".pt", ".bin", ".zst",
    ".zstd", ".lock",
}

ALLOW_MARK = "privacy-scan: allow"

#: 允许逐条豁免的规则名 —— 只有兼容变量名这类"结构性必须存在"的才准豁免。
ALLOWABLE_RULES = {"旧环境变量"}


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext in SKIP_EXT:
                continue
            path = os.path.join(dirpath, name)
            yield path


def _read_lines(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.readlines()


def scan(root, rules):
    hits = []
    scanned = 0
    for path in iter_files(root):
        lines = _read_lines(path)
        if not lines:
            continue
        scanned += 1
        rel = os.path.relpath(path, root)
        for lineno, line in enumerate(lines, 1):
            exempt = ALLOW_MARK in line
            for name, pattern, note in rules:
                match = pattern.search(line)
                if not match:
                    continue
                hits.append({
                    "file": rel,
                    "line": lineno,
                    "rule": name,
                    "note": note,
                    "text": line.strip()[:160],
                    "match": match.group(0),
                    "exempt": exempt and name in ALLOWABLE_RULES,
                })
    return hits, scanned


def _fmt(hit, show_text):
    """一条命中。默认只给 文件:行号 [规则名]，不给原文。"""
    base = "    %s:%d  [%s]" % (hit["file"], hit["line"], hit["rule"])
    if show_text:
        base += "  " + hit["text"]
    return base


def main(argv):
    strict = "--strict" in argv
    show_text = "--show-text" in argv
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    root = args[1] if len(args) > 1 else os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))
    )
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise SystemExit("扫描目录不存在")

    hard, scanned = scan(root, RULES)
    soft, _ = scan(root, SOFT_RULES)
    real_hard = [h for h in hard if not h["exempt"]]
    exempted = [h for h in hard if h["exempt"]]
    # strict 只升级「有隐私风险」的软规则，见 PRIVACY_RISK_RULES 的说明。
    risk_soft = [h for h in soft if h["rule"] in PRIVACY_RISK_RULES]

    if as_json:
        print(json.dumps({
            "root": root,
            "scanned": scanned,
            "hard": [{k: v for k, v in h.items() if k not in ("text", "match")} for h in real_hard],
            "soft": [{k: v for k, v in h.items() if k not in ("text", "match")} for h in soft],
            "strict_violations": [h["rule"] for h in risk_soft],
        }, ensure_ascii=True, indent=2))
        if real_hard:
            return 1
        if strict and risk_soft:
            return 1
        return 0

    print("扫描目录: %s" % root)
    print("模式: %s" % ("strict（有隐私风险的软规则也算失败）" if strict
                        else "normal（软规则只提示）"))
    print("扫描文件: %d" % scanned)
    print()

    if exempted:
        print("已豁免 %d 处：" % len(exempted))
        for h in exempted[:20]:
            print(_fmt(h, show_text))
        print()

    if soft:
        by_rule = {}
        for item in soft:
            by_rule.setdefault(item["rule"], []).append(item)
        print("提示 %d 处（软规则）：" % len(soft))
        for rule, items in sorted(by_rule.items(), key=lambda kv: -len(kv[1])):
            mark = "  ← strict 会失败" if (strict and rule in PRIVACY_RISK_RULES) else ""
            print("  【%s】%d 处%s" % (rule, len(items), mark))
            for item in items[:3]:
                print("    %s:%d" % (item["file"], item["line"]))
            if len(items) > 3:
                print("    … 其余 %d 处省略" % (len(items) - 3))
        print()

    if not real_hard:
        print("✅ 硬门禁 0 命中")
        if strict and risk_soft:
            print("❌ strict 模式：%d 处有隐私风险的软规则未清" % len(risk_soft))
            return 1
        return 0

    by_rule = {}
    for hit in real_hard:
        by_rule.setdefault(hit["rule"], []).append(hit)

    print("❌ 命中 %d 处，分布在 %d 类：" % (len(real_hard), len(by_rule)))
    for rule, items in sorted(by_rule.items(), key=lambda kv: -len(kv[1])):
        print()
        print("  【%s】%d 处" % (rule, len(items)))
        for hit in items[:40]:
            print(_fmt(hit, show_text))
        if len(items) > 40:
            print("    … 其余 %d 处省略" % (len(items) - 40))
    if not show_text:
        print()
        print("（默认不回显原文；需要看命中行请加 --show-text）")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
