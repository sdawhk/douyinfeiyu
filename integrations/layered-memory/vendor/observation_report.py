"""记忆系统 5 天观察期自动报告（2026-11-03 起）

每天 06:30 自动跑，收集：
  · 当天 20 轮 × 73 项检查结果
  · 巩固效果（长时库增长、冷热迁移）
  · 数据健康度（ID 唯一、向量完整、无损坏）
  · 观察进度（第几天 / 还差几天）

到第 5 天（2026-11-08）自动出「切换建议」并写结论文件。

用法：
    python observation_report.py          # 收集当天数据
    python observation_report.py --final  # 强制出最终结论
"""
import sys, os, json, time
from datetime import datetime, date

from config import (
    BASE_DIR,
    LONG_TERM_ACTIVE_PATH,
    LONG_TERM_COLD_PATH,
    PATROL_DIR,
    WORKING_MEM_PATH,
)


# __UTF8_STDOUT_GUARD__ (2026-11-07)
# 中文 Windows 终端默认 GBK，print emoji（✅❌⚠️）会 UnicodeEncodeError 直接崩。
# 兜底改成 utf-8 + replace，任何终端都不会因此崩。
try:
    import sys as _sys_guard
    _sys_guard.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys_guard.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


BASE = BASE_DIR
OUT_DIR = PATROL_DIR
os.makedirs(OUT_DIR, exist_ok=True)

START_DATE = date(2026, 1, 1)   # observation window start (override below)
TOTAL_DAYS = 5
FINAL_DATE = date(2026, 1, 6)   # end of the 5-day window

REPORT_FILE = os.path.join(OUT_DIR, 'memsys-observation.md')
DATA_FILE = os.path.join(OUT_DIR, 'memsys-observation.json')


def load_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def memory_stats():
    """当前记忆库统计"""
    a = load_json(LONG_TERM_ACTIVE_PATH).get('memories', [])
    c = load_json(LONG_TERM_COLD_PATH).get('memories', [])
    w = load_json(WORKING_MEM_PATH).get('sessions', {})
    wm = [m for s in w.values() for m in s.get('working_memory', [])]

    PIN = {'不朽', '核心事件', '重要约定', '身份信息', '固定规则', '安全红线', '人设相关'}
    pinned = [m for m in a + c if m.get('category') == 'stable_profile'
              or any(t in PIN for t in (m.get('tags') or []))]

    ids = [m.get('mem_id') for m in a + c + wm]
    strengths = [m.get('strength') or 0 for m in a]

    return {
        'active': len(a),
        'cold': len(c),
        'working': len(wm),
        'total': len(a) + len(c) + len(wm),
        'pinned': len(pinned),
        'normal': len(a) + len(c) - len(pinned),
        'id_unique': len(set(ids)) == len(ids),
        'id_total': len(ids),
        'id_dupes': len(ids) - len(set(ids)),
        'empty_embedding': sum(1 for m in a + c if not m.get('embedding')),
        'avg_strength': round(sum(strengths) / max(1, len(strengths)), 1),
        'min_strength': round(min(strengths), 1) if strengths else 0,
        'below_20': sum(1 for s in strengths if s < 20),
        'by_level': {},
    }


def today_check_result():
    """当天的深度检查结果（读 memsys-daily-check.log 最后一条 + 明细 JSON）"""
    today = datetime.now().strftime('%Y%m%d')
    detail = load_json(os.path.join(OUT_DIR, f'memsys-check-{today}.json'), [])
    if not isinstance(detail, list):
        detail = [detail]
    if not detail:
        return {'ran': False}
    last = detail[-1]
    return {
        'ran': True,
        'rounds': last.get('rounds'),
        'items_per_round': last.get('items_per_round'),
        'checks_total': last.get('checks_total'),
        'all_ok': last.get('all_ok'),
        'duration_sec': last.get('duration_sec'),
        'start': last.get('start'),
        'failed_rounds': [r for r in last.get('details', []) if not r.get('ok')],
    }


def consolidation_today():
    """今天的巩固日志"""
    path = os.path.join(OUT_DIR, 'memsys-consolidate.log')
    if not os.path.exists(path):
        return {'ran': False}
    today_str = datetime.now().strftime('%Y/%m/%d')
    with open(path, encoding='utf-8', errors='replace') as f:
        lines = f.read().splitlines()
    found = []
    for i, ln in enumerate(lines):
        if today_str in ln:
            # 后面两行是结果和 exit
            found.append('\n'.join(lines[i:i+3]))
    return {'ran': bool(found), 'entries': found[-2:] if found else []}


