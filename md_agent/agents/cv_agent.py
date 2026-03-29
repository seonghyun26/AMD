"""CV Suggester Agent — recommends collective variables for enhanced sampling.

Reads the molecular structure, identifies key atoms/residues, and outputs
ready-to-use PLUMED CV definitions with 1-based atom indices.
"""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.tools import tool

from md_agent.agents.base import build_executor, stream_executor, sync_run

# ── Tool factory ────────────────────────────────────────────────────────


def _make_tools(work_dir: str):
    wd = Path(work_dir)

    @tool
    def list_structure_files() -> str:
        """List PDB, GRO, MOL2, and XYZ files in the work directory.
        Call this first to discover available structure files.
        """
        exts = {".pdb", ".gro", ".mol2", ".xyz"}
        files = [
            str(p.relative_to(wd))
            for p in wd.rglob("*")
            if p.suffix.lower() in exts and p.is_file()
        ]
        return json.dumps(files or ["No structure files found."], indent=2)

    @tool
    def read_atom_list(filename: str) -> str:
        """Read a PDB or GRO file and return a numbered list of atoms (1-based indices).
        Format: index | atom_name | residue_name | residue_number | element
        PLUMED uses these 1-based indices directly.
        """
        p = wd / filename
        if not p.exists():
            return f"File not found: {filename}"
        ext = p.suffix.lower()
        atoms = []
        if ext == ".pdb":
            for line in p.read_text(errors="replace").splitlines():
                if line.startswith(("ATOM", "HETATM")):
                    try:
                        atom_idx = len(atoms) + 1
                        atom_name = line[12:16].strip()
                        res_name = line[17:20].strip()
                        res_num = line[22:26].strip()
                        element = line[76:78].strip() if len(line) > 76 else ""
                        atoms.append(
                            {
                                "index": atom_idx,
                                "atom": atom_name,
                                "residue": res_name,
                                "resnum": res_num,
                                "element": element,
                            }
                        )
                    except Exception:
                        continue
        elif ext == ".gro":
            lines = p.read_text(errors="replace").splitlines()
            for line in lines[2:]:
                if len(line) > 20:
                    try:
                        res_num = int(line[0:5])
                        res_name = line[5:10].strip()
                        atom_name = line[10:15].strip()
                        atom_idx = int(line[15:20])
                        atoms.append(
                            {
                                "index": atom_idx,
                                "atom": atom_name,
                                "residue": res_name,
                                "resnum": str(res_num),
                                "element": atom_name[0] if atom_name else "",
                            }
                        )
                    except (ValueError, IndexError):
                        continue
        if not atoms:
            return "No atoms parsed — check file format."
        # truncate for display
        n = len(atoms)
        sample = atoms[:50] + ([{"index": "...", "note": f"{n - 50} more atoms"}] if n > 50 else [])
        return f"Total atoms: {n}\n" + json.dumps(sample, indent=2)

    @tool
    def read_residue_list(filename: str) -> str:
        """Read a PDB or GRO file and return a summary of residues with their first/last atom indices.
        Use this to understand the molecular composition before selecting CV atoms.
        """
        p = wd / filename
        if not p.exists():
            return f"File not found: {filename}"
        residues: dict[tuple, list[int]] = {}
        ext = p.suffix.lower()
        if ext == ".pdb":
            for line in p.read_text(errors="replace").splitlines():
                if line.startswith(("ATOM", "HETATM")):
                    try:
                        atom_idx = len(residues) + 1  # approximate
                        res_name = line[17:20].strip()
                        res_num = line[22:26].strip()
                        chain = line[21:22].strip()
                        key = (res_name, res_num, chain)
                        residues.setdefault(key, [])
                        # count atoms per residue
                    except Exception:
                        continue
        elif ext == ".gro":
            idx = 0
            for line in p.read_text(errors="replace").splitlines()[2:]:
                if len(line) > 20:
                    try:
                        res_num = int(line[0:5])
                        res_name = line[5:10].strip()
                        atom_idx = int(line[15:20])
                        key = (res_name, str(res_num), "")
                        residues.setdefault(key, [])
                        residues[key].append(atom_idx)
                        idx += 1
                    except (ValueError, IndexError):
                        continue
        summary = [
            {
                "residue": k[0],
                "resnum": k[1],
                "first_atom": min(v) if v else "?",
                "last_atom": max(v) if v else "?",
                "n_atoms": len(v),
            }
            for k, v in residues.items()
        ]
        return json.dumps(summary[:80], indent=2)

    @tool
    def generate_torsion_cv(name: str, atom1: int, atom2: int, atom3: int, atom4: int) -> str:
        """Generate a PLUMED torsion (dihedral angle) CV definition.
        All atom indices must be 1-based (PLUMED convention).
        Example: phi = atoms C(prev)-N-CA-C; psi = atoms N-CA-C-N(next)
        """
        return (
            f"{name}: TORSION ATOMS={atom1},{atom2},{atom3},{atom4}\n"
            f"# Range: [-π, π] radians. Common for backbone dihedrals (phi, psi)."
        )

    @tool
    def generate_distance_cv(name: str, atom1: int, atom2: int) -> str:
        """Generate a PLUMED distance CV between two atoms.
        All atom indices must be 1-based. Returns PLUMED-ready definition.
        """
        return (
            f"{name}: DISTANCE ATOMS={atom1},{atom2}\n"
            f"# Distance in nm. Suitable for end-to-end distance, contact formation, etc."
        )

    @tool
    def generate_rmsd_cv(name: str, reference_file: str, atom_group: str = "backbone") -> str:
        """Generate a PLUMED RMSD CV relative to a reference structure.
        atom_group: 'backbone', 'alpha', or 'heavy'. Reference file must be in work_dir.
        """
        return (
            f"{name}: RMSD REFERENCE={reference_file} TYPE=OPTIMAL\n"
            f"# RMSD in nm from the reference structure. Use for folding/unfolding studies."
        )

    @tool
    def generate_metadynamics_bias(
        cv_names: str,
        sigma: str = "0.3",
        height: str = "1.2",
        pace: int = 500,
        biasfactor: int = 10,
    ) -> str:
        """Generate a PLUMED METAD bias section for one or more CVs.
        cv_names: comma-separated list of CV variable names already defined above.
        sigma: width of Gaussians (same units as CV, e.g. radians for torsions).
        height: initial Gaussian height in kJ/mol.
        pace: steps between Gaussian depositions.
        biasfactor: well-tempered factor (γ). Use 0 for non-well-tempered.
        """
        cv_list = ",".join(c.strip() for c in cv_names.split(","))
        sigma_list = ",".join([sigma] * len(cv_names.split(",")))
        wt_line = f"\n  BIASFACTOR={biasfactor}" if biasfactor > 0 else ""
        return (
            f"METAD ARG={cv_list} SIGMA={sigma_list} HEIGHT={height} "
            f"PACE={pace}{wt_line} FILE=HILLS LABEL=metad"
        )

    @tool
    def write_plumed_dat(content: str, filename: str = "plumed.dat") -> str:
        """Write a PLUMED input file into this session's work directory.
        Only filenames without path separators are accepted — writing outside
        the session directory is refused.
        content: full PLUMED .dat file text to write.
        filename: target filename (default: plumed.dat). Must not contain '/' or '..'.
        """
        if "/" in filename or "\\" in filename or ".." in filename:
            return json.dumps({"error": "filename must not contain path separators or '..'"})
        dest = wd / filename
        # Resolve and verify destination stays inside work_dir
        if not str(dest.resolve()).startswith(str(wd.resolve())):
            return json.dumps({"error": "Refusing to write outside session directory."})
        dest.write_text(content)
        return json.dumps({"saved_path": str(dest), "filename": filename, "bytes": len(content)})

    return [
        list_structure_files,
        read_atom_list,
        read_residue_list,
        generate_torsion_cv,
        generate_distance_cv,
        generate_rmsd_cv,
        generate_metadynamics_bias,
        write_plumed_dat,
    ]


