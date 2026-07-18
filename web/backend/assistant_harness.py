"""Deterministic, guarded actions available to the project AI assistant.

The conversational backbones remain read-only. This module recognizes a small,
explicit set of high-confidence requests and performs the corresponding server
action through the normal session lifecycle. New simulation creation deliberately
stops at configuration; it never launches GROMACS.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

_SYSTEM_ALIASES = {
    "ala dipeptide": "ala_dipeptide",
    "alanine dipeptide": "ala_dipeptide",
    "chignolin": "chignolin",
    "trp-cage": "trp_cage",
    "trp cage": "trp_cage",
    "villin": "villin",
    "bba": "bba",
}
_CREATE_VERB = re.compile(r"\b(?:create|set\s+up|start|run|test|simulate)\b", re.IGNORECASE)
_DURATION = re.compile(
    r"\b(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>fs|ps|ns|us|microseconds?|nanoseconds?|picoseconds?|femtoseconds?)\b",
    re.IGNORECASE,
)
_QUESTION_PREFIX = re.compile(r"^\s*(?:can|could|would|should|how|what|why)\b", re.IGNORECASE)
_STATE_TOPIC = re.compile(
    r"\b(?:status|selected|selection|coordinates?|initial\s+(?:state|structure)|"
    r"starting\s+structure|configured\s+(?:molecule|structure))\b",
    re.IGNORECASE,
)
_STATE_QUESTION = re.compile(
    r"^\s*(?:is|are|what|which|has|have|does|do|confirm|now)\b|"
    r"\b(?:right|correct)\s*[?.!]*\s*$",
    re.IGNORECASE,
)
_READINESS_QUESTION = re.compile(
    r"\bready\b.{0,80}\b(?:run|start|launch)\b|" r"\b(?:run|start|launch)\b.{0,80}\bready\b",
    re.IGNORECASE,
)
_PS_PER_UNIT = {
    "fs": 0.001,
    "femtosecond": 0.001,
    "femtoseconds": 0.001,
    "ps": 1.0,
    "picosecond": 1.0,
    "picoseconds": 1.0,
    "ns": 1_000.0,
    "nanosecond": 1_000.0,
    "nanoseconds": 1_000.0,
    "us": 1_000_000.0,
    "microsecond": 1_000_000.0,
    "microseconds": 1_000_000.0,
}
_DT_PS = 0.002
_SHORT_UNIT = {
    "fs": "fs",
    "femtosecond": "fs",
    "femtoseconds": "fs",
    "ps": "ps",
    "picosecond": "ps",
    "picoseconds": "ps",
    "ns": "ns",
    "nanosecond": "ns",
    "nanoseconds": "ns",
    "us": "us",
    "microsecond": "us",
    "microseconds": "us",
}

# This is intentionally limited to actions that the project/general assistant
# can execute itself. It is not a catalogue of every backend endpoint. Prompts
# are kept server-side so a UI button cannot silently change an action's scope.
ASSISTANT_ACTIONS: tuple[dict[str, str], ...] = (
    {
        "name": "create_simulation",
        "title": "Create simulation configuration",
        "description": "Create a configured, non-running plain-MD simulation from an explicit molecule and duration.",
        "safety": "Creates a standby session only; it never starts GROMACS.",
        "scope": "project_or_general",
    },
    {
        "name": "analyze_simulation",
        "title": "Analyze results",
        "description": "Inspect one simulation's local outputs and report stability, sampling, and convergence.",
        "safety": "Read-only; never starts, stops, or changes a simulation.",
        "scope": "simulation",
    },
    {
        "name": "start_simulation",
        "title": "Start simulation",
        "description": "Validate one simulation's start prerequisites and available storage, then launch its managed MD pipeline when safe.",
        "safety": "Starts GROMACS only after deterministic configuration, input, run-state, and disk-space checks pass.",
        "scope": "simulation",
    },
    {
        "name": "inspect_molecular_system",
        "title": "Inspect molecular system",
        "description": "Identify the configured system and assess its structure and topology inputs.",
        "safety": "Read-only; suggestions are not downloaded or applied automatically.",
        "scope": "simulation",
    },
    {
        "name": "inspect_simulation_state",
        "title": "Inspect simulation state",
        "description": "Report the persisted initial structure and run state from one simulation's metadata and configuration.",
        "safety": "Read-only and deterministic; never relies on chat history or changes the simulation.",
        "scope": "simulation",
    },
    {
        "name": "check_run_readiness",
        "title": "Check run readiness",
        "description": "Check whether one standby simulation has the source inputs and configuration needed to start its managed run pipeline.",
        "safety": "Read-only; understands which preparation and initialization files are generated automatically at run time.",
        "scope": "simulation",
    },
    {
        "name": "review_initial_configuration",
        "title": "Review initial configuration",
        "description": "Review one system's initial GROMACS configuration and propose a concrete, justified patch.",
        "safety": "Read-only; reports recommendations without changing config.yaml or generated files.",
        "scope": "simulation",
    },
    {
        "name": "research_cv_publications",
        "title": "Research CV publications",
        "description": "Find relevant publications for collective-variable choices, then relate them to one configured system.",
        "safety": "Read-only; publication metadata is searched, but CVs and PLUMED files are not changed.",
        "scope": "simulation",
    },
)

_ACTION_PROMPTS: dict[str, str] = {
    "analyze_simulation": """\
