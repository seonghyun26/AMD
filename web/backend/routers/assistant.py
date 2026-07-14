"""Project-level and general AI assistant — separate from the per-simulation chat.

Both reuse the read-only Claude Code streamer (:mod:`web.backend.claude_code_agent`):
- **Project assistant**: rooted at the project's directory, conversation persisted
  per project — "attached to the project", persisting across its simulations.
- **General assistant** (home screen): rooted at the user's outputs directory,
  conversation persisted per user — a general helper for discussing/navigating.

These are always read-only Claude Code (an analysis/help assistant), independent
of the per-simulation backbone selector.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from web.backend import project_store

router = APIRouter()

_OUTPUTS = Path("outputs")
_MSG_FILE = "assistant_messages.json"


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


def _stream(work_dir: str, message: str, tmux_name: str | None = None) -> StreamingResponse:
    from web.backend.claude_code_agent import stream_claude_code

    async def gen():
        try:
            async for event in stream_claude_code(work_dir, message, tmux_name):
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


class ChatRequest(BaseModel):
    message: str


class MessagesRequest(BaseModel):
    messages: list = []


# ── Project assistant (attached to the project) ───────────────────────


@router.post("/projects/{project_id}/stream")
async def project_stream(project_id: str, req: ChatRequest):
    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return _stream(str(_project_dir(project)), req.message, project_tmux_name(project_id))


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
async def general_stream(req: ChatRequest):
    # The general assistant can read ALL result directories (read-only), not one.
    _OUTPUTS.mkdir(parents=True, exist_ok=True)
    return _stream(str(_OUTPUTS), req.message)


@router.get("/assistant/messages")
async def general_get_messages(request: Request):
    username = getattr(request.state, "username", "") or "_"
    return {"messages": _read_messages(_general_dir(username) / _MSG_FILE)}


@router.post("/assistant/messages")
async def general_save_messages(req: MessagesRequest, request: Request):
    username = getattr(request.state, "username", "") or "_"
    (_general_dir(username) / _MSG_FILE).write_text(json.dumps(req.messages, default=str, indent=2))
    return {"saved": len(req.messages)}
