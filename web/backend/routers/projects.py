"""Project endpoints: group simulations and hold CV-discovery state.

A *project* is the container introduced for CV discovery; a *simulation* is what
the rest of the API calls a *session* (``session_id`` is unchanged).  These
routes are additive — existing ``/sessions/*`` endpoints keep working.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from web.backend import cv_store, project_store

router = APIRouter()


# ── Projects ──────────────────────────────────────────────────────────


class CreateProjectRequest(BaseModel):
    name: str = ""
    username: str = ""
    description: str = ""
    molecule: str = ""
    system: str = ""
    goal: str = ""


class UpdateProjectRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    molecule: str | None = None
    system: str | None = None
    goal: str | None = None
    status: str | None = None


@router.post("/projects")
async def create_project_endpoint(req: CreateProjectRequest, request: Request):
    username = getattr(request.state, "username", "") or req.username
    project = project_store.create_project(
        name=req.name.strip() or "Untitled Project",
        username=username,
        description=req.description,
        molecule=req.molecule,
        system=req.system,
        goal=req.goal,
    )
    return {"project": project}


@router.get("/projects")
async def list_projects_endpoint(request: Request):
    username = getattr(request.state, "username", "") or ""
    return {"projects": project_store.list_projects(username)}


@router.get("/projects/{project_id}")
async def get_project_endpoint(project_id: str):
    project = project_store.get_project(project_id)
    if not project or project.get("status") == "deleted":
        raise HTTPException(404, "Project not found")
    return {"project": project}


@router.patch("/projects/{project_id}")
async def update_project_endpoint(project_id: str, req: UpdateProjectRequest):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not project_store.update_project(project_id, updates):
        raise HTTPException(404, "Project not found or no valid fields to update")
    return {"project": project_store.get_project(project_id)}


@router.delete("/projects/{project_id}")
async def delete_project_endpoint(project_id: str):
    if not project_store.delete_project(project_id):
        raise HTTPException(404, "Project not found")
    return {"deleted": project_id}


# ── Simulations within a project ──────────────────────────────────────


class AssignSimulationRequest(BaseModel):
    session_id: str


@router.get("/projects/{project_id}/simulations")
async def list_project_simulations_endpoint(project_id: str):
    if not project_store.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return {"simulations": project_store.list_project_simulations(project_id)}


@router.post("/projects/{project_id}/simulations")
async def assign_simulation_endpoint(project_id: str, req: AssignSimulationRequest):
    """Attach an existing simulation (session) to this project."""
    if not project_store.get_project(project_id):
        raise HTTPException(404, "Project not found")
    if not project_store.assign_simulation(req.session_id, project_id):
        raise HTTPException(404, "Simulation not found")
    return {"project_id": project_id, "session_id": req.session_id}


# ── CV candidates ─────────────────────────────────────────────────────


class CreateCVRequest(BaseModel):
    name: str = ""
    cv_type: str = ""
    definition: str = ""
    origin_sims: list[str] = []
    metrics: dict[str, Any] = {}
    score: float | None = None
    status: str = "candidate"


class UpdateCVRequest(BaseModel):
    name: str | None = None
    cv_type: str | None = None
    definition: str | None = None
    origin_sims: list[str] | None = None
    metrics: dict[str, Any] | None = None
    score: float | None = None
    status: str | None = None


@router.get("/projects/{project_id}/cvs")
async def list_cvs_endpoint(project_id: str):
    if not project_store.get_project(project_id):
        raise HTTPException(404, "Project not found")
    return {"cvs": cv_store.list_cvs(project_id)}


@router.post("/projects/{project_id}/cvs")
async def create_cv_endpoint(project_id: str, req: CreateCVRequest):
    if not project_store.get_project(project_id):
        raise HTTPException(404, "Project not found")
    cv = cv_store.create_cv(
        project_id=project_id,
        name=req.name,
        cv_type=req.cv_type,
        definition=req.definition,
        origin_sims=req.origin_sims,
        metrics=req.metrics,
        score=req.score,
        status=req.status,
    )
    project_store.touch_project(project_id)
    return {"cv": cv}


@router.patch("/projects/{project_id}/cvs/{cv_id}")
async def update_cv_endpoint(project_id: str, cv_id: str, req: UpdateCVRequest):
    existing = cv_store.get_cv(cv_id)
    if not existing or existing.get("project_id") != project_id:
        raise HTTPException(404, "CV candidate not found")
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    cv_store.update_cv(cv_id, updates)
    return {"cv": cv_store.get_cv(cv_id)}


@router.delete("/projects/{project_id}/cvs/{cv_id}")
async def delete_cv_endpoint(project_id: str, cv_id: str):
    existing = cv_store.get_cv(cv_id)
    if not existing or existing.get("project_id") != project_id:
        raise HTTPException(404, "CV candidate not found")
    cv_store.delete_cv(cv_id)
    return {"deleted": cv_id}


# ── CV discovery (heuristic v1) ───────────────────────────────────────


class ScoreCVRequest(BaseModel):
    session_id: str


@router.post("/projects/{project_id}/cv-discovery/propose")
async def propose_cvs_endpoint(project_id: str):
    """Propose candidate CVs for the project's system and persist them.

    Heuristic v1: curated CVs for known systems (e.g. alanine dipeptide → φ/ψ).
    """
    from md_agent.cv_discovery import propose_cvs

    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    hint = (project.get("system") or project.get("molecule") or "").strip()
    proposed = propose_cvs(system=hint)
    created = [
        cv_store.create_cv(
            project_id=project_id,
            name=cv["name"],
            cv_type=cv.get("type", ""),
            definition=json.dumps(cv),
            status="candidate",
        )
        for cv in proposed
    ]
    if created:
        project_store.touch_project(project_id)
    return {
        "proposed": created,
        "system": hint,
        "message": None if created else f"No heuristic CVs for system '{hint or 'unknown'}'.",
    }


@router.post("/projects/{project_id}/cvs/{cv_id}/score")
async def score_cv_endpoint(project_id: str, cv_id: str, req: ScoreCVRequest):
    """Score a CV candidate from a project simulation's COLVAR; store the metrics."""
    from md_agent.cv_discovery import read_colvar_column, score_cv
    from web.backend.db import get_session_indexed

    existing = cv_store.get_cv(cv_id)
    if not existing or existing.get("project_id") != project_id:
        raise HTTPException(404, "CV candidate not found")

    sess = get_session_indexed(req.session_id)
    if not sess or not sess.get("work_dir"):
        raise HTTPException(404, "Simulation not found")
    # Only score against a simulation that belongs to this project.
    if sess.get("project_id") != project_id:
        raise HTTPException(403, "Simulation is not part of this project")

    work_dir = Path(sess["work_dir"])
    colvar = next(
        (c for c in (work_dir / "simulation" / "COLVAR", work_dir / "COLVAR") if c.exists()),
        None,
    )
    if colvar is None:
        raise HTTPException(400, "No COLVAR file found for this simulation")

    values = read_colvar_column(str(colvar), existing["name"])
    metrics = score_cv(values)
    origin = list(dict.fromkeys([*existing.get("origin_sims", []), req.session_id]))
    cv_store.update_cv(
        cv_id, {"metrics": metrics, "score": metrics["score"], "origin_sims": origin}
    )
    return {"cv": cv_store.get_cv(cv_id), "metrics": metrics}
