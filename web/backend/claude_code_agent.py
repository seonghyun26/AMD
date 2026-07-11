"""Claude Code chat backend: stream a real Claude Code session for a web session.

Uses the Python **Claude Agent SDK** (which drives the `claude` CLI). The session
is scoped **read-only** to the simulation's working directory so the assistant can
inspect GROMACS/PLUMED outputs (.mdp, .log, COLVAR, .edr, config.yaml) but cannot
modify files or run commands.

Auth: the CLI's **subscription login** is used — we strip ``ANTHROPIC_API_KEY``
from the subprocess environment so it does not fall back to API-key billing.

Output: yields SSE-shaped event dicts matching the existing chat protocol
(``text_delta``, ``thinking``, ``tool_start``, ``tool_result``, ``agent_done``,
``error``) so the existing frontend renders them unchanged.
"""

from __future__ import annotations

import dataclasses
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

# Read-only toolset — everything else is denied by permission_mode="dontAsk".
_READ_ONLY_TOOLS = ["Read", "Grep", "Glob"]
_BLOCKED_TOOLS = ["Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"]

_SYSTEM_PROMPT = (
    "You are a molecular-dynamics analysis assistant embedded in the AMD web app. "
    "You have READ-ONLY access to this simulation's working directory, which holds "
    "GROMACS/PLUMED outputs (e.g. md.mdp, md.log, COLVAR, .edr, .xtc, plumed.dat, "
    "config.yaml). Help the user inspect, analyse and understand their simulation. "
    "You cannot modify files or run shell commands — read and reason only."
)


def _subprocess_env() -> dict[str, str]:
    """Environment for the Claude Code subprocess.

    Drops ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the CLI authenticates with the
    logged-in Claude subscription rather than metered API billing.
    """
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env


def _build_options(work_dir: str):
    """Construct read-only ClaudeAgentOptions rooted at *work_dir* (fields filtered
    to those the installed SDK actually supports)."""
    from claude_agent_sdk import ClaudeAgentOptions

    wd = Path(work_dir)
    if not wd.is_dir():
        wd = wd.parent if wd.parent.is_dir() else Path.cwd()

    desired: dict[str, Any] = {
        "cwd": str(wd),
        "system_prompt": _SYSTEM_PROMPT,
        "allowed_tools": _READ_ONLY_TOOLS,
        "disallowed_tools": _BLOCKED_TOOLS,
        "permission_mode": "dontAsk",
        "setting_sources": [],  # SDK isolation: ignore project/user settings + CLAUDE.md
        "env": _subprocess_env(),
    }
    valid = {f.name for f in dataclasses.fields(ClaudeAgentOptions)}
    return ClaudeAgentOptions(**{k: v for k, v in desired.items() if k in valid})


def _tool_result_payload(block: Any) -> dict[str, Any]:
    content = getattr(block, "content", None)
    payload: dict[str, Any] = {"content": content}
    if getattr(block, "is_error", None):
        payload["is_error"] = True
    return payload


async def stream_claude_code(work_dir: str, message: str) -> AsyncIterator[dict[str, Any]]:
    """Stream a read-only Claude Code session rooted at *work_dir*, yielding
    SSE event dicts for *message*."""
    try:
        from claude_agent_sdk import (
            ClaudeSDKClient,
            ResultMessage,
            TextBlock,
            ThinkingBlock,
            ToolResultBlock,
            ToolUseBlock,
        )
    except Exception as exc:  # SDK not installed / import failure
        yield {
            "type": "error",
            "message": f"Claude Agent SDK unavailable ({exc}). Install it with "
            "`pip install claude-agent-sdk` in the server environment.",
        }
        return

    try:
        options = _build_options(work_dir)
        async with ClaudeSDKClient(options=options) as client:
            await client.query(message)
            async for msg in client.receive_response():
                # Blocks can arrive on assistant messages (text/thinking/tool_use)
                # or user messages (tool_result); handle any message with content.
                for block in getattr(msg, "content", None) or []:
                    if isinstance(block, TextBlock):
                        if block.text:
                            yield {"type": "text_delta", "text": block.text}
                    elif isinstance(block, ThinkingBlock):
                        yield {"type": "thinking", "thinking": block.thinking}
                    elif isinstance(block, ToolUseBlock):
                        yield {
                            "type": "tool_start",
                            "tool_use_id": block.id,
                            "tool_name": block.name,
                            "tool_input": block.input or {},
                        }
                    elif isinstance(block, ToolResultBlock):
                        yield {
                            "type": "tool_result",
                            "tool_use_id": block.tool_use_id,
                            "tool_name": "",
                            "result": _tool_result_payload(block),
                        }
                if isinstance(msg, ResultMessage):
                    yield {"type": "agent_done", "final_text": ""}
                    return
    except Exception as exc:
        yield {"type": "error", "message": f"Claude Code session error: {exc}"}
