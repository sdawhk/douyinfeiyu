"""A rebuildable SQLite cache for hot JSON pool reads."""
from array import array
from contextlib import closing
import json
import os
import sqlite3


_CACHE_MIN_BYTES = 1024 * 1024
_CACHE_SCHEMA = """CREATE TABLE IF NOT EXISTS pool_snapshot_v1 (
    name TEXT PRIMARY KEY, revision TEXT NOT NULL, metadata TEXT NOT NULL,
    vectors BLOB NOT NULL
)"""


def _revision(st):
    return f"{st.st_size}:{st.st_mtime_ns}:{st.st_ctime_ns}:{st.st_ino}"


def _pack(data):
    packed = array("d")
    refs = []
    rows = []
    for row in data.get("memories", ()):
        vector = row.get("embedding")
        if not isinstance(vector, list) or not vector or any(type(x) not in (int, float) for x in vector):
            rows.append(row)
            continue
        at = len(packed)
        try:
            native = array("d", vector)
        except OverflowError:
            rows.append(row)
            continue
        packed.extend(native)
        clean = dict(row)
        del clean["embedding"]
        refs.append((len(rows), at, len(native)))
        rows.append(clean)
    metadata = json.dumps([dict(data, memories=rows), refs], ensure_ascii=False, separators=(",", ":"))
    return metadata, packed.tobytes()


def _unpack(metadata, packed):
    data, refs = json.loads(metadata)
    values = memoryview(packed).cast("d")
    rows = data["memories"]
    for index, offset, size in refs:
        segment = values[offset:offset + size]
        if len(segment) != size:
            raise ValueError("invalid vector length")
        rows[index]["embedding"] = segment.tolist()
    return data


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _discard_snapshot(db, name, path):
    if not os.path.isfile(db):
        return
    try:
        with closing(sqlite3.connect(db, timeout=0.1)) as conn, conn:
            conn.execute("PRAGMA secure_delete=ON")
            conn.execute("BEGIN IMMEDIATE")
            try:
                if os.stat(path).st_size >= _CACHE_MIN_BYTES:
                    return
            except FileNotFoundError:
                pass
            conn.execute("DELETE FROM pool_snapshot_v1 WHERE name=?", (name,))
    except (sqlite3.Error, OSError):
        pass


def load_pool(path):
    """Use a complete cached generation or read the canonical JSON."""
    name = os.path.basename(path)
    db = os.path.join(os.path.dirname(path), "embeddings.sqlite")
    try:
        st = os.stat(path)
    except FileNotFoundError:
        _discard_snapshot(db, name, path)
        raise
    if st.st_size < _CACHE_MIN_BYTES:
        _discard_snapshot(db, name, path)
        return _load_json(path)
    revision = _revision(st)
    if os.path.isfile(db):
        try:
            with closing(sqlite3.connect(db, timeout=0.1)) as conn:
                snapshot = conn.execute(
                    "SELECT metadata, vectors FROM pool_snapshot_v1 WHERE name=? AND revision=?",
                    (name, revision)).fetchone()
            if snapshot is not None and _revision(os.stat(path)) == revision:
                return _unpack(*snapshot)
        except (sqlite3.Error, OSError, ValueError, TypeError, IndexError, KeyError):
            pass

    data = _load_json(path)
    try:
        if _revision(os.stat(path)) == revision:
            metadata, vectors = _pack(data)
            with closing(sqlite3.connect(db, timeout=0.1)) as conn, conn:
                conn.execute("PRAGMA secure_delete=ON")
                conn.execute("BEGIN IMMEDIATE")
                if _revision(os.stat(path)) == revision:
                    conn.execute(_CACHE_SCHEMA)
                    conn.execute("INSERT OR REPLACE INTO pool_snapshot_v1 VALUES (?, ?, ?, ?)",
                                 (name, revision, metadata, vectors))
    except (sqlite3.Error, OSError, ValueError, TypeError):
        pass
    return data
