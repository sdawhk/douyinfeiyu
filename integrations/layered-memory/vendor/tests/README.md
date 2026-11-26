# Tests

Every runtime module carries its own `selftest()`, runnable standalone:

```bash
python window_ledger.py      # asserts against a temp directory, never real data
python recall_engine.py
```

That is the primary test surface, and it is deliberately kept inside each module
rather than extracted: a self-test next to the code it exercises gets updated
when the code changes, and a self-test in a separate tree does not.

This directory holds the cross-module checks that do not belong to any single
module.

---

## Running everything

```bash
python tests/run_all.py
```

Runs every module self-test plus the end-to-end suite below, in isolated temp
directories, and exits non-zero on the first failure. This is the command CI
should run.

---

## What is covered where

| Layer | Where |
|---|---|
| Single-module behaviour | `<module>.py` self-test |
| Tokenisation and classification | `schema.py` self-test |
| Decay curves and floors | `decay_logic.py` self-test |
| Pool load/write/atomicity | `memory_manager.py`, `atomic_io.py` self-tests |
| Eligibility policy | `services/recall_policy.py` self-test |
| Recall assembly | `services/recall_service.py`, `recall_engine.py` self-tests |
| Consolidation steps | `daily_consolidation.py` self-test |
| Handover read/write/verify | `handover.py` self-test |
| Ledger append/truncate/repair | `window_ledger.py` self-test |
| Nightly checks | `nightly_patrol.py` self-test |
| **Cross-module, empty store** | `tests/e2e_empty_store.py` |
| **Privacy gate** | `tools/privacy_scan.py` |

---

## The empty-store contract

The most important cross-module property is that **a fresh checkout works**.
`tests/e2e_empty_store.py` pins it: point `MEMORY_DATA_DIR` at an empty
directory and require that

1. recall returns an empty result with `ok: true` — not an error
2. writing to the short-term pool creates `shortterm.json`. With automatic
   maintenance disabled for this suite, the active and cold pools stay absent
   until an operation writes them.
3. what was written can be recalled
4. the window ledger creates its files under `<data>/window`, with no extra
   `data/` layer
5. handover reads cleanly with nothing to read
6. consolidation previews without writing
7. the nightly patrol reports normal
8. the privacy gate passes
9. every module imports
10. every module self-test passes

Item 4 exists because a path bug that appends `data/` twice is invisible on a
machine that already has data in the shallow location, and silent on any store
that happens to be empty at the wrong level. It is checked explicitly rather than
inferred from "files appeared somewhere".

---

## Conventions for a self-test

- **Isolate data.** Set `MEMORY_DATA_DIR` to a temp directory, or monkeypatch the
  module's path constants. Never write to the real store.
- **Assert on the contract, not the implementation.** "Recalling this returns it"
  survives a rewrite; "this internal list has 3 elements" does not.
- **Treat empty as valid.** A test that requires pre-existing data cannot run on
  a fresh clone.
- **Clean up in `finally`.** A failed assertion should not leave temp sessions
  behind; `window_ledger` and `handover` both create per-session directories.
- **One assertion per behaviour.** A test that checks five things reports one
  failure and hides four.

---

## Why there is no mocking framework

The modules are file-backed and take their paths from `config`, so a temp
directory is a complete isolation boundary. A fake pool layer would test the fake.
