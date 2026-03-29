"""Centralized session.json read/write with file locking + SQLite index.

All session.json mutations should go through this module to avoid
race conditions from concurrent reads and writes.

Read path:  SQLite index (fast O(1)) → filesystem fallback (slow O(n))
Write path: session.json with fcntl lock + SQLite index update
"""

from __future__ import annotations

import fcntl
import json
from pathlib import Path
from typing import Any

from web.backend.db import (
    get_session_indexed,
    list_sessions_indexed,
    update_session_index,
    upsert_session,
    session_index_count,
)


# ── Filesystem helpers (locked I/O) ──────────────────────────────────


def _scan_session_file(session_id: str) -> Path | None:
    """Find the session.json file for a given session_id.

    Fast path: use json_path from SQLite index.
    Slow path: glob filesystem (O(n), used only if index misses).
    """
    # Fast: check SQLite index for the json_path
    indexed = get_session_indexed(session_id)
    if indexed and indexed.get("json_path"):
        p = Path(indexed["json_path"])
        if p.exists():
            return p

    # Slow fallback: glob
    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") == session_id:
                # Backfill the index with the path we found
                update_session_index(session_id, {"json_path": str(sf)})
                return sf
        except Exception:
            continue
    return None


def read_session_json(session_id: str) -> dict[str, Any] | None:
    """Read session.json with a shared (read) lock. Returns None if not found."""
    sf = _scan_session_file(session_id)
    if not sf:
        return None
    try:
        with sf.open("r") as fh:
            fcntl.flock(fh, fcntl.LOCK_SH)
            try:
                return json.load(fh)
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
    except Exception:
        return None


def update_session_json(session_id: str, updates: dict[str, Any]) -> bool:
    """Atomically read-modify-write session.json with an exclusive lock.

    Also updates the SQLite index with the same fields.
    Returns True if the update was applied, False if the session was not found.
    """
    sf = _scan_session_file(session_id)
    if not sf:
        return False
    try:
        with sf.open("r+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                data = json.load(fh)
                data.update(updates)
                fh.seek(0)
                fh.write(json.dumps(data, indent=2))
                fh.truncate()
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
        # Keep SQLite index in sync
        update_session_index(session_id, updates)
        return True
    except Exception:
        return False


# ── Listing ──────────────────────────────────────────────────────────


def _migrate_filesystem_to_index() -> None:
    """One-time migration: scan filesystem and populate SQLite index."""
    outputs_root = Path("outputs")
    if not outputs_root.is_dir():
        return
    for sf in outputs_root.glob("*/*/session.json"):
        try:
            with sf.open("r") as fh:
                fcntl.flock(fh, fcntl.LOCK_SH)
                try:
                    data = json.load(fh)
                finally:
                    fcntl.flock(fh, fcntl.LOCK_UN)
            if "session_id" not in data or "work_dir" not in data:
                continue
            # Infer username from path: outputs/{username}/{session}/session.json
            parts = sf.relative_to(outputs_root).parts
            username = parts[0] if len(parts) >= 3 else ""
            data.setdefault("username", username)
            data["json_path"] = str(sf)
            upsert_session(data)
        except Exception:
            continue


def read_all_sessions(username: str = "") -> list[dict[str, Any]]:
    """List sessions from SQLite index. Falls back to filesystem on first run.

    Returns dicts with session metadata (no file I/O on the hot path).
    """
    # Migrate from filesystem if index is empty
    if session_index_count() == 0:
        _migrate_filesystem_to_index()

    return list_sessions_indexed(username)
