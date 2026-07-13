"""Direct simulation launcher — grompp + mdrun via Docker, no AI."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from omegaconf import OmegaConf

from web.backend.session_manager import get_or_restore_session

logger = logging.getLogger(__name__)

router = APIRouter()

# GPUs that must never be auto-selected.
# Set AMD_GPU_DENY_LIST env var as comma-separated indices (e.g. "0,1,2,3").
# Defaults to GPUs 0-3 which are reserved on this machine.
_GPU_DENY_LIST: set[str] = set(
    os.getenv("AMD_GPU_DENY_LIST", "0,1,2,3").split(",")
)


def _auto_detect_gpu() -> str | None:
    """Return the index of the first idle *allowed* GPU, or None."""
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if r.returncode != 0:
            return None
        for line in r.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2 and parts[0] not in _GPU_DENY_LIST and int(parts[1]) < 10:
                return parts[0]
    except Exception:
        pass
    return None


_COORD_EXTS = {".gro", ".pdb"}


def _persist_run_status(session: object, status: str) -> None:
    """Advance run_status via the single locked session.json + index write path.

    Enforces the FSM:
      standby  → running, failed
      running  → finished, failed, paused
      paused   → running (resume), standby (terminate)
      failed   → running
      finished → (terminal — no further transitions)

    Routing through ``session_store.mutate_session_json`` (fcntl-locked and
    index-synced) means the SQLite ``sessions`` index no longer drifts to a
    permanent ``standby``, and concurrent writers can't corrupt session.json.
    """
    from datetime import datetime

    from web.backend.session_store import mutate_session_json

    def _apply(meta: dict) -> dict | None:
        current = meta.get("run_status", "standby")
        if current == status:
            return None
        # `finished` is terminal for the *run*, but the user may re-run or reset:
        # allow finished→running (re-run) and finished→standby (terminate/reset).
        if current == "finished" and status not in ("running", "standby"):
            return None
        if current == "failed" and status != "running":
            return None
        if current == "paused" and status not in ("running", "standby"):
            return None

        meta["run_status"] = status
        if status == "running":
            if current != "paused":  # fresh start, not a resume
                meta["started_at"] = time.time()
            meta["finished_at"] = None  # explicit None so the index clears too
        elif status == "paused":
            meta["paused_at"] = time.time()
        elif status in ("finished", "failed"):
            meta.setdefault("finished_at", time.time())
        meta["updated_at"] = datetime.utcnow().isoformat()
        return meta

    try:
        mutate_session_json(session.session_id, _apply)  # type: ignore[attr-defined]
    except Exception:
        pass


_TOP_EXTS = {".top"}

# Subfolder within work_dir where mdrun writes its output files
_SIM_SUBDIR = "simulation"
# Subfolder where pre-existing GROMACS outputs are archived before each run
_ARCHIVE_SUBDIR = "archive"


def _archive_existing(work_dir: Path, *patterns: str) -> None:
    """Archiving disabled by request."""
    return None


def _remove_existing(work_dir: Path, *names: str) -> None:
    """Best-effort cleanup of derived files to avoid stale reuse across runs."""
    for name in names:
        p = work_dir / name
        if p.exists() and p.is_file():
            try:
                p.unlink()
            except Exception:
                pass


def _find_file(work_dir: Path, extensions: set[str], preferred: str = "") -> str | None:
    if preferred and (work_dir / preferred).exists():
        return preferred
    for f in sorted(work_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in extensions:
            return f.name
    return None


def _is_derived_coord(name: str) -> bool:
    n = (Path(name).name or "").lower()
    return (
        n.endswith("_system.gro")
        or n.endswith("_box.gro")
        or n.endswith("_solvated.gro")
        or n.endswith("_ionized.gro")
        or n in {"system.gro", "box.gro", "solvated.gro", "ionized.gro"}
    )


def _find_source_coord(work_dir: Path, preferred: str = "") -> str | None:
    """Find the original user-provided coordinate file (exclude derived intermediates)."""
    pref_name = Path(preferred).name if preferred else ""
    if pref_name and (work_dir / pref_name).exists() and not _is_derived_coord(pref_name):
        return pref_name
    if pref_name and _is_derived_coord(pref_name):
        # Recover the original source root from derived names like
        # "<root>_system.gro", "<root>_box.gro", "<root>_solvated.gro", "<root>_ionized.gro".
        n = pref_name
        for suffix in ("_system.gro", "_box.gro", "_solvated.gro", "_ionized.gro"):
            if n.lower().endswith(suffix):
                root = n[: -len(suffix)]
                # Prefer PDB as canonical source when both PDB/GRO exist.
                for ext in (".pdb", ".gro"):
                    cand = f"{root}{ext}"
                    if (work_dir / cand).exists() and not _is_derived_coord(cand):
                        return cand
                break
    for f in sorted(work_dir.iterdir()):
        if not f.is_file():
            continue
        if f.suffix.lower() not in _COORD_EXTS:
            continue
        if _is_derived_coord(f.name):
            continue
        return f.name
    return None


def _remove_matching(work_dir: Path, *patterns: str) -> None:
    for pattern in patterns:
        for p in work_dir.glob(pattern):
            if p.is_file():
                try:
                    p.unlink()
                except Exception:
                    pass


# ── Pre-production equilibration ───────────────────────────────────────
# Standard protocol before the production run: energy minimization, then
# (position-restrained) NVT and — for solvated systems — NPT. Overrides are
# applied on top of the session's gromacs config so cutoffs/electrostatics stay
# consistent across stages.
_EQUIL_NSTEPS = 50000  # 100 ps at dt=0.002 ps

_EM_OVERRIDES: dict[str, Any] = {
    "integrator": "steep",
    "nsteps": _EQUIL_NSTEPS,
    "emtol": 1000.0,
    "emstep": 0.01,
    "tcoupl": "no",
    "pcoupl": "no",
    "gen_vel": "no",
    "continuation": "no",
    "define": None,
}
_NVT_OVERRIDES: dict[str, Any] = {
    "integrator": "md",
    "nsteps": _EQUIL_NSTEPS,
    "pcoupl": "no",          # NVT: no barostat
    "gen_vel": "yes",        # assign initial velocities at ref_t
    "continuation": "no",
    "define": "-DPOSRES",    # restrain the solute
}
_NPT_OVERRIDES: dict[str, Any] = {
    "integrator": "md",
    "nsteps": _EQUIL_NSTEPS,
    "pcoupl": "C-rescale",   # gentle barostat for equilibration
    "gen_vel": "no",
    "continuation": "yes",   # continue velocities from NVT
    "define": "-DPOSRES",
}
# Production continues from the equilibrated state (velocities from the last cpt).
_PROD_OVERRIDES: dict[str, Any] = {"continuation": "yes", "gen_vel": "no"}

_EQUIL_STAGES = ("minimizing", "nvt", "npt")


def _set_stage(session: object, stage: str) -> None:
    """Record the current pipeline stage (in memory + session.json)."""
    try:
        if session.sim_status is None:  # type: ignore[attr-defined]
            session.sim_status = {}  # type: ignore[attr-defined]
        session.sim_status["stage"] = stage  # type: ignore[attr-defined]
    except Exception:
        pass
    try:
        from web.backend.session_store import mutate_session_json

        mutate_session_json(session.session_id, lambda m: {**m, "stage": stage})  # type: ignore[attr-defined]
    except Exception:
        pass


def _equilibrate_and_run(
    session: object,
    gmx: object,
    cfg: object,
    work_dir: Path,
    coord_file: str,
    top_file: str,
    index_file: str | None,
    gpu_id: str | None,
    plumed_file: str | None,
    water_model: str,
    expected_nsteps: int | None,
) -> None:
    """Run EM → NVT → [NPT] → production sequentially in a background thread.

    Each equilibration stage is a blocking grompp+mdrun; production is launched
    non-blocking (its handle becomes the live run). Any failure marks the session
    ``failed``. NPT is skipped for vacuum (no barostat)."""
    from md_agent.config.hydra_utils import generate_mdp_from_config

    def _grompp(mdp: str, coord: str, tpr: str, restraint: str | None = None, checkpoint: str | None = None) -> None:
        r = gmx.grompp(  # type: ignore[attr-defined]
            mdp_file=mdp,
            topology_file=top_file,
            coordinate_file=coord,
            output_tpr=tpr,
            index_file=index_file,
            restraint_file=restraint,
            checkpoint_file=checkpoint,
            max_warnings=5,
        )
        if not r.get("success"):
            raise RuntimeError(f"grompp {mdp} failed: {r.get('stderr', '')[-1200:]}")

    def _mdrun_blocking(tpr: str, deffnm: str) -> None:
        m = gmx.mdrun(tpr_file=tpr, output_prefix=deffnm, gpu_id=gpu_id)  # type: ignore[attr-defined]
        if m.get("error"):
            raise RuntimeError(m["error"])
        w = gmx.wait_mdrun()  # type: ignore[attr-defined]
        if not w.get("success"):
            raise RuntimeError(f"mdrun {deffnm} failed (rc={w.get('returncode')})")

    try:
        solvated = str(water_model).strip().lower() not in ("none", "vacuum", "")
        # Equilibration knob (configured from the GROMACS tab). Durations: EM in
        # max steps; NVT/NPT in ps (→ steps via dt).
        _eq = OmegaConf.select(cfg, "gromacs.equilibrate")
        equilibrate = True if _eq is None else bool(_eq)
        dt = float(OmegaConf.select(cfg, "gromacs.dt") or 0.002)
        em_steps = int(OmegaConf.select(cfg, "gromacs.equil_em_steps") or _EQUIL_NSTEPS)
        nvt_steps = max(1, int(float(OmegaConf.select(cfg, "gromacs.equil_nvt_ps") or 100.0) / dt))
        npt_steps = max(1, int(float(OmegaConf.select(cfg, "gromacs.equil_npt_ps") or 100.0) / dt))

        last_gro, last_cpt = coord_file, None
        if equilibrate:
            _set_stage(session, "minimizing")
            generate_mdp_from_config(cfg, str(work_dir / "em.mdp"), extra_params={**_EM_OVERRIDES, "nsteps": em_steps})
            _grompp("em.mdp", coord_file, "em.tpr")
            _mdrun_blocking("em.tpr", "em")
            last_gro, last_cpt = "em.gro", None

            _set_stage(session, "nvt")
            generate_mdp_from_config(cfg, str(work_dir / "nvt.mdp"), extra_params={**_NVT_OVERRIDES, "nsteps": nvt_steps})
            _grompp("nvt.mdp", last_gro, "nvt.tpr", restraint=last_gro, checkpoint=last_cpt)
            _mdrun_blocking("nvt.tpr", "nvt")
            last_gro, last_cpt = "nvt.gro", "nvt.cpt"

            if solvated:
                _set_stage(session, "npt")
                generate_mdp_from_config(cfg, str(work_dir / "npt.mdp"), extra_params={**_NPT_OVERRIDES, "nsteps": npt_steps})
                _grompp("npt.mdp", last_gro, "npt.tpr", restraint=last_gro, checkpoint=last_cpt)
                _mdrun_blocking("npt.tpr", "npt")
                last_gro, last_cpt = "npt.gro", "npt.cpt"

        # ── Production ──
        _set_stage(session, "production")
        # Continue from the equilibrated checkpoint; if equilibration was disabled,
        # start production fresh (assign velocities) from the built system.
        prod_overrides = _PROD_OVERRIDES if equilibrate else {"continuation": "no", "gen_vel": "yes"}
        generate_mdp_from_config(cfg, str(work_dir / "md.mdp"), extra_params=prod_overrides)
        sim_dir = work_dir / _SIM_SUBDIR
        if sim_dir.exists():
            shutil.rmtree(sim_dir)
        sim_dir.mkdir(exist_ok=True)
        output_prefix = f"{_SIM_SUBDIR}/md"
        _grompp("md.mdp", last_gro, "md.tpr", checkpoint=last_cpt)
        m = gmx.mdrun(  # type: ignore[attr-defined]
            tpr_file="md.tpr",
            output_prefix=output_prefix,
            gpu_id=gpu_id,
            plumed_file=plumed_file,
            extra_flags=["-cpt", "0.1"],
        )
        if m.get("error"):
            raise RuntimeError(m["error"])
        session.sim_status.update(  # type: ignore[attr-defined]
            {
                "status": "running",
                "output_prefix": output_prefix,
                "expected_nsteps": expected_nsteps,
                "pid": m["pid"],
                "gpu_id": gpu_id,
                "stage": "production",
            }
        )
        try:
            from web.backend.session_store import mutate_session_json

            mutate_session_json(
                session.session_id,  # type: ignore[attr-defined]
                lambda meta: {**meta, "pid": m["pid"], "gpu_id": gpu_id, "output_prefix": output_prefix, "stage": "production"},
            )
        except Exception:
            pass
    except Exception as exc:  # noqa: BLE001 — any stage failure ⇒ failed
        logger.error("Equilibration/production failed for %s: %s", getattr(session, "session_id", "?"), exc)
        _set_stage(session, "failed")
        _persist_run_status(session, "failed")


@router.post("/sessions/{session_id}/simulate")
async def start_simulation(session_id: str):
    """Generate MDP, run grompp, then launch mdrun in Docker — no AI involved.

    All GROMACS steps run with work_dir bind-mounted at /work inside the
    Docker container.  mdrun output files are written to work_dir/simulation/.

    Pipeline for solvated systems (water_model != "none"):
      pdb2gmx → editconf → solvate → grompp(ions) → genion → grompp → mdrun

    Pipeline for vacuum systems (water_model == "none"):
      pdb2gmx → editconf (cubic box) → grompp → mdrun

    Both pdb2gmx and the solvation steps are idempotent: they are re-run
    whenever their canonical output file is absent.  Pre-existing outputs are
    moved to work_dir/archive/ before each step so GROMACS never produces its
    own #filename.bak# backups.
    """
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    # Status is NOT set to "running" here — it is only set after mdrun actually starts.
    # Any preparation failure will set status to "failed" via the except block below.

    work_dir = Path(session.work_dir)
    cfg = session.agent.cfg
    gmx = session.agent._gmx

    forcefield = OmegaConf.select(cfg, "system.forcefield") or "amber99sb-ildn"
    water_model = OmegaConf.select(cfg, "system.water_model") or "none"
    box_clearance = float(OmegaConf.select(cfg, "gromacs.box_clearance") or 1.5)

    try:
        # 1. Generate md.mdp from current config
        from md_agent.config.hydra_utils import generate_mdp_from_config

        generate_mdp_from_config(cfg, str(work_dir / "md.mdp"))

        # 2. Find the raw input coordinate file (the original PDB/GRO the user uploaded)
        preferred_coord = OmegaConf.select(cfg, "system.coordinates") or ""
        # Exclude derived GROMACS outputs so preprocessing always starts from raw input.
        input_coord = _find_source_coord(work_dir, preferred_coord)
        if not input_coord:
            raise HTTPException(
                400, "No coordinate file (.gro or .pdb) found in session directory."
            )
        input_stem = Path(input_coord).stem
        system_gro = f"{input_stem}_system.gro"
        box_gro = f"{input_stem}_box.gro"
        solvated_gro = f"{input_stem}_solvated.gro"
        ionized_gro = f"{input_stem}_ionized.gro"

        # ── Step A: pdb2gmx ─────────────────────────────────────────────────
        # Always regenerate topology/processed coordinates from the selected raw input.
        # This avoids stale topol.top vs *.gro mismatches when users switch solvent/model.
        _archive_existing(work_dir, system_gro, "topol.top", "posre*.itp", "mdout.mdp")
        _remove_existing(work_dir, system_gro, "topol.top", "mdout.mdp")
        # Remove stale prefixed intermediates from prior runs with a different input file.
        _remove_matching(work_dir, "*_system.gro", "*_box.gro", "*_solvated.gro", "*_ionized.gro")

        def _run_pdb2gmx(ff: str) -> dict:
            return gmx.run_gmx_command(
                "pdb2gmx",
                [
                    "-f",
                    input_coord,
                    "-o",
                    system_gro,
                    "-p",
                    "topol.top",
                    "-ff",
                    ff,
                    "-water",
                    water_model,
                    "-ignh",
                ],
                work_dir=str(work_dir),
            )

        result = _run_pdb2gmx(forcefield)

        # Fall back to amber99sb-ildn if the chosen FF lacks the residue
        if result["returncode"] != 0:
            stderr = result.get("stderr", "")
            if (
                "not found in residue topology database" in stderr
                and forcefield != "amber99sb-ildn"
            ):
                result = _run_pdb2gmx("amber99sb-ildn")
                if result["returncode"] == 0:
                    from omegaconf import OmegaConf as _OC

                    _OC.update(cfg, "system.forcefield", "amber99sb-ildn", merge=True)
                    forcefield = "amber99sb-ildn"

        if result["returncode"] != 0:
            raise HTTPException(500, f"pdb2gmx failed:\n{result.get('stderr', '')[-2000:]}")
        top_file = "topol.top"

        # ── Step B: solvation + ionisation ─────────────────────────────────
        # Rebuild every run to keep coordinates/topology consistent after UI changes.
        if water_model != "none":
            if not (work_dir / system_gro).exists():
                raise HTTPException(
                    500,
                    f"{system_gro} not found — pdb2gmx must succeed before solvation.",
                )

            _archive_existing(work_dir, ionized_gro, solvated_gro, box_gro, "ions.tpr")
            _remove_existing(work_dir, ionized_gro, solvated_gro, box_gro, "ions.tpr", "mdout.mdp")

            # B1. Add simulation box using configured clearance
            box_type = str(OmegaConf.select(cfg, "gromacs.box_type") or "cubic")
            r = gmx.run_gmx_command(
                "editconf",
                [
                    "-f",
                    system_gro,
                    "-o",
                    box_gro,
                    "-c",
                    "-d",
                    str(box_clearance),
                    "-bt",
                    box_type,
                ],
                work_dir=str(work_dir),
            )
            if r["returncode"] != 0:
                raise HTTPException(500, f"editconf failed:\n{r.get('stderr', '')[-2000:]}")

            # B2. Fill with water
            r = gmx.run_gmx_command(
                "solvate",
                ["-cp", box_gro, "-cs", "spc216.gro", "-o", solvated_gro, "-p", "topol.top"],
                work_dir=str(work_dir),
            )
            if r["returncode"] != 0:
                raise HTTPException(500, f"solvate failed:\n{r.get('stderr', '')[-2000:]}")

            # B3. grompp → ions.tpr (net-charge warning expected; genion will fix it)
            r = gmx.grompp(
                mdp_file="md.mdp",
                topology_file="topol.top",
                coordinate_file=solvated_gro,
                output_tpr="ions.tpr",
                max_warnings=20,
            )
            if not r["success"]:
                raise HTTPException(500, f"grompp (ions) failed:\n{r.get('stderr', '')[-2000:]}")

            # B4. Replace water molecules with Na+/Cl- to neutralise
            r = gmx.run_gmx_command(
                "genion",
                [
                    "-s",
                    "ions.tpr",
                    "-o",
                    ionized_gro,
                    "-p",
                    "topol.top",
                    "-pname",
                    "NA",
                    "-nname",
                    "CL",
                    "-neutral",
                ],
                stdin_text="SOL\n",
                work_dir=str(work_dir),
            )
            if r["returncode"] != 0:
                raise HTTPException(500, f"genion failed:\n{r.get('stderr', '')[-2000:]}")

            coord_file = ionized_gro
            OmegaConf.update(cfg, "system.coordinates", ionized_gro, merge=True)
        else:
            # Vacuum: always rebuild <input>_box.gro from freshly generated <input>_system.gro.
            _archive_existing(work_dir, box_gro)
            _remove_existing(work_dir, box_gro)
            _src = system_gro if (work_dir / system_gro).exists() else input_coord
            r = gmx.run_gmx_command(
                "editconf",
                ["-f", _src, "-o", box_gro, "-c", "-d", str(box_clearance), "-bt", "cubic"],
                work_dir=str(work_dir),
            )
            if r["returncode"] != 0:
                raise HTTPException(
                    500, f"editconf (vacuum) failed:\n{r.get('stderr', '')[-2000:]}"
                )

            coord_file = box_gro

        # ── Step C: equilibrate, then run production (background) ──────────
        # Fresh Docker-backed mdrun handle per launch.
        try:
            gmx._cleanup()
        except Exception:
            pass
        _archive_existing(work_dir, "md.tpr", "mdout.mdp")
        index_file = OmegaConf.select(cfg, "system.index") or None
        has_index = bool(index_file and (work_dir / index_file).exists())
        gpu_id = OmegaConf.select(cfg, "gromacs.gpu_id") or None
        if not gpu_id:
            gpu_id = _auto_detect_gpu()
        method_name = OmegaConf.select(cfg, "method._target_name") or "md"
        plumed_methods = {
            "metadynamics", "metad", "opes",
            "umbrella", "umbrella_sampling", "steered", "steered_md",
        }
        plumed_file = (
            "plumed.dat"
            if method_name in plumed_methods and (work_dir / "plumed.dat").exists()
            else None
        )
        expected_nsteps = OmegaConf.select(cfg, "method.nsteps")

        # Mark the run live immediately; a background worker runs
        # EM → NVT → [NPT] → production and advances `stage` as it goes so the
        # HTTP request returns without blocking for the equilibration runs.
        _eq = OmegaConf.select(cfg, "gromacs.equilibrate")
        initial_stage = "production" if _eq is not None and not bool(_eq) else "minimizing"
        session.sim_status = {
            "status": "running",
            "started_at": time.time(),
            "output_prefix": f"{_SIM_SUBDIR}/md",
            "expected_nsteps": int(expected_nsteps) if expected_nsteps is not None else None,
            "gpu_id": gpu_id,
            "stage": initial_stage,
        }
        _persist_run_status(session, "running")

        threading.Thread(
            target=_equilibrate_and_run,
            args=(
                session, gmx, cfg, work_dir, coord_file, top_file,
                index_file if has_index else None, gpu_id, plumed_file,
                water_model, int(expected_nsteps) if expected_nsteps is not None else None,
            ),
            daemon=True,
        ).start()

        return {
            "status": "running" if initial_stage == "production" else "equilibrating",
            "stage": initial_stage,
        }

    except HTTPException:
        # Any preparation or launch failure transitions the session to "failed"
        _persist_run_status(session, "failed")
        raise


@router.get("/sessions/{session_id}/simulate/status")
async def simulation_status(session_id: str):
    """Check whether mdrun is currently running for this session."""
    from web.backend.session_manager import get_simulation_status

    result = get_simulation_status(session_id)
    terminal = result.get("status") if result.get("status") in {"finished", "failed"} else None
    if terminal:
        session = get_or_restore_session(session_id)
        if session:
            _persist_run_status(session, terminal)
    return result


@router.post("/sessions/{session_id}/simulate/stop")
async def stop_simulation(session_id: str):
    """Terminate a running mdrun process (pause — checkpoint preserved for resume).

    After SIGTERM GROMACS should flush a checkpoint file.  We verify it exists
    so the user knows whether resume is possible.
    """
    from web.backend.session_manager import stop_session_simulation

    stopped = stop_session_simulation(session_id)
    session = get_or_restore_session(session_id)
    has_checkpoint = False
    if session:
        # Only record "paused" if we actually stopped a live run — otherwise a
        # stop click on an already-finished/idle sim would mislabel it paused
        # (and a later resume would relaunch from an end-of-run checkpoint).
        if stopped:
            _persist_run_status(session, "paused")
        work_dir = Path(session.work_dir)
        cpt = work_dir / _SIM_SUBDIR / "md.cpt"
        has_checkpoint = cpt.exists()
    return {"stopped": stopped, "has_checkpoint": has_checkpoint}


@router.post("/sessions/{session_id}/simulate/terminate")
async def terminate_simulation(session_id: str):
    """Permanently stop a simulation — reset to standby, discard checkpoint intent."""
    from web.backend.session_manager import stop_session_simulation

    stop_session_simulation(session_id)
    session = get_or_restore_session(session_id)
    if session:
        session.sim_status = {}
        _persist_run_status(session, "standby")
    return {"terminated": True}


@router.get("/sessions/{session_id}/simulate/checkpoint-status")
async def checkpoint_status(session_id: str):
    """Check whether a checkpoint file exists for resume."""
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work_dir = Path(session.work_dir)
    cpt = work_dir / _SIM_SUBDIR / "md.cpt"
    return {"has_checkpoint": cpt.exists()}


@router.post("/sessions/{session_id}/simulate/resume")
async def resume_simulation(session_id: str):
    """Resume a paused simulation from the last checkpoint.

    Uses ``gmx mdrun -s md.tpr -cpi simulation/md.cpt -deffnm simulation/md -append``.
    The checkpoint file must exist from the previous run.
    """
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    work_dir = Path(session.work_dir)
    cfg = session.agent.cfg
    gmx = session.agent._gmx

    output_prefix = f"{_SIM_SUBDIR}/md"
    cpt_file = work_dir / f"{output_prefix}.cpt"

    if not cpt_file.exists():
        # Reset to standby so the user can start fresh
        _persist_run_status(session, "standby")
        return {
            "status": "no_checkpoint",
            "resumed": False,
            "message": "No checkpoint file found. The simulation ran too briefly to save a checkpoint. Please start a new simulation.",
        }

    tpr_file = "md.tpr"
    if not (work_dir / tpr_file).exists():
        raise HTTPException(400, "md.tpr not found — cannot resume.")

    try:
        # Clean up any stale process handle
        try:
            gmx._cleanup()
        except Exception:
            pass

        gpu_id = OmegaConf.select(cfg, "gromacs.gpu_id") or None
        if not gpu_id:
            gpu_id = _auto_detect_gpu()

        # Generate plumed.dat if needed (same as initial launch)
        method_name = OmegaConf.select(cfg, "method._target_name") or "plain_md"
        plumed_methods = {
            "metadynamics",
            "metad",
            "opes",
            "umbrella",
            "umbrella_sampling",
            "steered",
            "steered_md",
        }
        plumed_file = None
        if method_name in plumed_methods and (work_dir / "plumed.dat").exists():
            plumed_file = "plumed.dat"

        mdrun = gmx.mdrun(
            tpr_file=tpr_file,
            output_prefix=output_prefix,
            gpu_id=gpu_id,
            cpt_file=f"{output_prefix}.cpt",
            plumed_file=plumed_file,
            extra_flags=["-cpt", "1"],
        )

        expected_nsteps = OmegaConf.select(cfg, "method.nsteps")
        session.sim_status = {
            "status": "running",
            "started_at": session.sim_status.get("started_at", time.time())
            if session.sim_status
            else time.time(),
            "resumed_at": time.time(),
            "output_prefix": output_prefix,
            "expected_nsteps": int(expected_nsteps) if expected_nsteps is not None else None,
            "pid": mdrun["pid"],
            "gpu_id": gpu_id,
        }
        _persist_run_status(session, "running")

        return {
            "status": "running",
            "pid": mdrun["pid"],
            "resumed": True,
            "expected_files": mdrun["expected_files"],
        }

    except HTTPException:
        _persist_run_status(session, "failed")
        raise
    except Exception as exc:
        _persist_run_status(session, "failed")
        raise HTTPException(500, f"Resume failed: {exc}")
