"""Tests for the central per-resource ownership check (#1).

authz.owns() is what the JWT middleware calls to block cross-user access to
id-scoped routes. These assert the ownership matrix directly (no HTTP stack).
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault(
    "AMD_ENCRYPTION_KEY_PATH", os.path.join(tempfile.gettempdir(), "amd_test_enc_key")
)

import pytest  # noqa: E402

from web.backend import authz, db, project_store  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "users.db")
    project_store.init_projects_db()
    yield


def _seed_session(sid, owner):
    db.upsert_session(
        {
            "session_id": sid,
            "work_dir": f"/tmp/{sid}",
            "username": owner,
            "status": "active",
            "run_status": "standby",
            "updated_at": "x",
            "json_path": "",
        }
    )


class TestOwns:
    def test_session_owner_enforced(self, temp_db):
        _seed_session("s1", "alice")
        assert authz.owns("alice", "/api/sessions/s1/files") is True
        assert authz.owns("bob", "/api/sessions/s1/files") is False
        assert authz.owns("bob", "/api/sessions/s1") is False  # DELETE/PATCH too

    def test_agents_route_is_session_scoped(self, temp_db):
        _seed_session("s2", "alice")
        assert authz.owns("bob", "/api/agents/s2/paper_config/run") is False
        assert authz.owns("alice", "/api/agents/s2/paper_config/run") is True

    def test_unknown_session_falls_through_to_handler(self, temp_db):
        # Unknown id → allowed here (handler 404s); never leaks another user's data.
        assert authz.owns("bob", "/api/sessions/ghost/files") is True

    def test_user_keys_route_self_only(self, temp_db):
        assert authz.owns("alice", "/api/users/alice/api-keys") is True
        assert authz.owns("bob", "/api/users/alice/api-keys/anthropic") is False

    def test_project_owner_enforced(self, temp_db):
        pid = project_store.create_project(name="P", username="alice")["project_id"]
        assert authz.owns("alice", f"/api/projects/{pid}/cvs") is True
        assert authz.owns("bob", f"/api/projects/{pid}/cvs") is False

    def test_collections_and_globals_allowed(self, temp_db):
        # No id segment → authenticated but not ownership-gated (handlers self-scope).
        for path in (
            "/api/sessions",
            "/api/projects",
            "/api/config/options",
            "/api/molecules",
            "/api/server/status",
        ):
            assert authz.owns("bob", path) is True
