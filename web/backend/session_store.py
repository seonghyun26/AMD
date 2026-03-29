"""Centralized session.json read/write with file locking.

All session.json mutations should go through this module to avoid
race conditions from concurrent reads and writes.

Uses fcntl.flock (Linux) for advisory file locking.
"""

from __future__ import annotations

import fcntl
import json
from pathlib import Path
from typing import Any


def _scan_session_file(session_id: str) -> Path | None:
    """Find the session.json file for a given session_id."""
    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") == session_id:
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
        return True
    except Exception:
        return False


def read_all_sessions(username: str = "") -> list[dict[str, Any]]:
    """Read all session.json files, optionally filtered by username folder.

    Uses shared locks for each file. Does NOT write to any file —
    status inference is the caller's responsibility.
    """
    outputs_root = Path("outputs")
    if username:
        scan_root = outputs_root / username
        glob_pattern = "*/session.json"
    else:
        scan_root = outputs_root
        glob_pattern = "*/*/session.json"

    sessions: list[dict[str, Any]] = []
    if not scan_root.is_dir():
        return sessions

    for sf in scan_root.glob(glob_pattern):
        try:
            with sf.open("r") as fh:
                fcntl.flock(fh, fcntl.LOCK_SH)
                try:
                    data = json.load(fh)
                finally:
                    fcntl.flock(fh, fcntl.LOCK_UN)

            if "session_id" not in data or "work_dir" not in data:
                continue
            if data.get("status") in ("inactive", "deleted"):
                continue
            sessions.append(data)
        except Exception:
            continue

    return sessions
