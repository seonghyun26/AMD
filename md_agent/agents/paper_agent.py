"""Paper Config Agent — extracts MD simulation settings from published papers.

Workflow
--------
1. Accept an arXiv ID, DOI, title, or keyword search query
2. Locate and download the paper (Semantic Scholar or arXiv)
3. Extract the Methods section text via pdfplumber
4. Use Claude to parse structured MD settings (GROMACS + PLUMED)
5. Return a clear structured summary ready for the user to apply
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from langchain_core.tools import tool

from md_agent.agents.base import build_executor, stream_executor, sync_run
from md_agent.tools.paper_tools import MDSettingsExtractor, PaperRetriever

# ── Singleton helpers (shared across tool calls in one session) ────────

_retriever = PaperRetriever()
_extractor: MDSettingsExtractor | None = None  # lazy — needs Anthropic client


def _get_extractor() -> MDSettingsExtractor:
    global _extractor
    if _extractor is None:
        import anthropic

        _extractor = MDSettingsExtractor(anthropic.Anthropic())
    return _extractor


# ── Tools ──────────────────────────────────────────────────────────────


@tool
def search_papers(query: str) -> str:
    """Search Semantic Scholar for MD-related papers matching a keyword query.
    Returns a JSON list of up to 5 papers with title, abstract, authors, year, and PDF URL.
    """
    results = _retriever.search_semantic_scholar(query, limit=5)
    return json.dumps(results, default=str, indent=2)


@tool
def fetch_arxiv_paper(arxiv_id: str) -> str:
    """Fetch paper metadata from arXiv by paper ID (e.g. '2301.12345' or '2301.12345v2').
    Returns title, abstract, PDF URL, authors, published date, and arXiv categories.
    """
    result = _retriever.fetch_arxiv_paper(arxiv_id)
    return json.dumps(result, default=str, indent=2)


@tool
def download_and_read_paper(pdf_url: str) -> str:
    """Download a paper PDF from a URL and extract the Methods section text (up to 30 000 chars).
    Focuses on the Methods / Simulation Details section where MD parameters are described.
    """
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        _retriever.download_pdf(pdf_url, str(tmp_path))
        text = _retriever.extract_text_from_pdf(str(tmp_path))
        return text[:30_000] if len(text) > 30_000 else text
    finally:
        tmp_path.unlink(missing_ok=True)


@tool
def extract_md_settings_from_paper(paper_text: str, paper_title: str = "") -> str:
    """Use Claude to parse structured MD simulation settings from paper text.
    Returns a JSON object with gromacs, plumed, and system sections.
    All values are unit-normalised to GROMACS conventions (ps, nm, kJ/mol, K).
    """
    result = _get_extractor().extract_md_settings_from_text(paper_text, paper_title=paper_title)
    return json.dumps(result, default=str, indent=2)


TOOLS = [search_papers, fetch_arxiv_paper, download_and_read_paper, extract_md_settings_from_paper]

# ── RCSB PDB tools ─────────────────────────────────────────────────────


@tool
def search_rcsb_pdb(query: str) -> str:
    """Search the RCSB Protein Data Bank for protein structures matching a keyword query.
    Returns a list of PDB IDs with titles and organism information.
    Use this to find relevant structures before downloading them with download_pdb_to_session.
    """
    import urllib.error
    import urllib.request

    search_query = {
        "query": {
            "type": "terminal",
            "service": "full_text",
            "parameters": {"value": query},
        },
        "return_type": "entry",
        "request_options": {"results_limit": 10},
    }
    url = "https://search.rcsb.org/rcsbsearch/v2/query"
    data = json.dumps(search_query).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
        pdb_ids = [r["identifier"] for r in result.get("result_set", [])]
        if not pdb_ids:
            return json.dumps({"results": [], "message": "No structures found."})
        entries = []
        for pid in pdb_ids[:8]:
            try:
                meta_url = f"https://data.rcsb.org/rest/v1/core/entry/{pid}"
                with urllib.request.urlopen(meta_url, timeout=10) as mr:
                    meta = json.loads(mr.read())
                title = meta.get("struct", {}).get("title", "Unknown")
                names = meta.get("rcsb_entry_info", {}).get("source_organism_names")
                organism = names[0] if names else "Unknown"
                entries.append({"pdb_id": pid, "title": title, "organism": organism})
            except Exception:
                entries.append({"pdb_id": pid})
        return json.dumps({"results": entries}, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


def _make_config_tools(work_dir: str, session):
    """Return tools that write to this session's config — scoped to work_dir."""

    wd = Path(work_dir).resolve()

    @tool
    def update_session_config(updates_json: str) -> str:
        """Apply MD settings to this session-root config.yaml and regenerate md.mdp.
        updates_json: JSON object with OmegaConf dot-key → value pairs.
        Example: {"gromacs.temperature": 300, "gromacs.nsteps": 5000000, "system.forcefield": "amber99sb-ildn"}
        Only modifies the config of the current session — never touches other sessions.
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
            # Save to this session root's config.yaml (sibling of data/)
            cfg_path = wd.parent / "config.yaml"
            OmegaConf.save(cfg, str(cfg_path))
            # Regenerate md.mdp from updated config
            from md_agent.config.hydra_utils import generate_mdp_from_config

            generate_mdp_from_config(cfg, str(wd / "md.mdp"))
            return json.dumps(
                {"updated": True, "applied_keys": applied, "config_path": str(cfg_path)}
            )
        except Exception as e:
            return json.dumps({"error": str(e)})

    return [update_session_config]


def _make_download_pdb_tool(work_dir: str):
    """Return a download_pdb_to_session tool bound to the given work_dir."""

    @tool
    def download_pdb_to_session(pdb_id: str) -> str:
        """Download a PDB structure file from RCSB and save it to the session directory.
        pdb_id: 4-character PDB identifier (e.g. '1AKI', '1UBQ', '2JOF').
        Returns the saved file path on success.
        Always call search_rcsb_pdb first to confirm the correct PDB ID.
        """
        import urllib.request
        from pathlib import Path

        pid = pdb_id.strip().upper()
        url = f"https://files.rcsb.org/download/{pid}.pdb"
        dest = Path(work_dir) / f"{pid}.pdb"
        try:
            urllib.request.urlretrieve(url, str(dest))
            return json.dumps({"saved_path": str(dest), "pdb_id": pid, "filename": f"{pid}.pdb"})
        except Exception as e:
            return json.dumps({"error": f"Failed to download {pid}: {e}"})

    return download_pdb_to_session


# ── System prompt ──────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a specialist agent for molecular dynamics simulation setup with two capabilities:

## Capability 1 — Extract MD settings from a scientific paper
Given a paper identifier (arXiv ID, DOI, title, or search query):
1. If an arXiv ID is provided (e.g. "2301.12345"), use `fetch_arxiv_paper` directly
2. Otherwise use `search_papers` to find the most relevant paper
3. Download and read the full paper using `download_and_read_paper`
4. Extract all MD parameters using `extract_md_settings_from_paper`
5. Present a clear, organised summary with sections: System, Sampling method, GROMACS parameters, PLUMED/CVs, Settings to confirm

## Capability 2 — Find and download a PDB structure
When the user asks to find or download a protein structure:
1. Use `search_rcsb_pdb` to search the RCSB Protein Data Bank
2. Show the user the top results (PDB ID, title, organism) and confirm the best match
3. Use `download_pdb_to_session` to download the chosen PDB file into the session directory
4. Report the saved filename so the user can select it in the Molecule pane

## Applying extracted settings (Capability 3)
After extracting settings from a paper, offer to apply them:
- Use `update_session_config` with a JSON object of dot-key → value pairs
- Only update keys that were clearly stated in the paper; leave others unchanged
- Always confirm with the user which settings will be applied before calling the tool

## Critical rules
- PLUMED atom indices are **1-based** (GROMACS convention after `pdb2gmx`)
- Time unit: ps | Distance: nm | Energy: kJ/mol | Temperature: K | Pressure: bar
- Flag clearly if a required parameter was NOT found in the paper
- After downloading a PDB, tell the user to go to the Molecule tab and click Select on the new file
- `update_session_config` only modifies the current session — it cannot affect other sessions
"""


# ── Agent class ────────────────────────────────────────────────────────


class PaperConfigAgent:
    """LangChain specialist agent that extracts MD settings from papers and downloads PDB files."""

    def __init__(self, work_dir: str = "", session=None, api_key: str | None = None) -> None:
        tools = list(TOOLS) + [search_rcsb_pdb]
        if work_dir:
            tools.append(_make_download_pdb_tool(work_dir))
        if work_dir and session is not None:
            tools.extend(_make_config_tools(work_dir, session))
        self.executor = build_executor(SYSTEM_PROMPT, tools, max_iterations=12, api_key=api_key)

    def run(self, query: str) -> str:
        """Synchronous run — returns final text output."""
        return sync_run(self.executor, query)

    async def astream(self, query: str):
        """Async streaming — yields SSE event dicts."""
        async for event in stream_executor(self.executor, query):
            yield event
