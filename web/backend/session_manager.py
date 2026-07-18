"""Session management: one MDAgent per browser session.

Uses an LRU-bounded dict to prevent unbounded memory growth.
Sessions with active simulations are never evicted.
Evicted sessions can be transparently restored from disk via restore_session().
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from importlib.util import find_spec
from pathlib import Path

from md_agent.config.hydra_utils import normalize_runtime_config
from md_agent.utils.parsers import parse_gromacs_log_progress


def _repo_conf_dir() -> str:
    """Return the conf/ directory, whether running from the repo or installed."""
    spec = find_spec("md_agent")
    if spec and spec.origin:
        pkg_dir = Path(spec.origin).parent
    else:
        raise RuntimeError("md_agent package not found")

    for candidate in [
        Path(__file__).parents[2] / "conf",  # repo root/conf
        pkg_dir.parents[1] / "share" / "amd-agent" / "conf",  # installed
    ]:
        if candidate.is_dir():
            return str(candidate)

    raise FileNotFoundError("Cannot locate conf/ directory")


def _load_hydra_cfg(overrides: list[str], work_dir: str):
    from hydra import compose, initialize_config_dir
    from hydra.core.global_hydra import GlobalHydra

    conf_dir = _repo_conf_dir()
    GlobalHydra.instance().clear()
    with initialize_config_dir(config_dir=conf_dir, job_name="amd-web"):
        cfg = compose(
            config_name="config",
            overrides=overrides + [f"run.work_dir={work_dir}"],
        )
    return cfg


@dataclass
class Session:
    session_id: str
    work_dir: str
    nickname: str = ""
    username: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    sim_status: dict = field(default_factory=dict)
    # agent is set after __init__ to allow dataclass + post-init pattern
    agent: object = field(default=None, init=False)


_MAX_SESSIONS = int(os.getenv("AMD_MAX_SESSIONS", "50"))
_sessions: OrderedDict[str, Session] = OrderedDict()


def _has_active_simulation(session: Session) -> bool:
    """Check if a session has a running mdrun process."""
    try:
        runner = getattr(session.agent, "_gmx", None)
        if runner is not None:
            proc = getattr(runner, "_mdrun_proc", None)
            if proc is not None and proc.poll() is None:
                return True
    except Exception:
        pass
    return False


def _evict_if_needed() -> None:
    """Remove the oldest idle session if we're over the limit."""
    while len(_sessions) > _MAX_SESSIONS:
        # Find the oldest session that doesn't have an active simulation
        evict_key = None
        for sid, session in _sessions.items():
            if not _has_active_simulation(session):
                evict_key = sid
                break
        if evict_key is None:
            break  # All sessions have active simulations — can't evict
        # Best-effort: stop any lingering Docker container before dropping the
        # only handle to its runner (guards against leaking a GPU container from
        # a restored session whose process handle we no longer hold).
        try:
            _sessions[evict_key].agent._gmx._cleanup()
        except Exception:
            pass
        _sessions.pop(evict_key)


def _touch(session_id: str) -> None:
    """Move a session to the end (most recently used)."""
    if session_id in _sessions:
        _sessions.move_to_end(session_id)


def create_session(
    work_dir: str,
    nickname: str = "",
    username: str = "",
    method: str = "metadynamics",
    system: str = "protein",
    gromacs: str = "default",
    plumed_cvs: str = "default",
    extra_overrides: list[str] | None = None,
) -> Session:
    from md_agent.agent import MDAgent

    overrides = [
        f"method={method}",
        f"system={system}",
        f"gromacs={gromacs}",
        f"plumed/collective_variables={plumed_cvs}",
        *(extra_overrides or []),
    ]
    cfg = _load_hydra_cfg(overrides, work_dir)
    normalize_runtime_config(cfg)

    sid = str(uuid.uuid4())
    session = Session(session_id=sid, work_dir=work_dir, nickname=nickname, username=username)
    session.agent = MDAgent(cfg=cfg, work_dir=work_dir)
    _sessions[sid] = session
    _evict_if_needed()
    return session


