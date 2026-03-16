"""Analysis helpers for plot endpoints. Reuses md_agent parsers."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

from md_agent.utils.parsers import (
    parse_colvar_file,
    parse_gromacs_log_progress,
)

# ── gmx energy helpers ────────────────────────────────────────────────

# Terms to extract — keywords matched case-insensitively after normalising
# hyphens→spaces and stripping trailing dots (handles both "Kinetic-En." and "Kinetic En.")
_GMX_ENERGY_TERMS = ["Potential", "Kinetic En", "Total Energy", "Temperature", "Pressure"]


def _norm(s: str) -> str:
    """Normalise a GROMACS term name for fuzzy matching."""
    return s.lower().replace("-", " ").rstrip(". ")


def _parse_energy_term_indices(output: str, desired: list[str]) -> list[int]:
    """Parse 'gmx energy' stderr/stdout to map desired term names → numeric indices."""
    # Find the dashes separator that precedes the term listing
    dash_pos = output.find("---")
    section = output[dash_pos:] if dash_pos != -1 else output

    # Each entry: "  11  Kinetic-En." padded to fixed column width.
    pairs = re.findall(r"\b(\d+)\s{2,}([A-Za-z][\w\s\.\-\(\)]{0,20}?)(?=\s{2,}|\s*\n|\s*$)", section)
    # Build map of normalised_name → index
    term_map: dict[str, int] = {
        _norm(name.strip()): int(num)
        for num, name in pairs if name.strip()
    }

    indices: list[int] = []
    seen: set[int] = set()
    for want in desired:
        wn = _norm(want)
        for name_norm, idx in term_map.items():
            if idx in seen:
                continue
            # Match if either is a prefix of the other after normalisation
            if name_norm == wn or name_norm.startswith(wn) or wn.startswith(name_norm):
                indices.append(idx)
                seen.add(idx)
                break
    return indices


def _parse_xvg_with_header(xvg_path: str) -> dict[str, list]:
    """Parse a GROMACS XVG file (xmgrace format) into {time_ps: [...], term: [...], ...}."""
    path = Path(xvg_path)
    if not path.exists():
        return {}

    legends: dict[int, str] = {}
    time_col: list[float] = []
    value_cols: dict[int, list[float]] = {}

    with open(path) as fh:
        for line in fh:
            stripped = line.strip()
            # Legend: @ s0 legend "Potential"
            m = re.match(r'^@\s+s(\d+)\s+legend\s+"([^"]*)"', stripped)
            if m:
                legends[int(m.group(1))] = m.group(2)
                continue
            if stripped.startswith(("#", "@", "&")):
                continue
            parts = stripped.split()
            if len(parts) < 2:
                continue
            try:
                t = float(parts[0])
                time_col.append(t)
                for i, vs in enumerate(parts[1:]):
                    value_cols.setdefault(i, []).append(float(vs))
            except ValueError:
                continue

    if not time_col:
        return {}

    result: dict[str, list] = {"time_ps": time_col}
    for i, col in sorted(value_cols.items()):
        result[legends.get(i, f"col{i}")] = col
    return result


def _save_energy_npy(data: dict[str, list], analysis_dir: Path) -> None:
    """Save each energy term as a separate .npy file for fast cached loading."""
    try:
        import numpy as np
        analysis_dir.mkdir(parents=True, exist_ok=True)
        for key, values in data.items():
            safe_name = key.lower().replace(" ", "_").replace("-", "_").replace(".", "")
            np.save(str(analysis_dir / f"energy_{safe_name}.npy"), np.array(values, dtype=np.float64))
        # Save column names so we can reconstruct the dict
        (analysis_dir / "energy_columns.json").write_text(
            json.dumps(list(data.keys()), indent=2)
        )
    except Exception as exc:
        log.warning("Failed to save energy .npy cache: %s", exc)


def _load_energy_npy(analysis_dir: Path) -> dict[str, list] | None:
    """Load energy data from cached .npy files. Returns None if cache is missing."""
    cols_path = analysis_dir / "energy_columns.json"
    if not cols_path.exists():
        return None
    try:
        import numpy as np
        columns = json.loads(cols_path.read_text())
        data: dict[str, list] = {}
        for key in columns:
            safe_name = key.lower().replace(" ", "_").replace("-", "_").replace(".", "")
            npy_path = analysis_dir / f"energy_{safe_name}.npy"
            if not npy_path.exists():
                return None
            data[key] = np.load(str(npy_path)).tolist()
        return data if data else None
    except Exception:
        return None


def run_gmx_energy(
    work_dir: str,
    gmx_runner: Any,
    edr_rel: str = "simulation/md.edr",
    xvg_rel: str = "analysis/energy.xvg",
    force: bool = False,
) -> dict[str, list]:
    """Run 'gmx energy' to extract timeseries from .edr, caching as .npy + .xvg.

    Returns parsed {time_ps, term_name, ...} dict or {} on failure.
    Check order: .npy cache → .xvg cache → run gmx energy.
    """
    wd = Path(work_dir)
    edr_path = wd / edr_rel
    xvg_path = wd / xvg_rel
    analysis_dir = wd / "analysis"

    if not edr_path.exists():
        return {}

    # Fast path: load from cached .npy files
    if not force:
        npy_data = _load_energy_npy(analysis_dir)
        if npy_data:
            return npy_data

    # Fallback: return cached XVG when available
    if not force and xvg_path.exists() and xvg_path.stat().st_size > 0:
        data = _parse_xvg_with_header(str(xvg_path))
        if data:
            _save_energy_npy(data, analysis_dir)
            return data

    # Create analysis dir on host before any Docker call (Docker bind-mounts the host dir)
    xvg_path.parent.mkdir(parents=True, exist_ok=True)

    # Step 1: probe — send "0\n" so gmx energy exits after printing the full term list.
    # rc=1 is expected (no terms were selected); we only need the stderr output.
    probe = gmx_runner.run_gmx_command(
        "energy",
        ["-f", edr_rel, "-o", "analysis/.probe.xvg"],
        stdin_text="0\n",
        work_dir=str(wd),
    )
    (wd / "analysis" / ".probe.xvg").unlink(missing_ok=True)

    probe_output = probe.get("stderr", "") + probe.get("stdout", "")
    indices = _parse_energy_term_indices(probe_output, _GMX_ENERGY_TERMS)
    if not indices:
        return {}

    # Step 2: extract the selected terms into the XVG file.
    # Space-separated indices on one line followed by 0 (matches gmx energy interactive input).
    stdin = " ".join(str(i) for i in indices) + " 0\n"
    gmx_runner.run_gmx_command(
        "energy",
        ["-f", edr_rel, "-o", xvg_rel, "-xvg", "xmgrace"],
        stdin_text=stdin,
        work_dir=str(wd),
    )

    # Parse whatever was written — don't gate on return code (varies by gmx version)
    if not xvg_path.exists() or xvg_path.stat().st_size == 0:
        return {}

    data = _parse_xvg_with_header(str(xvg_path))
    if data:
        _save_energy_npy(data, analysis_dir)
    return data


def colvar_to_columns(colvar_path: str) -> dict[str, list[float]]:
    """Parse COLVAR file and transpose rows → column arrays for Plotly."""
    rows = parse_colvar_file(colvar_path)
    if not rows:
        return {}
    keys = list(rows[0].keys())
    return {k: [r[k] for r in rows] for k in keys}


def fes_dat_to_heatmap(fes_path: str) -> dict[str, Any]:
    """Parse plumed sum_hills fes.dat into {x, y, z} for Plotly heatmap.

    fes.dat format (2D):
        # phi psi file.bias
        -3.14  -3.14  12.5
        -3.14  -3.08  11.2
        ...
        (blank line between phi blocks)

    Returns {"x": [...unique phi...], "y": [...unique psi...], "z": [[...]]}
    """
    if not Path(fes_path).exists():
        return {}

    x_vals: list[float] = []
    y_vals: list[float] = []
    z_vals: list[float] = []

    with open(fes_path) as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            if len(parts) >= 3:
                try:
                    x_vals.append(float(parts[0]))
                    y_vals.append(float(parts[1]))
                    z_vals.append(float(parts[2]))
                except ValueError:
                    pass

    if not x_vals:
        return {}

    # Build unique sorted axis values
    unique_x = sorted(set(x_vals))
    unique_y = sorted(set(y_vals))

    # Build 2D z matrix: z[i_y][i_x]
    x_idx = {v: i for i, v in enumerate(unique_x)}
    y_idx = {v: i for i, v in enumerate(unique_y)}
    z_matrix = [[math.nan] * len(unique_x) for _ in range(len(unique_y))]
    for xi, yi, zi in zip(x_vals, y_vals, z_vals):
        ix = x_idx.get(xi)
        iy = y_idx.get(yi)
        if ix is not None and iy is not None:
            z_matrix[iy][ix] = zi

    return {"x": unique_x, "y": unique_y, "z": z_matrix}


def _load_trajectory(wd: Path):
    """Load trajectory from work_dir, trying topology candidates.
    Returns mdtraj.Trajectory or raises RuntimeError."""
    import mdtraj

    xtc_path = wd / "simulation" / "md.xtc"
    if not xtc_path.exists():
        raise RuntimeError("No trajectory file found")

    top_candidates: list[Path] = []
    tpr = wd / "md.tpr"
    if tpr.exists():
        top_candidates.append(tpr)
    top_candidates.extend(wd.glob("*_system.gro"))
    top_candidates.extend(p for p in wd.glob("*.gro") if p not in top_candidates)
    top_candidates.extend(p for p in wd.glob("*.pdb") if p not in top_candidates)

    for top in top_candidates:
        try:
            return mdtraj.load(str(xtc_path), top=str(top))
        except Exception:
            continue
    raise RuntimeError("Could not load trajectory with any topology candidate")


def generate_ramachandran_png(
    work_dir: str,
    force: bool = False,
    *,
    dpi: int = 120,
    bins: int = 60,
    cmap: str = "Blues",
    log_scale: bool = True,
    show_start: bool = True,
) -> tuple[str | None, str | None]:
    """Generate a Ramachandran plot PNG.

    Pipeline:
      1. Return cached PNG if it exists (unless force=True).
      2. Load cached phi/psi from analysis/phi.npy + psi.npy if available.
      3. Extract from trajectory via mdtraj; save phi.npy/psi.npy.
         Falls back to COLVAR phi/psi columns if mdtraj fails.
      4. Render PNG with matplotlib.

    Returns (png_path, error_message). Exactly one will be non-None.
    """
    import numpy as np  # type: ignore[import]

    wd = Path(work_dir)
    analysis_dir = wd / "analysis"
    png_path = analysis_dir / "ramachandran.png"
    phi_npy = analysis_dir / "phi.npy"
    psi_npy = analysis_dir / "psi.npy"

    # ── Step 1: cached PNG ────────────────────────────────────────────
    if not force and png_path.exists() and png_path.stat().st_size > 0:
        log.info("ramachandran: serving cached PNG %s", png_path)
        return str(png_path), None

    # ── Step 2: cached .npy arrays (always use if available) ──────────
    phi_arr = psi_arr = None
    if phi_npy.exists() and psi_npy.exists():
        try:
            phi_arr = np.load(str(phi_npy))
            psi_arr = np.load(str(psi_npy))
            log.info("ramachandran: loaded cached phi/psi arrays (%d frames)", len(phi_arr))
        except Exception as e:
            log.warning("ramachandran: could not load cached .npy files — %s", e)
            phi_arr = psi_arr = None

    # ── Step 3a: extract from trajectory via mdtraj ───────────────────
    if phi_arr is None:
        xtc_path = wd / "simulation" / "md.xtc"
        if xtc_path.exists():
            try:
                import mdtraj  # type: ignore[import]

                traj = _load_trajectory(wd)
                log.info("ramachandran: loaded %d frames", traj.n_frames)
                _, phi_vals = mdtraj.compute_phi(traj)
                _, psi_vals = mdtraj.compute_psi(traj)
                log.info("ramachandran: phi shape=%s psi shape=%s",
                         phi_vals.shape, psi_vals.shape)
                if phi_vals.size > 0 and psi_vals.size > 0:
                    phi_arr = phi_vals[:, 0]
                    psi_arr = psi_vals[:, 0]
                    analysis_dir.mkdir(parents=True, exist_ok=True)
                    np.save(str(phi_npy), phi_arr)
                    np.save(str(psi_npy), psi_arr)
                    log.info("ramachandran: saved phi.npy/psi.npy (%d frames)", len(phi_arr))
                else:
                    log.warning("ramachandran: compute_phi/psi returned empty arrays for %s", wd)

            except ImportError:
                log.warning("ramachandran: mdtraj not installed, falling back to COLVAR")
            except RuntimeError as e:
                log.error("ramachandran: could not load trajectory — %s", e)
            except Exception as e:
                log.error("ramachandran: mdtraj extraction failed — %s", e)

    # ── Step 3b: ramachandran.json fallback ─────────────────────────────
    if phi_arr is None:
        json_path = analysis_dir / "ramachandran.json"
        if json_path.exists():
            try:
                with open(json_path) as fh:
                    jdata = json.load(fh)
                phi_key = next((k for k in jdata if "phi" in k.lower()), None)
                psi_key = next((k for k in jdata if "psi" in k.lower()), None)
                if phi_key and psi_key:
                    phi_arr = np.array(jdata[phi_key])
                    psi_arr = np.array(jdata[psi_key])
                    analysis_dir.mkdir(parents=True, exist_ok=True)
                    np.save(str(phi_npy), phi_arr)
                    np.save(str(psi_npy), psi_arr)
                    log.info("ramachandran: loaded from ramachandran.json (%d frames)", len(phi_arr))
            except Exception as e:
                log.warning("ramachandran: failed to load ramachandran.json — %s", e)

    # ── Step 3c: COLVAR fallback ──────────────────────────────────────
    if phi_arr is None:
        colvar_path = wd / "COLVAR"
        if colvar_path.exists():
            cols = colvar_to_columns(str(colvar_path))
            phi_key = next((k for k in cols if "phi" in k.lower()), None)
            psi_key = next((k for k in cols if "psi" in k.lower()), None)
            if phi_key and psi_key:
                phi_arr = np.array(cols[phi_key])
                psi_arr = np.array(cols[psi_key])
                analysis_dir.mkdir(parents=True, exist_ok=True)
                np.save(str(phi_npy), phi_arr)
                np.save(str(psi_npy), psi_arr)
                log.info("ramachandran: using COLVAR '%s'/'%s' (%d frames)",
                         phi_key, psi_key, len(phi_arr))
            else:
                log.warning("ramachandran: COLVAR has no phi/psi columns (found: %s)",
                            list(cols.keys()))
        else:
            log.warning("ramachandran: COLVAR not found at %s", colvar_path)

    if phi_arr is None or len(phi_arr) == 0:
        xtc_path = wd / "simulation" / "md.xtc"
        if not xtc_path.exists():
            msg = "Trajectory not found: simulation/md.xtc"
        else:
            msg = "No phi/psi angles found — no protein residues or unsupported topology"
        log.error("ramachandran: %s (work_dir=%s)", msg, wd)
        return None, msg

    # ── Step 4: render PNG ────────────────────────────────────────────
    step = max(1, len(phi_arr) // 5000)
    phi_plot = phi_arr[::step]
    psi_plot = psi_arr[::step]

    try:
        import matplotlib  # type: ignore[import]
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt  # type: ignore[import]

        fig, ax = plt.subplots(figsize=(4.5, 4.5), facecolor="none")
        ax.set_facecolor("none")
        h, xe, ye = np.histogram2d(phi_plot, psi_plot, bins=bins,
                                   range=[[-np.pi, np.pi], [-np.pi, np.pi]])
        xc = (xe[:-1] + xe[1:]) / 2
        yc = (ye[:-1] + ye[1:]) / 2
        plot_data = np.where(h > 0, np.log10(h), np.nan) if log_scale else h
        ax.contourf(xc, yc, plot_data.T, levels=20, cmap=cmap)
        if show_start:
            ax.plot(phi_arr[0], psi_arr[0], marker="*", markersize=14,
                    color="white", alpha=0.8, markeredgecolor="black",
                    markeredgewidth=0.8, zorder=10)
        ax.set_xlabel("φ (rad)", color="#6b7280", fontsize=12)
        ax.set_ylabel("ψ (rad)", color="#6b7280", fontsize=12)
        ax.set_xlim(-np.pi, np.pi)
        ax.set_ylim(-np.pi, np.pi)
        ax.tick_params(colors="#6b7280", labelsize=10)
        for spine in ax.spines.values():
            spine.set_edgecolor("#9ca3af")
        plt.tight_layout(pad=0.4)
        analysis_dir.mkdir(parents=True, exist_ok=True)
        plt.savefig(str(png_path), dpi=dpi, bbox_inches="tight",
                    facecolor="none", transparent=True)
        plt.close(fig)
        log.info("ramachandran: PNG saved to %s", png_path)
        return str(png_path), None
    except Exception as e:
        msg = f"Failed to render plot: {e}"
        log.error("ramachandran: %s", msg)
        return None, msg


def get_log_progress(log_path: str) -> dict[str, Any]:
    """Return latest step/time/ns_per_day from GROMACS log."""
    info = parse_gromacs_log_progress(log_path)
    return info or {}


# ── Custom CV analysis ────────────────────────────────────────────────


def _cv_cache_key(cvs: list[dict]) -> str:
    canonical = json.dumps(
        [{"type": c["type"], "atoms": c["atoms"]} for c in cvs],
        sort_keys=True,
    )
    return hashlib.md5(canonical.encode()).hexdigest()[:12]


def compute_custom_cvs(work_dir: str, cvs: list[dict], force: bool = False) -> dict:
    """Compute custom collective variables from trajectory using mdtraj.

    Args:
        work_dir: Session work directory
        cvs: List of CV definitions, each with 'type', 'atoms' (1-based), 'label'
        force: If True, recompute even if cached

    Returns:
        dict with 'time_ps', 'cv_labels', and one key per CV label with values
    """
    import numpy as np
    import mdtraj

    wd = Path(work_dir)
    analysis_dir = wd / "analysis"
    analysis_dir.mkdir(parents=True, exist_ok=True)

    cache_key = _cv_cache_key(cvs)
    cache_path = analysis_dir / f"custom_cv_{cache_key}.npz"

    if not force and cache_path.exists():
        try:
            data = np.load(str(cache_path), allow_pickle=False)
            labels = [cv.get("label", f"CV{i+1}") for i, cv in enumerate(cvs)]
            result: dict[str, Any] = {"time_ps": data["time_ps"].tolist(), "cv_labels": labels}
            for i, label in enumerate(labels):
                key = f"cv_{i}"
                if key in data:
                    result[label] = data[key].tolist()
            return result
        except Exception:
            pass

    traj = _load_trajectory(wd)

    # Downsample if too many frames
    step = max(1, len(traj) // 5000)
    if step > 1:
        traj = traj[::step]

    time_ps = traj.time.tolist()
    labels = []
    arrays: dict[str, Any] = {}

    for i, cv in enumerate(cvs):
        cv_type = cv["type"]
        atoms_1based = cv["atoms"]
        label = cv.get("label", f"CV{i+1}")
        labels.append(label)

        # Convert 1-based to 0-based for mdtraj
        atoms_0based = [a - 1 for a in atoms_1based]

        if cv_type == "distance":
            values = mdtraj.compute_distances(traj, [atoms_0based])
            values = values[:, 0] * 10.0  # nm -> Angstroms
        elif cv_type == "angle":
            values = mdtraj.compute_angles(traj, [atoms_0based])
            values = np.degrees(values[:, 0])
        elif cv_type == "dihedral":
            values = mdtraj.compute_dihedrals(traj, [atoms_0based])
            values = np.degrees(values[:, 0])
        else:
            raise ValueError(f"Unknown CV type: {cv_type}")

        arrays[f"cv_{i}"] = values

    # Cache
    np.savez(str(cache_path), time_ps=np.array(time_ps), **arrays)

    result = {"time_ps": time_ps, "cv_labels": labels}
    for i, label in enumerate(labels):
        result[label] = arrays[f"cv_{i}"].tolist()
    return result


def get_atom_list(work_dir: str) -> list[dict]:
    """Return list of atoms from topology file for atom picking UI."""
    import mdtraj

    wd = Path(work_dir)

    # Find topology file (don't need trajectory for this)
    top_candidates: list[Path] = []
    tpr = wd / "md.tpr"
    if tpr.exists():
        top_candidates.append(tpr)
    top_candidates.extend(wd.glob("*_ionized.gro"))
    top_candidates.extend(wd.glob("*_solvated.gro"))
    top_candidates.extend(wd.glob("*_system.gro"))
    top_candidates.extend(p for p in wd.glob("*.gro") if p not in top_candidates)
    top_candidates.extend(p for p in wd.glob("*.pdb") if p not in top_candidates)

    for top_path in top_candidates:
        try:
            topology = mdtraj.load_topology(str(top_path))
            atoms = []
            for atom in topology.atoms:
                atoms.append({
                    "index": atom.index + 1,  # 1-based for PLUMED convention
                    "name": atom.name,
                    "element": atom.element.symbol if atom.element else "",
                    "resName": atom.residue.name,
                    "resSeq": atom.residue.resSeq,
                })
            return atoms
        except Exception:
            continue

    return []
