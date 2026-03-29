"""Analysis Agent — evaluates MD simulation results and convergence.

Tools wrap the existing analysis_utils and file-reading helpers so the agent
can read COLVAR, HILLS, EDR, and md.log files from the session work_dir.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from langchain_core.tools import tool

from md_agent.agents.base import build_executor, stream_executor, sync_run

# ── Tool factory (closure over work_dir) ───────────────────────────────


def _make_tools(work_dir: str):
    wd = Path(work_dir)

    # ── helpers ─────────────────────────────────────────────────────────

    def _safe_read(rel_path: str, max_lines: int = 5000) -> str:
        p = (wd / rel_path).resolve()
        if not str(p).startswith(str(wd.resolve())):
            return "Error: path is outside the session directory."
        if not p.exists():
            return f"File not found: {rel_path}"
        lines = p.read_text(errors="replace").splitlines()
        if len(lines) > max_lines:
            lines = lines[:max_lines] + [f"… [{len(lines) - max_lines} more lines omitted]"]
        return "\n".join(lines)

    # ── tools ────────────────────────────────────────────────────────────

    @tool
    def list_simulation_files() -> str:
        """List all files in the simulation work directory.
        Use this first to discover what output files are available.
        """
        files = sorted(str(p.relative_to(wd)) for p in wd.rglob("*") if p.is_file())
        return json.dumps(files, indent=2)

    @tool
    def read_colvar_stats(filename: str = "COLVAR") -> str:
        """Read a PLUMED COLVAR file and compute per-column statistics.
        Returns column names, and for each: min, max, mean, std, and a simple
        variance-window convergence score (lower is more converged).
        """
        text = _safe_read(filename, max_lines=100_000)
        if text.startswith("File not found"):
            return text
        lines = [ln for ln in text.splitlines() if not ln.startswith("#")]
        if not lines:
            return "COLVAR file is empty or contains only comments."
        # parse header
        header_line = next((ln for ln in text.splitlines() if ln.startswith("#! FIELDS")), None)
        col_names = header_line.split()[2:] if header_line else []
        data_rows = []
        for line in lines[:50_000]:
            try:
                data_rows.append([float(x) for x in line.split()])
            except ValueError:
                continue
        if not data_rows:
            return "Could not parse numeric data from COLVAR."
        arr = np.array(data_rows)
        n_cols = min(arr.shape[1], len(col_names) or arr.shape[1])
        stats = {}
        for i in range(n_cols):
            col = arr[:, i]
            name = col_names[i] if i < len(col_names) else f"col{i}"
            half = len(col) // 2
            # variance convergence: ratio of 2nd-half variance to full variance
            conv = float(np.var(col[half:]) / max(np.var(col), 1e-12)) if half > 0 else 1.0
            stats[name] = {
                "min": float(col.min()),
                "max": float(col.max()),
                "mean": float(col.mean()),
                "std": float(col.std()),
                "n_frames": int(len(col)),
                "convergence_score": round(conv, 3),  # ~1 = not converged, ~0 = converged
            }
        return json.dumps(stats, indent=2)

    @tool
    def read_hills_stats(filename: str = "HILLS") -> str:
        """Read a PLUMED HILLS file and summarise the Gaussian bias deposition history.
        Returns number of hills, total time, bias height evolution (first / mid / last 100).
        """
        text = _safe_read(filename, max_lines=100_000)
        if text.startswith("File not found"):
            return text
        header = next((ln for ln in text.splitlines() if ln.startswith("#! FIELDS")), "")
        col_names = header.split()[2:] if header else []
        rows = []
        for line in text.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            try:
                rows.append([float(x) for x in line.split()])
            except ValueError:
                continue
        if not rows:
            return "No data found in HILLS."
        arr = np.array(rows)
        n = len(arr)
        # height column is typically the second-to-last
        h_idx = -2 if arr.shape[1] >= 3 else 0
        heights = arr[:, h_idx]
        return json.dumps(
            {
                "n_hills": n,
                "time_start_ps": float(arr[0, 0]) if arr.shape[1] > 0 else None,
                "time_end_ps": float(arr[-1, 0]) if arr.shape[1] > 0 else None,
                "height_first_100_mean": float(heights[:100].mean()),
                "height_last_100_mean": float(heights[-100:].mean()),
                "height_overall_mean": float(heights.mean()),
                "columns": col_names,
            },
            indent=2,
        )

    @tool
    def read_energy_stats(
        edr_filename: str = "ener.edr", terms: str = "Potential,Temperature"
    ) -> str:
        """Parse a GROMACS .edr energy file and return statistics for requested energy terms.
        terms: comma-separated list of GROMACS energy term names.
        Returns mean, std, and last value for each term.
        """
        import pyedr

        p = wd / edr_filename
        if not p.exists():
            return f"EDR file not found: {edr_filename}"
        try:
            edr = pyedr.edr_to_dict(str(p))
        except Exception as exc:
            return f"Error reading EDR: {exc}"
        requested = [t.strip() for t in terms.split(",")]
        result = {}
        for term in requested:
            if term in edr:
                arr = np.array(edr[term])
                result[term] = {
                    "mean": float(arr.mean()),
                    "std": float(arr.std()),
                    "last": float(arr[-1]),
                    "n_frames": int(len(arr)),
                }
            else:
                available = list(edr.keys())[:20]
                result[term] = {"error": "not found", "available_terms": available}
        return json.dumps(result, indent=2)

    @tool
    def read_log_progress(filename: str = "md.log") -> str:
        """Read a GROMACS md.log file and extract simulation progress and performance.
        Returns current step, time (ps), ns/day performance, and ETA estimate.
        """
        text = _safe_read(filename, max_lines=10_000)
        if text.startswith("File not found"):
            return text
        # scan for performance and step info
        step = time_ps = ns_per_day = None
        for line in text.splitlines():
            if line.strip().startswith("Step"):
                parts = line.split()
                try:
                    idx = parts.index("Step") + 1
                    step = int(parts[idx])
                    time_ps = float(parts[idx + 1])
                except (ValueError, IndexError):
                    pass
            if "Performance:" in line:
                parts = line.split()
                try:
                    idx = parts.index("Performance:") + 1
                    ns_per_day = float(parts[idx])
                except (ValueError, IndexError):
                    pass
        return json.dumps({"step": step, "time_ps": time_ps, "ns_per_day": ns_per_day}, indent=2)

    @tool
    def read_fes_summary(filename: str = "fes.dat") -> str:
        """Read a PLUMED FES (free energy surface) file and summarise the landscape.
        Returns the grid range, minimum FES value, maximum FES value, and barrier heights.
        """
        text = _safe_read(filename, max_lines=100_000)
        if text.startswith("File not found"):
            return text
        rows = []
        for line in text.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            try:
                rows.append([float(x) for x in line.split()])
            except ValueError:
                continue
        if not rows:
            return "Could not parse FES data."
        arr = np.array(rows)
        n_cols = arr.shape[1]
        # Last column is FES value; earlier are CV values
        fes = arr[:, -1]
        cv_cols = arr[:, :-1]
        result = {
            "n_points": len(arr),
            "fes_min_kJ_mol": float(fes.min()),
            "fes_max_kJ_mol": float(fes.max()),
            "fes_range_kJ_mol": float(fes.max() - fes.min()),
        }
        for i in range(min(n_cols - 1, 3)):
            result[f"cv{i+1}_range"] = [float(cv_cols[:, i].min()), float(cv_cols[:, i].max())]
        return json.dumps(result, indent=2)

    return [
        list_simulation_files,
        read_colvar_stats,
        read_hills_stats,
        read_energy_stats,
        read_log_progress,
        read_fes_summary,
    ]


# ── System prompt ──────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert MD simulation analyst. Your job is to analyse
the output files from a GROMACS + PLUMED simulation and produce a clear, actionable report.

## Analysis workflow
1. Start by listing available files (`list_simulation_files`)
2. Check simulation progress (`read_log_progress`)
3. Analyse energy convergence (`read_energy_stats`) for Potential Energy and Temperature
4. If COLVAR exists, check CV sampling (`read_colvar_stats`) — is the CV space well-explored?
5. If HILLS exists, check bias deposition (`read_hills_stats`) — are heights decreasing as expected?
6. If fes.dat exists, summarise the free energy landscape (`read_fes_summary`)

## Report structure
Produce a report with these sections:
- **Simulation status**: progress, performance (ns/day), estimated completion
- **Energy convergence**: is potential energy stable? Temperature thermostat working?
- **CV sampling quality**: range explored, convergence score interpretation
- **Metadynamics bias**: hills count, height trend (should decay in well-tempered MetaD)
- **Free energy landscape**: barrier heights (kJ/mol), minima locations
- **Recommendations**: specific actionable suggestions (extend simulation, adjust sigma, etc.)

Use concrete numbers from the analysis — avoid vague statements.
"""


# ── Agent class ────────────────────────────────────────────────────────


class AnalysisAgent:
    """LangChain specialist agent for MD results analysis."""

    def __init__(self, work_dir: str, api_key: str | None = None) -> None:
        self.work_dir = work_dir
        tools = _make_tools(work_dir)
        self.executor = build_executor(SYSTEM_PROMPT, tools, max_iterations=12, api_key=api_key)

    def run(self, task: str = "Analyse the simulation results.") -> str:
        return sync_run(self.executor, task)

    async def astream(self, task: str = "Analyse the simulation results."):
        async for event in stream_executor(self.executor, task):
            yield event
