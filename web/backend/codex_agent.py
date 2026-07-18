"""Read-only Codex CLI backend for simulation chat.

The adapter runs ``codex exec --json`` in an ephemeral, read-only session and
translates its JSONL events to the SSE event protocol used by the web frontend.
Codex reuses the server account's CLI login; API-key environment variables are
removed so selecting this backend does not silently switch to metered key auth.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

_SYSTEM_PROMPT = (
    "You are a molecular-dynamics analysis assistant embedded in the AMD web app. "
    "Work only inside the current simulation directory, which contains GROMACS and "
    "PLUMED inputs and outputs such as md.mdp, md.log, COLVAR, .edr, .xtc, "
    "plumed.dat, and config.yaml. Inspect and explain the simulation. This session "
    "is strictly read-only: do not modify files, start or stop processes, access the "
    "network, or inspect paths outside the current simulation directory. "
    "Work silently: do not narrate searches, tool calls, or intermediate reasoning. "
    "Default to a compact answer. For diagnostics and configuration reviews, give "
    "only the highest-priority findings as a numbered list of at most five items; "
    "each item must have "
    "a short problem label, one brief explanation, and one brief suggested fix. Do "
    "not dump a full file inventory, parameter-by-parameter review, commands, or a "
    "configuration patch unless the user explicitly asks for more detail. When they "
    "do, expand only the requested items. In AMD, Start regenerates topology and "
    "processed coordinates, builds solvent/ions when configured, then generates and "
    "runs EM, NVT, NPT, and the Main simulation. Missing generated preparation or "
    "initialization files in standby are therefore not readiness faults. "
    "method.nsteps overrides the GROMACS default, and initialization overrides "
    "gen_vel/continuation for each stage."
)

_DISABLED_FEATURES = (
    "apps",
    "browser_use",
    "computer_use",
    "image_generation",
    "in_app_browser",
    "plugins",
)
_TOOL_ITEM_TYPES = {
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "plan_update",
    "web_search",
}
_STDERR_LIMIT = 32 * 1024


def _work_dir(path: str) -> Path:
    candidate = Path(path).expanduser().resolve()
    if candidate.is_dir():
        return candidate
    if candidate.parent.is_dir():
        return candidate.parent
    return Path.cwd().resolve()


def _codex_executable() -> str | None:
    configured = os.environ.get("AMD_CODEX_COMMAND", "").strip()
    return configured or shutil.which("codex")


def _codex_env() -> dict[str, str]:
    env = os.environ.copy()
    # codex exec supports CODEX_API_KEY and may also inherit the standard OpenAI key.
    # Removing both makes the CLI reuse its saved ChatGPT/Codex login.
    env.pop("CODEX_API_KEY", None)
    env.pop("OPENAI_API_KEY", None)
    return env


def _codex_command(executable: str, work_dir: Path) -> list[str]:
    command = [
        executable,
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--skip-git-repo-check",
    ]
    for feature in _DISABLED_FEATURES:
        command.extend(("--disable", feature))
    command.extend(("--cd", str(work_dir), "-"))
    return command


def _tool_name(item: dict[str, Any]) -> str:
    item_type = str(item.get("type") or "tool")
    if item_type == "command_execution":
        return "read_shell"
    if item_type == "mcp_tool_call":
        server = item.get("server") or item.get("server_name")
        tool = item.get("tool") or item.get("tool_name") or "tool"
        return f"{server}.{tool}" if server else str(tool)
    return item_type


def _tool_input(item: dict[str, Any]) -> dict[str, Any]:
    if item.get("type") == "command_execution":
        return {"command": item.get("command", "")}
    if item.get("type") == "mcp_tool_call":
        arguments = item.get("arguments") or item.get("input") or {}
        return arguments if isinstance(arguments, dict) else {"arguments": arguments}
    if item.get("type") == "web_search":
        return {"query": item.get("query", "")}
    return {
        key: value
        for key, value in item.items()
        if key not in {"id", "type", "status", "output", "result"}
    }


def _tool_result(item: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"status": item.get("status", "completed")}
    for key in ("output", "aggregated_output", "result", "exit_code"):
        if key in item:
            result[key] = item[key]
    return result


def _error_message(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("message") or value.get("error") or json.dumps(value))
    return str(value or "Codex session failed")


def _translate_event(event: dict[str, Any]) -> dict[str, Any] | None:
    """Translate one documented ``codex exec --json`` event to web SSE."""
    event_type = event.get("type")
    item = event.get("item") if isinstance(event.get("item"), dict) else {}
    item_type = item.get("type")

    if event_type == "item.started" and item_type in _TOOL_ITEM_TYPES:
        return {
            "type": "tool_start",
            "tool_use_id": str(item.get("id") or "codex-tool"),
            "tool_name": _tool_name(item),
            "tool_input": _tool_input(item),
        }

    if event_type == "item.completed":
        if item_type == "agent_message" and item.get("text"):
            return {"type": "text_delta", "text": str(item["text"])}
        if item_type in _TOOL_ITEM_TYPES:
            return {
                "type": "tool_result",
                "tool_use_id": str(item.get("id") or "codex-tool"),
                "tool_name": _tool_name(item),
                "result": _tool_result(item),
            }

    if event_type == "turn.completed":
        return {"type": "agent_done", "final_text": ""}

    if event_type == "turn.failed":
        return {"type": "error", "message": _error_message(event.get("error"))}

    if event_type == "error":
        return {
            "type": "error",
            "message": _error_message(event.get("message") or event.get("error")),
        }

    return None


async def _read_stderr(stream: asyncio.StreamReader) -> str:
    tail = bytearray()
    while chunk := await stream.read(4096):
        tail.extend(chunk)
        if len(tail) > _STDERR_LIMIT:
            del tail[:-_STDERR_LIMIT]
    return tail.decode("utf-8", errors="replace").strip()


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def stream_codex(work_dir: str, message: str) -> AsyncIterator[dict[str, Any]]:
    """Run one ephemeral, read-only Codex turn and yield frontend SSE events."""
    executable = _codex_executable()
    if not executable:
        yield {
            "type": "error",
            "message": "Codex CLI is unavailable. Install it and run `codex login` "
            "as the web-server user.",
        }
        return

    process: asyncio.subprocess.Process | None = None
    stderr_task: asyncio.Task[str] | None = None
    terminal_event_sent = False
    # Codex can emit progress narration as separate agent_message items between
    # command executions. Keep only the final agent message for the chat; tool
    # events still stream live and the full CLI activity remains observable in
    # the process output/logs.
    pending_agent_text = ""
    try:
        wd = _work_dir(work_dir)
        process = await asyncio.create_subprocess_exec(
            *_codex_command(executable, wd),
            cwd=str(wd),
            env=_codex_env(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None

        prompt = f"{_SYSTEM_PROMPT}\n\nUser request:\n{message}\n"
        process.stdin.write(prompt.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()

        stderr_task = asyncio.create_task(_read_stderr(process.stderr))
        async for raw_line in process.stdout:
            try:
                payload = json.loads(raw_line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            translated = _translate_event(payload)
            if translated is None or terminal_event_sent:
                continue
            if translated["type"] == "text_delta":
                pending_agent_text = str(translated.get("text") or "")
                continue
            if translated["type"] in {"agent_done", "error"}:
                terminal_event_sent = True
            if translated["type"] == "agent_done" and pending_agent_text:
                yield {"type": "text_delta", "text": pending_agent_text}
            yield translated

        returncode = await process.wait()
        stderr = await stderr_task
        if not terminal_event_sent:
            if returncode == 0:
                if pending_agent_text:
                    yield {"type": "text_delta", "text": pending_agent_text}
                yield {"type": "agent_done", "final_text": ""}
            else:
                detail = stderr or f"Codex exited with status {returncode}"
                yield {"type": "error", "message": f"Codex session error: {detail}"}
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if not terminal_event_sent:
            yield {"type": "error", "message": f"Codex session error: {exc}"}
    finally:
        if process is not None:
            await _stop_process(process)
        if stderr_task is not None and not stderr_task.done():
            stderr_task.cancel()