def _make_session_config_tools(work_dir: str, session):
    """Return a config-update tool scoped to this session's work_dir."""
    wd = Path(work_dir).resolve()

    @tool
    def update_session_config(updates_json: str) -> str:
        """Apply PLUMED / CV settings to this session-root config.yaml.
        updates_json: JSON object with OmegaConf dot-key → value pairs.
        Example: {"plumed.collective_variables.phi.atoms": [5, 7, 9, 15]}
        Only modifies the current session's config — never touches other sessions.
        """
        try:
            updates = json.loads(updates_json)
            if not isinstance(updates, dict):
                return json.dumps({"error": "updates_json must be a JSON object"})
            from omegaconf import OmegaConf

            cfg = session.agent.cfg
            applied: list[str] = []
            for key, value in updates.items():
                try:
                    OmegaConf.update(cfg, key, value, merge=True)
                    applied.append(key)
                except Exception as e:
                    return json.dumps({"error": f"Failed to set {key}: {e}"})
            cfg_path = wd.parent / "config.yaml"
            OmegaConf.save(cfg, str(cfg_path))
            return json.dumps({"updated": True, "applied_keys": applied})
        except Exception as e:
            return json.dumps({"error": str(e)})

    return [update_session_config]


# ── System prompt ──────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert in designing collective variables (CVs) for enhanced-sampling
molecular dynamics simulations using PLUMED.

