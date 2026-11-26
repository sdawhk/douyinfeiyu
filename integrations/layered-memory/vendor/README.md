# Layered Memory Model

A local-first, file-based memory system for long-running conversational agents.
Three memory pools, decay, consolidation, recall routing, a nightly health
patrol, and an MCP server — no external database, no cloud service, no build step.

Memory records live in JSON/JSONL under one data directory. Large pools can also use a local SQLite vector cache. You can read it,
diff it, back it up with `cp -r`, and delete it without touching any other
system.

```bash
git clone https://github.com/yinomo23-a11y/layered-memory.git && cd layered-memory
python -m pip install -r requirements.txt
echo '{"sessionId":"demo","query":"hello"}' | python memory_cli.py recall
```

That is the whole setup. An empty checkout bootstraps itself on first use.

---

## Why it is shaped like this

Most "agent memory" is a vector store with a wrapper: everything gets embedded,
everything is retrievable forever, and relevance is whatever cosine similarity
says today. That breaks in three specific ways, and each pool here exists to fix
one of them.

| Problem | What happens without a fix | What this repo does |
|---|---|---|
| Not everything deserves to be remembered | The store grows monotonically, recall gets diluted, the agent starts reciting trivia | **Decay.** Every item has a strength that falls with time and rises on use |
| Repeating something makes it true | A fact mentioned twice outranks a fact stated once, forever | **Consolidation.** Repetition moves items between pools; it does not inflate strength without bound |
| "Do you remember" is not the same as "what do you know" | Retrieving a memory to answer a question also trains it as a preference | **Recall routing.** Read-only recall and confirmed use are scored differently |

The design goal is *forgetting well*, not remembering more. A memory system that
never forgets is indistinguishable from a log file.

---

## The three pools

```
          write
            │
            ▼
    ┌───────────────┐   consolidate   ┌───────────────┐   archive   ┌──────────┐
    │   shortterm   │ ──────────────▶ │    active     │ ──────────▶ │   cold   │
    │  (3 day TTL)  │                 │  (working set)│  (180 days) │ (frozen) │
    └───────────────┘                 └───────────────┘             └──────────┘
            │                                 │
            └────────── recall ───────────────┘
```

**`shortterm.json`** — the last few days of raw material. Everything starts here.
Items are cheap to write and expire quickly; this is a buffer, not a archive.

**`active.json`** — the working set. What the agent actually draws on. Decay
runs here: unused items lose strength, used items regain it, and items that fall
below the floor are demoted rather than deleted.

**`cold.json`** — frozen snapshots. Nothing is written here during normal
operation; items arrive only through consolidation after long inactivity. Cold
items are still searchable but never surface unless asked for specifically.

There is also **`working_mem.json`**, which is *not* a fourth pool: it is the
per-session chunk buffer (the 7±2 slots holding the current conversation). It is
scoped to one session and never recalled directly.

---

## What is in the box

| Area | Module | Responsibility |
|---|---|---|
| Config | `config.py` | Every path and tunable, resolved once |
| Data model | `schema.py` | `MemoryItem`, validation, content classification |
| Pools | `memory_manager.py` | Load / write / atomic update of all pools |
| Decay | `decay_logic.py` | Strength curves, floors, reinforcement |
| Consolidation | `daily_consolidation.py` | shortterm → active → cold, episode building |
| Recall | `recall_engine.py`, `services/recall_service.py` | Scoring, routing, rendering |
| Eligibility | `services/recall_policy.py` | What may be surfaced, and when |
| Episodes | `episode.py`, `episode_store.py` | Grouping turns into narrative units |
| Distillation | `distillation.py` | Optional: turns memory into reusable skill cards |
| Handover | `handover.py` | Cross-session notes ("what were we talking about") |
| Window ledger | `window_ledger.py` | Raw per-session turn log |
| Health | `nightly_patrol.py`, `memory_health.py` | Integrity report and expired ledger cleanup |
| Entry points | `memory_cli.py`, `mcp_server.py` | CLI (stdin JSON) and MCP server |

Run module and integration checks with `python tests/run_all.py`. Individual modules also have self-tests:

```bash
python window_ledger.py      # runs its own assertions against a temp directory
```

---

## Entry points

### CLI

Pass the action as `argv[1]` and a JSON object on stdin. The CLI writes one JSON
line to stdout and diagnostics to stderr. Invalid input returns `ok: false` and
exit code 2.

