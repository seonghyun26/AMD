"""Core Claude agent: tool definitions, agentic loop, and system prompt."""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any, Optional

import anthropic
from omegaconf import DictConfig, OmegaConf

from md_agent.config.hydra_utils import (
    config_from_extracted_settings,
    generate_mdp_from_config,
    load_config,
    save_config,
)
from md_agent.config.schemas import validate_extracted_settings
from md_agent.tools.gromacs_tools import GROMACSRunner
from md_agent.tools.paper_tools import MDSettingsExtractor, PaperRetriever
from md_agent.tools.plumed_tools import PlumedGenerator
from md_agent.tools.wandb_tools import (
    wandb_init_run,
    wandb_log_colvar,
    wandb_log_from_edr,
    wandb_start_background_monitor,
    wandb_stop_monitor,
)
from md_agent.utils.file_utils import list_files, read_file

# ── System prompt ──────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert computational chemist and MD simulation specialist \
with deep knowledge of GROMACS and PLUMED.

## Capabilities
- Set up and run metadynamics (well-tempered & standard), umbrella sampling, and steered MD
- Read and reproduce MD protocols from scientific papers
- Monitor running simulations via wandb and interpret energy/CV convergence
- Identify and fix common GROMACS/PLUMED errors automatically

## Workflow Principles
1. Always validate Hydra config before running (call validate_config first)
2. Generate and validate the plumed.dat BEFORE calling grompp
3. Run grompp → inspect output for errors → then launch mdrun
4. Start the wandb background monitor immediately after mdrun starts
5. For metadynamics: periodically check HILLS growth and FES convergence
6. For umbrella sampling: verify CV window overlap before running WHAM
7. For steered MD: confirm pull force is within reasonable range (<500 kJ/mol typical)
8. Log all runs to wandb with full config for reproducibility

## PLUMED Critical Notes
- PLUMED atom indices are ALWAYS 1-based (not 0-based like Python/MDAnalysis)
- Add FLUSH STRIDE=100 to every plumed.dat (already in templates)
- Validate plumed.dat with `plumed driver --noatoms` before long runs
- sigma units: nm for distance CVs, radians for torsion CVs

## Common Error Patterns to Detect and Fix
- grompp: "ERROR: atom X not found" → topology file incomplete or mismatched
- grompp: "LINCS warnings" → reduce dt (try 0.001 ps) or relax constraints
- mdrun exits immediately → check .log for "Fatal error" and plumed.dat for atom index issues
- PLUMED: "Cannot find atom" → atom index is 0-based; add 1 to all indices
- PLUMED: HILLS not growing → check "-plumed" flag was passed to mdrun
- Negative pressure → box too small or equilibration insufficient; add NPT step
- wandb monitor_error → likely pyedr issue; file may be partially written (safe to ignore)

