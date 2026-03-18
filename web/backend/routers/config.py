"""Config endpoints: list available options, update session config, generate MD files."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from omegaconf import OmegaConf
from pydantic import BaseModel

from web.backend.session_manager import _repo_conf_dir, get_or_restore_session, get_session

router = APIRouter()

_DATA_MOLECULES = Path(__file__).parents[4] / "data" / "molecule"
_MOL_EXTS = {".pdb", ".gro", ".mol2", ".xyz", ".sdf"}


@router.get("/config/options")
async def get_config_options():
    """Return available Hydra config group options."""
    conf_dir = Path(_repo_conf_dir())

    def list_group(subdir: str) -> list[str]:
        d = conf_dir / subdir
        if not d.is_dir():
            return []
        return [f.stem for f in sorted(d.glob("*.yaml"))]

    return {
        "methods": list_group("method"),
        "systems": list_group("system"),
        "gromacs": list_group("gromacs"),
        "plumed_cvs": list_group("plumed/collective_variables"),
    }


class ConfigUpdateRequest(BaseModel):
    updates: dict  # flat or nested dict of overrides


@router.post("/sessions/{session_id}/config")
async def update_session_config(session_id: str, req: ConfigUpdateRequest):
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    cfg = session.agent.cfg
    for key, value in req.updates.items():
        try:
            OmegaConf.update(cfg, key, value, merge=True)
        except Exception:
            # Key not in schema — force-add it (new fields like store_states, gpu_id, etc.)
            OmegaConf.update(cfg, key, value, merge=True, force_add=True)
    return {"updated": True, "config": OmegaConf.to_container(cfg, resolve=True)}


@router.get("/sessions/{session_id}/config")
async def get_session_config(session_id: str):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    cfg = session.agent.cfg
    return {"config": OmegaConf.to_container(cfg, resolve=True)}


@router.post("/sessions/{session_id}/generate-files")
async def generate_session_files(session_id: str):
    """Write md.mdp (and session.json metadata) from current config into work_dir."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    work_dir = Path(session.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    cfg = session.agent.cfg

    generated: list[str] = []

    # ── config.yaml — human-readable session config (session root) ───────
    try:
        session_root = work_dir.parent
        session_root.mkdir(parents=True, exist_ok=True)
        OmegaConf.save(cfg, session_root / "config.yaml")
        generated.append("../config.yaml")
        # Remove legacy config location inside data/ so it is not listed in web files.
        legacy_cfg = work_dir / "config.yaml"
        if legacy_cfg.exists():
            legacy_cfg.unlink()
    except Exception as exc:
        raise HTTPException(500, f"Config YAML write failed: {exc}")

    # ── md.mdp — GROMACS parameter file (converted from config) ──────────
    try:
        from md_agent.config.hydra_utils import generate_mdp_from_config

        mdp_path = str(work_dir / "md.mdp")
        generate_mdp_from_config(cfg, mdp_path)
        generated.append("md.mdp")
    except Exception as exc:
        raise HTTPException(500, f"MDP generation failed: {exc}")

    # ── session.json metadata (lives in session root, parent of data/) ───────
    session_root.mkdir(parents=True, exist_ok=True)
    meta_path = session_root / "session.json"
    try:
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    except Exception:
        meta = {}
    meta.update(
        {
            "session_id": session_id,
            "nickname": session.nickname,
            "work_dir": session.work_dir,
            "updated_at": datetime.utcnow().isoformat(),
        }
    )
    meta.setdefault("status", "active")
    try:
        meta_path.write_text(json.dumps(meta, indent=2))
    except Exception as exc:
        raise HTTPException(500, f"Failed to write session.json: {exc}")

    return {"generated": generated, "work_dir": str(work_dir)}


def _resolve_cvs(cfg) -> list[dict]:
    """Extract CVs from config, handling both OmegaConf and plain dicts."""
    cvs_raw = OmegaConf.select(cfg, "plumed.collective_variables.cvs")
    if not cvs_raw:
        return []
    try:
        return list(OmegaConf.to_container(cvs_raw, resolve=True))
    except Exception:
        return list(cvs_raw) if cvs_raw else []


