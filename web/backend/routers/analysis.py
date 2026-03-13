"""Analysis endpoints: return plot-ready data for COLVAR, FES, energy, log."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

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


def _require_session(session_id: str):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


@router.get("/sessions/{session_id}/analysis/colvar")
async def get_colvar(session_id: str, filename: str = "COLVAR"):
    """Parse COLVAR and return column arrays for Plotly line/scatter charts."""
    session = _require_session(session_id)
    path = str(Path(session.work_dir) / filename)
    data = colvar_to_columns(path)
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
):
    """Run 'gmx energy' on simulation/md.edr → time series for Plotly.

    Results are cached as analysis/energy.xvg inside the session work_dir.
    Pass force=true to regenerate from the latest .edr data.
    """
    session = _require_session(session_id)
    wd = Path(session.work_dir)
    analysis_dir = wd / "analysis"

    # Fast path: serve from cached .npy files (no gmx runner needed)
    if not force:
        npy_data = _load_energy_npy(analysis_dir)
        if npy_data:
            return {"data": npy_data, "available": True}

    # Fallback: serve cached XVG without needing a gmx runner
    xvg_path = analysis_dir / "energy.xvg"
    if not force and xvg_path.exists() and xvg_path.stat().st_size > 0:
        data = _parse_xvg_with_header(str(xvg_path))
        if data:
            return {"data": data, "available": True}

    # Fall back to gmx energy extraction
    try:
        gmx = session.agent._gmx
    except AttributeError:
        return {"data": {}, "available": False}
    data = run_gmx_energy(session.work_dir, gmx, force=force)
    return {"data": data, "available": bool(data)}


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
