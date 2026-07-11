"""Paper retrieval and MD settings extraction from scientific literature."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from md_agent.utils.parsers import normalize_extracted_settings

# ── Semantic Scholar ───────────────────────────────────────────────────

_S2_BASE = "https://api.semanticscholar.org/graph/v1"
_DEFAULT_FIELDS = [
    "title",
    "abstract",
    "year",
    "authors",
    "externalIds",
    "openAccessPdf",
    "url",
]


class PaperRetriever:
    """Retrieves papers from Semantic Scholar and ArXiv."""

    def __init__(self, s2_api_key: str | None = None) -> None:
        self._s2_headers = {"x-api-key": s2_api_key} if s2_api_key else {}

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    def search_semantic_scholar(
        self,
        query: str,
        max_results: int = 10,
        fields: list[str] | None = None,
    ) -> dict[str, Any]:
        """Search Semantic Scholar for papers matching a query."""
        fields = fields or _DEFAULT_FIELDS
        resp = requests.get(
            f"{_S2_BASE}/paper/search",
            params={"query": query, "limit": max_results, "fields": ",".join(fields)},
            headers=self._s2_headers,
            timeout=30,
        )
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 5))
            time.sleep(retry_after)
            resp.raise_for_status()
        resp.raise_for_status()
        data = resp.json().get("data", [])
        # Simplify: flatten openAccessPdf
        for paper in data:
            pdf_info = paper.pop("openAccessPdf", None)
            paper["pdf_url"] = pdf_info.get("url") if pdf_info else None
        return {"papers": data, "total": len(data)}

    def fetch_arxiv_paper(self, arxiv_id: str) -> dict[str, Any]:
        """Fetch metadata and PDF URL for an ArXiv paper by ID."""
        try:
            import arxiv  # type: ignore
        except ImportError:
            return {"error": "arxiv package not installed. Run: pip install arxiv"}

        client = arxiv.Client()
        results = list(client.results(arxiv.Search(id_list=[arxiv_id])))
        if not results:
            return {"error": f"ArXiv paper '{arxiv_id}' not found"}
        paper = results[0]
        return {
            "arxiv_id": arxiv_id,
            "title": paper.title,
            "abstract": paper.summary,
            "pdf_url": paper.pdf_url,
            "authors": [a.name for a in paper.authors],
            "published": str(paper.published),
            "categories": paper.categories,
        }

    def download_pdf(self, url: str, output_path: str) -> dict[str, Any]:
        """Download a PDF from a URL to a local path."""
        try:
            resp = requests.get(url, timeout=60, stream=True)
            resp.raise_for_status()
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=8192):
                    fh.write(chunk)
            size_kb = Path(output_path).stat().st_size // 1024
            return {"output_path": output_path, "size_kb": size_kb}
        except Exception as exc:
            return {"error": str(exc)}

    def extract_text_from_pdf(
        self,
        pdf_path: str,
        pages: list[int] | None = None,
        max_chars: int = 50000,
    ) -> dict[str, Any]:
        """Extract readable text from a PDF using pdfplumber.

        Heuristic: finds the Methods/Simulation section and starts extraction there.
        """
        try:
            import pdfplumber  # type: ignore
        except ImportError:
            return {"error": "pdfplumber not installed. Run: pip install pdfplumber"}

        if not Path(pdf_path).exists():
            return {"error": f"PDF not found: {pdf_path}"}

        text_parts: list[str] = []
        try:
            with pdfplumber.open(pdf_path) as pdf:
                page_list = (
                    [pdf.pages[i] for i in pages if i < len(pdf.pages)] if pages else pdf.pages
                )
                for page in page_list:
                    extracted = page.extract_text()
                    if extracted:
                        text_parts.append(extracted)
        except Exception as exc:
            return {"error": f"PDF extraction failed: {exc}"}

        full_text = "\n".join(text_parts)
        # Heuristic: find Methods section
        methods_markers = [
            "methods",
            "simulation details",
            "computational details",
            "simulation protocol",
            "molecular dynamics simulation",
            "simulation setup",
            "computational methods",
        ]
        lower = full_text.lower()
        best_start = 0
        for marker in methods_markers:
            idx = lower.find(marker)
            if idx > 0:
                best_start = max(0, idx - 200)
                break

        excerpt = full_text[best_start : best_start + max_chars]
        return {
            "text": excerpt,
            "total_pages": len(text_parts),
            "chars_extracted": len(excerpt),
            "methods_section_found": best_start > 0,
        }


# ── MD settings extraction via Claude ─────────────────────────────────

_EXTRACTION_PROMPT = """\
You are an expert computational chemist. Extract ALL molecular dynamics simulation \
parameters from the paper text below.

Paper title: {title}
Expected method (if known): {method_hint}