def _build_plumed_content(cfg, cvs: list[dict], work_dir: str = "") -> str:
    """Build PLUMED .dat file content from config and CV definitions."""
    method_name = OmegaConf.select(cfg, "method._target_name") or "plain_md"
    colvar_stride = int(OmegaConf.select(cfg, "plumed.collective_variables.colvar_stride") or 100)
    colvar_file = str(OmegaConf.select(cfg, "plumed.collective_variables.colvar_file") or "COLVAR")

    lines: list[str] = []
    lines.append("# PLUMED input — generated by AMD web UI")
    lines.append("")

    # ── CV definitions ──
    lines.append("# Collective Variables")
    cv_names = []
    for cv in cvs:
        name = cv.get("name", "cv")
        cv_type = cv.get("type", "DISTANCE")
        cv_names.append(name)
        atoms = cv.get("atoms", [])
        if cv_type in ("DISTANCE", "TORSION", "ANGLE"):
            atoms_str = ",".join(str(a) for a in atoms)
            lines.append(f"{name}: {cv_type} ATOMS={atoms_str}")
        elif cv_type == "RMSD":
            ref = cv.get("reference", "reference.pdb")
            rtype = cv.get("rmsd_type", "OPTIMAL")
            lines.append(f"{name}: RMSD REFERENCE={ref} TYPE={rtype}")
        elif cv_type == "COORDINATION":
            ga = ",".join(str(a) for a in cv.get("groupa", []))
            gb = ",".join(str(a) for a in cv.get("groupb", []))
            r0 = cv.get("r0", 0.5)
            lines.append(f"{name}: COORDINATION GROUPA={ga} GROUPB={gb} R_0={r0}")
        else:
            atoms_str = ",".join(str(a) for a in atoms) if atoms else ""
            extra = f" ATOMS={atoms_str}" if atoms_str else ""
            lines.append(f"{name}: {cv_type}{extra}")
    lines.append("")

    # ── MLCV checkpoint (PyTorch model) ──
    mlcv_checkpoint = str(
        OmegaConf.select(cfg, "plumed.collective_variables.mlcv_checkpoint") or ""
    )
    mlcv_n_outputs = OmegaConf.select(cfg, "plumed.collective_variables.mlcv_n_outputs")
    raw_arg_str = ",".join(cv_names)
    if mlcv_checkpoint:
        out_count = int(mlcv_n_outputs) if mlcv_n_outputs else None

        # If n_outputs not stored, probe the model directly
        if out_count is None:
            try:
                import torch

                ckpt_path = str(Path(work_dir) / mlcv_checkpoint) if work_dir else mlcv_checkpoint
                model = torch.jit.load(ckpt_path, map_location="cpu")
                model.eval()
                # Parameter inspection: last 2D weight's shape[0] = output dim
                last_w = None
                for p in model.parameters():
                    if p.dim() == 2:
                        last_w = p
                if last_w is not None:
                    out_count = int(last_w.shape[0])
            except Exception:
                pass

        # Final fallback: assume 1 output (most common for MLCV)
        if not out_count or out_count <= 0:
            out_count = 1

        lines.append("# ML Collective Variable (PyTorch / TorchScript)")
        lines.append(f"# Model: {mlcv_checkpoint}  ({len(cv_names)} inputs → {out_count} outputs)")
        lines.append(f"mlcv: PYTORCH_MODEL FILE={mlcv_checkpoint} ARG={raw_arg_str}")
        ml_cv_names = [f"mlcv.node-{i}" for i in range(out_count)]
        arg_str = ",".join(ml_cv_names)
        print_arg_str = raw_arg_str + "," + arg_str
    else:
        arg_str = ",".join(cv_names)
        print_arg_str = arg_str
    lines.append("")

    # ── Method-specific bias ──
    # Count the number of bias arguments (needed for SIGMA matching)
    n_bias_args = len(arg_str.split(",")) if arg_str else 0

    if method_name in ("metadynamics", "metad"):
        height = float(OmegaConf.select(cfg, "method.hills.height") or 1.2)
        sigma_raw = OmegaConf.select(cfg, "method.hills.sigma") or [0.35]
        try:
            sigma_list = list(OmegaConf.to_container(sigma_raw, resolve=True))
        except Exception:
            sigma_list = list(sigma_raw) if not isinstance(sigma_raw, (int, float)) else [sigma_raw]
        # Ensure SIGMA count matches ARG count
        if len(sigma_list) != n_bias_args and n_bias_args > 0:
            base_sigma = sigma_list[0] if sigma_list else 0.35
            sigma_list = [base_sigma] * n_bias_args
        sigma_str = ",".join(str(s) for s in sigma_list)
        pace = int(OmegaConf.select(cfg, "method.hills.pace") or 500)
        biasfactor = OmegaConf.select(cfg, "method.hills.biasfactor")
        temperature = float(
            OmegaConf.select(cfg, "method.temperature")
            or OmegaConf.select(cfg, "gromacs.temperature")
            or 300
        )
        hills_file = str(OmegaConf.select(cfg, "method.hills.hills_file") or "HILLS")

        lines.append("# Metadynamics Bias")
        lines.append("METAD ...")
        lines.append(f"  ARG={arg_str}")
        lines.append(f"  HEIGHT={height}")
        lines.append(f"  SIGMA={sigma_str}")
        lines.append(f"  PACE={pace}")
        lines.append(f"  FILE={hills_file}")
        if biasfactor is not None:
            lines.append(f"  BIASFACTOR={float(biasfactor)}")
            lines.append(f"  TEMP={temperature}")
        lines.append("  LABEL=metad")
        lines.append("... METAD")
        lines.append("")
        lines.append(
            f"PRINT STRIDE={colvar_stride} ARG={print_arg_str},metad.bias FILE={colvar_file}"
        )

    elif method_name == "opes":
        pace = int(OmegaConf.select(cfg, "method.pace") or 500)
        sigma_val = float(OmegaConf.select(cfg, "method.sigma") or 0.05)
        # SIGMA must have one value per ARG
        sigma_str = ",".join([str(sigma_val)] * n_bias_args) if n_bias_args > 1 else str(sigma_val)
        barrier = float(OmegaConf.select(cfg, "method.barrier") or 30)
        temperature = float(
            OmegaConf.select(cfg, "method.temperature")
            or OmegaConf.select(cfg, "gromacs.temperature")
            or 340
        )

        kernels_file = str(OmegaConf.select(cfg, "method.kernels_file") or "KERNELS")
        state_wfile = str(OmegaConf.select(cfg, "method.state_wfile") or "STATE")
        state_wstride = int(OmegaConf.select(cfg, "method.state_wstride") or pace * 1000)
        store_states = OmegaConf.select(cfg, "method.store_states")
        if store_states is None:
            store_states = True

        lines.append("# OPES Metadynamics Bias")
        lines.append("opes: OPES_METAD ...")
        lines.append(f"  ARG={arg_str}")
        lines.append(f"  PACE={pace}")
        lines.append(f"  SIGMA={sigma_str}")
        lines.append(f"  BARRIER={barrier}")
        lines.append(f"  TEMP={temperature}")
        lines.append(f"  FILE={kernels_file}")
        lines.append(f"  STATE_WFILE={state_wfile}")
        lines.append(f"  STATE_WSTRIDE={state_wstride}")
        if store_states:
            lines.append("  STORE_STATES")
        lines.append("... OPES_METAD")
        lines.append("")
        lines.append(
            f"PRINT STRIDE={colvar_stride} ARG={print_arg_str},opes.bias FILE={colvar_file}"
        )

    elif method_name in ("umbrella", "umbrella_sampling"):
        window_center = float(OmegaConf.select(cfg, "method.window_start") or 0.0)
        force_constant = float(OmegaConf.select(cfg, "method.force_constant") or 1000)
        cv_name = cv_names[0] if cv_names else "cv1"

        lines.append("# Umbrella Sampling — Harmonic Restraint")
        lines.append(
            f"restraint: RESTRAINT ARG={cv_name} AT={window_center} KAPPA={force_constant}"
        )
        lines.append("")
        lines.append(
            f"PRINT STRIDE={colvar_stride} ARG={cv_name},restraint.bias FILE={colvar_file}"
        )

    elif method_name in ("steered", "steered_md"):
        initial = float(OmegaConf.select(cfg, "method.initial_value") or 0)
        final = float(OmegaConf.select(cfg, "method.final_value") or 4.0)
        force_constant = float(OmegaConf.select(cfg, "method.force_constant") or 500)
        nsteps = int(OmegaConf.select(cfg, "method.nsteps") or 5000000)
        cv_name = cv_names[0] if cv_names else "cv1"

        lines.append("# Steered MD — Moving Restraint")
        lines.append("MOVINGRESTRAINT ...")
        lines.append(f"  ARG={cv_name}")
        lines.append(f"  AT0={initial} STEP0=0")
        lines.append(f"  AT1={final} STEP1={nsteps}")
        lines.append(f"  KAPPA0={force_constant}")
        lines.append("  LABEL=smd")
        lines.append("... MOVINGRESTRAINT")
        lines.append("")
        lines.append(
            f"PRINT STRIDE={colvar_stride} ARG={cv_name},smd.bias,smd.force2 FILE={colvar_file}"
        )

    lines.append(f"FLUSH STRIDE={colvar_stride * 10}")
    lines.append("")
    return "\n".join(lines)


