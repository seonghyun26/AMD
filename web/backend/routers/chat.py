"""Chat endpoints: create sessions and stream agent responses via SSE."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from web.backend.analysis_utils import get_log_progress
from web.backend.session_manager import (
    create_session,
    delete_session,
    get_session,
    restore_session,
    stop_session_simulation,
)

router = APIRouter()

# ── Preset definitions ─────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).parents[3]

# Maps preset id → Hydra config group selections
PRESET_CONFIGS: dict[str, dict[str, str]] = {
    "undefined": dict(
        method="metadynamics", system="protein", gromacs="default", plumed_cvs="default"
    ),
    "md": dict(method="plain_md", system="protein", gromacs="default", plumed_cvs="default"),
    "metad": dict(method="metadynamics", system="protein", gromacs="default", plumed_cvs="default"),
    "opes": dict(method="metadynamics", system="protein", gromacs="default", plumed_cvs="default"),
    "umbrella": dict(method="umbrella", system="protein", gromacs="default", plumed_cvs="default"),
    "steered": dict(method="steered", system="protein", gromacs="default", plumed_cvs="default"),
}

# Maps molecule system id → subdirectory name under data/molecule/
_DATA_MOLECULES = _REPO_ROOT / "data" / "molecule"
_SYSTEM_DIR: dict[str, str] = {
    "ala_dipeptide": "alanine_dipeptide",
    "chignolin": "chignolin",
    "trp_cage": "trp-cage",
    "bba": "bba",
    "villin": "villin",
}
_MOL_EXTS = {".pdb", ".gro", ".mol2", ".xyz", ".sdf"}
_CKPT_EXTS = {".pt", ".ckpt", ".pth"}

# Maps molecule system id → subdirectory name under data/model/
_DATA_MODELS = _REPO_ROOT / "data" / "model"
_MODEL_DIR: dict[str, str] = {
    "ala_dipeptide": "alanine_dipeptide",
    "chignolin": "chignolin",
    "trp_cage": "trp-cage",
    "villin": "villin",
    "bba": "BBA",
}


def _seed_files(work_dir: str, preset: str, system: str, state: str = "") -> list[str]:
    """Copy molecule files from data/molecule/{system}/ and model checkpoints
    from data/model/{system}/ into work_dir.
    When state is provided, only the matching state file is copied.
    Returns a list of copied file names (relative to work_dir)."""
    import shutil

    seeded: list[str] = []
    # Seed molecule files
    dir_name = _SYSTEM_DIR.get(system)
    if dir_name:
        src_dir = _DATA_MOLECULES / dir_name
        if src_dir.is_dir():
            for src in sorted(src_dir.iterdir()):
                if src.is_file() and src.suffix.lower() in _MOL_EXTS:
                    if state and src.stem != state:
                        continue
                    dest = Path(work_dir) / src.name
                    shutil.copy2(src, dest)
                    seeded.append(src.name)

    # Seed pre-built MLCV checkpoints
    model_dir_name = _MODEL_DIR.get(system)
    if model_dir_name:
        model_src = _DATA_MODELS / model_dir_name
        if model_src.is_dir():
            for src in sorted(model_src.iterdir()):
                if src.is_file() and src.suffix.lower() in _CKPT_EXTS:
                    dest = Path(work_dir) / src.name
                    shutil.copy2(src, dest)
                    seeded.append(src.name)

    return seeded


# ── Session lifecycle ──────────────────────────────────────────────────


class CreateSessionRequest(BaseModel):
    work_dir: str
    nickname: str = ""
    username: str = ""
    preset: str = "undefined"
    # Individual overrides (ignored when preset is set)
    method: str = ""
    system: str = ""
    state: str = ""  # molecule conformational state (e.g. "c5", "c7ax")
    gromacs: str = ""
    plumed_cvs: str = ""
    extra_overrides: list[str] = []


@router.post("/sessions")
async def create_session_endpoint(req: CreateSessionRequest):
    """Create a new agent session. Returns session_id + list of seeded files."""
    Path(req.work_dir).mkdir(parents=True, exist_ok=True)

    # Resolve config from preset; individual fields override if provided
    cfg_defaults = PRESET_CONFIGS.get(req.preset, PRESET_CONFIGS["undefined"])
    method = req.method or cfg_defaults["method"]
    plumed_cvs = req.plumed_cvs or cfg_defaults["plumed_cvs"]
    # molecule_system is the UI selector (used for file seeding only)
    molecule_system = req.system  # e.g. "ala_dipeptide", "chignolin", "blank"

    # Map UI template ids to Hydra config group names (conf/gromacs/*.yaml).
    # UI sends "auto" or "vacuum"; preset default is "default".
    _HYDRA_GROMACS_MAP: dict[str, str] = {
        "auto": "default",
        "default": "default",
        "vacuum": "vacuum",
        "tip3p": "tip3p",
    }
    gromacs_raw = (req.gromacs or cfg_defaults["gromacs"] or "").strip()
    gromacs = _HYDRA_GROMACS_MAP.get(gromacs_raw.lower(), gromacs_raw)

    # Vacuum config has no solvent — ensure water_model is not inherited from
    # the system config (e.g. protein.yaml has water_model: tip3p).
    _VACUUM_CONFIGS = {"vacuum"}
    extra_overrides = list(req.extra_overrides)
    if gromacs in _VACUUM_CONFIGS:
        extra_overrides = [o for o in extra_overrides if not o.startswith("system.water_model")] + [
            "system.water_model=none"
        ]
    elif gromacs == "tip3p":
        # Explicit TIP3P solvation — override any system default (e.g. ala_dipeptide has water_model: none)
        extra_overrides = [o for o in extra_overrides if not o.startswith("system.water_model")] + [
            "system.water_model=tip3p"
        ]

    # hydra_system must be a valid conf/system/*.yaml name
    _HYDRA_SYSTEM_MAP: dict[str, str] = {
        "ala_dipeptide": "ala_dipeptide",
        "chignolin": "protein",
        "trp_cage": "protein",
        "bba": "protein",
        "villin": "protein",
        "blank": "protein",
    }
    hydra_system = _HYDRA_SYSTEM_MAP.get(molecule_system) or cfg_defaults["system"]

    # Auto-select system-specific PLUMED CV config when available
    _PLUMED_CV_MAP: dict[str, str] = {
        "ala_dipeptide": "ala_dipeptide",
    }
    if plumed_cvs == "default" and molecule_system in _PLUMED_CV_MAP:
        plumed_cvs = _PLUMED_CV_MAP[molecule_system]

    session = create_session(
        work_dir=req.work_dir,
        nickname=req.nickname,
        username=req.username,
        method=method,
        system=hydra_system,
        gromacs=gromacs,
        plumed_cvs=plumed_cvs,
        extra_overrides=extra_overrides,
    )

    seeded = _seed_files(req.work_dir, req.preset, molecule_system, req.state)

    # If a structure file was seeded, update system.coordinates so the UI
    # can auto-load the correct molecule on session open.
    _STRUCT_EXTS = {".pdb", ".gro", ".mol2", ".xyz"}
    seeded_structs = [f for f in seeded if Path(f).suffix.lower() in _STRUCT_EXTS]
    # Prefer unfolded conformations as starting structure for enhanced sampling
    seeded_struct = next((f for f in seeded_structs if "unfolded" in f.lower()), None) or next(iter(seeded_structs), None)
    if seeded_struct:
        try:
            from omegaconf import OmegaConf as _OC

            _OC.update(session.agent.cfg, "system.coordinates", seeded_struct, merge=True)
        except Exception:
            pass

    # Write initial config.yaml to session root (sibling of data/) so it is
    # shared metadata for the whole session.
    try:
        from omegaconf import OmegaConf

        cfg_path = Path(req.work_dir).parent / "config.yaml"
        OmegaConf.save(session.agent.cfg, cfg_path)
    except Exception:
        pass

    # Write session.json for persistence across server restarts
    from datetime import datetime

    meta = {
        "session_id": session.session_id,
        "nickname": session.nickname,
        "work_dir": session.work_dir,
        "status": "active",
        "run_status": "standby",
        "updated_at": datetime.utcnow().isoformat(),
    }
    (Path(req.work_dir).parent / "session.json").write_text(json.dumps(meta, indent=2))

    return {
        "session_id": session.session_id,
        "work_dir": session.work_dir,
        "nickname": session.nickname,
        "seeded_files": seeded,
    }


@router.get("/sessions")
async def list_sessions_endpoint(username: str = ""):
    """List sessions by scanning outputs/{username}/*/session.json on disk."""
    outputs_root = Path("outputs")
    if username:
        scan_root = outputs_root / username
        glob_pattern = "*/session.json"
    else:
        scan_root = outputs_root
        glob_pattern = "*/*/session.json"

    from web.backend.session_manager import infer_run_status_from_disk

    sessions = []
    if scan_root.is_dir():
        for sf in scan_root.glob(glob_pattern):
            try:
                data = json.loads(sf.read_text())
                if "session_id" not in data or "work_dir" not in data:
                    continue
                if data.get("status") in ("inactive", "deleted"):
                    continue
                run_status = data.get("run_status", "standby")
                # If session.json says "running", infer actual status from md.log (e.g. after refresh)
                if run_status == "running":
                    work_dir_resolved = Path(data["work_dir"]).resolve()
                    session_root = work_dir_resolved.parent
                    inferred = infer_run_status_from_disk(session_root, work_dir_resolved)
                    if inferred in ("finished", "failed"):
                        import time as _time

                        run_status = inferred
                        data["run_status"] = inferred
                        data.setdefault("started_at", _time.time())
                        data.setdefault("finished_at", _time.time())
                        sf.write_text(json.dumps(data, indent=2))
                sessions.append(
                    {
                        "session_id": data["session_id"],
                        "work_dir": data["work_dir"],
                        "nickname": data.get("nickname", ""),
                        "selected_molecule": data.get("selected_molecule", ""),
                        "updated_at": data.get("updated_at", ""),
                        "run_status": run_status,
                        "started_at": data.get("started_at"),
                        "finished_at": data.get("finished_at"),
                        "result_cards": data.get("result_cards", []),
                    }
                )
            except Exception:
                continue

    sessions.sort(key=lambda s: s.get("updated_at", ""), reverse=True)
    return {"sessions": sessions}


