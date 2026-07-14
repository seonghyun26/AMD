"""Regression tests for the handle-lost staleness fallback in
`infer_run_status_from_disk` — a run left "running" after the process/handle is
gone (server restart, OOM-kill, crash) must eventually resolve to "failed"
rather than being stuck "running" forever, WITHOUT false-failing a live run
(whose md.log mtime stays fresh)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from web.backend import session_manager as sm


def _make_session(tmp_path: Path, started_at: float) -> tuple[Path, Path]:
    root = tmp_path / "sess"
    work = root / "data"
    (work / "simulation").mkdir(parents=True)
    (root / "session.json").write_text(
        json.dumps({"run_status": "running", "started_at": started_at, "work_dir": str(work)})
    )
    return root, work


def test_no_log_and_started_long_ago_is_failed(tmp_path):
    root, work = _make_session(tmp_path, started_at=time.time() - 3600)  # 1h ago
    assert sm.infer_run_status_from_disk(root, work) == "failed"


def test_no_log_but_recently_started_is_unknown(tmp_path):
    root, work = _make_session(tmp_path, started_at=time.time() - 30)  # 30s ago
    assert sm.infer_run_status_from_disk(root, work) is None


def test_fresh_log_is_not_failed(tmp_path):
    root, work = _make_session(tmp_path, started_at=time.time() - 3600)
    log = work / "simulation" / "md.log"
    log.write_text("step 10\n")  # mtime = now
    assert sm.infer_run_status_from_disk(root, work) is None


def test_stale_log_is_failed(tmp_path):
    root, work = _make_session(tmp_path, started_at=time.time() - 3600)
    log = work / "simulation" / "md.log"
    log.write_text("step 10\n")
    old = time.time() - 3600
    os.utime(log, (old, old))  # log untouched for 1h
    assert sm.infer_run_status_from_disk(root, work) == "failed"
