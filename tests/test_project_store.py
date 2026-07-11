"""Tests for the project + CV-candidate persistence layer (Phase 1 of the
projects/CV-discovery restructure).

The DB path is monkeypatched to a tmp file so these never touch the real
~/.amd/users.db.  A hermetic encryption-key path is set before importing
``db`` so the import-time Fernet key is not written to the user's home.
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault(
    "AMD_ENCRYPTION_KEY_PATH", os.path.join(tempfile.gettempdir(), "amd_test_enc_key")
)

import pytest  # noqa: E402

from web.backend import cv_store, db, project_store  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    project_store.init_projects_db()
    cv_store.init_cv_db()
    yield


def _make_session(session_id, username="alice", nickname="run-1", project_id=None):
    db.upsert_session(
        {
            "session_id": session_id,
            "work_dir": f"/tmp/{session_id}/data",
            "nickname": nickname,
            "username": username,
            "run_status": "standby",
            "status": "active",
            "updated_at": "2026-01-01T00:00:00",
            "json_path": f"/tmp/{session_id}/session.json",
        }
    )
    if project_id:
        project_store.assign_simulation(session_id, project_id)


class TestProjectCRUD:
    def test_create_and_get(self, temp_db):
        p = project_store.create_project(name="Ala CV hunt", username="alice", goal="find CVs")
        assert p["project_id"].startswith("proj_")
        assert p["name"] == "Ala CV hunt"
        assert p["status"] == "active"
        assert p["simulation_count"] == 0
        assert project_store.get_project(p["project_id"])["goal"] == "find CVs"

    def test_list_filters_by_user_and_hides_deleted(self, temp_db):
        project_store.create_project(name="A", username="alice")
        project_store.create_project(name="B", username="bob")
        d = project_store.create_project(name="D", username="alice")
        project_store.delete_project(d["project_id"])
        names = {p["name"] for p in project_store.list_projects("alice")}
        assert names == {"A"}  # bob's project hidden, deleted project hidden

    def test_update_whitelist(self, temp_db):
        p = project_store.create_project(name="A", username="alice")
        assert project_store.update_project(p["project_id"], {"name": "renamed", "bogus": "x"})
        assert project_store.get_project(p["project_id"])["name"] == "renamed"

    def test_update_all_unknown_is_noop(self, temp_db):
        p = project_store.create_project(name="A")
        assert project_store.update_project(p["project_id"], {"only_bogus": 1}) is False

    def test_get_missing(self, temp_db):
        assert project_store.get_project("nope") is None


class TestSimulationAssociation:
    def test_assign_and_count(self, temp_db):
        p = project_store.create_project(name="A", username="alice")
        _make_session("s1", project_id=p["project_id"])
        _make_session("s2", project_id=p["project_id"])
        assert project_store.get_project(p["project_id"])["simulation_count"] == 2
        sims = project_store.list_project_simulations(p["project_id"])
        assert {s["session_id"] for s in sims} == {"s1", "s2"}
        assert isinstance(sims[0]["result_cards"], list)  # deserialised

    def test_assign_missing_session(self, temp_db):
        p = project_store.create_project(name="A")
        assert project_store.assign_simulation("nope", p["project_id"]) is False

    def test_upsert_session_preserves_project_id(self, temp_db):
        """db.upsert_session must NOT clobber the project_id set separately."""
        p = project_store.create_project(name="A")
        _make_session("s1", project_id=p["project_id"])
        # Re-upsert the same session (as the app does on status changes)
        db.upsert_session(
            {"session_id": "s1", "work_dir": "/tmp/s1/data", "run_status": "running",
             "status": "active", "updated_at": "x", "json_path": "/tmp/s1/session.json"}
        )
        assert project_store.get_project(p["project_id"])["simulation_count"] == 1


class TestMigration:
    def test_wraps_orphans_idempotently(self, temp_db):
        _make_session("s1", username="alice", nickname="My Run")
        _make_session("s2", username="bob", nickname="")
        assert project_store.migrate_sessions_to_projects() == 2
        assert project_store.migrate_sessions_to_projects() == 0  # idempotent
        alice = project_store.list_projects("alice")
        assert len(alice) == 1
        assert alice[0]["name"] == "My Run"
        assert alice[0]["simulation_count"] == 1


class TestCVStore:
    def test_cv_crud_and_ordering(self, temp_db):
        pid = project_store.create_project(name="A")["project_id"]
        cv_store.create_cv(pid, name="phi", cv_type="dihedral", score=0.4)
        cv_store.create_cv(
            pid, name="psi", cv_type="dihedral", score=0.9,
            origin_sims=["s1"], metrics={"tica": 0.9},
        )
        cv_store.create_cv(pid, name="unscored", cv_type="distance")
        cvs = cv_store.list_cvs(pid)
        assert [c["name"] for c in cvs] == ["psi", "phi", "unscored"]  # score DESC, nulls last
        assert cvs[0]["origin_sims"] == ["s1"]
        assert cvs[0]["metrics"] == {"tica": 0.9}

    def test_cv_update_json_fields(self, temp_db):
        pid = project_store.create_project(name="A")["project_id"]
        cv = cv_store.create_cv(pid, name="phi")
        cv_store.update_cv(
            cv["cv_id"],
            {"status": "validated", "metrics": {"score": 1.0}, "origin_sims": ["s1", "s2"]},
        )
        got = cv_store.get_cv(cv["cv_id"])
        assert got["status"] == "validated"
        assert got["metrics"] == {"score": 1.0}
        assert got["origin_sims"] == ["s1", "s2"]

    def test_cv_delete(self, temp_db):
        pid = project_store.create_project(name="A")["project_id"]
        cv = cv_store.create_cv(pid, name="phi")
        assert cv_store.delete_cv(cv["cv_id"]) is True
        assert cv_store.get_cv(cv["cv_id"]) is None
