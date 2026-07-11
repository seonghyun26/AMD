"""Ownership checks for id-scoped API routes.

Enforced centrally by the JWT middleware so every ``/api/{resource}/{id}`` route
is covered without per-handler code. A path is authorised unless it targets a
resource *known* to be owned by a different user: unknown ids fall through to the
handler (which 404s) rather than leaking, and non-id-scoped paths are always
allowed here (they still require a valid token, enforced by the middleware).
"""

from __future__ import annotations

from web.backend import db, project_store

# Resource segments whose {id} path parameter is a session_id.
_SESSION_RESOURCES = {"sessions", "agents"}


def session_owner(session_id: str) -> str | None:
    """Return the owning username of a session, or None if unknown."""
    try:
        rec = db.get_session_indexed(session_id)
    except Exception:
        return None
    return (rec or {}).get("username") or None


def project_owner(project_id: str) -> str | None:
    """Return the owning username of a project, or None if unknown."""
    try:
        proj = project_store.get_project(project_id)
    except Exception:
        return None
    return (proj or {}).get("username") or None


def owns(current_user: str, path: str) -> bool:
    """Return False only when *path* targets a resource owned by someone else.

    Paths without an id segment (collections, global config) return True here —
    they are still authenticated, and collection handlers scope results to the
    caller themselves.
    """
    parts = path.split("/")  # ['', 'api', resource, id, ...]
    if len(parts) < 4 or parts[1] != "api":
        return True
    resource, rid = parts[2], parts[3]
    if not rid:
        return True
    if resource in _SESSION_RESOURCES:
        owner = session_owner(rid)
        return owner is None or owner == current_user
    if resource == "projects":
        owner = project_owner(rid)
        return owner is None or owner == current_user
    if resource == "users":
        # /api/users/{username}/... — only the user themselves.
        return rid == current_user
    return True
