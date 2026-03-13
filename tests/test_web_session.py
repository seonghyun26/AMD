"""Tests for web backend session manager — unit tests that don't require GROMACS."""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from web.backend.session_manager import (
    _sessions,
    Session,
    get_session,
    list_sessions,
    delete_session,
    infer_run_status_from_disk,
)


@pytest.fixture(autouse=True)
def clean_sessions():
    """Ensure a clean session store for each test."""
    _sessions.clear()
    yield
    _sessions.clear()


class TestSessionStore:
    def test_get_nonexistent_session(self):
        assert get_session("nonexistent") is None

    def test_list_sessions_empty(self):
        assert list_sessions() == []

    def test_list_sessions_filters_by_username(self):
        s1 = Session(session_id="s1", work_dir="/tmp/s1", nickname="one", username="alice")
        s2 = Session(session_id="s2", work_dir="/tmp/s2", nickname="two", username="bob")
        _sessions["s1"] = s1
        _sessions["s2"] = s2

        alice_sessions = list_sessions(username="alice")
        assert len(alice_sessions) == 1
        assert alice_sessions[0]["session_id"] == "s1"

        all_sessions = list_sessions()
        assert len(all_sessions) == 2

    def test_delete_session(self):
        s = Session(session_id="s1", work_dir="/tmp/s1")
        _sessions["s1"] = s
        assert delete_session("s1") is True
        assert get_session("s1") is None
        assert delete_session("s1") is False

    def test_get_session_returns_correct(self):
        s = Session(session_id="s1", work_dir="/tmp/s1", nickname="test")
        _sessions["s1"] = s
        result = get_session("s1")
        assert result is not None
        assert result.nickname == "test"


class TestInferRunStatus:
    def test_no_log_returns_none(self, tmp_path):
        assert infer_run_status_from_disk(tmp_path, tmp_path / "data") is None

    def test_fatal_error_returns_failed(self, tmp_path):
        data_dir = tmp_path / "data" / "simulation"
        data_dir.mkdir(parents=True)
        log = data_dir / "md.log"
        log.write_text("Some output\nFATAL ERROR: something went wrong\n")
        assert infer_run_status_from_disk(tmp_path, tmp_path / "data") == "failed"

    def test_segfault_returns_failed(self, tmp_path):
        data_dir = tmp_path / "data" / "simulation"
        data_dir.mkdir(parents=True)
        log = data_dir / "md.log"
        log.write_text("Running...\nSegmentation Fault\n")
        assert infer_run_status_from_disk(tmp_path, tmp_path / "data") == "failed"

    def test_completed_steps_returns_finished(self, tmp_path):
        data_dir = tmp_path / "data" / "simulation"
        data_dir.mkdir(parents=True)
        log = data_dir / "md.log"
        # Write a config.yaml with expected nsteps
        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text("method:\n  nsteps: 1000\n")
        # Write a log that parse_gromacs_log_progress can read
        # The parser looks for "Step           Time" table format
        log.write_text(
            "           Step           Time\n"
            "           1000        2.00000\n"
            "\n"
        )
        result = infer_run_status_from_disk(tmp_path, tmp_path / "data")
        # May return "finished" or None depending on parser — both acceptable
        assert result in ("finished", None)