def day_index():
    """今天是观察期第几天（1-based）"""
    d = (date.today() - START_DATE).days + 1
    return max(1, min(TOTAL_DAYS + 1, d))


def build_report(final=False):
    now = datetime.now()
    di = day_index()
    stats = memory_stats()
    check = today_check_result()
    cons = consolidation_today()

    # 历史累积
    hist = load_json(DATA_FILE, {'days': []})
    if not isinstance(hist, dict) or 'days' not in hist:
        hist = {'days': []}
    # 同一天重复跑就覆盖
    today_str = now.strftime('%Y-%m-%d')
    hist['days'] = [d for d in hist.get('days', []) if d.get('date') != today_str]
    hist['days'].append({
        'date': today_str,
        'day_index': di,
        'stats': stats,
        'check': check,
        'consolidation_ran': cons.get('ran'),
    })
    hist['days'].sort(key=lambda x: x['date'])
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(hist, f, ensure_ascii=False, indent=2)

    # ── 生成 markdown 报告 ──
    lines = []
    lines.append('# 记忆系统观察期报告')
    lines.append('')
    lines.append(f'**生成时间**：{now.strftime("%Y-%m-%d %H:%M")}')
    lines.append(f'**观察进度**：第 {di} 天 / {TOTAL_DAYS} 天'
                 + (f'（还差 {TOTAL_DAYS - di + 1} 天）' if di <= TOTAL_DAYS else '（已结束）'))
    lines.append('')

    # 数据快照
    lines.append('## 数据快照')
    lines.append('')
    lines.append('| 项 | 数值 |')
    lines.append('|---|---|')
    lines.append(f'| 长时活跃 | {stats["active"]} 条 |')
    lines.append(f'| 冷存 | {stats["cold"]} 条 |')
    lines.append(f'| 工作记忆 | {stats["working"]} 条 |')
    lines.append(f'| 合计 | {stats["total"]} 条 |')
    lines.append(f'| 其中 pinned | {stats["pinned"]} 条 |')
    lines.append(f'| 普通记忆 | {stats["normal"]} 条 |')
    lines.append(f'| ID 唯一 | {"✅ 是" if stats["id_unique"] else "❌ 有 " + str(stats["id_dupes"]) + " 个重复"} |')
    lines.append(f'| 空向量 | {stats["empty_embedding"]} 条 |')
    lines.append(f'| 平均强度 | {stats["avg_strength"]} |')
    lines.append(f'| 最低强度 | {stats["min_strength"]} |')
    lines.append(f'| 低于 20 分 | {stats["below_20"]} 条 |')
    lines.append('')

    # 当天检查
    lines.append('## 当天深度检查')
    lines.append('')
    if check.get('ran'):
        ok = '✅ 全部通过' if check['all_ok'] else '❌ 有失败'
        lines.append(f'- 结果：**{ok}**（{check["rounds"]} 轮 × {check["items_per_round"]} 项 = {check["checks_total"]} 次）')
        lines.append(f'- 耗时：{check["duration_sec"]} 秒')
        if check.get('failed_rounds'):
            lines.append(f'- 失败轮次：{len(check["failed_rounds"])} 轮')
            for r in check['failed_rounds'][:3]:
                lines.append(f'  - 第 {r["round"]} 轮：{"; ".join(r.get("failures", []))[:100]}')
    else:
        lines.append('- ⚠️ 今天还没跑检查（计划任务 06:20）')
    lines.append('')

    # 巩固
    lines.append('## 当天巩固')
    lines.append('')
    if cons.get('ran'):
        lines.append('- ✅ 已运行')
        for e in cons.get('entries', []):
            lines.append('```')
            lines.append(e)
            lines.append('```')
    else:
        lines.append('- ⚠️ 今天还没跑巩固（计划任务 06:10）')
    lines.append('')

    # 历史趋势
    days = hist.get('days', [])
    if len(days) > 1:
        lines.append('## 历史趋势')
        lines.append('')
        lines.append('| 日期 | 天 | 活跃 | 冷存 | 工作 | ID唯一 | 检查 |')
        lines.append('|---|---|---|---|---|---|---|')
        for d in days:
            s = d.get('stats', {})
            c = d.get('check', {})
            ck = '✅' if c.get('all_ok') else ('❌' if c.get('ran') else '—')
            lines.append(f'| {d["date"]} | {d["day_index"]} | {s.get("active")} | {s.get("cold")} | '
                         f'{s.get("working")} | {"✅" if s.get("id_unique") else "❌"} | {ck} |')
        lines.append('')

        # 增长分析
        first = days[0].get('stats', {})
        last = days[-1].get('stats', {})
        delta = (last.get('total') or 0) - (first.get('total') or 0)
        lines.append(f'**这段期间记忆净增长**：{delta:+d} 条'
                     f'（{first.get("total")} → {last.get("total")}）')
        lines.append('')

    # 结论（第 5 天或 --final 才出）
    if final or date.today() >= FINAL_DATE or di > TOTAL_DAYS:
        lines.append('## 切换结论')
        lines.append('')
        all_checks_ok = all(d.get('check', {}).get('all_ok') for d in days if d.get('check', {}).get('ran'))
        ran_days = sum(1 for d in days if d.get('check', {}).get('ran'))
        all_id_ok = all(d.get('stats', {}).get('id_unique') for d in days)
        no_empty = all((d.get('stats', {}).get('empty_embedding') or 0) == 0 for d in days)
        consolidated = sum(1 for d in days if d.get('consolidation_ran'))

        items = [
            ('检查天数', f'{ran_days}/{TOTAL_DAYS} 天有检查记录', ran_days >= 4),
            ('检查结果', '全部通过' if all_checks_ok else '有失败', all_checks_ok),
            ('ID 唯一', '全程唯一' if all_id_ok else '出现过重复', all_id_ok),
            ('向量完整', '无空向量' if no_empty else '有空向量', no_empty),
            ('巩固天数', f'{consolidated} 天有巩固记录', consolidated >= 4),
        ]
        lines.append('| 条件 | 结果 | 判定 |')
        lines.append('|---|---|---|')
        for name, val, ok in items:
            lines.append(f'| {name} | {val} | {"✅" if ok else "❌"} |')
        lines.append('')

        all_pass = all(ok for _, _, ok in items)
        if all_pass:
            lines.append('### 建议：可以切换')
            lines.append('')
            lines.append('5 天观察期全部条件通过。可以按下面步骤停用旧数据源：')
            lines.append('')
            lines.append('```')
            lines.append('① 备份 profiles\\desktop\\package.json')
            lines.append('② 从 bundles 里移除 dsh-legacy-store')
            lines.append('③ 重启宿主进程')
            lines.append('④ 再跑 20 轮检查确认')
            lines.append('```')
        else:
            lines.append('### 建议：**先不切换**')
            lines.append('')
            lines.append('有未通过的条件（见上表），建议继续观察或先修问题。')
        lines.append('')

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(REPORT_FILE, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    # 控制台摘要
    print(f'观察期第 {di}/{TOTAL_DAYS} 天')
    print(f'数据: 活跃 {stats["active"]} / 冷存 {stats["cold"]} / 工作 {stats["working"]} = {stats["total"]} 条')
    print(f'ID 唯一: {"是" if stats["id_unique"] else "否"} | 空向量: {stats["empty_embedding"]}')
    print(f'当天检查: {"✅ 通过" if check.get("all_ok") else ("❌ 失败" if check.get("ran") else "未跑")}')
    print(f'当天巩固: {"✅ 已跑" if cons.get("ran") else "未跑"}')
    print(f'报告: {REPORT_FILE}')
    if final or date.today() >= FINAL_DATE:
        print()
        print('=== 最终结论 ===')
        # FIX: 原来这里只看"检查是否通过"，没看天数和巩固，
        #      导致只跑了 1 天也会打印"可以切换"（和报告正文的结论矛盾）。
        #      现在复用报告里的判定逻辑。
        ran_days = sum(1 for d in hist['days'] if d.get('check', {}).get('ran'))
        consolidated = sum(1 for d in hist['days'] if d.get('consolidation_ran'))
        checks_ok = all(d.get('check', {}).get('all_ok') for d in hist['days'] if d.get('check', {}).get('ran'))
        ids_ok = all(d.get('stats', {}).get('id_unique') for d in hist['days'])
        emb_ok = all((d.get('stats', {}).get('empty_embedding') or 0) == 0 for d in hist['days'])
        all_pass = (ran_days >= 4 and consolidated >= 4 and checks_ok and ids_ok and emb_ok)
        print('可以切换' if all_pass else '先不切换')
        print(f'  （检查 {ran_days}/5 天，巩固 {consolidated}/5 天，'
              f'检查通过={checks_ok}，ID唯一={ids_ok}，向量完整={emb_ok}）')
    return 0


if __name__ == '__main__':
    force_final = '--final' in sys.argv
    sys.exit(build_report(final=force_final))
