"""Layered memory model — configuration.

Everything the runtime needs is resolved here, in one file. Two rules:

  1. **Paths are absolute.** The data directory is derived from this file's
     own location, never from ``os.getcwd()``. Starting the process from a
     different working directory must not scatter data files somewhere else.

  2. **No personal data lives in code.** Any path that used to point at a
     specific machine, a chat client's role file, or a user's mood provider is
     now an environment variable that defaults to empty and is skipped when
     unset. A fresh clone with no ``.env`` runs on three local pools and an
     optional embedding service; nothing else.

Data directory resolution (first match wins):

    1. ``MEMORY_DATA_DIR``        preferred
    2. ``DSH_MEMORY_DATA_DIR``    kept for compatibility with older deployments  # privacy-scan: allow
    3. ``<repository>/data``      default

See ``.env.example`` for every supported variable.
"""

import os

VERSION = "3.0.0"

# ── Root and data directory ──────────────────────────────────────────────────

#: Absolute directory holding this file. All defaults hang off it, so the
#: process may be started from any working directory.
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

_ENV_DATA_DIRS = ("MEMORY_DATA_DIR", "DSH_MEMORY_DATA_DIR")  # privacy-scan: allow


def _resolve_base_dir():
    """Return the absolute data directory, creating it if needed."""
    for name in _ENV_DATA_DIRS:
        value = (os.environ.get(name) or "").strip()
        if value:
            return os.path.abspath(os.path.expanduser(value))
    return os.path.join(PROJECT_ROOT, "data")


BASE_DIR = _resolve_base_dir()


def _env_str(name, default=""):
    value = os.environ.get(name)
    return default if value is None else value.strip()


def _env_int(name, default):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name, default):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name, default):
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


# ── Optional external inputs ────────────────────────────────────────────────
#
# Each of these used to be a hardcoded absolute path into a specific machine.
# They are now opt-in: when the variable is empty the corresponding feature is
# skipped rather than raising. ``identity_service`` and ``session_init`` check
# for emptiness before touching them.

#: Optional role/persona document injected on the first turn of a session.
ROLE_FILE_PATH = _env_str("MEMORY_ROLE_FILE")

#: Optional long-lived identity notes merged into the first injection.
MEMORY_MD_PATH = _env_str("MEMORY_IDENTITY_FILE")

#: Optional mood provider state (a JSON file with ``moods.__default__.mood``).
MOOD_FILE_PATH = _env_str("MEMORY_MOOD_FILE")

#: Optional directory of extra persona snippets.
DIARY_DIR = _env_str("MEMORY_DIARY_DIR")

# ── Data files (all under BASE_DIR) ─────────────────────────────────────────

WORKING_MEM_PATH = os.path.join(BASE_DIR, "working_mem.json")
LONG_TERM_ACTIVE_PATH = os.path.join(BASE_DIR, "active.json")
LONG_TERM_COLD_PATH = os.path.join(BASE_DIR, "cold.json")
SHORT_TERM_PATH = os.path.join(BASE_DIR, "shortterm.json")
LOCK_FILE_PATH = os.path.join(BASE_DIR, "memory_data.lock")
CONSOLIDATION_STATS_PATH = os.path.join(BASE_DIR, "last_consolidation.json")
CANDIDATE_POOL_PATH = os.path.join(BASE_DIR, "candidates.jsonl")

#: Report directory for the nightly patrol. Kept inside the data directory so
#: a move of BASE_DIR never leaves reports behind.
PATROL_DIR = _env_str("MEMORY_PATROL_DIR") or os.path.join(BASE_DIR, "patrol")
PATROL_LOG_PATH = os.path.join(BASE_DIR, "patrol.log")

#: Directory for per-subsystem auxiliary state (audit logs, caches, ...).
STATE_DIR = os.path.join(BASE_DIR, "state")


def ensure_dirs():
    """Create the data directories. Safe to call repeatedly.

    The runtime calls this on first use, so an empty checkout bootstraps
    itself without a manual setup step.
    """
    for path in (BASE_DIR, STATE_DIR, PATROL_DIR):
        if path:
            os.makedirs(path, exist_ok=True)
    return BASE_DIR


# ── Embedding service ───────────────────────────────────────────────────────
#
# Optional. When the service is unreachable the recall path degrades to
# lexical scoring instead of failing.

OLLAMA_EMBED_URL = _env_str(
    "OLLAMA_EMBED_URL", "http://127.0.0.1:11434/api/embeddings"
)
EMBED_MODEL = _env_str("OLLAMA_EMBED_MODEL", "bge-m3")
EMBED_DIM = _env_int("OLLAMA_EMBED_DIM", 1024)

# ── Working memory ──────────────────────────────────────────────────────────

WORKING_MEM_MAX_CHUNKS = 8          # 7±2 rule
WORKING_MEM_MAX_TOKEN = 50000
WORKING_MEM_CHUNK_MAX_TOKEN = 500
WORKING_MEM_DEFAULT_TTL = 86400

