"""Tests for the EM → NVT → [NPT] → production equilibration orchestration
(`_equilibrate_and_run`). Uses a fake GROMACSRunner so no Docker/GROMACS runs;
verifies the stage sequence, the grompp coordinate/restraint/checkpoint chaining,
that vacuum skips NPT, and that a stage failure marks the run failed."""

from __future__ import annotations

import os

import pytest
from hydra import compose, initialize_config_dir

import web.backend.routers.simulate as sim


class _FakeGmx:
    def __init__(self, fail_on: str | None = None):
        self.fail_on = fail_on          # mdp_file whose grompp should fail
        self.grompps: list[dict] = []
        self.mdruns: list[str] = []

    def _cleanup(self):
        pass

    def grompp(self, **kw):
        self.grompps.append(kw)
        return {"success": kw.get("mdp_file") != self.fail_on, "stderr": "boom"}

    def mdrun(self, **kw):
        self.mdruns.append(kw.get("output_prefix"))
        return {"pid": 4321, "status": "running"}

    def wait_mdrun(self):
        return {"success": True, "returncode": 0}


class _FakeSession:
    def __init__(self):
        self.session_id = "s1"
        self.sim_status: dict = {}


@pytest.fixture
def _cfg():
    with initialize_config_dir(config_dir=os.path.abspath("conf"), version_base=None):
        return compose(config_name="config", overrides=["gromacs=tip3p", "system=protein", "method=plain_md"])


@pytest.fixture
def _patched(monkeypatch):
    stages: list[str] = []
    monkeypatch.setattr(sim, "_set_stage", lambda session, s: stages.append(s))
    monkeypatch.setattr(sim, "_persist_run_status", lambda session, s: stages.append(f"status:{s}"))
    return stages


def test_solvated_runs_em_nvt_npt_production(tmp_path, _cfg, _patched):
    gmx = _FakeGmx()
    sim._equilibrate_and_run(
        _FakeSession(), gmx, _cfg, tmp_path, "ionized.gro", "topol.top",
        None, "0", None, "tip3p", 1000,
    )
    assert _patched[:3] == ["minimizing", "nvt", "npt"]
    assert "production" in _patched
    mdps = [g["mdp_file"] for g in gmx.grompps]
    assert mdps == ["em.mdp", "nvt.mdp", "npt.mdp", "md.mdp"]
    # grompp coordinate/restraint/checkpoint chaining
    assert gmx.grompps[0]["coordinate_file"] == "ionized.gro" and not gmx.grompps[0]["restraint_file"]
    assert gmx.grompps[1]["coordinate_file"] == "em.gro" and gmx.grompps[1]["restraint_file"] == "em.gro"
    assert gmx.grompps[2]["restraint_file"] == "nvt.gro" and gmx.grompps[2]["checkpoint_file"] == "nvt.cpt"
    assert gmx.grompps[3]["checkpoint_file"] == "npt.cpt" and not gmx.grompps[3]["restraint_file"]
    assert gmx.mdruns[-1] == "simulation/md"  # production launched last


def test_vacuum_skips_npt(tmp_path, _cfg, _patched):
    gmx = _FakeGmx()
    sim._equilibrate_and_run(
        _FakeSession(), gmx, _cfg, tmp_path, "prot_box.gro", "topol.top",
        None, None, None, "none", 1000,
    )
    assert "npt" not in _patched
    mdps = [g["mdp_file"] for g in gmx.grompps]
    assert mdps == ["em.mdp", "nvt.mdp", "md.mdp"]
    assert gmx.grompps[2]["checkpoint_file"] == "nvt.cpt"  # production continues from NVT


def test_equilibration_disabled_runs_production_directly(tmp_path, _cfg, _patched):
    from omegaconf import OmegaConf

    OmegaConf.update(_cfg, "gromacs.equilibrate", False, merge=True)
    gmx = _FakeGmx()
    sim._equilibrate_and_run(
        _FakeSession(), gmx, _cfg, tmp_path, "ionized.gro", "topol.top",
        None, "0", None, "tip3p", 1000,
    )
    mdps = [g["mdp_file"] for g in gmx.grompps]
    assert mdps == ["md.mdp"]  # no EM/NVT/NPT
    assert gmx.grompps[0]["coordinate_file"] == "ionized.gro"
    assert not gmx.grompps[0]["checkpoint_file"]  # fresh start, no continuation
    assert gmx.mdruns == ["simulation/md"]


def test_configurable_nvt_length(tmp_path, _cfg, _patched):
    from omegaconf import OmegaConf

    OmegaConf.update(_cfg, "gromacs.equil_nvt_ps", 20, merge=True)  # 20 ps at dt=0.002 → 10000 steps
    gmx = _FakeGmx()
    sim._equilibrate_and_run(
        _FakeSession(), gmx, _cfg, tmp_path, "ionized.gro", "topol.top",
        None, "0", None, "tip3p", 1000,
    )
    nvt_mdp = (tmp_path / "nvt.mdp").read_text()
    assert any(line.replace(" ", "").startswith("nsteps=10000") for line in nvt_mdp.splitlines())


def test_stage_failure_marks_failed(tmp_path, _cfg, _patched):
    gmx = _FakeGmx(fail_on="nvt.mdp")  # NVT grompp fails
    sim._equilibrate_and_run(
        _FakeSession(), gmx, _cfg, tmp_path, "ionized.gro", "topol.top",
        None, "0", None, "tip3p", 1000,
    )
    assert "status:failed" in _patched
    assert not any(m == "simulation/md" for m in gmx.mdruns)  # production never launched