@router.get("/sessions/{session_id}/run-status")
async def get_session_run_status(session_id: str):
    """Read run_status from session.json on disk. If still 'running', verify via md.log."""
    from web.backend.session_manager import infer_run_status_from_disk

    outputs_root = Path("outputs")
    for sf in outputs_root.glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") != session_id:
                continue
            run_status = data.get("run_status", "standby")
            if run_status == "running":
                work_dir = Path(data["work_dir"]).resolve()
                inferred = infer_run_status_from_disk(sf.parent, work_dir)
                if inferred in ("finished", "failed"):
                    import time as _time

                    run_status = inferred
                    data["run_status"] = inferred
                    data.setdefault("started_at", _time.time())
                    data.setdefault("finished_at", _time.time())
                    sf.write_text(json.dumps(data, indent=2))
            return {
                "run_status": run_status,
                "started_at": data.get("started_at"),
                "finished_at": data.get("finished_at"),
            }
        except Exception:
            continue
    return {"run_status": "standby"}


class NicknameRequest(BaseModel):
    nickname: str


class MoleculeSelectRequest(BaseModel):
    selected_molecule: str


class ResultCardsRequest(BaseModel):
    result_cards: list[Any] = []


@router.post("/sessions/{session_id}/result-cards")
async def update_result_cards(session_id: str, req: ResultCardsRequest):
    """Persist which result plot cards are open in session.json."""
    from datetime import datetime

    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") != session_id:
                continue
            data.update(
                {
                    "result_cards": req.result_cards,
                    "updated_at": datetime.utcnow().isoformat(),
                }
            )
            sf.write_text(json.dumps(data, indent=2))
            break
        except Exception:
            continue
    return {"session_id": session_id, "result_cards": req.result_cards}


