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
import json
import shlex
import shutil
import subprocess
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

_TMUX = shutil.which("tmux")
_LIVE_LOG = ".assistant-live.log"

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
    """Env overrides for the Claude Code subprocess.

    The SDK MERGES this dict on top of the full parent environment
    (``process_env = {**os.environ, **options.env}``), so omitting a key does NOT
    remove it. We must OVERRIDE ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN to empty
    so the CLI ignores them and authenticates with the logged-in Claude
    subscription instead of metered API billing.
    """
    return {"ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""}


def _ensure_tmux_session(name: str, logfile: Path) -> bool:
    """Ensure a **persistent** tmux session *name* exists, running ``tail -F`` on
    *logfile*, so the user can ``tmux attach -t <name>`` and watch the assistant
    work live. The session outlives individual queries. Returns False (no-op) if
    tmux is unavailable or anything goes wrong — observation is best-effort and
    must never break the chat stream."""
    if not _TMUX:
        return False
    try:
        logfile.parent.mkdir(parents=True, exist_ok=True)
        logfile.touch(exist_ok=True)
        exists = subprocess.run([_TMUX, "has-session", "-t", name], capture_output=True)
        if exists.returncode != 0:
            subprocess.run(
                [_TMUX, "new-session", "-d", "-s", name, f"tail -F {shlex.quote(str(logfile))}"],
                capture_output=True,
                check=False,
            )
        return True
    except Exception:
        return False


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


async def stream_claude_code(
    work_dir: str, message: str, tmux_name: str | None = None
) -> AsyncIterator[dict[str, Any]]:
    """Stream a read-only Claude Code session rooted at *work_dir*, yielding
    SSE event dicts for *message*.

    If *tmux_name* is given, a persistent tmux session of that name mirrors a
    human-readable transcript (prompt, streamed text, and — unlike the chat — the
    Read/Grep/Glob tool calls) so the user can ``tmux attach -t <name>`` and
    observe the assistant working."""
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

    # ── tmux transcript mirror (best-effort, never fatal) ──────────────
    log_fh = None
    if tmux_name:
        logfile = Path(work_dir) / _LIVE_LOG
        if _ensure_tmux_session(tmux_name, logfile):
            try:
                log_fh = open(logfile, "a", encoding="utf-8")  # noqa: SIM115
            except Exception:
                log_fh = None

    def mirror(text: str) -> None:
        if log_fh:
            try:
                log_fh.write(text)
                log_fh.flush()
            except Exception:
                pass

    mirror(f"\n{'=' * 72}\n▶ {time.strftime('%Y-%m-%d %H:%M:%S')}  you: {message}\n{'=' * 72}\n")

    try:
        options = _build_options(work_dir)
        async with ClaudeSDKClient(options=options) as client:
            await client.query(message)
            async for msg in client.receive_response():
                # Blocks can arrive on assistant messages (text/thinking/tool_use)
                # or user messages (tool_result). Only the assistant's TEXT is
                # surfaced to the chat; thinking and tool events are suppressed
                # there but mirrored to the tmux transcript for observation.
                for block in getattr(msg, "content", None) or []:
                    if isinstance(block, TextBlock) and block.text:
                        yield {"type": "text_delta", "text": block.text}
                        mirror(block.text)
                    elif isinstance(block, ThinkingBlock):
                        thought = getattr(block, "thinking", "") or ""
                        if thought:
                            mirror(f"\n  🧠 {thought}\n")
                    elif isinstance(block, ToolUseBlock):
                        tool_in = json.dumps(getattr(block, "input", {}), default=str)
                        mirror(f"\n  🔧 {getattr(block, 'name', 'tool')}({tool_in[:400]})\n")
                    elif isinstance(block, ToolResultBlock):
                        mirror("  ✓ tool result\n")
                if isinstance(msg, ResultMessage):
                    mirror("\n— done —\n")
                    yield {"type": "agent_done", "final_text": ""}
                    return
    except Exception as exc:
        mirror(f"\n[error] {exc}\n")
        yield {"type": "error", "message": f"Claude Code session error: {exc}"}
    finally:
        if log_fh:
            try:
                log_fh.close()
            except Exception:
                pass
