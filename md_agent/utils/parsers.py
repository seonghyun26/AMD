"""Parsers for GROMACS and PLUMED output files, plus unit conversion utilities."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# ── Unit conversion ────────────────────────────────────────────────────

_ENERGY_FACTORS: dict[tuple[str, str], float] = {
    ("kcal/mol", "kj/mol"): 4.184,
    ("kj/mol", "kcal/mol"): 1 / 4.184,
    ("kcal", "kj"): 4.184,
    ("kj", "kcal"): 1 / 4.184,
}

_LENGTH_FACTORS: dict[tuple[str, str], float] = {
    ("angstrom", "nm"): 0.1,
    ("å", "nm"): 0.1,
    ("a", "nm"): 0.1,
    ("nm", "angstrom"): 10.0,
    ("nm", "å"): 10.0,
}

_ALL_FACTORS = {**_ENERGY_FACTORS, **_LENGTH_FACTORS}


def convert_units(value: float, from_unit: str, to_unit: str) -> float:
    """Convert a scalar value between supported unit pairs."""
    key = (from_unit.lower(), to_unit.lower())
    if key[0] == key[1]:
        return value
    factor = _ALL_FACTORS.get(key)
    if factor is None:
        raise ValueError(
            f"Unsupported unit conversion: '{from_unit}' → '{to_unit}'. "
            f"Supported pairs: {list(_ALL_FACTORS.keys())}"
        )
    return value * factor


def normalize_extracted_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Apply unit normalization to extracted paper settings.

    GROMACS convention: kJ/mol for energy, nm for length.
    Modifies and returns the settings dict in-place.
    """
    plumed = settings.get("plumed", {})

    height_unit = plumed.pop("hills_height_unit", "kJ/mol")
    if height_unit.lower() in ("kcal/mol", "kcal"):
        if "hills_height" in plumed:
            plumed["hills_height"] = convert_units(plumed["hills_height"], "kcal/mol", "kJ/mol")

    sigma_unit = plumed.pop("sigma_unit", "nm")
    if sigma_unit.lower() in ("angstrom", "å", "a"):
        if "hills_sigma" in plumed:
            plumed["hills_sigma"] = [convert_units(s, "Å", "nm") for s in plumed["hills_sigma"]]

    # Force constant: kJ/mol/nm^2 is GROMACS default; kcal/mol/Å^2 also common
    fc_unit = plumed.pop("force_constant_unit", "kJ/mol/nm^2")
    if fc_unit.lower() in ("kcal/mol/a^2", "kcal/mol/å^2"):
        for key in ("force_constant",):
            if key in plumed:
                # kcal/mol/Å^2 → kJ/mol/nm^2: multiply by 4.184 × 100 = 418.4
                plumed[key] = plumed[key] * 418.4

    settings["plumed"] = plumed
    return settings


# ── EDR parsing ────────────────────────────────────────────────────────


def parse_edr_with_pyedr(
    edr_path: str,
    terms: list[str],
    from_step: int = 0,
) -> dict[int, dict[str, float]]:
    """Parse a GROMACS .edr file using pyedr.

    Returns {step: {term_name: value}} for all steps > from_step.
    Silently returns empty dict if pyedr or the file is unavailable.
    """
    try:
        import pyedr  # type: ignore
    except ImportError:
        return {}

    if not Path(edr_path).exists():
        return {}

    try:
        data = pyedr.edr_to_dict(edr_path)
    except Exception:
        # File may be partially written; skip this poll cycle
        return {}

    step_arr = data.get("Step", [])
    result: dict[int, dict[str, float]] = {}
    for i, step in enumerate(step_arr):
        step = int(step)
        if step <= from_step:
            continue
        metrics: dict[str, float] = {}
        for term in terms:
            if term in data:
                metrics[term] = float(data[term][i])
        if metrics:
            result[step] = metrics
    return result


# ── COLVAR parsing ─────────────────────────────────────────────────────


def parse_colvar_file(
    colvar_path: str,
    from_line: int = 0,
) -> list[dict[str, float]]:
    """Parse a PLUMED COLVAR file, skipping already-read lines.

    COLVAR format:
        #! FIELDS time cv1 cv2 ...
        <time> <val1> <val2> ...

    Returns a list of row dicts starting from ``from_line`` (line count
    excluding comment/header lines).
    """
    if not Path(colvar_path).exists():
        return []

    rows: list[dict[str, float]] = []
    headers: list[str] | None = None
    data_line_count = 0

    with open(colvar_path) as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("#! FIELDS"):
                headers = line.split()[2:]  # skip '#!' and 'FIELDS'
                continue
            if line.startswith("#"):
                continue
            # Data line
            if data_line_count < from_line:
                data_line_count += 1
                continue
            if headers:
                try:
                    vals = list(map(float, line.split()))
                except ValueError:
                    # Torn/partial line — GROMACS is mid-write at EOF. Stop here so
                    # we don't count it as consumed; it'll be complete next poll.
                    # (Advancing the caller's bookmark past it would drop or, when
                    # advancing by len(rows), duplicate a row.)
                    break
                rows.append(dict(zip(headers, vals)))
            data_line_count += 1

    return rows


# ── HILLS parsing ──────────────────────────────────────────────────────


def count_hills(hills_path: str) -> int:
    """Count the number of Gaussian hills deposited (non-comment data lines)."""
    if not Path(hills_path).exists():
        return 0
    count = 0
    with open(hills_path) as fh:
        for line in fh:
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                count += 1
    return count


# ── GROMACS .log parsing ───────────────────────────────────────────────


def parse_gromacs_log_progress(log_path: str) -> dict[str, Any] | None:
    """Extract the latest performance/step info from a GROMACS .log file.

    Returns a dict with keys: 'step', 'time_ps', 'ns_per_day' (if available),
    or None if the file does not exist / no data yet.
    """
    if not Path(log_path).exists():
        return None

    step: int | None = None
    time_ps: float | None = None
    ns_per_day: float | None = None

    with open(log_path) as fh:
        for line in fh:
            # Lines look like: "           Step           Time"
            # followed by:     "          50000       100.000"
            stripped = line.strip()
            if stripped.startswith("Step") and "Time" in stripped:
                continue  # header line
            parts = stripped.split()
            if len(parts) == 2:
                try:
                    step = int(parts[0])
                    time_ps = float(parts[1])
                except ValueError:
                    pass
            # Performance line: "Performance:    3.456 ns/day ..."
            if stripped.startswith("Performance:"):
                try:
                    ns_per_day = float(stripped.split()[1])
                except (IndexError, ValueError):
                    pass

    if step is None:
        return None
    return {"step": step, "time_ps": time_ps, "ns_per_day": ns_per_day}


def get_file_mtime(path: str) -> float:
    """Return file modification time, or 0.0 if file does not exist."""
    try:
        return os.stat(path).st_mtime
    except FileNotFoundError:
        return 0.0
