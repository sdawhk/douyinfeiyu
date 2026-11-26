# -*- coding: utf-8 -*-
r"""公共 I/O：原子写 + 三方合并写。

## 为什么有这个模块

原来「原子写」在 5 个模块各转发一份薄壳（都指向 atomic_io），
「三方合并」只在 memory_manager 里有一份（active.json 专用），
而 shortterm.json / working_mem.json 没有 → 会整库覆盖丢数据。

## 两类写

    atomic_write_json(path, data)
        单纯原子写。调用方自己保证 data 是最新的。

    merge_write_json(path, rows, *, key="mem_id", on_disk_only="keep")
        三方合并写。写前重读磁盘，按 key 合并：
            磁盘有、内存有     → 用内存的（内存是刚改过的）
            磁盘有、内存没有   → 用磁盘的（别的进程新增的，保留）
            磁盘没有、内存有   → 丢弃（别的进程删的，尊重删除）

## 三方合并为什么必须

memory_manager 是常驻的（mcp_server 一直活着），内存里持有全库副本。
写回用的是**内存副本**。如果这期间别的进程新增了记忆，就会被覆盖掉。

实测场景（2026-11-08）：
    mcp_server 启动        → 读入 300 条
    巩固跑一次             → 新增 5 条（磁盘 305 条）
    recall 5 分钟到        → 写回内存的 300 条
    → 那 5 条永久丢失，且不报错
"""
import os
import sys
import json
import uuid

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)


def atomic_write_json(path, data, sweep=False):
    """原子写 JSON（转发到项目根的 atomic_io）。"""
    from atomic_io import atomic_write_json as _impl
    return _impl(path, data, sweep=sweep)


def load_json(path, default=None):
    """读 JSON。文件不存在 / 解析失败 → 返回 default。"""
    if default is None:
        default = {}
    try:
        if not os.path.exists(path):
            return default
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def merge_write_json(path, rows, *, key="mem_id",
                     top_key="memories", skip_categories=("private",),
                     verbose=True, respect_delete=True):
    """三方合并写：先重读磁盘，把「磁盘有但内存没有」的补进来，再写。

    参数：
        path           目标路径
        rows           内存里的行（list[dict]），会被**就地修改**（补进磁盘新增）
        key            主键字段名（默认 mem_id）
        top_key        JSON 顶层字段名（默认 memories）
        skip_categories  这些 category 的行不参与合并（默认排除 private，
                          因为它属于已移除的私有池，不该写回普通池）
        verbose        合并了几条是否打印
        respect_delete 磁盘上没有、内存里有的行，是否丢弃（默认 True = 尊重删除）

    返回：{"added": [key, ...], "total": int, "dropped": [key, ...]}

    ⚠️ 调用方要保证 rows 是「最新的内存状态」。
       这个方法解决的是「别的进程新增了但内存不知道」，
       不解决「内存自己就没加载全」。

    ★ 2026-11-09 修（独立审计抓出的真 bug，两种语义打架）：
      本函数 docstring 一直写「磁盘没有、内存有 → 丢弃（尊重删除）」，
      但**实现里根本没有这段逻辑**，实测会保留内存的行。

      而 selftest ④ 断言的也是「保留（内存是真相）」——
      docstring / 实现 / selftest 三者互相矛盾，谁都不知道该信哪个。

      实测（旧行为）：
        磁盘清空后，常驻进程写回 → 被删的条目复活
        → 别人删不掉东西（删除是明确意图，复活它等于篡改）

      现在按 docstring 的承诺实现：respect_delete=True 时，
      磁盘上不存在的行会被丢弃，并记进返回值的 dropped 里（可观测）。
      需要「内存是真相」的旧调用方，显式传 respect_delete=False。
    """
    added = []
    dropped = []
    try:
        if os.path.exists(path):
            disk = load_json(path, {})
            disk_rows = disk.get(top_key, []) or []
            mine = {str(r.get(key) or "") for r in rows}
            disk_ids = {str(dr.get(key) or "") for dr in disk_rows}
            for dr in disk_rows:
                mid = str(dr.get(key) or "")
                if not mid:
                    continue
                if mid in mine:
                    continue                                  # 内存有 → 用内存的
                if skip_categories and dr.get("category") in skip_categories:
                    continue                                  # 已标记删除的行不写回
                rows.append(dr)
                mine.add(mid)
                added.append(mid)

            # 反向：内存有、磁盘没有 → 尊重删除（默认）
            if respect_delete:
                kept = []
                for r in rows:
                    mid = str(r.get(key) or "")
                    if (mid and mid not in disk_ids
                            and not (skip_categories
                                     and r.get("category") in skip_categories)):
                        dropped.append(mid)
                        continue
                    kept.append(r)
                if dropped:
                    rows[:] = kept
    except Exception as e:
        # 合并失败不能阻止写回（否则永远写不进去），但要说清楚
        if verbose:
            print("[merge_write] 重读合并失败（按原样写回）: %s: %s"
                  % (type(e).__name__, e))

    if added and verbose:
        print("[merge_write] 合并了 %d 条磁盘新增（防止覆盖）: %s"
              % (len(added), added[:5]))
    if dropped and verbose:
        print("[merge_write] 丢弃了 %d 条已被别人删除的行（尊重删除）: %s"
              % (len(dropped), dropped[:5]))

    atomic_write_json(path, {top_key: rows})
    return {"added": added, "total": len(rows), "dropped": dropped}