Run the registered **Analyze results** action for exactly this simulation.

Simulation: {nickname}
System: {system}

Inspect the files available in the current simulation directory. Summarize the
trajectory, thermodynamic outputs, collective variables, bias history, run log,
and free-energy results when present. Assess stability, sampling, convergence,
and obvious setup/runtime problems. Distinguish observed evidence from inference
and explicitly list missing files or analyses. Do not modify files or processes.
User focus: {user_request}
""",
    "inspect_molecular_system": """\
Run the registered **Inspect molecular system** action for exactly this simulation.

Simulation: {nickname}
Configured system: {system}

Inspect config.yaml and all local coordinate/topology/index inputs. Identify the
molecule and conformational state as precisely as the files allow; check whether
the selected coordinates, topology, force field, solvent, and index are mutually
consistent. If an input is missing, recommend suitable structure records or a
preparation/search route, but give a PDB ID only when it is verified in local
metadata. Do not download or change anything. Clearly separate local evidence
from recommendations.
User focus: {user_request}
""",
    "check_run_readiness": """\
Run the registered **Check run readiness** action for exactly this simulation.

Simulation: {nickname}
Configured system: {system}

Decide whether the simulation can enter the AMD managed run pipeline. Inspect
the selected raw coordinate file and config.yaml. Report **Not ready** only for
a genuine pre-run blocker, such as a missing/unreadable selected source
structure, invalid required configuration, or a missing PLUMED input required by
the selected enhanced-sampling method. Otherwise report **Ready**, with optional
non-blocking recommendations clearly labeled as such.

Do not modify, generate, or launch anything.
User focus: {user_request}
""",
    "review_initial_configuration": """\
Run the registered **Review initial configuration** action for exactly this simulation.

Simulation: {nickname}
Configured system: {system}

Read config.yaml and generated GROMACS/PLUMED inputs. Review the initial system
configuration: coordinates/topology, force field and water model, box and ions,
energy minimization, NVT/NPT equilibration, temperature/pressure coupling,
timestep, constraints, non-bonded settings, output cadence, and production
length. Identify only blocking issues and the highest-value recommendations.
Provide a dot-key/value patch only when the user explicitly requests one. Do not
edit or regenerate files.
User focus: {user_request}
""",
    "research_cv_publications": """\
Run the registered **Research CV publications** action for exactly this simulation.

Simulation: {nickname}
Configured system: {system}

