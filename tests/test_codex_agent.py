from __future__ import annotations

import asyncio
import json
from pathlib import Path

from web.backend import codex_agent


def test_codex_command_is_ephemeral_read_only_and_reads_prompt_from_stdin(tmp_path: Path):
    command = codex_agent._codex_command("/usr/bin/codex", tmp_path)

    assert command[:2] == ["/usr/bin/codex", "exec"]
    assert "--json" in command
    assert "--ephemeral" in command
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert command[command.index("--cd") + 1] == str(tmp_path)
    assert command[-1] == "-"


def test_codex_env_removes_api_keys(monkeypatch):
    monkeypatch.setenv("CODEX_API_KEY", "codex-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.setenv("KEEP_ME", "yes")

    env = codex_agent._codex_env()

    assert "CODEX_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert env["KEEP_ME"] == "yes"


def test_translate_documented_codex_jsonl_events():
    started = codex_agent._translate_event(
        {
            "type": "item.started",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "command": "rg -n nsteps md.mdp",
                "status": "in_progress",
            },
        }
    )
    assert started == {
        "type": "tool_start",
        "tool_use_id": "item_1",
        "tool_name": "read_shell",
        "tool_input": {"command": "rg -n nsteps md.mdp"},
    }

    completed = codex_agent._translate_event(
        {
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "command_execution",
                "status": "completed",
                "aggregated_output": "nsteps = 500000",
                "exit_code": 0,
            },
        }
    )
    assert completed == {
        "type": "tool_result",
        "tool_use_id": "item_1",
        "tool_name": "read_shell",
        "result": {
            "status": "completed",
            "aggregated_output": "nsteps = 500000",
            "exit_code": 0,
        },
    }

    assert codex_agent._translate_event(
        {
            "type": "item.completed",
            "item": {"id": "item_2", "type": "agent_message", "text": "The run is stable."},
        }
    ) == {"type": "text_delta", "text": "The run is stable."}
    assert codex_agent._translate_event({"type": "turn.completed"}) == {
        "type": "agent_done",
        "final_text": "",
    }


class _FakeReader:
    def __init__(self, chunks: list[bytes]):
        self._chunks = list(chunks)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._chunks:
            raise StopAsyncIteration
        return self._chunks.pop(0)

    async def read(self, _size: int = -1) -> bytes:
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


class _FakeWriter:
    def __init__(self):
        self.data = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.data.extend(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _FakeProcess:
    def __init__(self):
        events = [
            {"type": "thread.started", "thread_id": "thread_1"},
            {
                "type": "item.completed",
                "item": {"id": "item_1", "type": "agent_message", "text": "Looks healthy."},
            },
            {"type": "turn.completed", "usage": {}},
        ]
        self.stdin = _FakeWriter()
        self.stdout = _FakeReader([f"{json.dumps(event)}\n".encode() for event in events])
        self.stderr = _FakeReader([])
        self.returncode = 0

    async def wait(self) -> int:
        return self.returncode


def test_stream_codex_translates_events_and_sends_prompt_over_stdin(monkeypatch, tmp_path: Path):
    process = _FakeProcess()
    invocation = {}

    async def fake_create_subprocess_exec(*args, **kwargs):
        invocation["args"] = args
        invocation["kwargs"] = kwargs
        return process

    monkeypatch.setattr(codex_agent, "_codex_executable", lambda: "/usr/bin/codex")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    async def collect():
        return [event async for event in codex_agent.stream_codex(str(tmp_path), "Check md.log")]

    events = asyncio.run(collect())

    assert events == [
        {"type": "text_delta", "text": "Looks healthy."},
        {"type": "agent_done", "final_text": ""},
    ]
    assert invocation["args"][-1] == "-"
    assert "Check md.log" not in invocation["args"]
    assert b"Check md.log" in process.stdin.data
    assert process.stdin.closed is True