def get_session(session_id: str) -> Session | None:
    session = _sessions.get(session_id)
    if session is not None:
        _touch(session_id)
    return session


def list_sessions(username: str = "") -> list[dict]:
    sessions = _sessions.values()
    if username:
        sessions = [s for s in sessions if s.username == username]
    return [
        {"session_id": s.session_id, "work_dir": s.work_dir, "nickname": s.nickname}
        for s in sessions
    ]


def stop_session_simulation(session_id: str) -> bool:
    """Terminate any running mdrun for this session. Returns True if a process was stopped."""
    session = _sessions.get(session_id)
    if not session:
        return False
    try:
        runner = getattr(session.agent, "_gmx", None)
        if runner is not None:
            proc = getattr(runner, "_mdrun_proc", None)
            if proc is not None and proc.poll() is None:
                runner._cleanup()
                return True
    except Exception:
        pass
    return False


_tail_cache: dict[str, tuple[float, str]] = {}  # path → (mtime, text)


def _tail_text(path: Path, max_bytes: int = 64 * 1024) -> str:
    """Read the tail of a text file, with mtime-based caching."""
    try:
        key = str(path)
        mtime = path.stat().st_mtime
        cached = _tail_cache.get(key)
        if cached and cached[0] == mtime:
            return cached[1]
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            text = fh.read().decode("utf-8", errors="replace")
        _tail_cache[key] = (mtime, text)
        # Cap cache size to avoid unbounded growth
        if len(_tail_cache) > 100:
            oldest = next(iter(_tail_cache))
            del _tail_cache[oldest]
        return text
    except Exception:
        return ""


_infer_cache: dict[str, tuple[float, dict | None]] = {}  # path → (mtime, result)


def _infer_status_from_log(
    log_candidates: list[Path],
    expected_nsteps: int | None = None,
    started_after: float = 0.0,
) -> dict | None:
    """Shared log-inference logic. Returns {"status": str, "detected_by": str} or None.

    Parameters
    ----------
    log_candidates : candidate md.log paths to check (first existing wins)
    expected_nsteps : target step count for "finished" detection
    started_after : ignore logs with mtime before this timestamp (0 = no filter)
    """
    for log_path in log_candidates:
        if not log_path.exists():
            continue
        try:
            mtime = log_path.stat().st_mtime
        except Exception:
            continue
        if started_after > 0 and mtime < started_after:
            continue

        # Return cached result if log hasn't changed
        cache_key = str(log_path)
        cached = _infer_cache.get(cache_key)
        if cached and cached[0] == mtime:
            return cached[1]

        tail = _tail_text(log_path).lower()
        result: dict | None = None
        if "fatal error" in tail or "segmentation fault" in tail:
            result = {"status": "failed", "detected_by": "log_error"}
        else:
            info = parse_gromacs_log_progress(str(log_path))
            if expected_nsteps is not None and info and int(info.get("step", 0)) >= expected_nsteps:
                result = {"status": "finished", "detected_by": "step_reached"}
            # NOTE: a stale log (no writes for a while) is deliberately NOT treated
            # as failure. GROMACS legitimately pauses output for >60s (PME tuning,
            # large systems, checkpoint flush). Terminal state is decided by actual
            # process exit in get_simulation_status(), not by log mtime.

        if result is not None:
            _infer_cache[cache_key] = (mtime, result)
            return result

    return None


