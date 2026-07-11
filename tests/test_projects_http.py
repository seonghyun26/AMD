"""End-to-end tests for the wired project/CV routes through the real app.

Proves the Phase 1 projects layer works over HTTP AND that the central
ownership middleware scopes it correctly (create binds to the JWT identity;
cross-user access to a project is 403).
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

from web.backend import cv_store, db, project_store  # noqa: E402
from web.backend.jwt_auth import create_token  # noqa: E402
from web.backend.main import app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "users.db")
    project_store.init_projects_db()
    cv_store.init_cv_db()
    return TestClient(app)


def _auth(user):
    return {"Authorization": f"Bearer {create_token(user)}"}


def test_project_lifecycle_scoped_to_owner(client):
    alice, bob = _auth("alice"), _auth("bob")
    r = client.post("/api/projects", json={"name": "Ala CV hunt", "goal": "find CVs"}, headers=alice)
    assert r.status_code == 200
    proj = r.json()["project"]
    pid = proj["project_id"]
    assert proj["username"] == "alice"  # bound to the JWT, not any body field

    # Listing is scoped to the caller
    alice_ids = [p["project_id"] for p in client.get("/api/projects", headers=alice).json()["projects"]]
    assert pid in alice_ids
    assert client.get("/api/projects", headers=bob).json()["projects"] == []

    # Ownership enforced on the id-scoped route
    assert client.get(f"/api/projects/{pid}", headers=alice).status_code == 200
    assert client.get(f"/api/projects/{pid}", headers=bob).status_code == 403


def test_cv_crud_over_http(client):
    alice = _auth("alice")
    pid = client.post("/api/projects", json={"name": "P"}, headers=alice).json()["project"]["project_id"]
    r = client.post(
        f"/api/projects/{pid}/cvs",
        json={"name": "phi", "cv_type": "dihedral", "score": 0.7},
        headers=alice,
    )
    assert r.status_code == 200
    cvs = client.get(f"/api/projects/{pid}/cvs", headers=alice).json()["cvs"]
    assert len(cvs) == 1 and cvs[0]["name"] == "phi"


def test_simulation_assignment_over_http(client):
    alice = _auth("alice")
    db.upsert_session(
        {"session_id": "s1", "work_dir": "/tmp/s1", "username": "alice", "status": "active",
         "run_status": "standby", "updated_at": "x", "json_path": ""}
    )
    pid = client.post("/api/projects", json={"name": "P"}, headers=alice).json()["project"]["project_id"]
    assert client.post(
        f"/api/projects/{pid}/simulations", json={"session_id": "s1"}, headers=alice
    ).status_code == 200
    sims = client.get(f"/api/projects/{pid}/simulations", headers=alice).json()["simulations"]
    assert [s["session_id"] for s in sims] == ["s1"]