## Your workflow
1. List available structure files (`list_structure_files`)
2. Read the atom list (`read_atom_list`) to identify key atoms
3. Read the residue list (`read_residue_list`) to understand the molecular topology
4. Based on the user's description of the biological process or sampling goal:
   - Select appropriate CV type(s): torsion, distance, RMSD, …
   - Identify the correct atom indices from the structure
   - Generate the PLUMED CV definitions
5. Generate a METADYNAMICS bias section with reasonable initial parameters
6. Summarise your choices and explain why you selected these CVs
7. Offer to save the PLUMED definitions using `write_plumed_dat` — only after user confirms

## Output format
Produce ready-to-use PLUMED input lines in a code block, plus brief explanations:
```plumed
phi: TORSION ATOMS=5,7,9,15
psi: TORSION ATOMS=7,9,15,17
METAD ARG=phi,psi SIGMA=0.3,0.3 HEIGHT=1.2 PACE=500 BIASFACTOR=10 FILE=HILLS LABEL=metad
PRINT ARG=phi,psi,metad.bias STRIDE=100 FILE=COLVAR
```

## Critical rules
- **ALL atom indices are 1-based** (PLUMED convention; `pdb2gmx -ignh` renumbers starting from 1)
- Verify atom indices from the structure file before using them
- For proteins: backbone φ = C(i-1)–N–Cα–C, ψ = N–Cα–C–N(i+1)
- For well-tempered metadynamics, biasfactor γ = 5–15 is typical
- Sigma should be ~0.2–0.5 rad for torsions, ~0.05–0.2 nm for distances
- If the user did not specify a goal, ask for clarification before suggesting CVs
- `write_plumed_dat` and `update_session_config` are scoped to the current session only
"""


# ── Agent class ────────────────────────────────────────────────────────


class CVAgent:
    """LangChain specialist agent for CV selection and PLUMED definition generation."""

    def __init__(self, work_dir: str, session=None, api_key: str | None = None) -> None:
        self.work_dir = work_dir
        tools = _make_tools(work_dir)
        if session is not None:
            tools.extend(_make_session_config_tools(work_dir, session))
        self.executor = build_executor(SYSTEM_PROMPT, tools, max_iterations=10, api_key=api_key)

    def run(self, task: str) -> str:
        return sync_run(self.executor, task)

    async def astream(self, task: str):
        async for event in stream_executor(self.executor, task):
            yield event