def infer_run_status_from_disk(session_root: Path, work_dir: Path) -> str | None:
    """Infer finished/failed from md.log and config when session is not in memory.
    Returns 'finished', 'failed', or None if unknown."""
    expected_nsteps = None
    try:
        cfg_path = session_root / "config.yaml"
        if cfg_path.exists():
            from omegaconf import OmegaConf

            cfg = OmegaConf.load(cfg_path)
            n = OmegaConf.select(cfg, "method.nsteps")
            if n is not None:
                expected_nsteps = int(n)
    except Exception:
        pass

    result = _infer_status_from_log(
        [work_dir / "simulation" / "md.log", work_dir / "md.log"],
        expected_nsteps=expected_nsteps,
    )
    if result:
        return result["status"]

    # No terminal verdict from the log. This is the HANDLE-LOST path (no live
    # process to protect), so a run still marked "running" whose process is gone
    # — server restart, OOM-kill, container death, host reboot — would otherwise
    # be stuck "running" forever. Fall back to a *generous* staleness check: a
    # genuinely live mdrun writes md.log continuously, and legitimate pauses (PME
    # tuning, checkpoint flush) last seconds, so idleness far beyond that means
    # the run died. This never fires for a healthy run (fresh log mtime).
    import time as _time

    stale_secs = 900  # 15 min
    now = _time.time()
    log = next(
        (p for p in (work_dir / "simulation" / "md.log", work_dir / "md.log") if p.exists()),
        None,
    )
    if log is not None:
        try:
            if now - log.stat().st_mtime > stale_secs:
                return "failed"
        except Exception:
            pass
        return None  # log recently written → assume still alive
    # No log at all: fall back to how long ago the run was recorded as started.
    try:
        import json as _json

        meta = _json.loads((session_root / "session.json").read_text())
        started = float(meta.get("started_at") or 0.0)
        if started and now - started > stale_secs:
            return "failed"
    except Exception:
        pass
    return None


def _infer_terminal_status_from_outputs(session: Session) -> dict | None:
    """Infer terminal simulation status from output files/log markers."""
    work_dir = Path(session.work_dir)
    sim_meta = session.sim_status or {}
    started_at = float(sim_meta.get("started_at") or 0.0)
    if started_at == 0.0:
        return None

    output_prefix = str(sim_meta.get("output_prefix") or "simulation/md")
    try:
        expected_nsteps = (
            int(sim_meta["expected_nsteps"])
            if sim_meta.get("expected_nsteps") is not None
            else None
        )
    except Exception:
        expected_nsteps = None

    return _infer_status_from_log(
        [
            work_dir / f"{output_prefix}.log",
            work_dir / "simulation" / "md.log",
            work_dir / "md.log",
        ],
        expected_nsteps=expected_nsteps,
        started_after=started_at,
    )


def get_simulation_status(session_id: str) -> dict:
    """Return current mdrun lifecycle status for this session."""
    session = _sessions.get(session_id)
    if not session:
        return {"running": False, "status": "standby"}
    try:
        runner = getattr(session.agent, "_gmx", None)
        cfg = getattr(session.agent, "cfg", None)
        if session.sim_status is None:
            session.sim_status = {}
        if "expected_nsteps" not in session.sim_status:
            try:
                from omegaconf import OmegaConf

                nsteps = OmegaConf.select(cfg, "method.nsteps")
                if nsteps is not None:
                    session.sim_status["expected_nsteps"] = int(nsteps)
            except Exception:
                pass

        # Helper to attach wall-clock timestamps from sim_status
        def _with_timestamps(result: dict) -> dict:
            sa = session.sim_status.get("started_at") if session.sim_status else None
            fa = session.sim_status.get("finished_at") if session.sim_status else None
            if sa is not None:
                result["started_at"] = sa
            if fa is not None:
                result["finished_at"] = fa
            return result

        # During pre-production equilibration the live mdrun handle belongs to a
        # STAGE (EM/NVT/NPT), not the production run. Report "running" + the stage
        # so a stage's clean exit isn't misread as the production run finishing.
        # The background worker owns stage transitions and marks failure itself.
        stage = (session.sim_status or {}).get("stage")
        if stage in ("minimizing", "nvt", "npt"):
            return _with_timestamps({"running": True, "status": "running", "stage": stage})

        if runner is not None:
            proc = getattr(runner, "_mdrun_proc", None)

            # Case 1: we hold a live process handle → liveness is authoritative.
            if proc is not None:
                rc = proc.poll()
                if rc is None:
                    # Still running. Do NOT kill on log heuristics: step-reached
                    # fires before the final checkpoint flush, and a stale log is
                    # not death — either would truncate output / leak GPU work.
                    return _with_timestamps({"running": True, "status": "running", "pid": proc.pid})
                # Process has ACTUALLY exited — now it is safe to finalise/clean up.
                try:
                    runner._cleanup()
                except Exception:
                    pass
                try:
                    runner._mdrun_proc = None
                except Exception:
                    pass
                # Prefer the log's verdict for the finished/failed distinction
                # (e.g. step target reached), else fall back to the exit code.
                inferred = _infer_terminal_status_from_outputs(session)
                if inferred and inferred["status"] in {"finished", "failed"}:
                    status = {"running": False, **inferred}
                else:
                    # Decide the terminal state from the ACTUAL process exit code
                    # (see test_lifecycle_fixes #8). Handle-lost/crashed runs with
                    # no exit code are covered separately by the disk staleness
                    # fallback in infer_run_status_from_disk().
                    status = {
                        "running": False,
                        "status": "finished" if rc == 0 else "failed",
                    }
                status["pid"] = proc.pid
                status["exit_code"] = rc
                return _with_timestamps(status)

            # Case 2: no live handle (restored session / server restarted). We can
            # only read the log: trust explicit finished/failed markers, but never
            # synthesise failure from a stale log (see _infer_status_from_log).
            inferred = _infer_terminal_status_from_outputs(session)
            if inferred and inferred["status"] in {"finished", "failed"}:
                return _with_timestamps({"running": False, **inferred})
            return _with_timestamps({"running": False, "status": "standby"})
    except Exception:
        pass
    return {"running": False, "status": "standby"}