@router.patch("/sessions/{session_id}/molecule")
async def update_selected_molecule(session_id: str, req: MoleculeSelectRequest):
    """Persist the selected molecule filename in session.json."""
    from datetime import datetime

    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") != session_id:
                continue
            data.update(
                {
                    "selected_molecule": req.selected_molecule,
                    "updated_at": datetime.utcnow().isoformat(),
                }
            )
            sf.write_text(json.dumps(data, indent=2))
            break
        except Exception:
            continue
    return {"session_id": session_id, "selected_molecule": req.selected_molecule}


@router.patch("/sessions/{session_id}/nickname")
async def update_nickname(session_id: str, req: NicknameRequest):
    from datetime import datetime

    nickname = req.nickname.strip()
    # Update the in-memory session if it exists
    session = get_session(session_id)
    if session:
        session.nickname = nickname
    # Scan disk and update session.json in-place, preserving all existing fields
    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") != session_id:
                continue
            data.update({"nickname": nickname, "updated_at": datetime.utcnow().isoformat()})
            sf.write_text(json.dumps(data, indent=2))
            break
        except Exception:
            continue
    return {"session_id": session_id, "nickname": nickname}


class RestoreRequest(BaseModel):
    work_dir: str
    nickname: str = ""
    username: str = ""


@router.post("/sessions/{session_id}/restore")
async def restore_session_endpoint(session_id: str, req: RestoreRequest):
    """Ensure a session is live in memory, reconstructing from config.yaml if needed."""
    session = restore_session(session_id, req.work_dir, req.nickname, req.username)
    return {
        "session_id": session.session_id,
        "work_dir": session.work_dir,
        "nickname": session.nickname,
    }


