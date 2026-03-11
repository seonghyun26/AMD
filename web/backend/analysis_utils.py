"""Analysis helpers for plot endpoints. Reuses md_agent parsers."""

from __future__ import annotations

import logging
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


def run_gmx_energy(
    work_dir: str,
    gmx_runner: Any,
    edr_rel: str = "simulation/md.edr",
    xvg_rel: str = "analysis/energy.xvg",
    force: bool = False,
) -> dict[str, list]:
    """Run 'gmx energy' to extract timeseries from .edr, caching the result as .xvg.

    Returns parsed {time_ps, term_name, ...} dict or {} on failure.
    Uses cached .xvg when available unless force=True.
    """
    wd = Path(work_dir)
    edr_path = wd / edr_rel
    xvg_path = wd / xvg_rel

    if not edr_path.exists():
        return {}

    # Return cached XVG when available
    if not force and xvg_path.exists() and xvg_path.stat().st_size > 0:
        data = _parse_xvg_with_header(str(xvg_path))
        if data:
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

    return _parse_xvg_with_header(str(xvg_path))


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
    import math
    z_matrix = [[math.nan] * len(unique_x) for _ in range(len(unique_y))]
    for xi, yi, zi in zip(x_vals, y_vals, z_vals):
        ix = x_idx.get(xi)
        iy = y_idx.get(yi)
        if ix is not None and iy is not None:
            z_matrix[iy][ix] = zi

    return {"x": unique_x, "y": unique_y, "z": z_matrix}




def generate_ramachandran_png(work_dir: str, force: bool = False) -> tuple[str | None, str | None]:
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
            top_candidates: list[Path] = []
            tpr = wd / "md.tpr"
            if tpr.exists():
                top_candidates.append(tpr)
            top_candidates.extend(wd.glob("*_system.gro"))
            top_candidates.extend(p for p in wd.glob("*.gro") if p not in top_candidates)

            if not top_candidates:
                log.warning("ramachandran: no topology (.tpr/.gro) found in %s", wd)
            else:
                try:
                    import mdtraj  # type: ignore[import]

                    traj = None
                    last_err: Exception | None = None
                    for top in top_candidates:
                        try:
                            traj = mdtraj.load(str(xtc_path), top=str(top))
                            log.info("ramachandran: loaded %d frames with topology %s",
                                     traj.n_frames, top.name)
                            break
                        except Exception as e:
                            last_err = e
                            log.warning("ramachandran: failed with topology %s — %s", top.name, e)

                    if traj is None:
                        log.error("ramachandran: could not load trajectory — %s", last_err)
                    else:
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
                except Exception as e:
                    log.error("ramachandran: mdtraj extraction failed — %s", e)

    # ── Step 3b: ramachandran.json fallback ─────────────────────────────
    if phi_arr is None:
        json_path = analysis_dir / "ramachandran.json"
        if json_path.exists():
            try:
                import json
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

        fig, ax = plt.subplots(figsize=(4.5, 4.5), facecolor="#111827")
        ax.set_facecolor("#111827")
        bins = 60
        h, xe, ye = np.histogram2d(phi_plot, psi_plot, bins=bins,
                                   range=[[-np.pi, np.pi], [-np.pi, np.pi]])
        xc = (xe[:-1] + xe[1:]) / 2
        yc = (ye[:-1] + ye[1:]) / 2
        # Log-scale density to reveal low-population regions
        h_log = np.where(h > 0, np.log10(h), np.nan)
        ax.contourf(xc, yc, h_log.T, levels=20, cmap="Blues")
        # Mark start state with a white star with black outline
        ax.plot(phi_arr[0], psi_arr[0], marker="*", markersize=14,
                color="white", alpha=0.8, markeredgecolor="black",
                markeredgewidth=0.8, zorder=10)
        ax.set_xlabel("φ (rad)", color="#9ca3af", fontsize=12)
        ax.set_ylabel("ψ (rad)", color="#9ca3af", fontsize=12)
        ax.set_xlim(-np.pi, np.pi)
        ax.set_ylim(-np.pi, np.pi)
        ax.tick_params(colors="#6b7280", labelsize=10)
        for spine in ax.spines.values():
            spine.set_edgecolor("#374151")
        plt.tight_layout(pad=0.4)
        analysis_dir.mkdir(parents=True, exist_ok=True)
        plt.savefig(str(png_path), dpi=120, bbox_inches="tight",
                    facecolor=fig.get_facecolor())
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
