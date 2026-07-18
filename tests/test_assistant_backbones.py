"""Tests for backend startup assistant-backbone detection."""

from __future__ import annotations

from web.backend import main


def test_detects_codex_without_an_anthropic_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AMD_CODEX_COMMAND", raising=False)
    monkeypatch.setattr(main, "find_spec", lambda _name: None)
    monkeypatch.setattr(
        main.shutil, "which", lambda command: "/usr/bin/codex" if command == "codex" else None
    )

    assert main._available_assistant_backbones() == ["codex"]


def test_reports_no_backbone_when_every_option_is_unavailable(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AMD_CODEX_COMMAND", raising=False)
    monkeypatch.setattr(main, "find_spec", lambda _name: None)
    monkeypatch.setattr(main.shutil, "which", lambda _command: None)

    assert main._available_assistant_backbones() == []