@router.get("/sessions/{session_id}/plumed-preview")
async def plumed_preview(session_id: str):
    """Generate PLUMED .dat content from current session config (does not write to disk)."""
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    cfg = session.agent.cfg
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
    if method_name not in plumed_methods:
        return {
            "content": None,
            "method": method_name,
            "message": "No PLUMED file needed for this method.",
        }

    cvs = _resolve_cvs(cfg)
    if not cvs:
        return {
            "content": None,
            "method": method_name,
            "message": "No collective variables defined.",
        }

    try:
        content = _build_plumed_content(cfg, cvs, work_dir=str(session.work_dir))
        return {"content": content, "method": method_name}
    except Exception as exc:
        return {"content": None, "method": method_name, "message": str(exc)}


@router.post("/sessions/{session_id}/plumed-generate")
async def plumed_generate(session_id: str):
    """Generate and write plumed.dat into the session work_dir."""
    preview = await plumed_preview(session_id)
    if not preview.get("content"):
        raise HTTPException(400, preview.get("message", "Cannot generate PLUMED file"))

    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    work_dir = Path(session.work_dir)
    plumed_path = work_dir / "plumed.dat"
    plumed_path.write_text(preview["content"])

    return {"generated": "plumed.dat", "work_dir": str(work_dir)}


