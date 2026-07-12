"""Regression tests for audit fixes: COLVAR bookmark drift and the authz
ownerless-session leak."""

from __future__ import annotations

from md_agent.config.schemas import validate_gromacs_dict
from md_agent.utils.parsers import parse_colvar_file
from web.backend import authz


class TestGromacsValidation:
    def test_partial_config_is_valid(self):
        # vacuum-like: no pressure/rlist — must NOT be rejected
        assert validate_gromacs_dict(
            {"integrator": "md", "dt": 0.002, "temperature": 300, "pcoupl": "no",
             "rcoulomb": 1.2, "rvdw": 1.2, "constraints": "h-bonds"}
        ) == []

    def test_bad_values_are_reported(self):
        assert validate_gromacs_dict({"dt": 0.01})          # 10 fs — too large
        assert validate_gromacs_dict({"temperature": -5})   # negative
        assert validate_gromacs_dict({"nsteps": 0})         # not > 0
        assert validate_gromacs_dict({"pcoupl": "Nonsense"})  # unknown barostat

    def test_unknown_keys_ignored(self):
        assert validate_gromacs_dict({"dt": 0.002, "coulombtype": "PME", "box_clearance": 1.2}) == []


class TestColvarBookmark:
    def test_torn_last_line_is_not_consumed(self, tmp_path):
        f = tmp_path / "COLVAR"
        # third data line is a torn/partial write (non-numeric)
        f.write_text("#! FIELDS time d1\n0.0 1.0\n1.0 2.0\n2.0 ab")
        rows = parse_colvar_file(str(f), from_line=0)
        assert len(rows) == 2  # stops before the torn line
        # bookmark advanced by len(rows)=2; the torn line is still torn → nothing new
        assert parse_colvar_file(str(f), from_line=2) == []

    def test_completed_line_picked_up_without_duplication(self, tmp_path):
        f = tmp_path / "COLVAR"
        f.write_text("#! FIELDS time d1\n0.0 1.0\n1.0 2.0\n2.0 ab")
        assert len(parse_colvar_file(str(f), from_line=0)) == 2
        # GROMACS finishes writing the third line
        f.write_text("#! FIELDS time d1\n0.0 1.0\n1.0 2.0\n2.0 3.0\n")
        rows = parse_colvar_file(str(f), from_line=2)  # resume from the bookmark
        assert len(rows) == 1 and rows[0]["d1"] == 3.0  # exactly one new row, no dup


class TestAuthzOwnership:
    def test_ownerless_session_denied_to_real_user(self, monkeypatch):
        monkeypatch.setattr(authz.db, "get_session_indexed", lambda sid: {"username": ""})
        assert authz.session_owner("s1") == ""
        assert authz.owns("alice", "/api/sessions/s1/files") is False

    def test_unknown_session_falls_through(self, monkeypatch):
        monkeypatch.setattr(authz.db, "get_session_indexed", lambda sid: None)
        assert authz.session_owner("s2") is None
        assert authz.owns("alice", "/api/sessions/s2/files") is True  # handler 404s

    def test_owned_session_allowed_to_owner_only(self, monkeypatch):
        monkeypatch.setattr(authz.db, "get_session_indexed", lambda sid: {"username": "bob"})
        assert authz.owns("bob", "/api/sessions/s3/files") is True
        assert authz.owns("alice", "/api/sessions/s3/files") is False
