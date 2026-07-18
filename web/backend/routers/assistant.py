"""Project-level and general AI assistant — separate from per-simulation chat.

The assistant uses the account-selected read-only CLI backbone, falling back to
Codex when Claude Code's optional SDK is unavailable. A small, deterministic
middleware handles explicit simulation-creation requests through the normal
session lifecycle, producing a configured ``standby`` session without starting
GROMACS.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from web.backend import authz, db, project_store
from web.backend.assistant_harness import (
    action_needs_publications,
    build_action_prompt,
    build_creation_summary,
    is_simulation_action,
    is_simulation_readiness_query,
    is_simulation_state_query,
    list_assistant_actions,
    parse_simulation_creation,
)
from web.backend.routers.chat import CreateSessionRequest, create_session_from_request
from web.backend.session_manager import get_or_restore_session

router = APIRouter()

_OUTPUTS = Path("outputs")
_MSG_FILE = "assistant_messages.json"
_MINIMUM_START_FREE_BYTES = 2 * 1024**3
_ENERGY_RESULT_CARDS = [
    "energy_potential",
    "energy_kinetic",
    "energy_total",
    "energy_temperature",
    "energy_pressure",
]


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"


def _project_dir(project: dict) -> Path:
    d = _OUTPUTS / (project.get("username") or "_") / project["project_id"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _general_dir(username: str) -> Path:
    d = _OUTPUTS / (username or "_")
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_code(project_id: str) -> str:
    """Short, unique, CLI-safe code for a project (drops the ``proj_`` prefix)."""
    raw = project_id[5:] if project_id.startswith("proj_") else project_id
    return re.sub(r"[^A-Za-z0-9_-]", "", raw) or "project"


def project_tmux_name(project_id: str) -> str:
    """tmux session name for a project's assistant: ``amd-{code}``."""
    return f"amd-{project_code(project_id)}"


def _read_messages(path: Path) -> list:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return []
    return []


def _agent_backbone(username: str) -> str:
    """Return the account-selected CLI assistant backbone, if any."""
    try:
        from web.backend.db import get_api_keys

        return (get_api_keys(username) or {}).get("_agent_backend", "")
    except Exception:
        return ""


async def _stream_read_only_assistant(
    work_dir: str, message: str, username: str, tmux_name: str | None
):
    """Stream the selected read-only CLI assistant with a Codex fallback."""
    use_codex = _agent_backbone(username) == "codex" or find_spec("claude_agent_sdk") is None
    if use_codex:
        from web.backend.codex_agent import stream_codex

        async for event in stream_codex(work_dir, message):
            yield event
        return

    from web.backend.claude_code_agent import stream_claude_code

    async for event in stream_claude_code(work_dir, message, tmux_name):
        yield event


def _system_label(session: Any, record: dict[str, Any]) -> str:
    """Return the most specific local system label available for an action."""
    selected = str(record.get("selected_molecule") or "").strip()
    if selected:
        stem = Path(selected).stem.replace("_", " ").replace("-", " ").strip()
        generic = {"temp", "system", "conf", "structure", "nvt", "npt", "em", "md"}
        if stem.lower() not in generic:
            return stem
    try:
        from omegaconf import OmegaConf

        cfg = session.agent.cfg
        name = OmegaConf.select(cfg, "system.name")
        coordinates = OmegaConf.select(cfg, "system.coordinates")
        if name and str(name).lower() != "protein":
            return str(name).replace("_", " ")
        if coordinates:
            return Path(str(coordinates)).stem.replace("_", " ").replace("-", " ")
        if name:
            return str(name).replace("_", " ")
    except Exception:
        pass
    return "unknown system"


