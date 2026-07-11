"""Collective-variable candidate persistence (project-scoped).

The CV-discovery agent proposes candidate CVs, runs simulations to evaluate
them, scores them, and promotes the best to ``validated``.  Each candidate is
owned by a project and remembers which simulations produced/evaluated it.

Reuses the shared SQLite DB (:mod:`web.backend.db`).  ``definition``,
``origin_sims`` and ``metrics`` are stored as JSON strings and (de)serialised at
the boundary.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from web.backend import db

# ── Schema ────────────────────────────────────────────────────────────


def init_cv_db() -> None:
    """Create the ``cv_candidates`` table (idempotent)."""
    db.init_db()
    with db._conn() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS cv_candidates (
                cv_id       TEXT PRIMARY KEY,
                project_id  TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT '',
                cv_type     TEXT NOT NULL DEFAULT '',
                definition  TEXT NOT NULL DEFAULT '',
                origin_sims TEXT NOT NULL DEFAULT '[]',
                metrics     TEXT NOT NULL DEFAULT '{}',
                score       REAL,
                status      TEXT NOT NULL DEFAULT 'candidate',
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_cv_project ON cv_candidates(project_id)"
        )


# ── (De)serialisation helpers ─────────────────────────────────────────


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    for key, default in (("origin_sims", []), ("metrics", {})):
        raw = d.get(key)
        if isinstance(raw, str):
            try:
                d[key] = json.loads(raw)
            except Exception:
                d[key] = default
    return d


# ── CRUD ──────────────────────────────────────────────────────────────


def create_cv(
    project_id: str,
    name: str = "",
    cv_type: str = "",
    definition: str = "",
    origin_sims: list[str] | None = None,
    metrics: dict[str, Any] | None = None,
    score: float | None = None,
    status: str = "candidate",
) -> dict[str, Any]:
    cv_id = f"cv_{uuid.uuid4().hex[:16]}"
    with db._conn() as con:
        con.execute(
            """
            INSERT INTO cv_candidates
                (cv_id, project_id, name, cv_type, definition, origin_sims, metrics, score, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cv_id,
                project_id,
                name,
                cv_type,
                definition,
                json.dumps(origin_sims or []),
                json.dumps(metrics or {}),
                score,
                status,
            ),
        )
    return get_cv(cv_id)  # type: ignore[return-value]


def get_cv(cv_id: str) -> dict[str, Any] | None:
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        row = con.execute(
            "SELECT * FROM cv_candidates WHERE cv_id = ?", (cv_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_cvs(project_id: str) -> list[dict[str, Any]]:
    """List a project's CV candidates, best score first (nulls last)."""
    with db._conn() as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT * FROM cv_candidates WHERE project_id = ? "
            "ORDER BY (score IS NULL), score DESC, updated_at DESC",
            (project_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


_CV_UPDATABLE = {"name", "cv_type", "definition", "origin_sims", "metrics", "score", "status"}
_CV_JSON_FIELDS = {"origin_sims", "metrics"}


def update_cv(cv_id: str, updates: dict[str, Any]) -> bool:
    """Update whitelisted CV fields. JSON fields are serialised automatically."""
    fields = {k: v for k, v in updates.items() if k in _CV_UPDATABLE}
    if not fields:
        return False
    for key in _CV_JSON_FIELDS & fields.keys():
        if not isinstance(fields[key], str):
            fields[key] = json.dumps(fields[key])
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    fields["cv_id"] = cv_id
    with db._conn() as con:
        cur = con.execute(
            f"UPDATE cv_candidates SET {set_clause}, updated_at = CURRENT_TIMESTAMP "
            "WHERE cv_id = :cv_id",
            fields,
        )
    return cur.rowcount > 0


def delete_cv(cv_id: str) -> bool:
    with db._conn() as con:
        cur = con.execute("DELETE FROM cv_candidates WHERE cv_id = ?", (cv_id,))
    return cur.rowcount > 0
