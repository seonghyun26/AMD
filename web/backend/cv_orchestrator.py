"""CV-discovery orchestrator: drives propose → score → rank across a project.

This is the project-level "agent" that coordinates the deterministic CV core
(:mod:`md_agent.cv_discovery`), the persisted CV candidates
(:mod:`web.backend.cv_store`), and the project's simulations. It is import-light
and mostly pure, so the planning/scoring logic is unit-testable; launching a new
probe simulation is delegated to the existing web simulate flow and kept out of
this module.

One iteration:
  1. propose CVs for the project's system (persist any new ones),
  2. score every unscored candidate from any project simulation whose COLVAR
     contains that CV's column,
  3. return the ranked candidates plus which still need a simulation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from md_agent import cv_discovery
from web.backend import cv_store, project_store


def _find_colvar(work_dir: str) -> Path | None:
    wd = Path(work_dir or "")
    for cand in (wd / "simulation" / "COLVAR", wd / "COLVAR"):
        if cand.exists():
            return cand
    return None


def propose_for_project(project_id: str) -> list[dict[str, Any]]:
    """Propose CVs for the project's system; persist those not already present."""
    project = project_store.get_project(project_id)
    if not project:
        return []
    hint = (project.get("system") or project.get("molecule") or "").strip()
    existing = {c["name"] for c in cv_store.list_cvs(project_id)}
    created: list[dict[str, Any]] = []
    for cv in cv_discovery.propose_cvs(system=hint):
        if cv["name"] in existing:
            continue
        created.append(
            cv_store.create_cv(
                project_id=project_id,
                name=cv["name"],
                cv_type=cv.get("type", ""),
                definition=json.dumps(cv),
                status="candidate",
            )
        )
    return created


def score_candidates_from_sims(project_id: str) -> list[dict[str, Any]]:
    """Score every unscored candidate CV from any project sim that has its COLVAR column."""
    sims = project_store.list_project_simulations(project_id)
    updated: list[dict[str, Any]] = []
    for cv in cv_store.list_cvs(project_id):
        if cv.get("score") is not None:
            continue
        for sim in sims:
            colvar = _find_colvar(sim.get("work_dir", ""))
            if not colvar:
                continue
            values = cv_discovery.read_colvar_column(str(colvar), cv["name"])
            if not values:
                continue
            metrics = cv_discovery.score_cv(values)
            origin = list(dict.fromkeys([*cv.get("origin_sims", []), sim["session_id"]]))
            cv_store.update_cv(
                cv["cv_id"],
                {"metrics": metrics, "score": metrics["score"], "origin_sims": origin},
            )
            updated.append(cv_store.get_cv(cv["cv_id"]))
            break
    return updated


def run_iteration(project_id: str) -> dict[str, Any]:
    """Run one discovery iteration and return the ranked state + next-step plan."""
    proposed = propose_for_project(project_id)
    scored = score_candidates_from_sims(project_id)
    ranked = cv_discovery.rank_cvs(cv_store.list_cvs(project_id))
    needs_sim = [
        {"cv_id": c["cv_id"], "name": c["name"], "definition": c.get("definition", "")}
        for c in ranked
        if c.get("score") is None
    ]
    best = ranked[0] if ranked and ranked[0].get("score") is not None else None
    return {
        "proposed": proposed,
        "scored": scored,
        "ranked": ranked,
        "needs_simulation": needs_sim,
        "best": best,
    }