Return ONLY a valid JSON object with exactly this structure (use null for missing values):
{{
  "method": "metadynamics|umbrella|steered|plain",
  "gromacs": {{
    "integrator": null,
    "dt": null,
    "temperature": null,
    "pressure": null,
    "nsteps": null,
    "tcoupl": null,
    "pcoupl": null,
    "constraints": null,
    "rcoulomb": null,
    "rvdw": null,
    "coulombtype": null
  }},
  "plumed": {{
    "cvs": [],
    "hills_height": null,
    "hills_height_unit": "kJ/mol",
    "hills_sigma": [],
    "sigma_unit": "nm",
    "hills_pace": null,
    "biasfactor": null,
    "force_constant": null,
    "force_constant_unit": "kJ/mol/nm^2",
    "pull_rate": null
  }},
  "system": {{
    "forcefield": null,
    "water_model": null,
    "box_type": null,
    "n_atoms": null
  }},
  "notes": "Parameters not captured above or ambiguous values",
  "confidence": "low|medium|high"
}}

For each CV in the "cvs" array use this format:
  {{"name": "cv1", "type": "DISTANCE|TORSION|ANGLE|RMSD", "atoms": [1, 2], "reference": null}}

IMPORTANT:
- Atom indices must be 1-based (PLUMED convention)
- dt in ps (convert from fs if needed: 2 fs = 0.002 ps)
- Temperature in Kelvin, pressure in bar
- Distance in nm, energy in kJ/mol (note if paper uses kcal/mol or Angstrom)
- If simulation length is given in ns, convert to steps: nsteps = length_ns * 1000 / dt_ps

Paper text:
{text}
"""


class MDSettingsExtractor:
    """Extracts structured MD parameters from paper text via a nested Claude call."""

    def __init__(self, anthropic_client: Any) -> None:
        self._client = anthropic_client

    def extract_md_settings_from_text(
        self,
        paper_text: str,
        paper_title: str = "",
        method_hint: str | None = None,
    ) -> dict[str, Any]:
        """Send paper text to Claude and extract MD simulation parameters.

        Returns a structured dict matching ExtractedPaperSettings schema.
        """
        prompt = _EXTRACTION_PROMPT.format(
            title=paper_title or "Unknown",
            method_hint=method_hint or "auto-detect",
            text=paper_text[:40000],  # stay well within context window
        )

        try:
            response = self._client.messages.create(
                model="claude-opus-4-6",
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
        except Exception as exc:
            return {"error": f"Claude API call failed: {exc}"}

        raw_text = "".join(block.text for block in response.content if hasattr(block, "text"))

        # Extract JSON from response (may be wrapped in markdown code block)
        json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if not json_match:
            return {
                "error": "No JSON found in extraction response",
                "raw_response": raw_text[:2000],
            }

        try:
            settings = json.loads(json_match.group())
        except json.JSONDecodeError as exc:
            return {"error": f"JSON parse error: {exc}", "raw_response": raw_text[:2000]}

        # Apply unit normalization
        settings = normalize_extracted_settings(settings)
        return settings

    def create_config_from_extracted_settings(
        self,
        settings: dict[str, Any],
        output_dir: str,
        config_name: str = "reproduced_config",
    ) -> dict[str, Any]:
        """Convert extracted paper settings to Hydra YAML config files.

        Saves:
          {output_dir}/{config_name}/config.yaml       — root override config
          {output_dir}/{config_name}/gromacs.yaml      — MDP parameters
          {output_dir}/{config_name}/method.yaml       — method-specific params
          {output_dir}/{config_name}/cvs.yaml          — collective variables
        """
        from omegaconf import OmegaConf

        from md_agent.config.schemas import validate_extracted_settings

        is_valid, errors = validate_extracted_settings(settings)
        output = Path(output_dir) / config_name
        output.mkdir(parents=True, exist_ok=True)

        saved_files: list[str] = []

        def _save(name: str, data: dict) -> None:
            path = str(output / name)
            (output / name).write_text(OmegaConf.to_yaml(OmegaConf.create(data)))
            saved_files.append(path)

        # Gromacs params
        if settings.get("gromacs"):
            _save("gromacs.yaml", {k: v for k, v in settings["gromacs"].items() if v is not None})

        # Method + PLUMED params
        method = settings.get("method", "plain")
        plumed = settings.get("plumed", {})
        method_data: dict[str, Any] = {"_target_name": method}
        if method == "metadynamics":
            method_data["hills"] = {
                k: plumed.get(k)
                for k in ("hills_height", "hills_sigma", "hills_pace", "biasfactor")
                if plumed.get(k) is not None
            }
        elif method in ("umbrella", "steered"):
            method_data["pull"] = {
                k: plumed.get(k)
                for k in ("force_constant", "pull_rate")
                if plumed.get(k) is not None
            }
        _save("method.yaml", method_data)

        # CVs
        if plumed.get("cvs"):
            _save("cvs.yaml", {"cvs": plumed["cvs"]})

        # Root summary
        root_config = {
            "reproduced_from": settings.get("notes", ""),
            "confidence": settings.get("confidence", "medium"),
            "method": method,
            "validation_errors": errors,
        }
        _save("config.yaml", root_config)

        return {
            "output_dir": str(output),
            "saved_files": saved_files,
            "is_valid": is_valid,
            "validation_errors": errors,
            "settings_summary": {
                "method": method,
                "temperature": settings.get("gromacs", {}).get("temperature"),
                "forcefield": settings.get("system", {}).get("forcefield"),
                "n_cvs": len(plumed.get("cvs", [])),
            },
        }