```bash
# recall
echo '{"sessionId":"s1","query":"上次说的那个项目"}' | python memory_cli.py recall

# add to working memory (set isManual:true or effective_from/effective_to to persist directly to active)
echo '{"sessionId":"s1","content":"第1周课表：周一上午高数","effective_from":1795000000,"effective_to":1795604800}' \
  | python memory_cli.py add

# add to the short-term buffer
echo '{"sub":"add","sessionId":"s1","content":"他周五要交报告","tags":["工作"]}' \
  | python memory_cli.py shortterm

# per-turn ledger append
echo '{"sub":"append","sessionId":"s1","his":"在吗","said":"在"}' | python memory_cli.py window

# optional distillation & skill cards (requires DISTILLATION_* provider + explicit review)
echo '{"sub":"status","scope":"main"}' | python memory_cli.py distill
echo '{"sub":"generate","scope":"main"}' | python memory_cli.py distill
echo '{"sub":"review","scope":"main","card_id":"<id>","reviewer":"owner","approved":true}' | python memory_cli.py distill
echo '{"sub":"match","scope":"main","text":"这是本周课表","has_image":true,"sessionId":"s1"}' | python memory_cli.py distill
```

### MCP server

```bash
python mcp_server.py
```

The stdio server exposes 8 tools: `memory_runtime_status`, `memory_recall`,
`memory_add`, `memory_correct`, `memory_recall_cold`,
`memory_add_later_thought`, `memory_confirm_used`, and `memory_init_session`.
Connect clients that may read and modify the configured store, for example:

```json
{
  "mcpServers": {
    "layered-memory": {
      "command": "python",
      "args": ["/absolute/path/to/layered-memory/mcp_server.py"],
      "env": {
        "MEMORY_DATA_DIR": "/absolute/path/to/memory-data"
      }
    }
  }
}
```

### Further documentation

- [docs/模型原理说明.md](docs/模型原理说明.md) — Chinese overview, architecture, CLI/MCP quickstart, distillation & skill cards
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module boundaries and data flow
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — deployment, daily/weekly checks, backup, and failure signals

---

## Configuration

Set environment variables in the process that starts the CLI or MCP server. See `.env.example` for their names. **Every variable has a safe default** — an empty
file is a valid configuration and runs on the three local pools with all optional
features at their defaults.

The only variable most deployments need:

```bash
MEMORY_DATA_DIR=/absolute/path/to/memory-data
```

Leave it unset and data goes to `<repo>/data`. Do not use a relative path: the
process may start from any working directory.

Two optional integrations:

- **Embedding service** (`OLLAMA_EMBED_URL`) — when unreachable, recall falls
  back to lexical scoring. Nothing breaks.
- **Distillation provider** (`DISTILLATION_*`) — without it the distilled layer
  stays empty and recall uses the three pools only.

---

## Operating it

```bash
python nightly_patrol.py          # report and expired ledger cleanup
python daily_consolidation.py     # dry-run; add --apply to actually consolidate
python tools/privacy_scan.py      # CI gate: no personal data in the source
```

`nightly_patrol.py` never writes to the pools. It prunes expired window ledger entries and writes a
Markdown report to `patrol/`. Run it before trusting a deployment.

`daily_consolidation.py` with no arguments is a preview that writes nothing.
This is deliberate: the single most common way to lose data is running a
maintenance script to "see what it does".

### Privacy gate

`tools/privacy_scan.py` is a hard gate, not a linter. Exit code 1 on any hit, so
it drops straight into CI:

```bash
python tools/privacy_scan.py --strict
```

The public scanner checks account-number patterns, phone numbers and local user paths.
Strict mode also checks common credential formats. Reports omit matched text unless
`--show-text` is set. Keep any deployment-specific identifier lists offline.

---

## Design notes

**Atomic writes everywhere.** Every JSON write goes through `atomic_io.py`
(temp file → fsync → replace). A process killed mid-write leaves the old file
intact, not a truncated one.

**Locking is per-resource, not global.** `common/locking.py` takes a file lock
scoped to what is being written. A consolidation pass and an interactive write
can proceed concurrently.

**Recall is eligible-then-ranked.** `services/recall_policy.py` decides what
*may* be surfaced (deleted, superseded, private, unscoped, unverified) before
any scoring happens. Scoring a record that should never appear is wasted work
and a correctness hazard.

**Failure is reported, not swallowed.** Silent failure is the failure mode that
costs days: a write that never succeeded and never errored looks exactly like a
write that was never needed. Where a step can fail without halting the caller,
it appends to an `errors` list rather than returning a bare empty result.

**Empty is a state, not a fault.** A fresh checkout has no memories. Every code
path and every self-test treats "no data yet" as valid, distinct from "data is
broken".

---

## Requirements

- Tested with Python 3.12
- `requirements.txt` (installs `filelock` and `requests`)
- Optional: a local embedding endpoint, an LLM provider for distillation

No external database or message queue is required.

---

## License

MIT — see `LICENSE`.