def _resolve_simulation_action(
    action: AssistantActionRequest,
    *,
    username: str,
    project_id: str = "",
) -> dict[str, Any]:
    """Validate and bind a structured action to one owned simulation."""
    if not is_simulation_action(action.name):
        raise HTTPException(400, f"Unknown or non-simulation assistant action: {action.name}")

    owner = authz.session_owner(action.session_id)
    if owner is not None and owner != username:
        raise HTTPException(403, "Simulation does not belong to the authenticated user")

    if project_id:
        member_ids = {
            str(sim.get("session_id")) for sim in project_store.list_project_simulations(project_id)
        }
        if action.session_id not in member_ids:
            raise HTTPException(400, "Simulation does not belong to this project")

    session = get_or_restore_session(action.session_id)
    if not session:
        raise HTTPException(404, "Simulation not found")
    record = db.get_session_indexed(action.session_id) or {}
    data_dir = Path(session.work_dir).resolve()
    session_root = data_dir.parent
    # Current sessions keep config.yaml/session.json beside data/. Legacy
    # sessions sometimes used work_dir itself as the root, so only step upward
    # when the on-disk layout confirms it.
    action_root = (
        session_root
        if (session_root / "config.yaml").exists() or (session_root / "session.json").exists()
        else data_dir
    )
    return {
        "name": action.name,
        "session_id": action.session_id,
        "work_dir": str(action_root),
        "data_dir": str(data_dir),
        "nickname": str(record.get("nickname") or session.nickname or action.session_id),
        "system": _system_label(session, record),
        "user_request": str(action.parameters.get("focus") or ""),
    }


def _read_simulation_state(action: dict[str, Any]) -> dict[str, Any]:
    """Read current state from persisted metadata, config, and local files."""
    record = db.get_session_indexed(action["session_id"]) or {}
    root = Path(action["work_dir"])
    data_dir = Path(action.get("data_dir") or root)

    session_data: dict[str, Any] = {}
    session_path = root / "session.json"
    if session_path.exists():
        try:
            session_data = json.loads(session_path.read_text())
        except Exception:
            session_data = {}

    coordinates = ""
    session = get_or_restore_session(action["session_id"])
    if session:
        try:
            from omegaconf import OmegaConf

            coordinates = str(OmegaConf.select(session.agent.cfg, "system.coordinates") or "")
        except Exception:
            coordinates = ""
    if not coordinates:
        config_path = root / "config.yaml"
        if config_path.exists():
            try:
                from omegaconf import OmegaConf

                coordinates = str(
                    OmegaConf.select(OmegaConf.load(config_path), "system.coordinates") or ""
                )
            except Exception:
                coordinates = ""

    session_selection = str(session_data.get("selected_molecule") or "")
    indexed_selection = str(record.get("selected_molecule") or "")
    selected = session_selection or indexed_selection or coordinates
    sources = {
        "session.json": session_selection,
        "database": indexed_selection,
        "config.yaml": coordinates,
    }
    populated = {value for value in sources.values() if value}
    consistent = len(populated) <= 1
    selected_path = (
        data_dir / selected if selected and not Path(selected).is_absolute() else Path(selected)
    )
    return {
        "session_id": action["session_id"],
        "nickname": action["nickname"],
        "system": action["system"],
        "selected_molecule": selected,
        "configured_coordinates": coordinates,
        "selection_consistent": consistent,
        "selected_file_exists": bool(selected and selected_path.is_file()),
        "run_status": str(session_data.get("run_status") or record.get("run_status") or "standby"),
        "updated_at": str(session_data.get("updated_at") or record.get("updated_at") or ""),
        "sources": sources,
    }


def _simulation_state_summary(state: dict[str, Any]) -> str:
    """Render a compact answer without involving a conversational model."""
    nickname = state["nickname"]
    selected = state["selected_molecule"]
    run_status = state["run_status"]
    if not selected:
        return (
            f"No initial structure is currently selected for **{nickname}**. "
            f"Simulation status: **{run_status}**."
        )
    if not state["selection_consistent"]:
        sources = state["sources"]
        return (
            f"The initial-structure state for **{nickname}** is inconsistent: "
            f"session metadata says `{sources['session.json'] or sources['database'] or 'unset'}`, "
            f"while `config.yaml` says `{sources['config.yaml'] or 'unset'}`. "
            f"Simulation status: **{run_status}**. Review the selection before starting."
        )
    availability = (
        "The selected file exists locally."
        if state["selected_file_exists"]
        else "The selected file is missing locally."
    )
    return (
        f"The selected initial structure for **{nickname}** is `{selected}`. "
        f"The persisted session metadata and configuration agree. {availability} "
        f"Simulation status: **{run_status}**."
    )