# ── Long-term tiers ─────────────────────────────────────────────────────────

COLD_STORAGE_THRESHOLD = 20.0
COLD_ARCHIVE_THRESHOLD = 20.0
HARD_DROP_THRESHOLD = 20.0
COLD_ARCHIVE_AFTER_DAYS = 180.0
COLD_RECALL_MIN_SIM = 0.45
COLD_RECALL_TOP_K = 2
COLD_AWAKE_STRENGTH = 50.0

LAYER_THRESHOLDS = [7.0, 30.0, 180.0]
LAYER_L1_WEIGHT = 0.8
LAYER_L2_WEIGHT = 0.5
LAYER_L3_WEIGHT = 1.0

DEDUPLICATION_SIM_THRESHOLD = 0.78
CONSOLIDATION_SCORE_THRESHOLD = 60
TRIAGE_L1_MIN = 20
TRIAGE_L2_MIN = 40

#: Per-day strength decay keyed by consolidation level (1 = least settled).
DECAY_RATE_MAP = {3: 2.0, 2: 5.0, 1: 8.0}

# ── Recall weights ──────────────────────────────────────────────────────────

RECALL_TOP_K = 5
RECALL_MAX_CHARS = 3000
ACTIVE_WINDOW_BONUS = 0.08
ACTIVE_WINDOW_MIN_SIM = 0.58
RECALL_SEMANTIC_MIN_SIM = 0.45
WEIGHT_SIM = 0.8
WEIGHT_STRENGTH = 0.15
WEIGHT_EMOTION = 0.05

ENTITY_BONUS = 0.05
ENTITY_BONUS_MAX = 0.1
ENTITY_GRAPH_WEIGHT = 0.11

RRF_K = 60
RECALL_USE_RRF = False
RRF_ROUTE_BONUS_RRF = 0.0015
RRF_ENTITY_WEIGHT_RRF = 0.002
QUERY_ROUTE_BONUS = 0.05

CROSS_DAY_HOURS = 20
INIT_MAX_TOKEN = 8000
INIT_MAX_TOKEN_COMPACT = 1500
INIT_DEFAULT_PROFILE = 'compact'
INIT_WORKING_TOP_K = 3
INIT_LONG_TERM_TOP_K = 2

# ── Short-term ──────────────────────────────────────────────────────────────

SHORT_TERM_WINDOW_DAYS = 3
SHORT_TERM_MAX_ITEMS = 1000
SHORT_TERM_DAILY_MAX = 400
SHORT_TERM_RECALL_MAX_CHARS = 1500
SHORT_TERM_RECALL_TOP_K = 5
SHORT_TERM_FORGET_THRESHOLD = 30.0
SHORT_TERM_MENTION_BONUS = 10.0
SHORT_TERM_FRESH_BONUS = 0.15
SHORT_TERM_SIM_HIT = 0.7
TOOL_CARD_PROMOTE_ENABLED = True
TOOL_CARD_PROMOTE_CATEGORY = "procedure"
#: How many cards to keep per ``(tool, action)`` pair. 1 means "one card per
#: action, refreshed in place" — the intended behaviour.
TOOL_CARD_PROMOTE_KEEP_PER_ACTION = _env_int(
    "TOOL_CARD_PROMOTE_KEEP_PER_ACTION", 1
)

# ── Episode layer ───────────────────────────────────────────────────────────

EPISODE_DECAY_RATE = 0.8
EPISODE_FLOOR = 45.0
EPISODE_KEEP_DAYS = 90.0
EPISODE_MAX_CHARS = 500
EPISODE_MAX_TURNS = 20
EPISODE_MIN_TURNS = 2
EPISODE_DAILY_EXPECTED = 10
EPISODE_ACTIVE_PER_DAY = 20
EPISODE_GAP_CUT_SECONDS = 600

# ── Conversation window ─────────────────────────────────────────────────────

WINDOW_KEEP_DAYS = 30.0
WINDOW_MAX_TURNS = 500

# ── Impression track ────────────────────────────────────────────────────────

IMPRESSION_BUILD_MIN_INTENSITY = 60.0
IMPRESSION_FLOOR_RATIO = 0.6
IMPRESSION_FLOOR_MIN = 20.0
IMPRESSION_FLOOR_CAP = 55.0
IMPRESSION_DECAY_RATE = _env_float("IMPRESSION_DECAY_RATE", 0.25)
IMPRESSION_RECALL_MIN = 40.0
IMPRESSION_DETAIL_MAX = 30.0
IMPRESSION_DETAIL_ERASED = 20.0
IMPRESSION_MENTION_BONUS = 6.0
IMPRESSION_PROTECT_FROM_COLD = False
IMPRESSION_SUPPLEMENT_ENABLED = False

CORE_FLOOR = 45.0
EMOTION_DECAY_PROTECT = {'extreme': (85.0, 0.25), 'high': (60.0, 0.4), 'medium': (40.0, 0.7)}

