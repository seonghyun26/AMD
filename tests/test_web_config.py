"""Tests for web backend config router — PLUMED generation and config endpoints."""

import pytest
from unittest.mock import MagicMock, patch
from omegaconf import OmegaConf

from web.backend.routers.config import _resolve_cvs, _build_plumed_content


@pytest.fixture
def base_cfg():
    """Minimal OmegaConf config for PLUMED tests."""
    return OmegaConf.create({
        "method": {"_target_name": "metad"},
        "gromacs": {"temperature": 300},
        "plumed": {
            "collective_variables": {
                "colvar_stride": 100,
                "colvar_file": "COLVAR",
                "cvs": [
                    {"name": "d1", "type": "DISTANCE", "atoms": [1, 100]},
                ],
            },
            "hills": {"hills_file": "HILLS"},
        },
    })


class TestResolveCvs:
    def test_extracts_cvs(self, base_cfg):
        cvs = _resolve_cvs(base_cfg)
        assert len(cvs) == 1
        assert cvs[0]["name"] == "d1"
        assert cvs[0]["type"] == "DISTANCE"

    def test_empty_when_no_cvs(self):
        cfg = OmegaConf.create({"plumed": {"collective_variables": {}}})
        assert _resolve_cvs(cfg) == []

    def test_empty_when_no_plumed(self):
        cfg = OmegaConf.create({"method": {}})
        assert _resolve_cvs(cfg) == []

    def test_multiple_cvs(self):
        cfg = OmegaConf.create({
            "plumed": {
                "collective_variables": {
                    "cvs": [
                        {"name": "d1", "type": "DISTANCE", "atoms": [1, 2]},
                        {"name": "phi", "type": "TORSION", "atoms": [5, 7, 9, 15]},
                    ],
                },
            },
        })
        cvs = _resolve_cvs(cfg)
        assert len(cvs) == 2
        assert cvs[1]["type"] == "TORSION"


class TestBuildPlumedContent:
    def test_metadynamics_content(self, base_cfg):
        cvs = _resolve_cvs(base_cfg)
        content = _build_plumed_content(base_cfg, cvs)
        assert "d1: DISTANCE ATOMS=1,100" in content
        assert "METAD" in content
        assert "PRINT STRIDE=100" in content
        assert "FLUSH" in content

    def test_metadynamics_with_biasfactor(self, base_cfg):
        OmegaConf.update(base_cfg, "method.hills.biasfactor", 10)
        cvs = _resolve_cvs(base_cfg)
        content = _build_plumed_content(base_cfg, cvs)
        assert "BIASFACTOR=10.0" in content
        assert "TEMP=300" in content

    def test_opes_content(self):
        cfg = OmegaConf.create({
            "method": {
                "_target_name": "opes",
                "pace": 500,
                "sigma": 0.05,
                "barrier": 30,
                "temperature": 340,
            },
            "gromacs": {"temperature": 300},
            "plumed": {
                "collective_variables": {
                    "colvar_stride": 200,
                    "colvar_file": "COLVAR",
                    "cvs": [{"name": "d1", "type": "DISTANCE", "atoms": [1, 2]}],
                },
            },
        })
        cvs = _resolve_cvs(cfg)
        content = _build_plumed_content(cfg, cvs)
        assert "OPES_METAD" in content
        assert "BARRIER=30" in content
        assert "PRINT STRIDE=200" in content

    def test_umbrella_content(self):
        cfg = OmegaConf.create({
            "method": {
                "_target_name": "umbrella",
                "window_start": 1.5,
                "force_constant": 1000,
            },
            "plumed": {
                "collective_variables": {
                    "colvar_stride": 100,
                    "colvar_file": "COLVAR",
                    "cvs": [{"name": "cv1", "type": "DISTANCE", "atoms": [1, 2]}],
                },
            },
        })
        cvs = _resolve_cvs(cfg)
        content = _build_plumed_content(cfg, cvs)
        assert "RESTRAINT" in content
        assert "AT=1.5" in content
        assert "KAPPA=1000" in content

    def test_steered_content(self):
        cfg = OmegaConf.create({
            "method": {
                "_target_name": "steered",
                "initial_value": 0.5,
                "final_value": 4.0,
                "force_constant": 500,
                "nsteps": 1000000,
            },
            "plumed": {
                "collective_variables": {
                    "colvar_stride": 100,
                    "colvar_file": "COLVAR",
                    "cvs": [{"name": "d1", "type": "DISTANCE", "atoms": [1, 2]}],
                },
            },
        })
        cvs = _resolve_cvs(cfg)
        content = _build_plumed_content(cfg, cvs)
        assert "MOVINGRESTRAINT" in content
        assert "AT0=0.5" in content
        assert "AT1=4.0" in content
        assert "KAPPA0=500" in content

    def test_multiple_cv_types(self):
        cfg = OmegaConf.create({
            "method": {"_target_name": "metad"},
            "gromacs": {"temperature": 300},
            "plumed": {
                "collective_variables": {
                    "colvar_stride": 100,
                    "colvar_file": "COLVAR",
                    "cvs": [
                        {"name": "d1", "type": "DISTANCE", "atoms": [1, 2]},
                        {"name": "phi", "type": "TORSION", "atoms": [5, 7, 9, 15]},
                        {"name": "rmsd1", "type": "RMSD", "reference": "ref.pdb", "rmsd_type": "OPTIMAL"},
                        {"name": "c1", "type": "COORDINATION", "groupa": [1, 2], "groupb": [3, 4], "r0": 0.6},
                    ],
                },
                "hills": {
                    "height": 1.2,
                    "sigma": [0.35, 0.35, 0.1, 0.2],
                    "pace": 500,
                    "hills_file": "HILLS",
                },
            },
        })
        cvs = _resolve_cvs(cfg)
        content = _build_plumed_content(cfg, cvs)
        assert "d1: DISTANCE ATOMS=1,2" in content
        assert "phi: TORSION ATOMS=5,7,9,15" in content
        assert "rmsd1: RMSD REFERENCE=ref.pdb TYPE=OPTIMAL" in content
        assert "c1: COORDINATION GROUPA=1,2 GROUPB=3,4 R_0=0.6" in content

    def test_plain_md_returns_minimal(self):
        cfg = OmegaConf.create({
            "method": {"_target_name": "plain_md"},
            "plumed": {
                "collective_variables": {
                    "colvar_stride": 100,
                    "colvar_file": "COLVAR",
                    "cvs": [{"name": "d1", "type": "DISTANCE", "atoms": [1, 2]}],
                },
            },
        })
        cvs = _resolve_cvs(cfg)
        content = _build_plumed_content(cfg, cvs)
        # Plain MD should still have CV definitions and FLUSH but no bias
        assert "d1: DISTANCE" in content
        assert "METAD" not in content
        assert "OPES" not in content
