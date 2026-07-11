"""End-to-end auth tests through the real FastAPI app + JWT middleware (#1, #10).

Exercises the actual HTTP stack: missing/invalid token -> 401, cross-user -> 403,
owner (header OR ?token= query param) -> 200, and that /auth/login stays public.
"""

from __future__ import annotations

import os
import tempfile

_d = tempfile.mkdtemp()
os.environ.setdefault("AMD_DB_PATH", os.path.join(_d, "users.db"))
os.environ.setdefault("AMD_ENCRYPTION_KEY_PATH", os.path.join(_d, "enc"))
os.environ.setdefault("AMD_JWT_SECRET_PATH", os.path.join(_d, "jwt"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from web.backend import db, project_store  # noqa: E402
from web.backend.jwt_auth import create_token  # noqa: E402
from web.backend.main import app  # noqa: E402

_PATH = "/api/sessions/s1/run-status"  # a cheap session-scoped GET


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "users.db")
    project_store.init_projects_db()
    db.upsert_session(
        {
            "session_id": "s1",
            "work_dir": "/tmp/s1",
            "username": "alice",
            "status": "active",
            "run_status": "standby",
            "updated_at": "x",
            "json_path": "",
        }
    )
    return TestClient(app)


def test_missing_token_is_401(client):
    assert client.get(_PATH).status_code == 401


def test_invalid_token_is_401(client):
    assert client.get(f"{_PATH}?token=not-a-jwt").status_code == 401


def test_owner_via_header_is_allowed(client):
    tok = create_token("alice")
    r = client.get(_PATH, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200


def test_cross_user_is_403(client):
    tok = create_token("bob")
    r = client.get(_PATH, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 403


def test_owner_via_query_token_is_allowed(client):
    # #10: browser downloads/images/NGL pass the JWT as ?token= (no header).
    tok = create_token("alice")
    assert client.get(f"{_PATH}?token={tok}").status_code == 200


def test_cross_user_via_query_token_is_403(client):
    tok = create_token("bob")
    assert client.get(f"{_PATH}?token={tok}").status_code == 403


def test_login_endpoint_stays_public(client):
    # Reachable without a token; invalid creds -> 401 from the handler, not the middleware.
    r = client.post("/api/auth/login", json={"username": "nobody", "password": "x"})
    assert r.status_code == 401