@router.delete("/sessions/{session_id}")
async def delete_session_endpoint(session_id: str):
    import shutil
    from datetime import datetime

    # Stop any running simulation before removing the session
    stopped = stop_session_simulation(session_id)

    moved_to: str | None = None

    # Scan disk directly by session_id and move the session folder to trash.
    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") != session_id:
                continue

            # Mark as deleted in session.json before moving
            data.update(
                {
                    "status": "deleted",
                    "updated_at": datetime.utcnow().isoformat(),
                }
            )
            sf.write_text(json.dumps(data, indent=2))

            # session folder is the parent of session.json
            session_folder = sf.parent
            # user folder is the parent of the session folder (outputs/{user}/{session}/)
            user_folder = session_folder.parent

            trash_dir = user_folder / "trash"
            trash_dir.mkdir(parents=True, exist_ok=True)

            dest = trash_dir / session_folder.name
            # If a folder with the same name already exists in trash, append session_id
            if dest.exists():
                dest = trash_dir / f"{session_folder.name}_{session_id[:8]}"

            shutil.move(str(session_folder), str(dest))
            moved_to = str(dest)
            break
        except Exception:
            continue

    delete_session(session_id)
    return {"deleted": session_id, "simulation_stopped": stopped, "moved_to": moved_to}


# ── Chat message persistence ──────────────────────────────────────────


class SaveMessagesRequest(BaseModel):
    messages: list[Any] = []


def _find_session_root(session_id: str) -> Path | None:
    """Find the session root directory (parent of data/) by session_id."""
    for sf in Path("outputs").glob("*/*/session.json"):
        try:
            data = json.loads(sf.read_text())
            if data.get("session_id") == session_id:
                return sf.parent
        except Exception:
            continue
    return None


@router.get("/sessions/{session_id}/messages")
async def get_messages(session_id: str):
    """Load persisted chat messages for a session."""
    root = _find_session_root(session_id)
    if not root:
        return {"messages": []}
    msg_path = root / "messages.json"
    if not msg_path.exists():
        return {"messages": []}
    try:
        return {"messages": json.loads(msg_path.read_text())}
    except Exception:
        return {"messages": []}


@router.post("/sessions/{session_id}/messages")
async def save_messages(session_id: str, req: SaveMessagesRequest):
    """Persist chat messages for a session."""
    root = _find_session_root(session_id)
    if not root:
        # Fall back: try to find from in-memory session
        session = get_session(session_id)
        if session:
            root = Path(session.work_dir).parent
        else:
            raise HTTPException(404, "Session not found")
    msg_path = root / "messages.json"
    msg_path.write_text(json.dumps(req.messages, default=str, indent=2))
    return {"saved": len(req.messages)}


# ── Streaming chat ─────────────────────────────────────────────────────


def _format_sse(event: dict) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"


class StreamChatRequest(BaseModel):
    message: str


@router.post("/sessions/{session_id}/stream")
async def stream_chat(session_id: str, req: StreamChatRequest):
    """SSE endpoint. Message sent as POST body to avoid URL length limits.

    Returns a text/event-stream response. Each event is a JSON-encoded
    dict; see MDAgent.stream_run() for the event schema.
    """
    message = req.message
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    async def event_generator():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        cancel_event = threading.Event()

        # Run the synchronous generator in a thread pool.
        gen = session.agent.stream_run(message)

        def _drain_sync():
            """Pull events from the synchronous generator, checking for cancellation."""
            try:
                while not cancel_event.is_set():
                    try:
                        event = next(gen)
                    except StopIteration:
                        break
                    loop.call_soon_threadsafe(queue.put_nowait, _format_sse(event))
                    if event.get("type") in ("agent_done", "error"):
                        break
            except GeneratorExit:
                pass
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        async def drain_agent():
            try:
                await loop.run_in_executor(None, _drain_sync)
            except Exception:
                await queue.put(None)

        async def poll_progress():
            log_path = str(Path(session.work_dir) / "md.log")
            total_steps = (
                session.sim_status.get("expected_nsteps")
                or session.sim_status.get("total_steps")
                or 1
            )
            while not cancel_event.is_set():
                await asyncio.sleep(10)
                info = get_log_progress(log_path)
                if info:
                    event = {
                        "type": "sim_progress",
                        "step": info.get("step", 0),
                        "total_steps": total_steps,
                        "ns_per_day": info.get("ns_per_day") or 0.0,
                        "time_ps": info.get("time_ps") or 0.0,
                    }
                    await queue.put(_format_sse(event))

        agent_task = asyncio.create_task(drain_agent())
        progress_task = asyncio.create_task(poll_progress())

        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            # Signal cancellation so the thread-pool worker stops
            cancel_event.set()
            agent_task.cancel()
            progress_task.cancel()
            # Close the generator to interrupt any blocking API call
            try:
                gen.close()
            except Exception:
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
