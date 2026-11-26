# Operations

Running this in practice: what to run, what to check, and what the failure
signals mean.

---

## First deployment

```bash
python -m pip install -r requirements.txt
export MEMORY_DATA_DIR=/absolute/path/to/memory-data
python nightly_patrol.py          # should report "正常" on an empty store
python tools/privacy_scan.py      # exit 0
```

An empty store reporting normal is the expected result. If the patrol reports
problems on a store with no data, something is wrong with the deployment, not
with the data.

Verify the round trip before wiring it into anything:

```bash
echo '{"sub":"add","sessionId":"smoke","content":"smoke test entry","tags":["test"]}' \
  | python memory_cli.py shortterm
echo '{"sessionId":"smoke","query":"smoke test entry"}' \
  | python memory_cli.py recall
```

The second command must return the first one's content. If it does not, stop —
recall is the one thing that has to work before anything else matters.

---

## Daily

Nothing to do. The system is designed to run unattended:

- consolidation is triggered by activity (`maintenance_trigger.py`) with a
  minimum gap, so a machine that was off at the scheduled hour still catches up
  on next use
- the window ledger writes on every turn
- decay is computed lazily on read, so there is no background job

If you want a scheduled run instead, run `daily_consolidation.py --apply` from
cron or Task Scheduler. The activity trigger and the schedule do not conflict;
whichever fires first runs, the other sees the recent run and skips.

---

## Weekly

```bash
python nightly_patrol.py
```

Read the report in `patrol/`. The counts that matter:

| Field | Healthy | What a rise means |
|---|---|---|
| `orphans` | 0 | Episodes referencing source ids that no longer exist. Grows when deletion runs without updating references |
| `zombies` | 0 | Items past their validity window still marked active. Grows when a supersede path is skipped |
| `duplicates` | low | Same content stored twice. Grows when the dedup key drifts |
| `conflicts` | low | Contradictory facts both active. Not always a bug — people change their minds — but worth reading |
| `halfwritten` | 0 | Items missing required fields. Always a bug; indicates a write path bypassing validation |
| `rarely_recalled` | informational | Large working set nothing is drawing on. Consider whether thresholds are too low |
| `untriaged` | low | Items with no category. Grows when a classifier is bypassed |

The report is a snapshot, not a trend. For trends, compare consecutive days in
`patrol/*.md`; the JSON next to each report has the same numbers if you want to
plot them.

---

## Before and after any change

```bash
python tools/privacy_scan.py --strict    # gate
python nightly_patrol.py                 # baseline report
# ... make the change ...
python nightly_patrol.py                 # compare against baseline
```

If the patrol counts moved and you did not intend them to, the change did
something you did not describe. That is the point of running it on both sides.

Run the isolated test suite:

```bash
python tests/run_all.py
```

Self-tests run against temporary directories and never touch production data.

---

## Failure signals and what they mean

**`召回服务不可用`** — the recall path raised. Check `errors` in the JSON
response; it names the channel that failed. A single channel failure returns
partial results with `degraded: true`, which is not the same as total failure.

**Empty recall on data that exists** — check eligibility before scoring. The most
common causes, in order: `recallable` set to `no`, category not in the registry,
source evidence missing, outside the validity window. Query the item directly and
run `services.recall_policy.eligible()` on it.

**Decay running too fast** — confirm `DECAY_RATE_MAP` in `config.py`. Modules
keep a documented fallback copy; if a fallback has drifted from config, the
module using the fallback decays at the wrong rate. The fallback values are
asserted equal in the self-tests for exactly this reason.

**`JSONDecodeError` on a pool file** — a write was interrupted. `atomic_io.py`
prevents truncated files, so this means something wrote around it. Check
`*.lock` handling and whether any tool opens the pool files directly.

**Consolidation reports success but nothing moved** — check the threshold values
and whether `last_consolidation.json` advanced. A step that silently skipped is
worse than one that failed, because the next run has no reason to retry.

---

## Retention and deletion

There is no automatic hard deletion. Items leave the working set by demotion
(`active` → `cold`), and remain on disk. This is a deliberate choice: demotion is
reversible, deletion is not, and "the agent forgot" is much easier to debug when
the data still exists.

To actually remove data, do it explicitly:

```bash
# stop any writer first
mv data/active.json data/active.json.bak
```

Every pool file is plain JSON. Read it, filter it, write it back atomically —
`common/io.py` has the helpers. Do not edit pool files while a process holds the
lock.

---

## Backup

The entire state is one directory:

```bash
tar czf memory-$(date +%F).tar.gz -C /path/to memory-data
```

Files are written atomically, so a copy taken at any moment is consistent at the
file level. For a cross-file consistent snapshot, stop the writers first — pool
files reference each other and a snapshot taken mid-consolidation can capture a
half-applied move.

Restore is the inverse, with one rule: restore the whole directory, not individual
files. Pools reference each other by `mem_id`; restoring one file in isolation is
how orphans are created.

---

## Privacy gate in CI

```yaml
- name: privacy
  run: python tools/privacy_scan.py --strict
```

The scanner exits non-zero on any hit, so it needs no wrapper. It is skipped in
`--strict` only for the explicitly allowed compatibility variable, which is
marked inline with `privacy-scan: allow`.

The scanner includes its own source. Runtime directories such as `data/` and `state/`
are excluded. Review the actual files in the release archive before publishing.

---

## Tuning

Almost everything worth changing is in `config.py`, in one place:

| Knob | Default | Effect of raising it |
|---|---|---|
| `SHORTTERM_TTL_DAYS` | 3 | More raw material survives to consolidation; working set gets noisier |
| `WORKING_MEM_MAX_CHUNKS` | 8 | Larger per-session buffer; more context, more dilution |
| `WINDOW_MAX_TURNS` | 500 | Longer raw turn log; better handovers, more disk |
| `DECAY_RATE_MAP` | level→rate | Slower decay; the working set grows |
| `COLD_AFTER_DAYS` | 180 | Longer retention before demotion |

Change one at a time and run the patrol on both sides. These interact: raising
the window size without raising the decay rate produces a working set that never
sheds anything, which is the failure this architecture exists to prevent.
