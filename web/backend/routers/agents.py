"""Agents router — SSE-streaming endpoints for specialist LangChain agents.

GET /api/agents/{session_id}/paper?input=...      → PaperConfigAgent
GET /api/agents/{session_id}/analysis?input=...   → AnalysisAgent
GET /api/agents/{session_id}/cv?input=...         → CVAgent
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from web.backend.db import get_api_keys
from web.backend.session_manager import get_session

router = APIRouter()

_AGENT_TYPES = {"paper", "analysis", "cv"}


def _fmt(event: dict) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"


@router.get("/agents/{session_id}/{agent_type}/run")
async def run_agent(session_id: str, agent_type: str, input: str = ""):
    """Stream a specialist agent's reasoning and output as SSE.

    agent_type: "paper" | "analysis" | "cv"
    input:      task description / arXiv ID / search query (URL-encoded)

    Events match the main chat SSE schema so the same frontend renderer works:
      text_delta, tool_start, tool_result, agent_done, error
    """
    if agent_type not in _AGENT_TYPES:
        raise HTTPException(400, f"Unknown agent type '{agent_type}'. Use: {_AGENT_TYPES}")

    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    work_dir = session.work_dir

    # Resolve the user's stored Anthropic key (passed directly, not via env)
    anthropic_key: str | None = None
    if session.username:
        user_keys = get_api_keys(session.username)
        anthropic_key = user_keys.get("anthropic") or None

    async def event_generator():
        try:
            if agent_type == "paper":
                from md_agent.agents.paper_agent import PaperConfigAgent

                agent = PaperConfigAgent(work_dir=work_dir, session=session, api_key=anthropic_key)
                async for ev in agent.astream(
                    input or "Please find and extract MD settings from a relevant paper."
                ):
                    yield _fmt(ev)

            elif agent_type == "analysis":
                from md_agent.agents.analysis_agent import AnalysisAgent

                agent = AnalysisAgent(work_dir, api_key=anthropic_key)
                async for ev in agent.astream(input or "Analyse the simulation results."):
                    yield _fmt(ev)

            elif agent_type == "cv":
                from md_agent.agents.cv_agent import CVAgent

                agent = CVAgent(work_dir, session=session, api_key=anthropic_key)
                async for ev in agent.astream(
                    input or "Read the structure and suggest appropriate CVs for metadynamics."
                ):
                    yield _fmt(ev)

        except (ImportError, AttributeError):
            yield _fmt(
                {
                    "type": "error",
                    "message": "API key is not set or agent dependencies are missing. Please add your Anthropic API key in Settings (top-right gear icon).",
                }
            )
            yield _fmt({"type": "agent_done", "final_text": ""})
        except Exception as exc:
            msg = str(exc)
            if (
                "api_key" in msg.lower()
                or "auth_token" in msg.lower()
                or "authentication" in msg.lower()
                or "unauthorized" in msg.lower()
            ):
                msg = "API key is not set. Please add your Anthropic API key in Settings (top-right gear icon)."
            yield _fmt({"type": "error", "message": msg})
            yield _fmt({"type": "agent_done", "final_text": ""})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
