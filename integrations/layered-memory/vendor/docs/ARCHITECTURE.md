# Architecture

How the pieces fit, and why each boundary is where it is.

---

## Layering

Modules are grouped by dependency level. A lower level must never import a
higher one — that rule is what keeps this importable from any entry point
without cycles.

```
L1  config.py            paths and tunables only; imports nothing local
L1  schema.py            data model; imports config
L1  atomic_io.py         atomic JSON writes; imports nothing local
L1  common/              locking and io primitives
        │
L2  memory_manager.py    pool load/write; imports L1
L2  decay_logic.py       strength curves; imports L1
L2  window_ledger.py     raw turn log; imports L1
        │
L3  daily_consolidation  shortterm → active → cold; imports L2
L3  episode*.py          narrative grouping; imports L2
L3  distillation.py      skill cards; imports L2
L3  handover.py          cross-session notes; imports L2
L3  recall_engine.py     scoring; imports L2
        │
L4  services/            policy, recall assembly, feedback, correction
L4  nightly_patrol.py    read-only checks over everything
L4  memory_cli.py        CLI surface
L4  mcp_server.py        MCP surface
```

`window_ledger.py` documents this explicitly and imports only `config`, because
`daily_consolidation` reads the ledger — importing it back would close a cycle
that prevents the process from starting at all.

---

## Data flow

### Write path

```
caller
  │  memory_cli.py <action>
  ▼
MemoryManager.add_shortterm()        ← everything enters here
  │
  ▼
shortterm.json                       ← TTL 3 days
```

Nothing writes directly into `active.json`. Items reach the working set only
through consolidation. This is the single most important structural rule: it
means the working set is always the output of a considered process, never an
accident.

### Consolidation

`daily_consolidation.py`, run daily:

1. **Load** shortterm + active.
2. **Aggregate** shortterm items into episodes (90-minute segments by default).
3. **Promote** items above threshold into `active.json`.
4. **Refresh** strength on everything that survived.
5. **Demote** active items below the floor to `cold.json`.
6. **Record** a stats snapshot in `last_consolidation.json`.

Every step is individually guarded. A failure in step 5 does not discard the
results of step 3 — that would be losing work because a later step broke.

### Recall path

```
query
  │
  ▼
services/recall_policy.eligible()    ← may this be surfaced at all?
  │
  ▼
recall_engine score                  ← lexical + vector + recency + strength
  │
  ▼
services/recall_service.recall_core()← assemble, render, budget
  │
  ▼
rendered text
```

**Eligibility runs before scoring**, and it is deliberately strict. A record is
excluded when it is deleted, superseded, corrected, private, unscoped, a
placeholder, outside its validity window, or when its source evidence is
missing. Scoring is expensive and, more importantly, a record that should never
appear must not be able to influence ranking even by taking a slot.

---

## Memory item lifecycle

```
created (shortterm)
   │
   ├── expires ──────────────────────────────▶ deleted
   │
   └── consolidated ──▶ active
                          │
                          ├── reinforced by use ──▶ stays active, stronger
                          │
                          ├── decays below floor ─▶ cold
                          │
                          └── superseded/corrected ▶ excluded from recall
                                                      (still on disk)
```

Deletion is rare and always explicit. Decay demotes; it does not destroy. An item
that leaves the working set is still on disk and still recoverable, which is what
makes the "forget well" claim safe to make.

---

## Strength and decay

Every item carries `strength` and a timestamp. Decay is applied lazily on read,
using the elapsed time since the last computation, so there is no background
process and no scheduler requirement.

The curve has three properties that matter:

1. **A floor.** Strength decays toward a non-zero floor, not to zero. Items
   become quiet, not dead.
2. **Reinforcement is bounded.** Recalling an item raises strength up to a
   ceiling, so a single query cannot permanently pin something at maximum.
3. **Half-lives differ by category.** Stable profile facts decay slower than
   passing events. Collapsing this into one half-life is what makes simple decay
   systems feel wrong: either trivia persists or identity evaporates.

The consolidation level (1/2/3) selects the decay rate. That mapping lives in
`config.py` as the single source of truth, and modules that keep a local fallback
copy document that the fallback **must equal** the config value.

---

## Episodes

A raw turn log is not memory. Episodes group turns into units that can be
referred to: "that time we planned the trip" is one episode, not forty rows.

Grouping is by time (90-minute gaps by default) plus topic continuity. Episodes
carry their own strength and are recalled alongside individual items, which is
why `recall_service` resolves episodes as a separate final step rather than
mixing them into the item ranking.

Orphan detection matters more than it looks: an episode whose referenced source
ids no longer exist is invisible to recall but occupies space and can resurrect
as a phantom. The nightly patrol checks for exactly this.

---

## Distillation (optional)

Turns lasting procedures into reusable **skill cards**. Off by default; without
a provider the layer stays empty and everything else works unchanged.

The design constraint is that a card must be *checkable*: `trigger` has to be
something a program can match against an incoming message, not a natural-language
description. Early versions accepted "when the user asks for an image" and the
matcher could do nothing with it — so two such cards absorbed every input and
the cap of 2 meant nothing else could ever be injected. The prompt now demands
quoted, literal match words, and the validator rejects descriptions.

---

## Handover

A short note passed between sessions: what was being discussed, the emotional
register, unfinished threads, small trivia. Injected on a session's first turn.

Three constraints, all learned from failure:

- **TTL.** A handover older than the TTL is not "the last conversation", it is a
  stale claim about the present. Expired notes return `None`.
- **Per-session preference.** When several sessions are alive, the caller should
  pass its own session key. Without it the result may be *someone else's*
  conversation — the failure looks like the agent knowing things it should not.
- **Unknown sessions fall back.** A brand-new session has no note of its own;
  falling back to the most recent note is the only thing that makes cross-day
  continuity work. Returning `None` because the key happens to carry a prefix is
  a bug, not isolation.

---

## Failure philosophy

Three rules, applied throughout:

**Never silently succeed.** A write that did not happen must not return as if it
did. Where a caller cannot act on an exception, the result carries `ok: false`
and a `reason`.

**Degrade by channel, not by request.** If cold-pool search fails, the short-term
results still return and `errors` gains one entry. A single broken channel must
not turn a partially successful recall into "memory unavailable".

**Treat empty as valid.** Fresh checkout, no data, first run — every one of these
is a legitimate state and every code path must handle it without erroring.
Conflating "no data" with "broken data" means a new deployment starts red.