#: Emotion residue track: current_intensity settles at this per-day rate and
#: never drops below ``event_intensity × ratio``.
EMOTION_RESIDUE_DECAY_RATE = _env_float("EMOTION_RESIDUE_DECAY_RATE", 0.5)
EMOTION_RESIDUE_FLOOR_RATIO = 0.25

#: Detail track: how far the "still sharp" impression floor may fall, and the
#: step at which it is released.
IMPRESSION_DETAIL_FLOOR_MIN = 10.0
IMPRESSION_DETAIL_FLOOR_RELEASE = 1.0

#: Impression supplement (the "details faded, the feeling remains" channel).
IMPRESSION_MAX_EXTRA = 2
IMPRESSION_MENTION_MAX = 100.0
IMPRESSION_MIN_SIM = 0.45
IMPRESSION_SCORE_CAP = 0.30

# ── Nightly patrol ──────────────────────────────────────────────────────────

PATROL_KEEP_DAYS = 90
PATROL_RARE_DAYS = 90
PATROL_RARE_RECENT_HITS = 5
PATROL_RARE_RECENT_WINDOW = 30
PATROL_DUP_THRESHOLD = 0.72
#: Lenient idle tier, only active once the library itself is old enough.
PATROL_IDLE_AGED_DAYS = 30
PATROL_IDLE_MIN_LIBRARY_DAYS = 90
ZOMBIE_DAYS = 90
ORPHAN_MIN_CHARS = 5

# ── Handover (cross-session carry-over) ─────────────────────────────────────

HANDOVER_PATH = os.path.join(BASE_DIR, "state", "handover.json")
HANDOVER_MAX_CHARS = 120
HANDOVER_TRIVIA_MAX = 3
HANDOVER_TTL_HOURS = 24

# ── Lessons and reflection ──────────────────────────────────────────────────

LESSON_MAX_PER_DAY = 3
LESSON_MIN_CLUSTER = 3
REFLECT_MAX_CHARS = 200
REFLECT_MAX_PER_DAY = 1
REFLECT_MIN_MEMS = 3

# ── Maintenance ─────────────────────────────────────────────────────────────

MAINTENANCE_MIN_GAP_HOURS = _env_int("MAINTENANCE_MIN_GAP_HOURS", 20)
MAINTENANCE_RUN_HOUR_START = _env_int("MAINTENANCE_RUN_HOUR_START", 6)
MAINTENANCE_RUN_HOUR_END = _env_int("MAINTENANCE_RUN_HOUR_END", 23)

#: Fallback timezone offset used when a timestamp has no zone. Kept explicit so
#: logs are reproducible across machines.
TIMEZONE_OFFSET_HOURS = _env_float("MEMORY_TIMEZONE_OFFSET_HOURS", 0.0)

# ── Distillation ────────────────────────────────────────────────────────────
#
# Optional. Without a provider the distilled layer stays empty and recall runs
# on the three pools only.

DISTILLATION_PROVIDER = _env_str("DISTILLATION_PROVIDER")
DISTILLATION_BASE_URL = _env_str("DISTILLATION_BASE_URL")
DISTILLATION_MODEL = _env_str("DISTILLATION_MODEL")
DISTILLATION_API_KEY_ENV = _env_str(
    "DISTILLATION_API_KEY_ENV", "DISTILLATION_API_KEY"
)
DISTILLATION_TIMEOUT_SECONDS = _env_float("DISTILLATION_TIMEOUT_SECONDS", 120.0)
DISTILLATION_REVIEW_REQUIRED = _env_bool("DISTILLATION_REVIEW_REQUIRED", True)

# ── Lessons / reflection ────────────────────────────────────────────────────

LESSON_CONFIDENCE = 0.6

# ── Ownership ───────────────────────────────────────────────────────────────

#: Optional owner identifier. Empty means "single anonymous user"; nothing is
#: filtered on it, it only labels exports and reports.
OWNER_ID = _env_str("MEMORY_OWNER_ID")

#: Names the categoriser treats as close contacts when scoring importance.
#: Empty by default so a fresh install has no assumed social graph.
CORE_PEOPLE = tuple(
    name.strip()
    for name in _env_str("MEMORY_CORE_PEOPLE").split(",")
    if name.strip()
)

# ── Guard ───────────────────────────────────────────────────────────────────


def assert_absolute(paths=None):
    """Raise if any configured path is relative.

    Called by the self-tests: a relative data path is the one mistake that
    silently writes data into the current working directory.
    """
    if paths is None:
        paths = (BASE_DIR, WORKING_MEM_PATH, LONG_TERM_ACTIVE_PATH,
                 LONG_TERM_COLD_PATH, SHORT_TERM_PATH)
    for path in paths:
        if path and not os.path.isabs(path):
            raise AssertionError("配置路径必须是绝对路径: %r" % (path,))
    return True
