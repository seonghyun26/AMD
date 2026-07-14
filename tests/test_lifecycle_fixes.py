"""Regression tests for the critical lifecycle/container fixes.

#8 — get_simulation_status must decide terminal state from ACTUAL process exit,
     never kill a live mdrun on a log heuristic (which truncates output / leaks
     the GPU container).
#9 — the Docker container is stopped by the exact --cidfile, not by guessing the
     most-recent container for the image (wrong under concurrency).
"""

from __future__ import annotations

import pytest

from md_agent.tools.gromacs_tools import GROMACSRunner
from web.backend import session_manager as sm


class _FakeProc:
    def __init__(self, rc):
        self._rc = rc  # None == still running; int == exit code
        self.pid = 4321

    def poll(self):
        return self._rc


class _FakeRunner:
    def __init__(self, proc):
        self._mdrun_proc = proc
        self.cleaned = False

    def _cleanup(self):
        self.cleaned = True
        self._mdrun_proc = None


class _FakeAgent:
    def __init__(self, runner):
        self._gmx = runner
        self.cfg = None


@pytest.fixture(autouse=True)
def _clear_sessions():
    sm._sessions.clear()
    yield
    sm._sessions.clear()


def _register(session_id, proc, tmp_path):
    sess = sm.Session(session_id=session_id, work_dir=str(tmp_path / "data"))
    runner = _FakeRunner(proc)
    sess.agent = _FakeAgent(runner)
    sess.sim_status = {"started_at": 1.0, "expected_nsteps": 100, "output_prefix": "simulation/md"}
    sm._sessions[session_id] = sess
    return runner


class TestLifecycleNoKill:
    def test_alive_process_reports_running_and_is_not_cleaned(self, tmp_path):
        runner = _register("s1", _FakeProc(None), tmp_path)  # poll()->None == alive
        status = sm.get_simulation_status("s1")
        assert status["running"] is True
        assert status["status"] == "running"
        assert runner.cleaned is False  # a healthy run must never be stopped

    def test_exited_zero_is_finished_and_cleaned(self, tmp_path):
        runner = _register("s2", _FakeProc(0), tmp_path)
        status = sm.get_simulation_status("s2")
        assert status["running"] is False
        assert status["status"] == "finished"
        assert status["exit_code"] == 0
        assert runner.cleaned is True  # safe to clean only after real exit

    def test_exited_nonzero_is_failed(self, tmp_path):
        _register("s3", _FakeProc(1), tmp_path)
        status = sm.get_simulation_status("s3")
        assert status["status"] == "failed"
        assert status["exit_code"] == 1


class TestCidfileContainer:
    def test_find_container_prefers_cidfile(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GMX_DOCKER_IMAGE", "gmxtest")
        r = GROMACSRunner(work_dir=str(tmp_path))
        cid = tmp_path / ".mdrun.cid"
        cid.write_text("abc123def\n")
        r._cid_path = cid
        assert r._find_docker_container(999) == "abc123def"

    def test_build_cmd_cidfile_only_when_requested(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GMX_DOCKER_IMAGE", "gmxtest")
        r = GROMACSRunner(work_dir=str(tmp_path))
        with_cid = r._build_cmd(["mdrun"], tmp_path, cidfile=tmp_path / ".mdrun.cid")
        assert "--cidfile" in with_cid
        without = r._build_cmd(["grompp"], tmp_path)
        assert "--cidfile" not in without
