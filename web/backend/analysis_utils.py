"""Analysis helpers for plot endpoints. Reuses md_agent parsers."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

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



def get_log_progress(log_path: str) -> dict[str, Any]:
    """Return latest step/time/ns_per_day from GROMACS log."""
    info = parse_gromacs_log_progress(log_path)
    return info or {}
