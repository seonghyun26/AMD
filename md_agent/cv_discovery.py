"""Heuristic collective-variable discovery: propose candidate CVs for a system
and score them from sampled trajectories.

These are pure functions (no web/GROMACS deps) so they are unit-testable; the
project-level orchestrator in the web layer launches simulations and persists
the resulting candidates. CV dicts match the repo's config shape used by the
PLUMED generator and cv_store:

    {"name": str, "type": "TORSION|DISTANCE|RMSD", "atoms": [1-based ints], ...}

Scoring philosophy (v1, heuristics-only): a good CV both *separates* metastable
states and *transitions* between them within the sampled trajectory. We reward
the number of basin-to-basin crossings (primary) and the spread of sampling
(secondary). Learned/ML CVs (TICA/VAMP) are a later addition.
"""

from __future__ import annotations

from typing import Any

import numpy as np

# Curated CV libraries for known systems — 1-based PLUMED atom indices, matching
# conf/plumed/collective_variables/ala_dipeptide.yaml.
_SYSTEM_CVS: dict[str, list[dict[str, Any]]] = {
    "ala_dipeptide": [
        {"name": "phi", "type": "TORSION", "atoms": [5, 7, 9, 15]},
        {"name": "psi", "type": "TORSION", "atoms": [7, 9, 15, 17]},
    ],
}


# ── Proposal ──────────────────────────────────────────────────────────


def propose_cvs(
    system: str = "",
    structure_path: str | None = None,
    max_cvs: int = 6,
) -> list[dict[str, Any]]:
    """Propose candidate CVs for a system.

    Priority:
      1. A curated library for known systems (e.g. alanine dipeptide → φ/ψ).
      2. Backbone φ/ψ torsions derived from a structure via mdtraj.
      3. Empty list (caller then defines CVs manually).
    """
    lib = _SYSTEM_CVS.get((system or "").strip().lower())
    if lib:
        return [dict(cv) for cv in lib][:max_cvs]
    if structure_path:
        derived = _propose_from_structure(structure_path, max_cvs=max_cvs)
        if derived:
            return derived
    return []


def _propose_from_structure(structure_path: str, max_cvs: int = 6) -> list[dict[str, Any]]:
    """Derive backbone φ/ψ torsions (converted to 1-based indices) via mdtraj."""
    try:
        import mdtraj as md
    except Exception:
        return []
    try:
        traj = md.load(structure_path)
    except Exception:
        return []

    cvs: list[dict[str, Any]] = []
    for label, fn in (("phi", md.compute_phi), ("psi", md.compute_psi)):
        try:
            indices, _ = fn(traj)
        except Exception:
            continue
        for i, quad in enumerate(indices):
            cvs.append(
                {
                    "name": f"{label}{i + 1}",
                    "type": "TORSION",
                    "atoms": [int(a) + 1 for a in quad],  # mdtraj is 0-based → PLUMED 1-based
                }
            )
    return cvs[:max_cvs]


# ── Scoring ───────────────────────────────────────────────────────────


def _count_transitions(arr: np.ndarray, min_span: float = 1e-9) -> int:
    """Count basin-to-basin crossings using a midpoint split with hysteresis.

    A hysteresis band around the midpoint suppresses noise-driven double counts,
    so only genuine excursions between the low and high basins are tallied.
    """
    lo, hi = float(arr.min()), float(arr.max())
    span = hi - lo
    if span < min_span:
        return 0
    thresh = 0.5 * (lo + hi)
    margin = 0.1 * span
    state = 0  # -1 = low basin, +1 = high basin, 0 = undecided / in band
    transitions = 0
    for v in arr:
        if v < thresh - margin:
            new = -1
        elif v > thresh + margin:
            new = 1
        else:
            new = state  # inside the hysteresis band → hold current basin
        if state != 0 and new != 0 and new != state:
            transitions += 1
        if new != 0:
            state = new
    return transitions


def score_cv(values) -> dict[str, Any]:
    """Heuristic score for a CV from its sampled time series (a COLVAR column).

    Returns metrics + an aggregate ``score``. Transitions are the primary signal
    (a CV that never crosses between basins can't drive enhanced sampling);
    fractional spread (std / range) is a scale-invariant tiebreak.
    """
    arr = np.asarray([v for v in values if v is not None], dtype=float)
    arr = arr[np.isfinite(arr)]
    if arr.size < 2:
        return {"range": 0.0, "std": 0.0, "n_transitions": 0, "n_samples": int(arr.size), "score": 0.0}

    vrange = float(arr.max() - arr.min())
    vstd = float(arr.std())
    n_trans = _count_transitions(arr)
    spread_frac = vstd / vrange if vrange > 1e-9 else 0.0
    score = float(n_trans) + spread_frac  # transitions dominate; spread breaks ties
    return {
        "range": vrange,
        "std": vstd,
        "n_transitions": n_trans,
        "n_samples": int(arr.size),
        "score": score,
    }


def rank_cvs(scored: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return candidates sorted best-first by their aggregate ``score``."""
    return sorted(scored, key=lambda c: c.get("score", 0.0), reverse=True)


# ── COLVAR I/O ────────────────────────────────────────────────────────


def read_colvar_column(colvar_path: str, name: str) -> list[float]:
    """Read one named column from a PLUMED COLVAR file.

    PLUMED writes a header like ``#! FIELDS time phi psi metad.bias`` followed by
    whitespace-separated data rows. Returns [] if the file/column is absent.
    """
    fields: list[str] | None = None
    out: list[float] = []
    try:
        with open(colvar_path) as fh:
            for line in fh:
                s = line.strip()
                if not s:
                    continue
                if s.startswith("#"):
                    toks = s.split()
                    if "FIELDS" in toks:
                        fields = toks[toks.index("FIELDS") + 1:]
                    continue
                if not fields or name not in fields:
                    continue
                cols = s.split()
                idx = fields.index(name)
                if idx < len(cols):
                    try:
                        out.append(float(cols[idx]))
                    except ValueError:
                        pass
    except OSError:
        return []
    return out