def restore_session(
    session_id: str,
    work_dir: str,
    nickname: str = "",
    username: str = "",
) -> Session:
    """Return existing in-memory session, or reconstruct it from session-root config.yaml."""
    if session_id in _sessions:
        _touch(session_id)
        return _sessions[session_id]

    from md_agent.agent import MDAgent

    session_root = Path(work_dir).parent
    cfg_path = session_root / "config.yaml"
    legacy_cfg_path = Path(work_dir) / "config.yaml"
    if cfg_path.exists():
        from omegaconf import OmegaConf

        cfg = OmegaConf.load(cfg_path)
        # Cleanup leftover legacy location if root config already exists.
        if legacy_cfg_path.exists():
            try:
                legacy_cfg_path.unlink()
            except Exception:
                pass
    elif legacy_cfg_path.exists():
        from omegaconf import OmegaConf

        cfg = OmegaConf.load(legacy_cfg_path)
        # Migrate legacy location (<session>/data/config.yaml) to session root.
        OmegaConf.save(cfg, cfg_path)
        try:
            legacy_cfg_path.unlink()
        except Exception:
            pass
    else:
        cfg = _load_hydra_cfg([], work_dir)

    # Rewrite legacy session metadata as it is restored so read-only assistant
    # reviews see the same authoritative configuration as the run pipeline.
    if normalize_runtime_config(cfg):
        try:
            from omegaconf import OmegaConf

            OmegaConf.save(cfg, cfg_path)
        except Exception:
            pass

    session = Session(
        session_id=session_id, work_dir=work_dir, nickname=nickname, username=username
    )
    session.agent = MDAgent(cfg=cfg, work_dir=work_dir)
    _sessions[session_id] = session
    _evict_if_needed()
    return session


def delete_session(session_id: str) -> bool:
    return _sessions.pop(session_id, None) is not None


def get_or_restore_session(session_id: str) -> Session | None:
    """Return in-memory session, or restore from session.json on disk."""
    session = _sessions.get(session_id)
    if session:
        return session

    repo_outputs = Path(__file__).parents[3] / "outputs"
    scan_roots = [Path("outputs"), repo_outputs]
    seen: set[Path] = set()
    for root in scan_roots:
        root = root.resolve()
        if root in seen or not root.is_dir():
            continue
        seen.add(root)
        for sf in root.rglob("session.json"):
            try:
                import json as _json

                data = _json.loads(sf.read_text())
                if data.get("session_id") != session_id:
                    continue
                work_dir = data.get("work_dir")
                if not work_dir:
                    continue
                return restore_session(
                    session_id=session_id,
                    work_dir=work_dir,
                    nickname=data.get("nickname", ""),
                    username=data.get("username", ""),
                )
            except Exception:
                continue
    return None