First inspect the local structure, topology, config, and any current plumed.dat.
Use only the publication metadata supplied below as verified bibliography; never
invent a title, DOI, author, year, or URL. Explain which collective variables the
papers used or support for this molecular system/process, then recommend a small
ranked CV set. For each recommendation give the physical rationale, limitations,
and a PLUMED-style definition. Give atom indices only when they can be verified
from the local post-topology structure; otherwise state exactly what mapping is
needed. Do not edit config.yaml or PLUMED files.

Publication search evidence:
{evidence}

User focus: {user_request}
""",
}

_PUBLICATION_ACTIONS = {"research_cv_publications"}
_DETERMINISTIC_ACTIONS = {"inspect_simulation_state", "start_simulation"}
_RUN_PIPELINE_ACTIONS = {"check_run_readiness", "review_initial_configuration"}
_RUN_PIPELINE_CONTEXT = """

AMD managed run lifecycle (authoritative for readiness/review):
1. Start uses the selected raw structure from session metadata/system.coordinates.
2. Every start regenerates processed coordinates and topology. For solvated
   systems it then builds the box, solvates, and neutralizes with ions.
3. With initialization enabled, it generates and runs EM, then NVT, then NPT
   (NPT is skipped for vacuum) before the Main simulation.
4. EM/NVT/NPT MDP/TPR/GRO/CPT files are generated just in time. Their absence in
   a standby session is expected and must never be reported as a readiness fault.
5. topol.top, index.ndx, processed/boxed/solvated/ionized structures, and final
   box contents may also be absent before Start. Do not judge the eventual box,
   solvent, or ions from a seeded system.gro preview.
6. method.nsteps is the authoritative Main simulation length and overrides the
   retired gromacs.nsteps key when md.mdp is generated. If an old config file
   still contains gromacs.nsteps, ignore it completely: report only the
   method.nsteps duration and never describe a conflict or request confirmation.
7. Initialization overrides velocity handling: NVT generates velocities; NPT
   continues them; the Main simulation continues from the final initialization
   checkpoint. Do not treat the base gen_vel value as a production fault.
8. Plain MD does not generate or run PLUMED. Ignore an old generic d1
   DISTANCE(1,2) placeholder or stale plumed.dat for plain MD; only evaluate CV
   definitions when the selected method is enhanced sampling.
9. For CHARMM36m, the expected GROMACS non-bonded profile is Verlet with
   rlist=rcoulomb=rvdw=1.2 nm, vdwtype=Cut-off, vdw-modifier=Force-switch, and
   rvdw-switch=1.0 nm. Do not recommend a generic 1.0 nm cutoff for CHARMM36m.
"""
_RESPONSE_STYLE = """

Default response style:
- Do not narrate file searches, tool calls, or intermediate reasoning.
- Unless the user explicitly asks for detail, return only the highest-priority
  findings as a numbered list (at most five). Use: **Problem** — brief evidence/impact.
  **Suggested fix:** one brief action.
- Do not provide a parameter-by-parameter review, full file inventory, long
  background explanation, commands, or a configuration patch by default.
- If the user explicitly asks for more detail, evidence, reasoning, commands, or
  a patch, expand only the requested items.
"""


@dataclass(frozen=True)
class SimulationCreationPlan:
    """A complete, non-running session setup inferred from one user request."""

    system: str
    duration_ps: float
    nsteps: int
    duration_label: str
    preset: str
    gromacs: str

    @property
    def nickname(self) -> str:
        """Short user-facing title, e.g. ``Chignolin-1ns``."""
        system_label = self.system.replace("_", "-").capitalize()
        return f"{system_label}-{self.duration_label}"

    @property
    def work_dir_slug(self) -> str:
        """Unique on-disk name; timestamps stay out of the visible title."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        return f"{self.system}-{self.duration_label}-{timestamp}"