def _start_preflight(action: dict[str, Any]) -> dict[str, Any]:
    """Perform deterministic start checks before invoking the simulation launcher."""
    from omegaconf import OmegaConf

    from md_agent.config.schemas import validate_gromacs_dict
    from web.backend.routers.simulate import _find_source_coord

    session = get_or_restore_session(action["session_id"])
    if not session:
        return {"ok": False, "problems": ["Simulation no longer exists."], "free_gb": None}

    work_dir = Path(session.work_dir)
    cfg = session.agent.cfg
    problems: list[str] = []
    sim_status = getattr(session, "sim_status", {}) or {}
    current_status = str(sim_status.get("status") or "standby")
    if current_status == "running":
        problems.append("Simulation is already running.")
    elif current_status == "finished":
        problems.append("Simulation is already finished; create or restart a new run instead.")

    try:
        gromacs = OmegaConf.to_container(OmegaConf.select(cfg, "gromacs") or {}, resolve=True)
        if isinstance(gromacs, dict):
            problems.extend(validate_gromacs_dict(gromacs))
        else:
            problems.append("GROMACS configuration is missing or invalid.")
    except Exception as exc:
        problems.append(f"Could not validate GROMACS configuration: {exc}")

    try:
        nsteps = int(OmegaConf.select(cfg, "method.nsteps") or 0)
        if nsteps < 1:
            problems.append("Main simulation length (method.nsteps) must be greater than zero.")
    except (TypeError, ValueError):
        problems.append("Main simulation length (method.nsteps) is invalid.")

    preferred_coord = str(OmegaConf.select(cfg, "system.coordinates") or "")
    source_coord = _find_source_coord(work_dir, preferred_coord)
    if not source_coord:
        problems.append("No selected raw PDB or GRO structure is available to prepare the system.")

    method = str(OmegaConf.select(cfg, "method._target_name") or "plain_md").lower()
    enhanced_methods = {
        "metadynamics",
        "metad",
        "opes",
        "umbrella",
        "umbrella_sampling",
        "steered",
        "steered_md",
    }
    if method in enhanced_methods and not (work_dir / "plumed.dat").is_file():
        problems.append("Enhanced sampling is selected but plumed.dat is missing.")

    free_gb: float | None = None
    try:
        disk = shutil.disk_usage(work_dir)
        free_gb = round(disk.free / (1024**3), 2)
        if disk.free < _MINIMUM_START_FREE_BYTES:
            problems.append(
                f"Only {free_gb:.2f} GB free; at least {_MINIMUM_START_FREE_BYTES / (1024**3):.0f} GB is required."
            )
    except OSError as exc:
        problems.append(f"Could not check free storage: {exc}")

    return {
        "ok": not problems,
        "problems": problems,
        "free_gb": free_gb,
        "minimum_free_gb": _MINIMUM_START_FREE_BYTES / (1024**3),
        "source_coordinate": source_coord,
    }


async def _stream_start_simulation(action: dict[str, Any]):
    """Run the guarded start action and stream its deterministic outcome."""
    action_id = "assistant-action-start_simulation"
    yield {
        "type": "tool_start",
        "tool_use_id": action_id,
        "tool_name": "start_simulation",
        "tool_input": {"session_id": action["session_id"], "simulation": action["nickname"]},
    }
    preflight = _start_preflight(action)
    if not preflight["ok"]:
        yield {
            "type": "tool_result",
            "tool_use_id": action_id,
            "tool_name": "start_simulation",
            "result": {"status": "blocked", **preflight},
        }
        details = " ".join(
            f"{index + 1}. {problem}" for index, problem in enumerate(preflight["problems"])
        )
        yield {"type": "text_delta", "text": f"Simulation was not started. {details}"}
        yield {"type": "agent_done", "final_text": ""}
        return

    try:
        from web.backend.routers.simulate import start_simulation

        result = await start_simulation(action["session_id"])
    except HTTPException as exc:
        detail = str(exc.detail)
        yield {
            "type": "tool_result",
            "tool_use_id": action_id,
            "tool_name": "start_simulation",
            "result": {"status": "error", "error": detail, **preflight},
        }
        yield {"type": "text_delta", "text": f"Simulation could not be started: {detail}"}
        yield {"type": "agent_done", "final_text": ""}
        return
    except Exception as exc:  # noqa: BLE001 - surface launcher errors to the user
        yield {
            "type": "tool_result",
            "tool_use_id": action_id,
            "tool_name": "start_simulation",
            "result": {"status": "error", "error": str(exc), **preflight},
        }
        yield {"type": "text_delta", "text": f"Simulation could not be started: {exc}"}
        yield {"type": "agent_done", "final_text": ""}
        return

    yield {
        "type": "tool_result",
        "tool_use_id": action_id,
        "tool_name": "start_simulation",
        "result": {"status": "started", **preflight, **result},
    }
    stage = result.get("stage", "production")
    yield {
        "type": "text_delta",
        "text": f"Simulation started after configuration and storage checks passed ({preflight['free_gb']:.2f} GB free). Current stage: {stage}.",
    }
    yield {"type": "agent_done", "final_text": ""}


