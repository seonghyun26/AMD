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
    """Owning username of a session; ``""`` if the record exists but has no owner
    (legacy/migrated), or ``None`` if the session is not indexed at all.

    The empty-string case must NOT be conflated with None: an authenticated user
    always has a non-empty username, so an ownerless record then fails the
    ``owner == current_user`` check in ``owns`` (deny), while a truly-unknown id
    (None) still falls through to a 404 rather than leaking existence.
    """
    try:
        rec = db.get_session_indexed(session_id)
    except Exception:
        return None
    if not rec:
        return None
    return rec.get("username") or ""


def project_owner(project_id: str) -> str | None:
    """Owning username of a project; ``""`` if ownerless, ``None`` if unknown.
    See :func:`session_owner` for why the two are kept distinct."""
    try:
        proj = project_store.get_project(project_id)
    except Exception:
        return None
    if not proj:
        return None
    return proj.get("username") or ""


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