def parse_simulation_creation(message: str) -> SimulationCreationPlan | None:
    """Return a creation plan only for an explicit, fully specified request.

    A molecule and duration are mandatory. Questions such as ``Can I run ...?``
    stay with the read-only assistant, avoiding surprise session creation.
    """
    if (
        not message
        or "?" in message
        or _QUESTION_PREFIX.match(message)
        or not _CREATE_VERB.search(message)
    ):
        return None

    normalized = " ".join(message.lower().replace("_", " ").split())
    system = next((value for alias, value in _SYSTEM_ALIASES.items() if alias in normalized), None)
    duration = _DURATION.search(normalized)
    if not system or not duration:
        return None

    value = float(duration.group("value"))
    unit = duration.group("unit").lower()
    duration_ps = value * _PS_PER_UNIT[unit]
    if duration_ps <= 0:
        return None

    nsteps = round(duration_ps / _DT_PS)
    if nsteps < 1 or nsteps > 500_000_000:
        return None

    duration_label = f"{value:g}{_SHORT_UNIT[unit]}"
    # Plain MD is the safe default for an unqualified request. Enhanced-sampling
    # methods require additional CV/bias parameters and should be specified
    # through the configuration workflow instead of guessed here.
    return SimulationCreationPlan(
        system=system,
        duration_ps=duration_ps,
        nsteps=nsteps,
        duration_label=duration_label,
        preset="md",
        gromacs="tip3p" if system != "ala_dipeptide" else "vacuum",
    )


def is_simulation_state_query(message: str) -> bool:
    """Recognize direct questions about one simulation's persisted state.

    Declarative mutation requests such as ``I want the initial state folded``
    deliberately do not match: this harness reports state but never changes it.
    """
    text = " ".join(str(message or "").split())
    if not text or not _STATE_TOPIC.search(text):
        return False
    return "?" in text or bool(_STATE_QUESTION.search(text))


def is_simulation_readiness_query(message: str) -> bool:
    """Recognize questions asking whether the selected simulation can run."""
    text = " ".join(str(message or "").split())
    return bool(text and _READINESS_QUESTION.search(text))


def list_assistant_actions() -> list[dict[str, str]]:
    """Return the public registry of executable assistant actions."""
    return [dict(action) for action in ASSISTANT_ACTIONS]


def is_simulation_action(name: str) -> bool:
    """Return whether *name* is a registered, structured simulation action."""
    return name in _ACTION_PROMPTS or name in _DETERMINISTIC_ACTIONS


def action_needs_publications(name: str) -> bool:
    """Return whether an action needs a publication-metadata lookup first."""
    return name in _PUBLICATION_ACTIONS


def build_action_prompt(
    name: str,
    *,
    nickname: str,
    system: str,
    user_request: str = "",
    evidence: str = "No external evidence was collected.",
) -> str:
    """Render one trusted server-side action template.

    Dynamic values are bounded before interpolation. This prevents an action
    request from turning into an unbounded second prompt while still allowing a
    short focus supplied by the user-facing button or chat input.
    """
    template = _ACTION_PROMPTS.get(name)
    if template is None:
        raise ValueError(f"Unknown assistant action: {name}")

    def bounded(value: str, limit: int, fallback: str) -> str:
        clean = " ".join(str(value or "").split())
        return clean[:limit] or fallback

    prompt = template.format(
        nickname=bounded(nickname, 160, "unnamed simulation"),
        system=bounded(system, 160, "unknown (inspect local inputs)"),
        user_request=bounded(user_request, 600, "No additional focus."),
        evidence=str(evidence or "No external evidence was collected.")[:20_000],
    )
    if name in _RUN_PIPELINE_ACTIONS:
        prompt += _RUN_PIPELINE_CONTEXT
    return prompt + _RESPONSE_STYLE


def build_creation_summary(plan: SimulationCreationPlan, nickname: str) -> str:
    """Human-readable completion message for the assistant SSE stream."""
    return (
        f"Created `{nickname}` in standby: {plan.system.replace('_', ' ')}, "
        f"plain MD, {plan.duration_label} ({plan.nsteps:,} steps at 2 fs), "
        f"and {'TIP3P solvent' if plan.gromacs == 'tip3p' else 'vacuum'}. "
        "Review the configuration, then start it from the simulation workspace."
    )