async def _stream_run_analysis(action: dict[str, Any]):
    """Extract standard energy data and open its five result cards.

    ``gmx energy`` extracts all selected terms in one invocation.  The five
    cards then reuse the cached data rather than each launching their own job.
    """
    action_id = "assistant-action-run_analysis"
    yield {
        "type": "tool_start",
        "tool_use_id": action_id,
        "tool_name": "run_analysis",
        "tool_input": {
            "session_id": action["session_id"],
            "simulation": action["nickname"],
            "analyses": _ENERGY_RESULT_CARDS,
        },
    }

    state = _read_simulation_state(action)
    if state["run_status"] != "finished":
        result = {"status": "blocked", "reason": "simulation_not_finished", **state}
        yield {
            "type": "tool_result",
            "tool_use_id": action_id,
            "tool_name": "run_analysis",
            "result": result,
        }
        yield {
            "type": "text_delta",
            "text": "Analysis is available after the Main simulation finishes; no analyses were run.",
        }
        yield {"type": "agent_done", "final_text": ""}
        return

    try:
        from web.backend.analysis_utils import run_gmx_energy
        from web.backend.session_store import update_session_json

        session = get_or_restore_session(action["session_id"])
        if not session:
            raise RuntimeError("Simulation no longer exists.")
        energy_data = await asyncio.to_thread(
            run_gmx_energy,
            session.work_dir,
            session.agent._gmx,
        )
        if not energy_data:
            raise RuntimeError("No energy data could be extracted from the completed run.")

        existing_cards = list(
            (db.get_session_indexed(action["session_id"]) or {}).get("result_cards") or []
        )
        existing_types = {
            entry if isinstance(entry, str) else entry.get("type")
            for entry in existing_cards
            if isinstance(entry, (str, dict))
        }
        result_cards = existing_cards + [
            card for card in _ENERGY_RESULT_CARDS if card not in existing_types
        ]
        if not update_session_json(action["session_id"], {"result_cards": result_cards}):
            raise RuntimeError(
                "Energy data was extracted, but the result cards could not be saved."
            )
    except Exception as exc:  # noqa: BLE001 - report the actionable extraction failure
        yield {
            "type": "tool_result",
            "tool_use_id": action_id,
            "tool_name": "run_analysis",
            "result": {"status": "error", "error": str(exc)},
        }
        yield {"type": "text_delta", "text": f"Analysis could not be run: {exc}"}
        yield {"type": "agent_done", "final_text": ""}
        return

    yield {
        "type": "tool_result",
        "tool_use_id": action_id,
        "tool_name": "run_analysis",
        "result": {
            "status": "completed",
            "analyses": _ENERGY_RESULT_CARDS,
            "result_cards": result_cards,
        },
    }
    yield {
        "type": "text_delta",
        "text": "Completed the five energy analyses: potential, kinetic, total energy, temperature, and pressure. Their result cards are now open.",
    }
    yield {"type": "agent_done", "final_text": ""}


async def _stream_simulation_state(action: dict[str, Any]):
    """Stream a deterministic, read-only simulation-state inspection."""
    action_id = "assistant-action-inspect_simulation_state"
    yield {
        "type": "tool_start",
        "tool_use_id": action_id,
        "tool_name": "inspect_simulation_state",
        "tool_input": {
            "session_id": action["session_id"],
            "simulation": action["nickname"],
        },
    }
    state = _read_simulation_state(action)
    yield {
        "type": "tool_result",
        "tool_use_id": action_id,
        "tool_name": "inspect_simulation_state",
        "result": {"status": "completed", **state},
    }
    yield {"type": "text_delta", "text": _simulation_state_summary(state)}
    yield {"type": "agent_done", "final_text": ""}


