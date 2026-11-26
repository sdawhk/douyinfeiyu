# Contributing

## Before you change anything

```bash
python tests/run_all.py          # must be green before you start
python nightly_patrol.py         # note the counts
```

Fixing a bug you introduced is easier when you know the baseline was clean.

---

## The rules this codebase enforces

**Self-tests live next to the code.** Every runtime module ends in
`selftest()`. New behaviour gets an assertion there, not in a separate tree.
A self-test that lives far from the code it tests stops being run.

**Empty is a valid state.** A fresh checkout has no data. Any code path that
assumes pre-existing data is a bug, and any test that requires it will fail on
a new clone. If you write a check that needs data, create it inside the test.

**Never silently succeed.** If a write did not happen, it must not return as
though it did. Where raising is not appropriate, return `ok: false` with a
`reason` the caller can act on.

**Degrade by channel.** One failing subsystem must not turn a partially
successful operation into a total failure. Append to `errors` and return what
did work.

**Paths come from `config`.** No module computes its own data directory. A
fallback copy of a config value is allowed only when documented, and it must
equal the config value — the self-tests assert this, because a drifted fallback
silently changes behaviour.

**Atomic writes only.** Every JSON write goes through `atomic_io.py`. Opening a
pool file with `"w"` truncates it first; if anything interrupts between truncate
and write, the data is gone.

---

## Adding a privacy rule

`tools/privacy_scan.py` is a CI gate, so a rule change is a behavioural change.

1. Keep real account identifiers and private names outside the repository.
   Use generic patterns and synthetic fixtures. Unicode escapes are reversible.
2. **Prefer multi-character phrases over single characters.** Single Chinese
   characters have no word boundaries: `硬` matches 硬编码, `脱` matches 脱敏,
   `下面` matches 下面这段代码. An earlier version of this file used single
   characters and produced 204 false positives and zero real findings.
3. **Do not print matched text by default.** Hits report as `file:line [rule]`.
   `--show-text` opts in.
4. **If the pattern is a common English word**, restrict it to identifier shape
   (underscores, camelCase, `.py`) rather than matching the bare word. `note` as
   an English word appears in ordinary technical prose; `strip_notes` does not.
5. **Verify both directions** before committing: the pattern must match what it
   is for and must not match ordinary prose. A privacy rule with false positives
   gets disabled by the first person it annoys, and then it protects nothing.

Compatibility variables that must exist (for example an older env var name) are
exempted inline with `privacy-scan: allow` on the exact line. Exemptions are
per-line and per-rule; there is no file-level escape.

---

## Adding a config value

Add it to `config.py` with a documented default, and to `.env.example` if it is
user-facing. An empty `.env` must remain a working configuration: every value
needs a default that runs without it.

---

## Commit messages

State the behaviour change, not the file touched.

```
good:  stop recall from surfacing items whose source evidence is missing
bad:   update recall_policy.py
```

If the change fixes something specific, say what the symptom was. "Fixed the
bug" tells the next person nothing about whether their bug is the same one.

---

## What not to do

- **Do not add a fourth pool.** Three pools is the design; a fourth means the
  consolidation boundaries are wrong, not that a pool is missing.
- **Do not make decay unbounded in either direction.** Items must be able to
  fade and must not be permanently pinnable.
- **Do not put private or personal data in the source**, including in comments,
  docstrings, test fixtures, and examples. That is what the gate is for.
- **Do not add a dependency for something the stdlib does.** The install is one
  package on purpose.