def selftest():
    """自检：三方合并的三条规则都验到。"""
    import tempfile
    import shutil

    print("=" * 72)
    print("common/io 自检")
    print("=" * 72)

    tmp = tempfile.mkdtemp(prefix="io_st_")
    p = os.path.join(tmp, "t.json")

    try:
        # ① 磁盘不存在 → 直接写
        rows = [{"mem_id": "a", "v": 1}]
        r = merge_write_json(p, rows, verbose=False)
        got = load_json(p, {})
        assert len(got.get("memories", [])) == 1, "① 写失败"
        print("  ✅ ① 磁盘不存在 → 直接写")

        # ② 磁盘有内存没有 → 补进来
        atomic_write_json(p, {"memories": [
            {"mem_id": "a", "v": 1},
            {"mem_id": "b", "v": 2},
        ]})
        rows = [{"mem_id": "a", "v": 99}]     # 内存只有 a，且改了值
        r = merge_write_json(p, rows, verbose=False)
        got = load_json(p, {})
        ids = {x["mem_id"] for x in got["memories"]}
        assert ids == {"a", "b"}, "② 应该合并成 a+b，实际 %s" % ids
        assert r["added"] == ["b"], "② added 应该是 [b]，实际 %s" % r["added"]
        print("  ✅ ② 磁盘有内存没有 → 补进来（added=%s）" % r["added"])

        # ③ 磁盘有内存也有 → 用内存的
        a = [x for x in got["memories"] if x["mem_id"] == "a"][0]
        assert a["v"] == 99, "③ 应该用内存的值 99，实际 %s" % a["v"]
        print("  ✅ ③ 两边都有 → 用内存的（v=99）")

        # ④ 磁盘没有内存有 → 丢弃（尊重删除）
        #
        # ★ 2026-11-09 修（独立审计指出）：这条断言原来写的是
        #   `assert ids == {"a", "b"}` +「内存是真相」，跟本文件 docstring
        #   第 19 行的「磁盘没有、内存有 → 丢弃（尊重删除）」**正好相反**。
        #   三处（docstring / 实现 / 本测试）互相矛盾，谁都不知道该信哪个。
        #   现在统一到 docstring 的承诺：删除是明确意图，复活它 = 让别人删不掉东西。
        atomic_write_json(p, {"memories": [{"mem_id": "b", "v": 2}]})
        rows = [{"mem_id": "a", "v": 1}, {"mem_id": "b", "v": 2}]
        r = merge_write_json(p, rows, verbose=False)
        got = load_json(p, {})
        ids = {x["mem_id"] for x in got["memories"]}
        assert ids == {"b"}, "④ 磁盘删了 a，写回应该尊重删除，实际 %s" % ids
        assert r["dropped"] == ["a"], "④ dropped 应该是 [a]，实际 %s" % r["dropped"]
        print("  ✅ ④ 内存有磁盘没有 → 丢弃（尊重删除，dropped=%s）" % r["dropped"])

        # ④b 显式要求「内存是真相」时，保留
        atomic_write_json(p, {"memories": [{"mem_id": "b", "v": 2}]})
        rows = [{"mem_id": "a", "v": 1}, {"mem_id": "b", "v": 2}]
        merge_write_json(p, rows, verbose=False, respect_delete=False)
        got = load_json(p, {})
        ids = {x["mem_id"] for x in got["memories"]}
        assert ids == {"a", "b"}, "④b respect_delete=False 应该保留，实际 %s" % ids
        print("  ✅ ④b respect_delete=False → 保留（内存是真相）")

        atomic_write_json(p, {"memories": [
            {"mem_id": "x", "category": "private"},
        ]})
        rows = [{"mem_id": "y"}]
        merge_write_json(p, rows, verbose=False)
        got = load_json(p, {})
        ids = {x["mem_id"] for x in got["memories"]}
        assert "x" not in ids, "⑤ private 不该被合并进来"
        print("  ✅ ⑤ 已删除记录不合并")

        # ⑥ load_json 容错
        with open(p, "w", encoding="utf-8") as f:
            f.write("{broken json")
        assert load_json(p, {"d": 1}) == {"d": 1}, "⑥ 坏 JSON 应该返回 default"
        print("  ✅ ⑥ 坏 JSON → 返回 default")

        print()
        print("common/io selftest OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    selftest()
