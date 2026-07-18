"""Tests for MDP generation — ensure no duplicate keys."""

from omegaconf import OmegaConf

from md_agent.config.hydra_utils import generate_mdp_from_config, normalize_runtime_config


def _make_cfg(method_name: str = "metad"):
    return OmegaConf.create(
        {
            "gromacs": {
                "integrator": "md",
                "dt": 0.002,
                "nstxout": 0,
                "nstvout": 0,
                "nstfout": 0,
                "nstlog": 1000,
                "nstxout_compressed": 5000,
                "nstenergy": 1000,
                "tcoupl": "no",
            },
            "method": {
                "_target_name": method_name,
                "nsteps": 500000,
            },
        }
    )


class TestGenerateMdp:
    def test_no_duplicate_nstfout_metad(self, tmp_path):
        """PLUMED method must not produce doubly-defined nstfout."""
        cfg = _make_cfg("metad")
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        count = content.count("nstfout")
        assert count == 1, f"nstfout appears {count} times, expected 1"

    def test_no_duplicate_nstfout_opes(self, tmp_path):
        cfg = _make_cfg("opes")
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        assert content.count("nstfout") == 1

    def test_no_duplicate_nstfout_steered(self, tmp_path):
        cfg = _make_cfg("steered")
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        assert content.count("nstfout") == 1

    def test_plain_md_keeps_nstfout(self, tmp_path):
        cfg = _make_cfg("plain_md")
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        assert content.count("nstfout") == 1

    def test_nstfout_forced_zero_for_plumed(self, tmp_path):
        """PLUMED methods should force nstfout=0 even if config says otherwise."""
        cfg = _make_cfg("metad")
        OmegaConf.update(cfg, "gromacs.nstfout", 500)
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        # Should contain nstfout = 0, not 500
        for line in content.splitlines():
            if "nstfout" in line:
                assert "0" in line, f"Expected nstfout=0 for PLUMED method, got: {line}"
                break

    def test_method_nsteps_overrides_gromacs(self, tmp_path):
        cfg = _make_cfg("metad")
        OmegaConf.update(cfg, "gromacs.nsteps", 999999, force_add=True)
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        nsteps_lines = [line for line in content.splitlines() if line.startswith("nsteps")]
        assert nsteps_lines == ["nsteps                         = 500000"]

    def test_charmm36m_force_switch_profile_is_written(self, tmp_path):
        cfg = _make_cfg("plain_md")
        OmegaConf.update(cfg, "system.forcefield", "charmm36m", force_add=True)
        assert normalize_runtime_config(cfg)
        out = str(tmp_path / "md.mdp")
        generate_mdp_from_config(cfg, out)
        content = open(out).read()
        assert "rlist                          = 1.2" in content
        assert "rcoulomb                       = 1.2" in content
        assert "vdwtype                        = Cut-off" in content
        assert "vdw-modifier                   = Force-switch" in content
        assert "rvdw-switch                    = 1.0" in content
        assert "rvdw                           = 1.2" in content
