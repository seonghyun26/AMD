"""Tests for the CV-discovery orchestrator (propose → score → rank iteration)."""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault(
    "AMD_ENCRYPTION_KEY_PATH", os.path.join(tempfile.gettempdir(), "amd_test_enc_key")
)

import pytest  # noqa: E402

from web.backend import cv_orchestrator, cv_store, db, project_store  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    project_store.init_projects_db()
    cv_store.init_cv_db()
    yield


def _sim_with_phi_colvar(tmp_path, sid, pid, phi_values):
    """A finished project sim whose COLVAR has only a 'phi' column."""
    wd = tmp_path / sid
    wd.mkdir()
    rows = "".join(f"{i} {v}\n" for i, v in enumerate(phi_values))
    (wd / "COLVAR").write_text("#! FIELDS time phi\n" + rows)
    db.upsert_session(
        {"session_id": sid, "work_dir": str(wd), "username": "alice", "status": "active",
         "run_status": "finished", "updated_at": "x", "json_path": ""}
    )
    project_store.assign_simulation(sid, pid)


class TestOrchestrator:
    def test_propose_dedupes(self, temp_db):
        pid = project_store.create_project(name="P", system="ala_dipeptide")["project_id"]
        assert {c["name"] for c in cv_orchestrator.propose_for_project(pid)} == {"phi", "psi"}
        assert cv_orchestrator.propose_for_project(pid) == []  # nothing new second time
        assert len(cv_store.list_cvs(pid)) == 2

    def test_run_iteration_scores_and_plans(self, temp_db, tmp_path):
        pid = project_store.create_project(name="P", system="ala_dipeptide")["project_id"]
        _sim_with_phi_colvar(tmp_path, "s1", pid, [-2.5, -2.5, 2.5, 2.5] * 20)

        res = cv_orchestrator.run_iteration(pid)
        assert {c["name"] for c in res["proposed"]} == {"phi", "psi"}
        assert "phi" in {c["name"] for c in res["scored"]}       # phi has a COLVAR column
        assert res["best"]["name"] == "phi"
        assert "psi" in {c["name"] for c in res["needs_simulation"]}  # psi has no column yet

    def test_second_iteration_skips_scored(self, temp_db, tmp_path):
        pid = project_store.create_project(name="P", system="ala_dipeptide")["project_id"]
        _sim_with_phi_colvar(tmp_path, "s1", pid, [-2.5, 2.5] * 40)
        cv_orchestrator.run_iteration(pid)

        res2 = cv_orchestrator.run_iteration(pid)
        assert res2["proposed"] == []                              # no new CVs
        assert all(c["name"] != "phi" for c in res2["scored"])     # phi already scored
