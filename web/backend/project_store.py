"""Project persistence: a project groups many simulations (sessions).

This is the container layer introduced for CV-discovery, where one scientific
investigation ("find good CVs for alanine dipeptide folding") spans many MD
runs.  A *simulation* is what the codebase historically called a *session*
(``session_id`` remains the simulation key); a *project* owns a set of them.

Design notes
------------
* Reuses the same SQLite database as :mod:`web.backend.db` (``AMD_DB_PATH``)
  via ``db._conn`` — no separate DB file, so users/sessions/projects stay in
  one place and can be joined.
* Purely additive: a new ``projects`` table plus a ``project_id`` column on the
  existing ``sessions`` index.  ``db.upsert_session`` never touches
  ``project_id`` (it upserts an explicit column list), so associations set here
  are preserved across session-index writes.
* ``status`` follows the soft-delete convention already used by ``sessions``
  (``active`` / ``archived`` / ``deleted``).
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any

from web.backend import db

# ── Schema / migration ────────────────────────────────────────────────


def init_projects_db() -> None:
    """Create the ``projects`` table and add ``sessions.project_id`` (idempotent).

    Calls :func:`db.init_db` first so the ``sessions`` table is guaranteed to
    exist before we ALTER it.
    """
    db.init_db()
    with db._conn() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                project_id   TEXT PRIMARY KEY,
                name         TEXT NOT NULL DEFAULT '',
                username     TEXT NOT NULL DEFAULT '',
                description  TEXT NOT NULL DEFAULT '',
                molecule     TEXT NOT NULL DEFAULT '',
                system       TEXT NOT NULL DEFAULT '',
                goal         TEXT NOT NULL DEFAULT '',
                status       TEXT NOT NULL DEFAULT 'active',
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """)
        # Additive migration: tag each session with its owning project.
        try:
            con.execute("ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # column already exists
        con.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)")


# ── Project CRUD ──────────────────────────────────────────────────────


def create_project(
    name: str,
    username: str = "",
    description: str = "",
    molecule: str = "",
    system: str = "",
    goal: str = "",
) -> dict[str, Any]:
    """Insert a new project and return its full row."""
    project_id = f"proj_{uuid.uuid4().hex[:16]}"
    with db._conn() as con:
        con.execute(
            """
            INSERT INTO projects (project_id, name, username, description, molecule, system, goal)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, name, username, description, molecule, system, goal),
        )
    return get_project(project_id)  # type: ignore[return-value]


def get_project(project_id: str) -> dict[str, Any] | None:
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
    if not row:
        return None
    project = dict(row)
    project["simulation_count"] = _count_simulations(project_id)
    return project


def list_projects(username: str = "") -> list[dict[str, Any]]:
    """List non-deleted projects (optionally filtered by owner), newest first."""
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        if username:
            rows = con.execute(
                "SELECT * FROM projects WHERE status != 'deleted' AND username = ? "
                "ORDER BY updated_at DESC",
                (username,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM projects WHERE status != 'deleted' ORDER BY updated_at DESC"
            ).fetchall()
    projects = []
    for row in rows:
        p = dict(row)
        p["simulation_count"] = _count_simulations(p["project_id"])
        projects.append(p)
    return projects


_PROJECT_UPDATABLE = {"name", "description", "molecule", "system", "goal", "status"}


def update_project(project_id: str, updates: dict[str, Any]) -> bool:
    """Update whitelisted project fields. Returns True if a row was changed."""
    fields = {k: v for k, v in updates.items() if k in _PROJECT_UPDATABLE}
    if not fields:
        return False
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    fields["project_id"] = project_id
    with db._conn() as con:
        cur = con.execute(
            f"UPDATE projects SET {set_clause}, updated_at = CURRENT_TIMESTAMP "
            "WHERE project_id = :project_id",
            fields,
        )
    return cur.rowcount > 0


def delete_project(project_id: str) -> bool:
    """Soft-delete a project. Member simulations are left intact (detached)."""
    with db._conn() as con:
        cur = con.execute(
            "UPDATE projects SET status = 'deleted', updated_at = CURRENT_TIMESTAMP "
            "WHERE project_id = ?",
            (project_id,),
        )
    return cur.rowcount > 0


def touch_project(project_id: str) -> None:
    """Bump a project's ``updated_at`` (call when a member simulation changes)."""
    with db._conn() as con:
        con.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE project_id = ?",
            (project_id,),
        )


