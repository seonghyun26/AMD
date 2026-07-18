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
            "created_at": "2025-12-31T23:59:00+00:00",
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
            {
                "session_id": "s1",
                "work_dir": "/tmp/s1/data",
                "run_status": "running",
                "status": "active",
                "updated_at": "x",
                "json_path": "/tmp/s1/session.json",
            }
        )
        assert project_store.get_project(p["project_id"])["simulation_count"] == 1
        indexed = db.get_session_indexed("s1")
        assert indexed is not None
        assert indexed["created_at"] == "2025-12-31T23:59:00+00:00"
        assert indexed["updated_at"] == "x"


class TestMigration:
    def test_created_at_schema_backfills_legacy_sessions(self, temp_db):
        with db._conn() as con:
            con.execute("DROP TABLE sessions")
            con.execute("""
                CREATE TABLE sessions (
                    session_id TEXT PRIMARY KEY,
                    work_dir TEXT NOT NULL,
                    nickname TEXT NOT NULL DEFAULT '',
                    username TEXT NOT NULL DEFAULT '',
                    run_status TEXT NOT NULL DEFAULT 'standby',
                    selected_molecule TEXT NOT NULL DEFAULT '',
                    started_at REAL,
                    finished_at REAL,
                    status TEXT NOT NULL DEFAULT 'active',
                    updated_at TEXT NOT NULL DEFAULT '',
                    json_path TEXT NOT NULL DEFAULT '',
                    result_cards TEXT NOT NULL DEFAULT '[]',
                    project_id TEXT NOT NULL DEFAULT ''
                )
                """)
            con.execute("""
                INSERT INTO sessions (session_id, work_dir, updated_at)
                VALUES ('legacy', '/tmp/legacy/data', '2024-05-06T07:08:09+00:00')
                """)

        db.init_db()

        legacy = db.get_session_indexed("legacy")
        assert legacy is not None
        assert legacy["created_at"] == "2024-05-06T07:08:09+00:00"

    def test_orphans_go_to_one_test_project_per_user(self, temp_db):
        _make_session("s1", username="alice", nickname="My Run")
        _make_session("s2", username="alice", nickname="Other")
        _make_session("s3", username="bob")
        assert project_store.migrate_sessions_to_projects() == 3
        assert project_store.migrate_sessions_to_projects() == 0  # idempotent

        alice = project_store.list_projects("alice")
        assert len(alice) == 1
        assert alice[0]["name"] == "test"
        assert alice[0]["simulation_count"] == 2  # both alice sims in one 'test'
        bob = project_store.list_projects("bob")
        assert len(bob) == 1 and bob[0]["name"] == "test" and bob[0]["simulation_count"] == 1

    def test_migration_leaves_user_projects_untouched(self, temp_db):
        real = project_store.create_project(name="Real Project", username="alice")
        _make_session("s1", username="alice", project_id=real["project_id"])
        _make_session("s2", username="alice")  # project-less → should go to 'test'
        assert project_store.migrate_sessions_to_projects() == 1
        names = {p["name"] for p in project_store.list_projects("alice")}
        assert names == {"Real Project", "test"}

    def test_consolidate_collapses_per_session_projects(self, temp_db):
        # Simulate the old scheme: each session wrapped in its own project.
        p1 = project_store.create_project(name="run1", username="alice")
        p2 = project_store.create_project(name="run2", username="alice")
        _make_session("s1", username="alice", project_id=p1["project_id"])
        _make_session("s2", username="alice", project_id=p2["project_id"])

        res = project_store.consolidate_into_test_project()
        assert res["moved"] == 2
        assert res["deleted_projects"] == 2  # run1/run2 now empty
        projs = project_store.list_projects("alice")
        assert [p["name"] for p in projs] == ["test"]
        assert projs[0]["simulation_count"] == 2


class TestCVStore:
    def test_cv_crud_and_ordering(self, temp_db):
        pid = project_store.create_project(name="A")["project_id"]
        cv_store.create_cv(pid, name="phi", cv_type="dihedral", score=0.4)
        cv_store.create_cv(
            pid,
            name="psi",
            cv_type="dihedral",
            score=0.9,
            origin_sims=["s1"],
            metrics={"tica": 0.9},
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
