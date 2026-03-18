"""Analysis endpoints: return plot-ready data for COLVAR, FES, energy, log."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from web.backend.analysis_utils import (
    _load_energy_npy,
    _parse_xvg_with_header,
    colvar_to_columns,
    fes_dat_to_heatmap,
    generate_ramachandran_png,
    get_log_progress,
    run_gmx_energy,
)
from web.backend.session_manager import get_or_restore_session

router = APIRouter()

MAX_PLOT_POINTS = 5000


def _downsample(data: dict[str, list], max_points: int = MAX_PLOT_POINTS) -> dict[str, list]:
    """Evenly downsample all columns to at most max_points entries."""
    if not data:
        return data
    n = len(next(iter(data.values())))
    if n <= max_points:
        return data
    step = max(1, n // max_points)
    return {k: v[::step] for k, v in data.items()}


def _require_session(session_id: str):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


class CVDef(BaseModel):
    type: Literal["distance", "angle", "dihedral"]
    atoms: list[int]  # 1-based
    label: str = ""


class CustomCVRequest(BaseModel):
    cvs: list[CVDef]
    force: bool = False


@router.get("/sessions/{session_id}/analysis/colvar")
async def get_colvar(
    session_id: str,
    filename: str = "COLVAR",
    max_points: int = Query(default=MAX_PLOT_POINTS, ge=100, le=100000),
):
    """Parse COLVAR and return column arrays for Plotly line/scatter charts."""
    session = _require_session(session_id)
    path = str(Path(session.work_dir) / filename)
    data = _downsample(colvar_to_columns(path), max_points)
    return {"data": data, "available": bool(data)}


@router.get("/sessions/{session_id}/analysis/fes")
async def get_fes(session_id: str, filename: str = "fes.dat"):
    """Parse plumed sum_hills FES file → {x, y, z} for Plotly heatmap (Ramachandran)."""
    session = _require_session(session_id)
    path = str(Path(session.work_dir) / filename)
    data = fes_dat_to_heatmap(path)
    return {"data": data, "available": bool(data)}


@router.get("/sessions/{session_id}/analysis/energy")
async def get_energy(
    session_id: str,
    force: bool = Query(default=False),
    extract: bool = Query(default=False),
    max_points: int = Query(default=MAX_PLOT_POINTS, ge=100, le=100000),
):
    """Return energy time series for Plotly.

    Behavior:
    - Default (no flags): serve from cache only (.npy or .xvg). Returns available=false if no cache.
    - extract=true: if no cache, run 'gmx energy' to extract from .edr and cache the result.
    - force=true: re-extract from .edr even if cache exists.
    """
    session = _require_session(session_id)
    wd = Path(session.work_dir)
    analysis_dir = wd / "analysis"

    # Serve from cached .npy files (fastest)
    if not force:
        npy_data = _load_energy_npy(analysis_dir)
        if npy_data:
            return {"data": _downsample(npy_data, max_points), "available": True, "source": "cache"}

    # Serve from cached XVG
    xvg_path = analysis_dir / "energy.xvg"
    if not force and xvg_path.exists() and xvg_path.stat().st_size > 0:
        data = _parse_xvg_with_header(str(xvg_path))
        if data:
            return {"data": _downsample(data, max_points), "available": True, "source": "cache"}

    # No cache — only run gmx energy if explicitly requested
    if not extract and not force:
        # Check if .edr exists so frontend knows extraction is possible
        edr_candidates = [
            wd / "simulation" / "md.edr",
            wd / "ener.edr",
            wd / "md.edr",
        ]
        has_edr = any(p.exists() for p in edr_candidates)
        return {"data": {}, "available": False, "has_edr": has_edr, "source": "none"}

    # Extract from .edr via gmx energy
    try:
        gmx = session.agent._gmx
    except AttributeError:
        return {"data": {}, "available": False, "source": "error"}
    data = run_gmx_energy(session.work_dir, gmx, force=force)
    return {"data": _downsample(data, max_points), "available": bool(data), "source": "extracted"}


@router.get("/sessions/{session_id}/analysis/ramachandran")
async def get_ramachandran(session_id: str, force: bool = Query(default=False)):
    """Return phi/psi arrays loaded from cached .npy files (or trigger generation)."""
    session = _require_session(session_id)
    wd = Path(session.work_dir)
    phi_npy = wd / "analysis" / "phi.npy"
    psi_npy = wd / "analysis" / "psi.npy"
    if not force and phi_npy.exists() and psi_npy.exists():
        try:
            import numpy as np

            return {
                "data": {
                    "phi": np.load(str(phi_npy)).tolist(),
                    "psi": np.load(str(psi_npy)).tolist(),
                },
                "available": True,
            }
        except Exception:
            pass
    # Trigger full pipeline to extract + save .npy
    _, error = generate_ramachandran_png(session.work_dir, force=force)
    if error:
        return {"data": {}, "available": False, "error": error}
    try:
        import numpy as np

        return {
            "data": {
                "phi": np.load(str(phi_npy)).tolist(),
                "psi": np.load(str(psi_npy)).tolist(),
            },
            "available": True,
        }
    except Exception:
        return {"data": {}, "available": False}


@router.get("/sessions/{session_id}/analysis/ramachandran.png")
async def get_ramachandran_image(
    session_id: str,
    force: bool = Query(default=False),
    dpi: int = Query(default=120, ge=72, le=300),
    bins: int = Query(default=60, ge=20, le=150),
    cmap: str = Query(default="Blues"),
    log_scale: bool = Query(default=True),
    show_start: bool = Query(default=True),
):
    """Generate (or serve cached) Ramachandran plot PNG."""
    session = _require_session(session_id)
    plot_opts = dict(dpi=dpi, bins=bins, cmap=cmap, log_scale=log_scale, show_start=show_start)
    png_path, error = generate_ramachandran_png(session.work_dir, force=force, **plot_opts)
    if error:
        raise HTTPException(422, error)
    if not png_path or not Path(png_path).exists():
        raise HTTPException(404, "No trajectory data available to plot")
    return Response(content=Path(png_path).read_bytes(), media_type="image/png")


@router.get("/sessions/{session_id}/analysis/progress")
async def get_progress(session_id: str, filename: str = "simulation/md.log"):
    """Return latest simulation progress from GROMACS log."""
    session = _require_session(session_id)
    path = str(Path(session.work_dir) / filename)
    info = get_log_progress(path)
    return {"progress": info, "available": bool(info)}


@router.post("/sessions/{session_id}/analysis/custom-cv")
async def compute_custom_cv(session_id: str, req: CustomCVRequest):
    """Compute custom collective variables from trajectory."""
    session = _require_session(session_id)

    # Validate: 1-3 CVs, each with correct atom count
    if not (1 <= len(req.cvs) <= 3):
        raise HTTPException(400, "Must define 1-3 CVs")

    required_atoms = {"distance": 2, "angle": 3, "dihedral": 4}
    for cv in req.cvs:
        expected = required_atoms[cv.type]
        if len(cv.atoms) != expected:
            raise HTTPException(
                400, f"{cv.type} requires exactly {expected} atoms, got {len(cv.atoms)}"
            )
        if any(a < 1 for a in cv.atoms):
            raise HTTPException(400, "Atom indices must be >= 1 (1-based)")

    try:
        from web.backend.analysis_utils import compute_custom_cvs

        cvs_dicts = [{"type": cv.type, "atoms": cv.atoms, "label": cv.label} for cv in req.cvs]
        data = compute_custom_cvs(str(session.work_dir), cvs_dicts, force=req.force)
        return {"data": data, "available": True}
    except Exception as e:
        return {"data": {}, "available": False, "error": str(e)}


@router.get("/sessions/{session_id}/analysis/atoms")
async def get_atoms(session_id: str):
    """Return atom list from topology for interactive picking."""
    session = _require_session(session_id)
    try:
        from web.backend.analysis_utils import get_atom_list

        atoms = get_atom_list(str(session.work_dir))
        return {"atoms": atoms, "available": len(atoms) > 0}
    except Exception as e:
        return {"atoms": [], "available": False, "error": str(e)}


@router.get("/sessions/{session_id}/analysis/macro-cvs")
async def get_macro_cvs(session_id: str, macro: str = "all_ca_distance"):
    """Generate predefined macro CV definitions from the topology.

    macro values:
      - all_ca_distance: DISTANCE between every pair of Cα atoms
      - consecutive_ca_distance: DISTANCE between consecutive Cα atoms
      - backbone_torsion: TORSION for backbone φ/ψ angles
    """
    session = _require_session(session_id)
    try:
        from web.backend.analysis_utils import get_atom_list

        atoms = get_atom_list(str(session.work_dir))
    except Exception as e:
        raise HTTPException(500, f"Failed to load atom list: {e}")

    # Filter Cα atoms
    ca_atoms = [a for a in atoms if a["name"] == "CA"]

    if macro == "all_ca_distance":
        cvs = []
        idx = 1
        for i in range(len(ca_atoms)):
            for j in range(i + 1, len(ca_atoms)):
                a1, a2 = ca_atoms[i], ca_atoms[j]
                cvs.append(
                    {
                        "name": f"d_CA{a1['resSeq']}_{a2['resSeq']}",
                        "type": "DISTANCE",
                        "atoms": [a1["index"], a2["index"]],
                    }
                )
                idx += 1
        return {"cvs": cvs, "count": len(cvs)}

    elif macro == "consecutive_ca_distance":
        cvs = []
        for i in range(len(ca_atoms) - 1):
            a1, a2 = ca_atoms[i], ca_atoms[i + 1]
            cvs.append(
                {
                    "name": f"d_CA{a1['resSeq']}_{a2['resSeq']}",
                    "type": "DISTANCE",
                    "atoms": [a1["index"], a2["index"]],
                }
            )
        return {"cvs": cvs, "count": len(cvs)}

    elif macro == "backbone_torsion":
        # Build backbone atom map per residue: {resSeq: {C, N, CA, ...}}
        bb_names = {"N", "CA", "C"}
        residues: dict[int, dict[str, int]] = {}
        for a in atoms:
            if a["name"] in bb_names:
                residues.setdefault(a["resSeq"], {})[a["name"]] = a["index"]

        sorted_res = sorted(residues.keys())
        cvs = []

        for k in range(len(sorted_res)):
            res_i = sorted_res[k]
            r = residues[res_i]

            # φ (phi): C(i-1) - N(i) - CA(i) - C(i)
            if k > 0:
                prev = residues[sorted_res[k - 1]]
                if all(x in prev for x in ["C"]) and all(x in r for x in ["N", "CA", "C"]):
                    cvs.append(
                        {
                            "name": f"phi_{res_i}",
                            "type": "TORSION",
                            "atoms": [prev["C"], r["N"], r["CA"], r["C"]],
                        }
                    )

            # ψ (psi): N(i) - CA(i) - C(i) - N(i+1)
            if k < len(sorted_res) - 1:
                nxt = residues[sorted_res[k + 1]]
                if all(x in r for x in ["N", "CA", "C"]) and "N" in nxt:
                    cvs.append(
                        {
                            "name": f"psi_{res_i}",
                            "type": "TORSION",
                            "atoms": [r["N"], r["CA"], r["C"], nxt["N"]],
                        }
                    )

        return {"cvs": cvs, "count": len(cvs)}

    else:
        raise HTTPException(
            400,
            f"Unknown macro: {macro}. Use: all_ca_distance, consecutive_ca_distance, backbone_torsion",
        )
