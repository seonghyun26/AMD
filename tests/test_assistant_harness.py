"""Tests for the assistant's guarded simulation-creation middleware."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from web.backend import codex_agent
from web.backend.assistant_harness import (
    build_action_prompt,
    is_simulation_readiness_query,
    is_simulation_state_query,
    list_assistant_actions,
    parse_simulation_creation,
)
from web.backend.routers import assistant


def test_parses_explicit_chignolin_duration_request():
    plan = parse_simulation_creation("I want to test a chignolin for 1 ns")

    assert plan is not None
    assert plan.system == "chignolin"
    assert plan.duration_ps == 1_000
    assert plan.nsteps == 500_000
    assert plan.preset == "md"
    assert plan.gromacs == "tip3p"
    assert plan.nickname == "Chignolin-1ns"
    assert plan.work_dir_slug.startswith("chignolin-1ns-")


def test_does_not_create_for_questions_or_incomplete_requests():
    assert parse_simulation_creation("Can I test chignolin for 1 ns?") is None
    assert parse_simulation_creation("Set up chignolin") is None
    assert parse_simulation_creation("Run 1 ns") is None


def test_action_registry_only_lists_executable_assistant_actions():
    actions = {action["name"]: action for action in list_assistant_actions()}

    assert set(actions) == {
        "create_simulation",
        "check_run_readiness",
        "analyze_simulation",
        "start_simulation",
        "inspect_molecular_system",
        "inspect_simulation_state",
        "review_initial_configuration",
        "research_cv_publications",
    }
    assert actions["create_simulation"]["scope"] == "project_or_general"
    assert actions["start_simulation"]["scope"] == "simulation"
    assert actions["research_cv_publications"]["scope"] == "simulation"
    assert all(action["safety"] for action in actions.values())


def test_start_action_reports_preflight_blockers_without_launching(monkeypatch):
    monkeypatch.setattr(
        assistant,
        "_start_preflight",
        lambda _action: {
            "ok": False,
            "problems": [
                "No selected raw PDB or GRO structure is available to prepare the system."
            ],
            "free_gb": 12.0,
            "minimum_free_gb": 2.0,
            "source_coordinate": None,
        },
    )
    action = {"name": "start_simulation", "session_id": "session-1", "nickname": "test"}

    async def collect():
        return [event async for event in assistant._stream_simulation_action(action, "alice", None)]

    events = asyncio.run(collect())

    assert events[0]["tool_name"] == "start_simulation"
    assert events[1]["result"]["status"] == "blocked"
    assert "not started" in events[2]["text"]
    assert events[-1] == {"type": "agent_done", "final_text": ""}


def test_recognizes_state_questions_without_treating_mutation_requests_as_reads():
    assert is_simulation_state_query("Now chignolin folded is selected, right?")
    assert is_simulation_state_query("What is the status now?")
    assert is_simulation_state_query("Which initial structure is selected?")
    assert not is_simulation_state_query("I want the initial state to be folded")
    assert not is_simulation_state_query("Analyze the simulation results")


def test_recognizes_run_readiness_questions():
    assert is_simulation_readiness_query("Is @Chignolin 1ns now ready for a simulation run?")
    assert is_simulation_readiness_query("Is this ready to start?")
    assert not is_simulation_readiness_query("Start the simulation now")
    assert not is_simulation_readiness_query("Analyze the simulation results")


def test_readiness_prompt_understands_managed_initialization_pipeline():
    prompt = build_action_prompt(
        "check_run_readiness",
        nickname="Chignolin-1ns",
        system="chignolin folded",
        user_request="Is it ready to run?",
    )

    assert "EM, then NVT, then NPT" in prompt
    assert "standby session is expected" in prompt
    assert "method.nsteps is the authoritative Main simulation length" in prompt
    assert "ignore it completely" in prompt
    assert "Plain MD does not generate or run PLUMED" in prompt
    assert "vdw-modifier=Force-switch" in prompt
    assert "base gen_vel value" in prompt
    assert "seeded system.gro preview" in prompt


def test_cv_publication_template_requires_verified_evidence_and_local_atom_mapping():
    prompt = build_action_prompt(
        "research_cv_publications",
        nickname="chignolin-test",
        system="chignolin unfolded",
        user_request="Focus on folding.",
        evidence='{"papers": [{"title": "Verified paper", "year": 2024}]}',
    )

    assert "Verified paper" in prompt
    assert "invent a title" in prompt
    assert "local post-topology structure" in prompt
    assert "Do not edit config.yaml" in prompt
    assert "at most five" in prompt
    assert "explicitly asks for more detail" in prompt


def test_assistant_falls_back_to_codex_when_claude_sdk_is_unavailable(monkeypatch):
    async def fake_codex(work_dir, message):
        assert work_dir == "/tmp/project"
        assert message == "Inspect the project"
        yield {"type": "text_delta", "text": "Using Codex."}
        yield {"type": "agent_done", "final_text": ""}

    monkeypatch.setattr(assistant, "_agent_backbone", lambda _username: "claude_code")
    monkeypatch.setattr(assistant, "find_spec", lambda _name: None)
    monkeypatch.setattr(codex_agent, "stream_codex", fake_codex)

    async def collect():
        return [
            event
            async for event in assistant._stream_read_only_assistant(
                "/tmp/project", "Inspect the project", "alice", None
            )
        ]

    assert asyncio.run(collect()) == [
        {"type": "text_delta", "text": "Using Codex."},
        {"type": "agent_done", "final_text": ""},
    ]


def test_assistant_stream_creates_standby_session_and_reports_result(monkeypatch):
    captured = {}

    def fake_create(request, username):
        captured["request"] = request
        captured["username"] = username
        return {
            "session_id": "session-1",
            "work_dir": request.work_dir,
            "nickname": request.nickname,
            "seeded_files": ["chignolin-unfolded.pdb"],
        }

    monkeypatch.setattr(assistant, "create_session_from_request", fake_create)

    async def collect():
        response = assistant._stream(
            "outputs/alice/project",
            "I want to test a chignolin for 1ns",
            "alice",
            project_id="project-1",
        )
        chunks = [chunk async for chunk in response.body_iterator]
        return [json.loads(str(chunk).removeprefix("data: ").strip()) for chunk in chunks]

    events = asyncio.run(collect())

    assert captured["username"] == "alice"
    request = captured["request"]
    assert request.project_id == "project-1"
    assert request.system == "chignolin"
    assert request.preset == "md"
    assert request.gromacs == "tip3p"
    assert request.nickname == "Chignolin-1ns"
    assert request.work_dir.startswith("outputs/alice/chignolin-1ns-")
    assert request.work_dir.endswith("/data")
    assert request.extra_overrides == ["method.nsteps=500000"]
    assert events[0]["type"] == "tool_start"
    assert events[0]["tool_name"] == "create_simulation"
    assert events[1]["result"]["status"] == "completed"
    assert events[2]["type"] == "text_delta"
    assert "standby" in events[2]["text"]
    assert events[3] == {"type": "agent_done", "final_text": ""}


def test_structured_cv_action_searches_publications_and_uses_exact_simulation(monkeypatch):
    captured = {}

    def fake_search(system):
        assert system == "chignolin"
        return {
            "query": "chignolin CV search",
            "papers": [{"title": "A CV paper", "year": 2025}],
        }

    async def fake_assistant(work_dir, prompt, username, tmux_name):
        captured.update(
            work_dir=work_dir,
            prompt=prompt,
            username=username,
            tmux_name=tmux_name,
        )
        yield {"type": "text_delta", "text": "Evidence-based CV report"}
        yield {"type": "agent_done", "final_text": ""}

    async def immediate_to_thread(func, *args):
        return func(*args)

    monkeypatch.setattr(assistant, "_search_cv_publications", fake_search)
    monkeypatch.setattr(assistant, "_stream_read_only_assistant", fake_assistant)
    monkeypatch.setattr(assistant.asyncio, "to_thread", immediate_to_thread)

    action = {
        "name": "research_cv_publications",
        "session_id": "session-1",
        "work_dir": "/tmp/exact-simulation",
        "nickname": "chignolin-test",
        "system": "chignolin",
        "user_request": "Focus on folding",
    }

    async def collect():
        return [
            event
            async for event in assistant._stream_simulation_action(action, "alice", "amd-project")
        ]

    events = asyncio.run(collect())

    assert captured["work_dir"] == "/tmp/exact-simulation"
    assert captured["username"] == "alice"
    assert captured["tmux_name"] == "amd-project"
    assert "A CV paper" in captured["prompt"]
    assert events[0]["tool_name"] == "assistant_action"
    assert events[1]["tool_name"] == "search_cv_publications"
    assert events[2]["result"]["status"] == "completed"
    assert events[-2]["result"]["action"] == "research_cv_publications"
    assert events[-1] == {"type": "agent_done", "final_text": ""}


def test_structured_action_resolves_to_session_root_with_config(tmp_path, monkeypatch):
    from omegaconf import OmegaConf

    root = tmp_path / "simulation-root"
    data = root / "data"
    data.mkdir(parents=True)
    (root / "config.yaml").write_text("system:\n  name: chignolin\n")
    session = SimpleNamespace(
        work_dir=str(data),
        nickname="fallback-name",
        agent=SimpleNamespace(cfg=OmegaConf.create({"system": {"name": "chignolin"}})),
    )
    monkeypatch.setattr(assistant.authz, "session_owner", lambda _sid: "alice")
    monkeypatch.setattr(assistant, "get_or_restore_session", lambda _sid: session)
    monkeypatch.setattr(
        assistant.db,
        "get_session_indexed",
        lambda _sid: {"nickname": "configured-name", "selected_molecule": ""},
    )

    request = assistant.AssistantActionRequest(
        name="review_initial_configuration",
        session_id="session-1",
    )
    resolved = assistant._resolve_simulation_action(request, username="alice")

    assert resolved["work_dir"] == str(root)
    assert resolved["nickname"] == "configured-name"
    assert resolved["system"] == "chignolin"


def test_simulation_state_action_reads_persisted_selection_without_agent(tmp_path, monkeypatch):
    from omegaconf import OmegaConf

    root = tmp_path / "simulation-root"
    data = root / "data"
    data.mkdir(parents=True)
    (data / "chignolin-folded.pdb").write_text("MODEL\nEND\n")
    (root / "session.json").write_text(
        json.dumps(
            {
                "session_id": "session-1",
                "nickname": "Chignolin-1ns",
                "selected_molecule": "chignolin-folded.pdb",
                "run_status": "standby",
            }
        )
    )
    cfg = OmegaConf.create({"system": {"name": "protein", "coordinates": "chignolin-folded.pdb"}})
    OmegaConf.save(cfg, root / "config.yaml")
    session = SimpleNamespace(
        work_dir=str(data),
        nickname="Chignolin-1ns",
        agent=SimpleNamespace(cfg=cfg),
    )
    monkeypatch.setattr(assistant, "get_or_restore_session", lambda _sid: session)
    monkeypatch.setattr(
        assistant.db,
        "get_session_indexed",
        lambda _sid: {
            "nickname": "Chignolin-1ns",
            "selected_molecule": "chignolin-folded.pdb",
            "run_status": "standby",
        },
    )
    action = {
        "name": "inspect_simulation_state",
        "session_id": "session-1",
        "work_dir": str(root),
        "data_dir": str(data),
        "nickname": "Chignolin-1ns",
        "system": "chignolin folded",
        "user_request": "",
    }

    async def collect():
        return [event async for event in assistant._stream_simulation_action(action, "alice", None)]

    events = asyncio.run(collect())

    assert events[0]["tool_name"] == "inspect_simulation_state"
    assert events[1]["result"]["selected_molecule"] == "chignolin-folded.pdb"
    assert events[1]["result"]["selection_consistent"] is True
    assert events[1]["result"]["selected_file_exists"] is True
    assert "chignolin-folded.pdb" in events[2]["text"]
    assert events[-1] == {"type": "agent_done", "final_text": ""}


def test_plain_state_question_is_bound_to_context_session(monkeypatch):
    captured = {}

    def fake_resolve(action, *, username, project_id=""):
        captured.update(action=action, username=username, project_id=project_id)
        return {"name": action.name, "session_id": action.session_id}

    monkeypatch.setattr(assistant, "_resolve_simulation_action", fake_resolve)
    request = assistant.ChatRequest(
        message="Now folded is selected, right?",
        context_session_id="session-1",
    )

    resolved = assistant._resolve_chat_action(
        request,
        username="alice",
        project_id="project-1",
    )

    assert resolved == {"name": "inspect_simulation_state", "session_id": "session-1"}
    assert captured["username"] == "alice"
    assert captured["project_id"] == "project-1"


def test_plain_readiness_question_is_bound_to_context_session(monkeypatch):
    captured = {}

    def fake_resolve(action, *, username, project_id=""):
        captured.update(action=action, username=username, project_id=project_id)
        return {"name": action.name, "session_id": action.session_id}

    monkeypatch.setattr(assistant, "_resolve_simulation_action", fake_resolve)
    request = assistant.ChatRequest(
        message="Is @Chignolin-1ns ready for a simulation run?",
        context_session_id="session-1",
    )

    resolved = assistant._resolve_chat_action(
        request,
        username="alice",
        project_id="project-1",
    )

    assert resolved == {"name": "check_run_readiness", "session_id": "session-1"}
    assert captured["action"].parameters["focus"] == request.message
