"""Interactive CLI entry point for the MD Agent (``amd`` command)."""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

# ── Helpers ───────────────────────────────────────────────────────────────────


def _prompt(question: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        answer = input(f"{question}{suffix}: ").strip()
        if answer:
            return answer
        if default is not None:
            return default
        print("  Please enter a value.")


def _choose(question: str, options: list[tuple[str, str]]) -> str:
    """Present a numbered menu; return the key of the chosen option."""
    print(f"\n{question}")
    for i, (key, label) in enumerate(options, 1):
        print(f"  {i}. {label}")
    while True:
        raw = input("Your choice [number]: ").strip()
        try:
            idx = int(raw) - 1
            if 0 <= idx < len(options):
                return options[idx][0]
        except ValueError:
            pass
        print(f"  Enter a number between 1 and {len(options)}.")


def _yesno(question: str, default: bool = True) -> bool:
    hint = "[Y/n]" if default else "[y/N]"
    raw = input(f"{question} {hint}: ").strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes")


# ── Lazy imports (keep startup fast) ──────────────────────────────────────────


def _load_hydra_cfg(
    conf_dir: str,
    overrides: list[str],
    work_dir: str,
) -> object:
    from hydra import compose, initialize_config_dir
    from hydra.core.global_hydra import GlobalHydra

    GlobalHydra.instance().clear()
    with initialize_config_dir(config_dir=conf_dir, job_name="amd"):
        cfg = compose(config_name="config", overrides=overrides + [f"run.work_dir={work_dir}"])
    return cfg


def _repo_conf_dir() -> str:
    """Return the conf/ directory, whether running from the repo or installed."""
    # When installed as a package, conf/ lives in share/amd-agent/conf
    import importlib.util

    spec = importlib.util.find_spec("md_agent")
    if spec and spec.origin:
        pkg_dir = Path(spec.origin).parent

    # Try repo root first (editable install / development)
    for candidate in [
        Path(__file__).parents[1] / "conf",  # repo root/conf
        pkg_dir.parents[1] / "share" / "amd-agent" / "conf",  # installed
    ]:
        if candidate.is_dir():
            return str(candidate)

    raise FileNotFoundError(
        "Cannot locate the conf/ directory. " "Run 'pip install -e .' from the repository root."
    )


# ── Simulation-type handlers ──────────────────────────────────────────────────


def _setup_from_paper(work_dir: str, conf_dir: str) -> tuple[object, str]:
    """Ask for a paper reference and build a reproduce-paper prompt."""
    print("\n-- Paper Reproduction Setup --")
    source = _choose(
        "How do you want to identify the paper?",
        [
            ("arxiv", "ArXiv ID  (e.g. 2301.12345)"),
            ("query", "Keyword search  (e.g. 'alanine dipeptide metadynamics')"),
            ("pdf", "Local PDF path"),
            ("text", "Paste paper text directly"),
        ],
    )

    if source == "arxiv":
        arxiv_id = _prompt("ArXiv ID")
        prompt = (
            f"Find ArXiv paper {arxiv_id}, extract its MD simulation parameters, "
            f"generate a Hydra config, and reproduce the simulation. "
            f"Work directory: {work_dir}. "
            "Show me the extracted config and ask for confirmation before running."
        )
        overrides = ["mode=reproduce_paper", f"paper.arxiv_id={arxiv_id}"]

    elif source == "query":
        query = _prompt("Search query")
        prompt = (
            f"Search for papers about: '{query}'. Show me the top results, let me choose "
            f"one, then extract its MD simulation parameters and reproduce them. "
            f"Work directory: {work_dir}. Ask for confirmation before running."
        )
        overrides = ["mode=reproduce_paper", f"paper.query={query}"]

    elif source == "pdf":
        pdf = _prompt("Path to PDF file")
        prompt = (
            f"Extract MD simulation parameters from the PDF at {pdf}, "
            f"generate a Hydra config, and reproduce the simulation. "
            f"Work directory: {work_dir}. Show me the extracted config and ask for confirmation."
        )
        overrides = ["mode=reproduce_paper", f"paper.pdf_path={pdf}"]

    else:  # text
        print("Paste the paper text below. Enter a line with just '---END---' when done.")
        lines = []
        while True:
            line = input()
            if line.strip() == "---END---":
                break
            lines.append(line)
        text = "\n".join(lines)
        prompt = (
            f"Extract MD simulation parameters from the following paper text and reproduce "
            f"the simulation. Work directory: {work_dir}.\n\nPaper text:\n{text}"
        )
        overrides = ["mode=reproduce_paper"]

    cfg = _load_hydra_cfg(conf_dir, overrides, work_dir)
    return cfg, prompt


def _setup_from_description(
    work_dir: str,
    conf_dir: str,
    pdb_path: str | None,
    wandb_project: str | None,
) -> tuple[object, str]:
    """Build a prompt from a natural-language simulation description."""
    print("\n-- Natural Language Simulation Setup --")
    description = _prompt(
        "Describe your simulation",
        default="Well-tempered metadynamics of the provided system at 300 K",
    )

    pdb_info = f"PDB file: {pdb_path}. " if pdb_path else ""
    wandb_info = f"Log to WandB project '{wandb_project}'. " if wandb_project else ""

    prompt = (
        f"{description}. "
        f"{pdb_info}"
        f"Work directory: {work_dir}. "
        f"Initialize wandb, generate all input files, run grompp, "
        f"launch mdrun with the PLUMED input, start the background monitor, "
        f"wait for completion, then do a final wandb log and analysis. "
        f"{wandb_info}"
    )
    overrides = ["mode=run"]
    cfg = _load_hydra_cfg(conf_dir, overrides, work_dir)
    return cfg, prompt


# ── Built-in examples ─────────────────────────────────────────────────────────

_EXAMPLES = {
    "ala_dipeptide": {
        "label": "Alanine Dipeptide — phi/psi metadynamics (vacuum)",
        "overrides": [
            "system=ala_dipeptide",
            "method=ala_metadynamics",
            "plumed/collective_variables=ala_dipeptide",
            "gromacs=vacuum",
        ],
    },
}


def _run_example(name: str, work_dir: str, conf_dir: str) -> None:
    if name not in _EXAMPLES:
        print(f"Unknown example '{name}'. Available: {', '.join(_EXAMPLES)}")
        sys.exit(1)

    ex = _EXAMPLES[name]
    print(f"\n==> Running example: {ex['label']}")

    # Point the user to the example README
    examples_dir = Path(__file__).parents[1] / "examples" / name
    readme = examples_dir / "README.md"
    if readme.exists():
        print(f"==> See {readme} for full instructions and preparation steps.")

    # Check that system files exist (output of prepare.sh lives in examples_dir)
    gro = examples_dir / "ala2.gro"
    top = examples_dir / "topol.top"
    if not gro.exists() or not top.exists():
        prepare_sh = examples_dir / "prepare.sh"
        print(
            f"\nSystem files not found in {examples_dir}.\n"
            f"Run the preparation script first:\n"
            f"    bash {prepare_sh}\n"
        )
        sys.exit(1)

    from hydra import compose, initialize_config_dir
    from hydra.core.global_hydra import GlobalHydra
    from omegaconf import OmegaConf

    from md_agent.agent import MDAgent

    GlobalHydra.instance().clear()
    with initialize_config_dir(config_dir=conf_dir, job_name="amd"):
        cfg = compose(
            config_name="config",
            overrides=ex["overrides"] + [f"run.work_dir={work_dir}"],
        )

    OmegaConf.update(cfg, "system.topology", str(top))
    OmegaConf.update(cfg, "system.coordinates", str(gro))

    Path(work_dir).mkdir(parents=True, exist_ok=True)
    shutil.copy(gro, Path(work_dir) / "ala2.gro")
    shutil.copy(top, Path(work_dir) / "topol.top")
    for itp in examples_dir.glob("*.itp"):
        shutil.copy(itp, Path(work_dir) / itp.name)

    prompt = (
        "Run a well-tempered metadynamics simulation of alanine dipeptide in vacuum "
        "(CHARMM36m force field, dodecahedron periodic box). "
        f"Work directory: {work_dir}. "
        "CVs (1-based PLUMED indices): "
        "  phi = TORSION ATOMS=5,7,9,15   (CY_ACE – N_ALA – CA_ALA – C_ALA), "
        "  psi = TORSION ATOMS=7,9,15,17  (N_ALA – CA_ALA – C_ALA – N_NME). "
        "ala2.gro and topol.top are already in the work directory. "
        "Steps: validate_config → generate_mdp_from_config → generate_plumed_metadynamics "
        "→ run_grompp (with ala2.gro and topol.top) "
        "→ wandb_init_run (if project set) → run_mdrun → "
        "wandb_start_background_monitor → wait_mdrun → analyze_hills → wandb_stop_monitor. "
        "Summarise the Ramachandran FES: identify C7eq, C7ax, and alpha-helix basins."
    )

    agent = MDAgent(cfg=cfg, work_dir=work_dir)
    print("\n==> Starting MD Agent...\n")
    result = agent.run(prompt)
    print("\n==> Agent summary:")
    print(result)


# ── Interactive setup ─────────────────────────────────────────────────────────


def _interactive_setup(work_dir: str | None) -> None:
    try:
        conf_dir = _repo_conf_dir()
    except FileNotFoundError as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("  MD Agent — AI-Powered Molecular Dynamics Setup")
    print("=" * 60)

    # ── Choose simulation type ───────────────────────────────────────────────
    sim_type = _choose(
        "What type of MD simulation do you want to run?",
        [
            ("description", "Describe the simulation in plain language"),
            ("paper", "Reproduce a published paper protocol"),
            ("example", "Run a built-in example"),
        ],
    )

    # ── Built-in example shortcut ────────────────────────────────────────────
    if sim_type == "example":
        ex_name = _choose(
            "Which example?",
            [(k, v["label"]) for k, v in _EXAMPLES.items()],
        )
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        wdir = work_dir or f"outputs/{ex_name}_{ts}"
        _run_example(ex_name, wdir, conf_dir)
        return

    # ── Get PDB / system files ───────────────────────────────────────────────
    print("\n-- System Files --")
    has_pdb = _yesno("Do you have a PDB or GRO file for your system?", default=True)
    pdb_path: str | None = None
    if has_pdb:
        raw = _prompt("Path to PDB / GRO file (or URL to download from RCSB, e.g. 1AKI)")
        if raw.startswith("http"):
            pdb_path = raw
        elif len(raw) == 4 and raw.isalnum():
            pdb_path = f"https://files.rcsb.org/download/{raw.upper()}.pdb"
            print(f"  Will download: {pdb_path}")
        else:
            pdb_path = str(Path(raw).resolve())
            if not Path(pdb_path).exists():
                print(f"  WARNING: file not found at {pdb_path}")
    else:
        print(
            "\n  Tip: Provide a PDB ID (4 chars, e.g. 1AKI) or describe the system\n"
            "  and the agent will attempt to download or build the structure."
        )

    # ── WandB ────────────────────────────────────────────────────────────────
    print("\n-- Experiment Tracking --")
    use_wandb = _yesno("Enable WandB logging?", default=True)
    wandb_project: str | None = None
    if use_wandb:
        wandb_project = _prompt("WandB project name", default="amd-agent")

    # ── Output directory ─────────────────────────────────────────────────────
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    default_wdir = f"outputs/{ts}"
    wdir = work_dir or _prompt("Output directory", default=default_wdir)

    # ── Build config + prompt ────────────────────────────────────────────────
    if sim_type == "paper":
        cfg, prompt = _setup_from_paper(wdir, conf_dir)
    else:
        cfg, prompt = _setup_from_description(wdir, conf_dir, pdb_path, wandb_project)

    # ── Patch WandB project in config ────────────────────────────────────────
    if wandb_project:
        from omegaconf import OmegaConf

        OmegaConf.update(cfg, "wandb.project", wandb_project)

    # ── Copy PDB into work_dir if local ──────────────────────────────────────
    if pdb_path and not pdb_path.startswith("http"):
        Path(wdir).mkdir(parents=True, exist_ok=True)
        dest = Path(wdir) / Path(pdb_path).name
        if not dest.exists():
            shutil.copy(pdb_path, dest)
            print(f"  Copied {pdb_path} → {dest}")
        from omegaconf import OmegaConf

        OmegaConf.update(cfg, "system.coordinates", str(dest))

    # ── Confirm before running ───────────────────────────────────────────────
    print(f"\n==> Work directory : {wdir}")
    if pdb_path:
        print(f"==> System file    : {pdb_path}")
    if wandb_project:
        print(f"==> WandB project  : {wandb_project}")
    print()

    if not _yesno("Start the MD Agent?", default=True):
        print("Aborted.")
        return

    # ── Run ──────────────────────────────────────────────────────────────────
    from md_agent.agent import MDAgent

    Path(wdir).mkdir(parents=True, exist_ok=True)
    agent = MDAgent(cfg=cfg, work_dir=wdir)
    print("\n==> Starting MD Agent...\n")
    result = agent.run(prompt)
    print("\n==> Agent summary:")
    print(result)


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="amd",
        description="Automated MD — AI-powered molecular dynamics simulation setup and execution",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  amd                              # interactive wizard\n"
            "  amd --example ala_dipeptide      # run built-in alanine dipeptide example\n"
            "  amd --work-dir ./my_run          # set output directory\n"
        ),
    )
    parser.add_argument(
        "--example",
        choices=list(_EXAMPLES.keys()),
        metavar="NAME",
        help=f"Run a built-in example. Choices: {', '.join(_EXAMPLES)}",
    )
    parser.add_argument(
        "--work-dir",
        default=None,
        metavar="DIR",
        help="Output directory (default: outputs/<timestamp>)",
    )
    args = parser.parse_args()

    if args.example:
        try:
            conf_dir = _repo_conf_dir()
        except FileNotFoundError as e:
            print(f"ERROR: {e}")
            sys.exit(1)
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        wdir = args.work_dir or f"outputs/{args.example}_{ts}"
        _run_example(args.example, wdir, conf_dir)
    else:
        _interactive_setup(args.work_dir)