## Paper Extraction Principles
Extract ALL of: force field, water model, box type, thermostat, barostat, coupling constants,
cutoffs, timestep, simulation length, CV definitions with exact atom selections,
enhanced sampling parameters. Ask user for any missing critical parameters before running.
Always confirm extracted config with user before launching multi-hour simulations.
"""

# ── Tool definitions ───────────────────────────────────────────────────

TOOLS: list[dict[str, Any]] = [
    # ── GROMACS ──
    {
        "name": "run_grompp",
        "description": (
            "Run gmx grompp to preprocess topology and MDP into a .tpr run input file. "
            "Returns output path and any warnings/errors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mdp_file":        {"type": "string"},
                "topology_file":   {"type": "string"},
                "coordinate_file": {"type": "string"},
                "output_tpr":      {"type": "string"},
                "index_file":      {"type": ["string", "null"], "default": None},
                "max_warnings":    {"type": "integer", "default": 0},
            },
            "required": ["mdp_file", "topology_file", "coordinate_file", "output_tpr"],
        },
    },
    {
        "name": "run_mdrun",
        "description": (
            "Launch gmx mdrun (non-blocking). Supports PLUMED plugin. "
            "Returns PID and expected output file paths. "
            "Call wandb_start_background_monitor immediately after."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tpr_file":      {"type": "string"},
                "output_prefix": {"type": "string", "description": "deffnm prefix for all output files"},
                "plumed_file":   {"type": ["string", "null"], "default": None},
                "n_cores":       {"type": "integer", "default": 1},
                "gpu_id":        {"type": ["string", "null"], "default": None},
                "append":        {"type": "boolean", "default": False},
                "cpt_file":      {"type": ["string", "null"], "default": None},
                "extra_flags":   {"type": "array", "items": {"type": "string"}, "default": []},
            },
            "required": ["tpr_file", "output_prefix"],
        },
    },
    {
        "name": "wait_mdrun",
        "description": "Block until the currently running mdrun process finishes. Returns exit code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "timeout": {"type": ["integer", "null"], "default": None, "description": "seconds"},
            },
        },
    },
    {
        "name": "run_gmx_command",
        "description": "Run an arbitrary gmx analysis subcommand (e.g. energy, rms, trjconv, wham).",
        "input_schema": {
            "type": "object",
            "properties": {
                "subcommand": {"type": "string"},
                "args":       {"type": "array", "items": {"type": "string"}},
                "stdin_text": {"type": ["string", "null"], "default": None},
                "work_dir":   {"type": "string", "default": "."},
            },
            "required": ["subcommand", "args"],
        },
    },
    # ── PLUMED ──
    {
        "name": "generate_plumed_metadynamics",
        "description": "Generate a plumed.dat file for (well-tempered) metadynamics.",
        "input_schema": {
            "type": "object",
            "properties": {
                "output_path":   {"type": "string"},
                "cvs":           {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name":      {"type": "string"},
                            "type":      {"type": "string"},
                            "atoms":     {"type": "array", "items": {"type": "integer"}},
                            "reference": {"type": ["string", "null"]},
                            "rmsd_type": {"type": "string", "default": "OPTIMAL"},
                        },
                        "required": ["name", "type"],
                    },
                },
                "hills_height":   {"type": "number"},
                "hills_sigma":    {"type": "array", "items": {"type": "number"}},
                "hills_pace":     {"type": "integer"},
                "biasfactor":     {"type": ["number", "null"], "default": None},
                "temperature":    {"type": "number", "default": 300.0},
                "hills_file":     {"type": "string", "default": "HILLS"},
                "colvar_file":    {"type": "string", "default": "COLVAR"},
                "colvar_stride":  {"type": "integer", "default": 100},
            },
            "required": ["output_path", "cvs", "hills_height", "hills_sigma", "hills_pace"],
        },
    },
    {
        "name": "generate_plumed_umbrella",
        "description": "Generate plumed.dat for umbrella sampling at a given window center.",
        "input_schema": {
            "type": "object",
            "properties": {
                "output_path":    {"type": "string"},
                "cv_definition":  {"type": "object"},
                "window_center":  {"type": "number"},
                "force_constant": {"type": "number"},
                "colvar_file":    {"type": "string", "default": "COLVAR"},
                "colvar_stride":  {"type": "integer", "default": 100},
            },
            "required": ["output_path", "cv_definition", "window_center", "force_constant"],
        },
    },
    {
        "name": "generate_plumed_steered",
        "description": "Generate plumed.dat for steered MD with a moving harmonic restraint.",
        "input_schema": {
            "type": "object",
            "properties": {
                "output_path":    {"type": "string"},
                "cv_definition":  {"type": "object"},
                "initial_value":  {"type": "number"},
                "final_value":    {"type": "number"},
                "force_constant": {"type": "number"},
                "total_steps":    {"type": "integer"},
                "colvar_file":    {"type": "string", "default": "COLVAR"},
                "colvar_stride":  {"type": "integer", "default": 100},
            },
            "required": ["output_path", "cv_definition", "initial_value", "final_value",
                         "force_constant", "total_steps"],
        },
    },
    {
        "name": "validate_plumed_input",
        "description": "Dry-run validate a plumed.dat file using 'plumed driver --noatoms'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "plumed_file": {"type": "string"},
                "gro_file":    {"type": ["string", "null"], "default": None},
            },
            "required": ["plumed_file"],
        },
    },
    {
        "name": "analyze_hills",
        "description": "Run 'plumed sum_hills' to compute the free energy surface from a HILLS file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "hills_file":    {"type": "string"},
                "output_prefix": {"type": "string", "default": "fes"},
                "mintozero":     {"type": "boolean", "default": True},
                "stride":        {"type": ["integer", "null"], "default": None},
            },
            "required": ["hills_file"],
        },
    },
    # ── WandB ──
    {
        "name": "wandb_init_run",
        "description": "Initialize a wandb run and log input files as an artifact.",
        "input_schema": {
            "type": "object",
            "properties": {
                "project":      {"type": "string"},
                "run_name":     {"type": "string"},
                "config":       {"type": "object"},
                "entity":       {"type": ["string", "null"], "default": None},
                "tags":         {"type": "array", "items": {"type": "string"}, "default": []},
                "notes":        {"type": "string", "default": ""},
                "resume":       {"type": "string", "default": "auto"},
                "input_files":  {"type": "array", "items": {"type": "string"}, "default": []},
            },
            "required": ["project", "run_name", "config"],
        },
    },
    {
        "name": "wandb_log_from_edr",
        "description": "Parse a GROMACS .edr file and log energy terms to wandb.",
        "input_schema": {
            "type": "object",
            "properties": {
                "edr_file":     {"type": "string"},
                "energy_terms": {"type": "array", "items": {"type": "string"}},
                "step_offset":  {"type": "integer", "default": 0},
            },
            "required": ["edr_file", "energy_terms"],
        },
    },
    {
        "name": "wandb_log_colvar",
        "description": "Parse a PLUMED COLVAR file and log CV values to wandb.",
        "input_schema": {
            "type": "object",
            "properties": {
                "colvar_file": {"type": "string"},
                "step_col":    {"type": "string", "default": "time"},
                "from_step":   {"type": "integer", "default": 0},
                "dt":          {"type": "number", "default": 0.002},
            },
            "required": ["colvar_file"],
        },
    },
    {
        "name": "wandb_start_background_monitor",
        "description": (
            "Start a background thread that periodically tails log/edr/COLVAR/HILLS "
            "and logs to wandb. Call this immediately after run_mdrun."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "log_file":        {"type": "string"},
                "edr_file":        {"type": "string"},
                "colvar_file":     {"type": ["string", "null"], "default": None},
                "hills_file":      {"type": ["string", "null"], "default": None},
                "energy_terms":    {"type": "array", "items": {"type": "string"}, "default": []},
                "poll_interval_s": {"type": "number", "default": 30.0},
                "dt":              {"type": "number", "default": 0.002},
            },
            "required": ["log_file", "edr_file"],
        },
    },
    {
        "name": "wandb_stop_monitor",
        "description": "Stop the background monitor, flush remaining data, and call wandb.finish().",
        "input_schema": {
            "type": "object",
            "properties": {
                "final_log": {"type": "boolean", "default": True},
            },
        },
    },
    # ── Config ──
    {
        "name": "load_config",
        "description": "Load a Hydra/YAML config file and return it as a dict.",
        "input_schema": {
            "type": "object",
            "properties": {
                "config_path": {"type": "string"},
            },
            "required": ["config_path"],
        },
    },
    {
        "name": "generate_mdp_from_config",
        "description": "Generate a GROMACS .mdp file from the current Hydra config.",
        "input_schema": {
            "type": "object",
            "properties": {
                "output_path":  {"type": "string"},
                "extra_params": {"type": "object", "default": {}},
            },
            "required": ["output_path"],
        },
    },
    {
        "name": "save_config",
        "description": "Save a config dict to a YAML file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "config":      {"type": "object"},
                "output_path": {"type": "string"},
            },
            "required": ["config", "output_path"],
        },
    },
    {
        "name": "validate_config",
        "description": "Validate a config dict against the Pydantic schema. Returns errors if any.",
        "input_schema": {
            "type": "object",
            "properties": {
                "config": {"type": "object"},
            },
            "required": ["config"],
        },
    },
    # ── Paper ──
    {
        "name": "search_semantic_scholar",
        "description": "Search Semantic Scholar for papers matching a query string.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query":       {"type": "string"},
                "max_results": {"type": "integer", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "fetch_arxiv_paper",
        "description": "Fetch metadata and PDF URL for an ArXiv paper by its ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "arxiv_id": {"type": "string"},
            },
            "required": ["arxiv_id"],
        },
    },
    {
        "name": "download_pdf",
        "description": "Download a PDF from a URL to a local file path.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url":         {"type": "string"},
                "output_path": {"type": "string"},
            },
            "required": ["url", "output_path"],
        },
    },
    {
        "name": "extract_text_from_pdf",
        "description": "Extract readable text from a local PDF (focuses on Methods section).",
        "input_schema": {
            "type": "object",
            "properties": {
                "pdf_path":   {"type": "string"},
                "pages":      {"type": ["array", "null"], "items": {"type": "integer"}, "default": None},
                "max_chars":  {"type": "integer", "default": 50000},
            },
            "required": ["pdf_path"],
        },
    },
    {
        "name": "extract_md_settings_from_text",
        "description": (
            "Use Claude to extract MD simulation parameters from paper text. "
            "Returns a structured dict with gromacs/plumed/system fields."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "paper_text":  {"type": "string"},
                "paper_title": {"type": "string", "default": ""},
                "method_hint": {"type": ["string", "null"], "default": None},
            },
            "required": ["paper_text"],
        },
    },
    {
        "name": "create_config_from_extracted_settings",
        "description": (
            "Convert extracted paper MD settings into Hydra YAML config files. "
            "Returns output directory and validation status."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "settings":    {"type": "object"},
                "output_dir":  {"type": "string"},
                "config_name": {"type": "string", "default": "reproduced_config"},
            },
            "required": ["settings", "output_dir"],
        },
    },
    # ── File ──
    {
        "name": "read_file",
        "description": "Read a text file (log, dat, xvg, mdp, yaml). Supports head/tail.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "max_lines": {"type": "integer", "default": 500},
                "tail":      {"type": "boolean", "default": False},
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "list_files",
        "description": "List files in a directory matching an optional glob pattern.",
        "input_schema": {
            "type": "object",
            "properties": {
                "directory": {"type": "string"},
                "pattern":   {"type": "string", "default": "*"},
                "recursive": {"type": "boolean", "default": False},
            },
            "required": ["directory"],
        },
    },
    # ── Specialist agents ────────────────────────────────────────────────
    {
        "name": "delegate_to_specialist",
        "description": (
            "Delegate a complex sub-task to a specialist LangChain agent that has its own "
            "dedicated tools and focused system prompt. Use this when:\n"
            "  • 'paper_config'  — the user wants to extract MD settings from a published paper "
            "(provide arXiv ID, DOI, title, or a keyword query)\n"
            "  • 'analysis'      — the user wants a detailed analysis of existing simulation "
            "results (convergence, free energy landscape, sampling quality)\n"
            "  • 'cv_suggester'  — the user needs collective variable recommendations based on "
            "their molecular system and sampling goal (agent reads the structure file)\n"
            "The specialist runs autonomously and returns a structured report."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_type": {
                    "type": "string",
                    "enum": ["paper_config", "analysis", "cv_suggester"],
                    "description": "Which specialist to invoke.",
                },
                "task": {
                    "type": "string",
                    "description": (
                        "Detailed task description for the specialist. "
                        "For paper_config: include the arXiv ID or search query. "
                        "For cv_suggester: describe the molecule and the biological process of interest."
                    ),
                },
            },
            "required": ["agent_type", "task"],
        },
    },
]

# ── Agent ──────────────────────────────────────────────────────────────

class MDAgent:
    """Claude Opus 4.6 agent with 25 MD tools and adaptive thinking."""

    def __init__(self, cfg: DictConfig, work_dir: str = ".") -> None:
        self.cfg = cfg
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)

        self._client = anthropic.Anthropic()
        self._gmx = GROMACSRunner(work_dir=str(self.work_dir))
        self._plumed = PlumedGenerator()
        self._paper_retriever = PaperRetriever()
        self._settings_extractor = MDSettingsExtractor(self._client)

        self._messages: list[dict[str, Any]] = []

        # Build tool dispatch table
        self._handlers: dict[str, Any] = self._build_handlers()

    # ── Tool dispatch ───────────────────────────────────────────────────

    def _build_handlers(self) -> dict[str, Any]:
        gmx = self._gmx
        plumed = self._plumed
        pr = self._paper_retriever
        se = self._settings_extractor
        cfg = self.cfg

        def _generate_mdp(output_path: str, extra_params: dict | None = None) -> dict:
            path = generate_mdp_from_config(cfg, output_path, extra_params or {})
            return {"output_path": path}

        def _validate_config(config: dict) -> dict:
            ok, errors = validate_extracted_settings(config)
            return {"valid": ok, "errors": errors}

        return {
            # GROMACS
            "run_grompp":        gmx.grompp,
            "run_mdrun":         gmx.mdrun,
            "wait_mdrun":        gmx.wait_mdrun,
            "run_gmx_command":   gmx.run_gmx_command,
            # PLUMED
            "generate_plumed_metadynamics": plumed.generate_metadynamics,
            "generate_plumed_umbrella":     plumed.generate_umbrella,
            "generate_plumed_steered":      plumed.generate_steered,
            "validate_plumed_input":        plumed.validate_plumed_input,
            "analyze_hills":                plumed.analyze_hills,
            # WandB
            "wandb_init_run":                wandb_init_run,
            "wandb_log_from_edr":           wandb_log_from_edr,
            "wandb_log_colvar":             wandb_log_colvar,
            "wandb_start_background_monitor": wandb_start_background_monitor,
            "wandb_stop_monitor":           wandb_stop_monitor,
            # Config
            "load_config":              load_config,
            "generate_mdp_from_config": _generate_mdp,
            "save_config":              save_config,
            "validate_config":          _validate_config,
            # Paper
            "search_semantic_scholar":            pr.search_semantic_scholar,
            "fetch_arxiv_paper":                  pr.fetch_arxiv_paper,
            "download_pdf":                       pr.download_pdf,
            "extract_text_from_pdf":              pr.extract_text_from_pdf,
            "extract_md_settings_from_text":      se.extract_md_settings_from_text,
            "create_config_from_extracted_settings": se.create_config_from_extracted_settings,
            # File
            "read_file":  read_file,
            "list_files": list_files,
            # Specialist agents
            "delegate_to_specialist": self._delegate_to_specialist,
        }

    def _delegate_to_specialist(self, agent_type: str, task: str) -> dict:
        """Run a specialist LangChain agent synchronously and return its output."""
        try:
            if agent_type == "paper_config":
                from md_agent.agents.paper_agent import PaperConfigAgent
                return {"result": PaperConfigAgent().run(task)}
            elif agent_type == "analysis":
                from md_agent.agents.analysis_agent import AnalysisAgent
                return {"result": AnalysisAgent(str(self.work_dir)).run(task)}
            elif agent_type == "cv_suggester":
                from md_agent.agents.cv_agent import CVAgent
                return {"result": CVAgent(str(self.work_dir)).run(task)}
            else:
                return {"error": f"Unknown agent type: {agent_type}"}
        except Exception as exc:
            return {"error": str(exc)}

    def _execute_tool(self, name: str, inputs: dict[str, Any]) -> Any:
        handler = self._handlers.get(name)
        if handler is None:
            return {"error": f"Unknown tool: {name}"}
        try:
            return handler(**inputs)
        except Exception as exc:
            return {"error": str(exc), "tool": name}

    # ── Agentic loop ────────────────────────────────────────────────────

    def run(self, user_message: str) -> str:
        """Run the agentic loop until Claude reaches end_turn."""
        self._messages.append({"role": "user", "content": user_message})

        while True:
            response = self._client.messages.create(
                model="claude-opus-4-6",
                max_tokens=16000,
                thinking={"type": "adaptive"},
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=self._messages,
            )

            # Preserve full content (including thinking blocks) in history
            self._messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "end_turn":
                return self._extract_text(response.content)

            if response.stop_reason != "tool_use":
                # Unexpected stop reason — return what we have
                return self._extract_text(response.content)

            # Execute all tool calls and collect results
            tool_results: list[dict[str, Any]] = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                result = self._execute_tool(block.name, block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result, default=str),
                })

            self._messages.append({"role": "user", "content": tool_results})

    def stream_run(self, user_message: str) -> Generator[dict, None, None]:
        """Streaming version of run(). Yields SSE event dicts in real time.

        Event types:
          text_delta    — {"type": "text_delta", "text": str}
          thinking      — {"type": "thinking", "thinking": str}
          tool_start    — {"type": "tool_start", "tool_use_id": str, "tool_name": str, "tool_input": dict}
          tool_result   — {"type": "tool_result", "tool_use_id": str, "tool_name": str, "result": Any}
          agent_done    — {"type": "agent_done", "final_text": str}
          error         — {"type": "error", "message": str}
        """
        self._messages.append({"role": "user", "content": user_message})

        try:
            while True:
                with self._client.messages.stream(
                    model="claude-opus-4-6",
                    max_tokens=16000,
                    thinking={"type": "adaptive"},
                    system=SYSTEM_PROMPT,
                    tools=TOOLS,
                    messages=self._messages,
                ) as stream:
                    for event in stream:
                        # Text and thinking deltas arrive as content_block_delta events
                        if event.type == "content_block_delta":
                            delta = event.delta
                            if delta.type == "text_delta":
                                yield {"type": "text_delta", "text": delta.text}
                            elif delta.type == "thinking_delta":
                                yield {"type": "thinking", "thinking": delta.thinking}

                    final_message = stream.get_final_message()

                # Preserve full content in history (same as run())
                self._messages.append({"role": "assistant", "content": final_message.content})

                if final_message.stop_reason == "end_turn":
                    yield {"type": "agent_done", "final_text": self._extract_text(final_message.content)}
                    return

                if final_message.stop_reason != "tool_use":
                    yield {"type": "agent_done", "final_text": self._extract_text(final_message.content)}
                    return

                # Execute all tool calls in this response
                tool_results: list[dict[str, Any]] = []
                for block in final_message.content:
                    if block.type != "tool_use":
                        continue
                    yield {
                        "type": "tool_start",
                        "tool_use_id": block.id,
                        "tool_name": block.name,
                        "tool_input": block.input,
                    }
                    result = self._execute_tool(block.name, block.input)
                    yield {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "tool_name": block.name,
                        "result": result,
                    }
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, default=str),
                    })

                self._messages.append({"role": "user", "content": tool_results})

        except Exception as exc:
            msg = str(exc)
            if "api_key" in msg or "auth_token" in msg or "authentication" in msg.lower():
                msg = "API key is not set. Please add your Anthropic API key in Settings (top-right gear icon)."
            yield {"type": "error", "message": msg}

    @staticmethod
    def _extract_text(content: list) -> str:
        return " ".join(
            block.text for block in content
            if hasattr(block, "text") and block.type == "text"
        )