# ── Project <-> simulation association ────────────────────────────────


def assign_simulation(session_id: str, project_id: str) -> bool:
    """Attach a simulation (session) to a project. Returns True on success."""
    with db._conn() as con:
        cur = con.execute(
            "UPDATE sessions SET project_id = ? WHERE session_id = ?",
            (project_id, session_id),
        )
    if cur.rowcount > 0:
        touch_project(project_id)
        return True
    return False


def list_project_simulations(project_id: str) -> list[dict[str, Any]]:
    """List a project's simulations from the SQLite session index (newest first)."""
    import json as _json

    with db._conn() as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT * FROM sessions WHERE project_id = ? AND status != 'deleted' "
            "ORDER BY updated_at DESC",
            (project_id,),
        ).fetchall()
    results = []
    for row in rows:
        d = dict(row)
        rc = d.get("result_cards", "[]")
        if isinstance(rc, str):
            try:
                d["result_cards"] = _json.loads(rc)
            except Exception:
                d["result_cards"] = []
        results.append(d)
    return results


def _count_simulations(project_id: str) -> int:
    with db._conn() as con:
        row = con.execute(
            "SELECT COUNT(*) FROM sessions WHERE project_id = ? AND status != 'deleted'",
            (project_id,),
        ).fetchone()
    return row[0] if row else 0


# ── One-time migration of legacy (project-less) sessions ──────────────


_LEGACY_PROJECT_NAME = "test"


def _get_or_create_test_project(username: str) -> dict[str, Any]:
    """Return the user's single ``test`` project, creating it if absent."""
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        row = con.execute(
            "SELECT * FROM projects WHERE username = ? AND name = ? AND status != 'deleted' "
            "ORDER BY created_at LIMIT 1",
            (username, _LEGACY_PROJECT_NAME),
        ).fetchone()
    if row:
        return dict(row)
    return create_project(
        name=_LEGACY_PROJECT_NAME,
        username=username,
        description="Home for pre-existing simulations.",
    )


def migrate_sessions_to_projects() -> int:
    """Assign every project-less session to its user's single ``test`` project.

    Forward-safe and idempotent: only sessions with an empty ``project_id`` are
    touched, so user-created projects are never disturbed. Populates the session
    index from disk first so on-disk sessions aren't missed. Returns the number
    of sessions assigned.
    """
    try:
        from web.backend.session_store import read_all_sessions

        read_all_sessions()  # ensure on-disk sessions are indexed before wrapping
    except Exception:
        pass

    with db._conn() as con:
        con.row_factory = sqlite3.Row
        orphans = con.execute(
            "SELECT session_id, username FROM sessions "
            "WHERE (project_id IS NULL OR project_id = '') AND status != 'deleted'"
        ).fetchall()

    moved = 0
    test_ids: dict[str, str] = {}
    for row in orphans:
        user = row["username"] or ""
        if user not in test_ids:
            test_ids[user] = _get_or_create_test_project(user)["project_id"]
        assign_simulation(row["session_id"], test_ids[user])
        moved += 1
    return moved


def consolidate_into_test_project() -> dict[str, Any]:
    """ONE-TIME: collapse every non-deleted session into its user's ``test``
    project and delete the now-empty other projects.

    Use this to migrate away from an earlier per-session auto-project scheme.
    NOT called at startup (it would yank user-created projects into ``test``).
    """
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT session_id, username, project_id FROM sessions WHERE status != 'deleted'"
        ).fetchall()

    moved = 0
    test_ids: dict[str, str] = {}
    for row in rows:
        user = row["username"] or ""
        if user not in test_ids:
            test_ids[user] = _get_or_create_test_project(user)["project_id"]
        if row["project_id"] != test_ids[user]:
            assign_simulation(row["session_id"], test_ids[user])
            moved += 1

    keep = set(test_ids.values())
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        projects = con.execute(
            "SELECT project_id FROM projects WHERE status != 'deleted'"
        ).fetchall()
    deleted = 0
    for p in projects:
        pid = p["project_id"]
        if pid not in keep and _count_simulations(pid) == 0:
            delete_project(pid)
            deleted += 1
    return {"moved": moved, "deleted_projects": deleted, "test_projects": sorted(keep)}