@router.post("/sessions/{session_id}/validate-checkpoint")
async def validate_checkpoint(session_id: str, filename: str):
    """Validate a PyTorch checkpoint file for use with PLUMED PYTORCH_MODEL.

    Checks:
    1. File is a TorchScript (JIT) model (required by PLUMED)
    2. Input/output dimensions via a dummy forward pass
    """
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    work_dir = Path(session.work_dir)
    ckpt_path = work_dir / filename
    if not ckpt_path.exists():
        return {
            "valid": False,
            "is_jit": False,
            "error": f"File not found: {filename}",
        }

    # Try to import torch for full validation
    torch = None
    try:
        import torch as _torch

        torch = _torch
    except Exception:
        pass

    if torch is None:
        # PyTorch not available — allow selection but skip JIT/dimension checks
        size_mb = ckpt_path.stat().st_size / (1024 * 1024)
        return {
            "valid": True,
            "is_jit": None,
            "n_inputs": None,
            "n_outputs": None,
            "error": f"PyTorch not available — skipped JIT validation. "
            f"Ensure the server runs in the correct conda environment (e.g. 'conda activate amd'). "
            f"File size: {size_mb:.1f} MB.",
        }

    # ── Full validation with torch ──
    # Attempt to load as TorchScript
    try:
        model = torch.jit.load(str(ckpt_path), map_location="cpu")
        model.eval()
    except Exception as e:
        err_msg = str(e)
        # Not a JIT model — try loading as a state_dict for a helpful message
        try:
            state = torch.load(str(ckpt_path), map_location="cpu", weights_only=True)
            if isinstance(state, dict):
                return {
                    "valid": False,
                    "is_jit": False,
                    "n_inputs": None,
                    "n_outputs": None,
                    "error": "File is a state_dict, not a TorchScript model. "
                    "PLUMED requires a JIT-traced/scripted model. "
                    "Re-export with: torch.jit.save(torch.jit.trace(model, dummy_input), path)",
                    "keys": list(state.keys())[:10],
                }
        except Exception:
            pass
        return {
            "valid": False,
            "is_jit": False,
            "n_inputs": None,
            "n_outputs": None,
            "error": f"Cannot load as TorchScript: {err_msg}",
        }

    # ── Determine input/output dimensions ──
    n_inputs = None
    n_outputs = None
    probe_error = None

    # Method 1: Inspect the TorchScript graph for parameter shapes
    try:
        params = list(model.parameters())
        if params:
            first_param = params[0]
            # First layer weight shape is (out_features, in_features) for Linear
            if first_param.dim() == 2:
                n_inputs = first_param.shape[1]
            last_param_w = None
            for p in params:
                if p.dim() == 2:
                    last_param_w = p
            if last_param_w is not None:
                n_outputs = last_param_w.shape[0]
    except Exception:
        pass

    # Method 2: If graph inspection didn't work, probe with a forward pass
    if n_inputs is None or n_outputs is None:
        # Try a range of input dimensions — include up to 128 for large CV sets
        for dim in list(range(1, 129)):
            try:
                dummy = torch.zeros(1, dim)
                with torch.no_grad():
                    out = model(dummy)
                n_inputs = dim
                n_outputs = out.shape[-1] if out.dim() > 1 else 1
                break
            except Exception:
                continue

    # Method 3: Verify output dim with actual input dim if we found n_inputs
    if n_inputs is not None and n_outputs is None:
        try:
            dummy = torch.zeros(1, n_inputs)
            with torch.no_grad():
                out = model(dummy)
            n_outputs = out.shape[-1] if out.dim() > 1 else 1
        except Exception as e:
            probe_error = f"Found {n_inputs} inputs but could not determine outputs: {e}"

    if n_inputs is None:
        probe_error = "Could not determine model input/output dimensions."

    return {
        "valid": True,
        "is_jit": True,
        "n_inputs": n_inputs,
        "n_outputs": n_outputs,
        "error": probe_error,
    }