def _search_cv_publications(system: str) -> dict[str, Any]:
    """Collect compact Semantic Scholar evidence for the CV action."""
    from md_agent.tools.paper_tools import PaperRetriever

    query = f'"{system}" molecular dynamics collective variable enhanced sampling metadynamics'
    result = PaperRetriever().search_semantic_scholar(query, max_results=5)
    compact = []
    for paper in result.get("papers", [])[:5]:
        authors = paper.get("authors") or []
        compact.append(
            {
                "title": paper.get("title"),
                "year": paper.get("year"),
                "authors": [a.get("name") for a in authors[:8] if isinstance(a, dict)],
                "external_ids": paper.get("externalIds") or {},
                "url": paper.get("url") or paper.get("pdf_url"),
                "abstract": str(paper.get("abstract") or "")[:1200],
            }
        )
    return {"query": query, "papers": compact}


async def _stream_simulation_action(action: dict[str, Any], username: str, tmux_name: str | None):
    """Execute one registered action and preserve the normal SSE lifecycle."""
    if action["name"] == "inspect_simulation_state":
        async for event in _stream_simulation_state(action):
            yield event
        return
    if action["name"] == "start_simulation":
        async for event in _stream_start_simulation(action):
            yield event
        return
    if action["name"] == "analyze_simulation":
        async for event in _stream_run_analysis(action):
            yield event
        return

    action_id = f"assistant-action-{action['name']}"
    yield {
        "type": "tool_start",
        "tool_use_id": action_id,
        "tool_name": "assistant_action",
        "tool_input": {
            "action": action["name"],
            "session_id": action["session_id"],
            "system": action["system"],
        },
    }

    evidence = "No external evidence was required for this action."
    if action_needs_publications(action["name"]):
        search_id = f"{action_id}-publications"
        query = (
            f'"{action["system"]}" molecular dynamics collective variable '
            "enhanced sampling metadynamics"
        )
        yield {
            "type": "tool_start",
            "tool_use_id": search_id,
            "tool_name": "search_cv_publications",
            "tool_input": {"query": query, "max_results": 5},
        }
        try:
            publication_result = await asyncio.to_thread(_search_cv_publications, action["system"])
            evidence = json.dumps(publication_result, default=str, indent=2)
            search_result = {
                "status": "completed",
                "query": publication_result["query"],
                "papers": publication_result["papers"],
            }
        except Exception as exc:
            evidence = json.dumps(
                {
                    "error": f"Publication lookup failed: {exc}",
                    "instruction": "Do not claim that unverified publications were found.",
                }
            )
            search_result = {"status": "error", "error": str(exc)}
        yield {
            "type": "tool_result",
            "tool_use_id": search_id,
            "tool_name": "search_cv_publications",
            "result": search_result,
        }

    prompt = build_action_prompt(
        action["name"],
        nickname=action["nickname"],
        system=action["system"],
        user_request=action["user_request"],
        evidence=evidence,
    )
    terminal: dict[str, Any] | None = None
    try:
        async for event in _stream_read_only_assistant(
            action["work_dir"], prompt, username, tmux_name
        ):
            if event.get("type") in {"agent_done", "error"}:
                terminal = event
            else:
                yield event
    except Exception as exc:
        terminal = {"type": "error", "message": str(exc)}

    failed = terminal is not None and terminal.get("type") == "error"
    yield {
        "type": "tool_result",
        "tool_use_id": action_id,
        "tool_name": "assistant_action",
        "result": {
            "status": "error" if failed else "completed",
            "action": action["name"],
            "session_id": action["session_id"],
        },
    }
    yield terminal or {"type": "agent_done", "final_text": ""}


