"""Analysis endpoints: return plot-ready data for COLVAR, FES, energy, log."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from web.backend.analysis_utils import (
    colvar_to_columns,
    fes_dat_to_heatmap,
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
    try:
        gmx = session.agent._gmx
    except AttributeError:
        return {"data": {}, "available": False}
    data = run_gmx_energy(session.work_dir, gmx, force=force)
    return {"data": data, "available": bool(data)}


@router.get("/sessions/{session_id}/analysis/progress")
async def get_progress(session_id: str, filename: str = "md.log"):
    """Return latest simulation progress from GROMACS log."""
    session = _require_session(session_id)
    path = str(Path(session.work_dir) / filename)
    info = get_log_progress(path)
    return {"progress": info, "available": bool(info)}
