"""Tests for the heuristic CV-discovery core (proposal + scoring)."""

from __future__ import annotations

import numpy as np

from md_agent.cv_discovery import propose_cvs, rank_cvs, read_colvar_column, score_cv


class TestPropose:
    def test_known_system_returns_phi_psi(self):
        cvs = propose_cvs(system="ala_dipeptide")
        names = [c["name"] for c in cvs]
        assert names == ["phi", "psi"]
        phi = next(c for c in cvs if c["name"] == "phi")
        assert phi["type"] == "TORSION"
        assert phi["atoms"] == [5, 7, 9, 15]  # 1-based PLUMED indices

    def test_case_insensitive(self):
        assert propose_cvs(system="Ala_Dipeptide") == propose_cvs(system="ala_dipeptide")

    def test_unknown_system_without_structure_is_empty(self):
        assert propose_cvs(system="mystery_protein") == []

    def test_max_cvs_caps_results(self):
        assert len(propose_cvs(system="ala_dipeptide", max_cvs=1)) == 1


class TestScore:
    def test_transitioning_cv_scores_above_flat(self):
        # Bistable series crossing between -1 and +1 repeatedly.
        switching = np.tile([1.0, 1.0, -1.0, -1.0], 50)
        flat = np.full(200, 0.3)
        s_switch = score_cv(switching)
        s_flat = score_cv(flat)
        assert s_switch["n_transitions"] > 10
        assert s_flat["n_transitions"] == 0
        assert s_switch["score"] > s_flat["score"]

    def test_flat_series_zero_range_and_transitions(self):
        s = score_cv([2.5] * 100)
        assert s["range"] == 0.0
        assert s["n_transitions"] == 0
        assert s["score"] == 0.0

    def test_ignores_none_and_nan(self):
        s = score_cv([0.0, None, float("nan"), 1.0])
        assert s["n_samples"] == 2

    def test_too_few_samples(self):
        assert score_cv([1.0])["score"] == 0.0
        assert score_cv([])["n_samples"] == 0

    def test_hysteresis_suppresses_band_jitter(self):
        # Two clear basins (range=2 → band ±0.2), then jitter ±0.05 around the
        # midpoint: only the single -1→+1 step should count, not the jitter.
        sig = np.concatenate(
            [
                np.full(20, -1.0),
                np.full(20, 1.0),
                0.05 * np.sin(np.linspace(0, 20, 60)),
            ]
        )
        assert score_cv(sig)["n_transitions"] == 1


class TestRank:
    def test_rank_orders_by_score_desc(self):
        scored = [
            {"name": "a", "score": 0.5},
            {"name": "b", "score": 3.0},
            {"name": "c", "score": 1.0},
        ]
        assert [c["name"] for c in rank_cvs(scored)] == ["b", "c", "a"]


class TestColvar:
    def test_read_named_column(self, tmp_path):
        p = tmp_path / "COLVAR"
        p.write_text("#! FIELDS time phi psi\n0 -2.5 1.0\n1 2.0 -1.0\n2 -2.4 1.1\n")
        assert read_colvar_column(str(p), "phi") == [-2.5, 2.0, -2.4]
        assert read_colvar_column(str(p), "psi") == [1.0, -1.0, 1.1]

    def test_read_missing_column_or_file(self, tmp_path):
        p = tmp_path / "COLVAR"
        p.write_text("#! FIELDS time phi\n0 1.0\n")
        assert read_colvar_column(str(p), "nope") == []
        assert read_colvar_column(str(tmp_path / "absent"), "phi") == []