# ── Molecule library ───────────────────────────────────────────────────


@router.get("/molecules")
async def get_molecules():
    """Scan data/molecule/ and return available systems with their conformational states."""
    systems = []
    if _DATA_MOLECULES.is_dir():
        for system_dir in sorted(_DATA_MOLECULES.iterdir()):
            if not system_dir.is_dir():
                continue
            states = []
            for f in sorted(system_dir.iterdir()):
                if f.is_file() and f.suffix.lower() in _MOL_EXTS:
                    states.append({"name": f.stem, "file": f.name})
            if states:
                label = system_dir.name.replace("_", " ").title()
                systems.append({"id": system_dir.name, "label": label, "states": states})
    return {"systems": systems}


class LoadMoleculeRequest(BaseModel):
    system: str
    state: str


@router.post("/sessions/{session_id}/molecules/load")
async def load_molecule(session_id: str, req: LoadMoleculeRequest):
    """Copy a specific molecule state file from the data library into the session work_dir."""
    import shutil

    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    src_dir = _DATA_MOLECULES / req.system
    if not src_dir.is_dir():
        raise HTTPException(404, f"System {req.system!r} not found in molecule library")

    src_file = next(
        (
            f
            for f in src_dir.iterdir()
            if f.is_file() and f.suffix.lower() in _MOL_EXTS and f.stem == req.state
        ),
        None,
    )
    if src_file is None:
        raise HTTPException(404, f"State {req.state!r} not found in system {req.system!r}")

    dest = Path(session.work_dir) / src_file.name
    shutil.copy2(src_file, dest)
    return {"loaded": src_file.name, "work_dir": session.work_dir}