def _stream(
    work_dir: str,
    message: str,
    username: str,
    project_id: str = "",
    tmux_name: str | None = None,
    action: dict[str, Any] | None = None,
) -> StreamingResponse:
    async def gen():
        if action:
            async for event in _stream_simulation_action(action, username, tmux_name):
                yield _sse(event)
            return

        plan = parse_simulation_creation(message)
        if plan:
            nickname = plan.nickname
            request = CreateSessionRequest(
                work_dir=f"outputs/{username}/{plan.work_dir_slug}/data",
                nickname=nickname,
                preset=plan.preset,
                system=plan.system,
                gromacs=plan.gromacs,
                project_id=project_id,
                extra_overrides=[f"method.nsteps={plan.nsteps}"],
            )
            tool_id = "assistant-create-simulation"
            yield _sse(
                {
                    "type": "tool_start",
                    "tool_use_id": tool_id,
                    "tool_name": "create_simulation",
                    "tool_input": {
                        "system": plan.system,
                        "method": "plain_md",
                        "duration_ps": plan.duration_ps,
                        "nsteps": plan.nsteps,
                        "solvent": plan.gromacs,
                    },
                }
            )
            try:
                created = create_session_from_request(request, username)
            except Exception as exc:
                yield _sse(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "tool_name": "create_simulation",
                        "result": {"status": "error", "error": str(exc)},
                    }
                )
                yield _sse({"type": "error", "message": f"Could not create simulation: {exc}"})
                return

            yield _sse(
                {
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "tool_name": "create_simulation",
                    "result": {"status": "completed", **created},
                }
            )
            yield _sse(
                {
                    "type": "text_delta",
                    "text": build_creation_summary(plan, created["nickname"]),
                }
            )
            yield _sse({"type": "agent_done", "final_text": ""})
            return

        try:
            async for event in _stream_read_only_assistant(work_dir, message, username, tmux_name):
                yield _sse(event)
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc)})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


class AssistantActionRequest(BaseModel):
    name: str
    session_id: str
    parameters: dict[str, str] = Field(default_factory=dict)


class ChatRequest(BaseModel):
    message: str
    action: AssistantActionRequest | None = None
    context_session_id: str = ""


class MessagesRequest(BaseModel):
    messages: list = []


def _resolve_chat_action(
    req: ChatRequest,
    *,
    username: str,
    project_id: str = "",
) -> dict[str, Any] | None:
    """Resolve explicit actions plus contextual readiness/state questions."""
    if req.action:
        return _resolve_simulation_action(req.action, username=username, project_id=project_id)
    if req.context_session_id and is_simulation_readiness_query(req.message):
        return _resolve_simulation_action(
            AssistantActionRequest(
                name="check_run_readiness",
                session_id=req.context_session_id,
                parameters={"focus": req.message},
            ),
            username=username,
            project_id=project_id,
        )
    if req.context_session_id and is_simulation_state_query(req.message):
        return _resolve_simulation_action(
            AssistantActionRequest(
                name="inspect_simulation_state",
                session_id=req.context_session_id,
            ),
            username=username,
            project_id=project_id,
        )
    return None


@router.get("/assistant/actions")
async def get_assistant_actions():
    """List actions the general/project assistant may execute."""
    return {"actions": list_assistant_actions()}


# ── Project assistant (attached to the project) ───────────────────────


@router.post("/projects/{project_id}/stream")
async def project_stream(project_id: str, req: ChatRequest, request: Request):
    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    username = getattr(request.state, "username", "") or project.get("username", "")
    action = _resolve_chat_action(req, username=username, project_id=project_id)
    return _stream(
        str(_project_dir(project)),
        req.message,
        username,
        project_id=project_id,
        tmux_name=project_tmux_name(project_id),
        action=action,
    )


@router.get("/projects/{project_id}/messages")
async def project_get_messages(project_id: str):
    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return {"messages": _read_messages(_project_dir(project) / _MSG_FILE)}


@router.post("/projects/{project_id}/messages")
async def project_save_messages(project_id: str, req: MessagesRequest):
    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    (_project_dir(project) / _MSG_FILE).write_text(json.dumps(req.messages, default=str, indent=2))
    return {"saved": len(req.messages)}


# ── General assistant (home screen) ───────────────────────────────────


@router.post("/assistant/stream")
async def general_stream(req: ChatRequest, request: Request):
    # The general assistant can read ALL result directories (read-only), not one.
    _OUTPUTS.mkdir(parents=True, exist_ok=True)
    username = getattr(request.state, "username", "") or "_"
    action = _resolve_chat_action(req, username=username)
    return _stream(str(_OUTPUTS), req.message, username, action=action)


@router.get("/assistant/messages")
async def general_get_messages(request: Request):
    username = getattr(request.state, "username", "") or "_"
    return {"messages": _read_messages(_general_dir(username) / _MSG_FILE)}


@router.post("/assistant/messages")
async def general_save_messages(req: MessagesRequest, request: Request):
    username = getattr(request.state, "username", "") or "_"
    (_general_dir(username) / _MSG_FILE).write_text(json.dumps(req.messages, default=str, indent=2))
    return {"saved": len(req.messages)}
