"""GROMACS subprocess wrappers for grompp, mdrun, and analysis commands."""

from __future__ import annotations

import atexit
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class GMXResult:
    returncode: int
    stdout: str
    stderr: str
    output_files: dict[str, str] = field(default_factory=dict)

    @property
    def success(self) -> bool:
        return self.returncode == 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "returncode": self.returncode,
            "success": self.success,
            "stdout": self.stdout[-4000:] if len(self.stdout) > 4000 else self.stdout,
            "stderr": self.stderr[-4000:] if len(self.stderr) > 4000 else self.stderr,
            "output_files": self.output_files,
        }


class GROMACSRunner:
    """Manages GROMACS subprocess calls.

    ``mdrun`` is launched as a non-blocking ``Popen`` so the calling code can
    start the WandB monitor immediately after.  All other commands block.

    When ``GMX_DOCKER_IMAGE`` is set in the environment, every ``gmx`` call is
    wrapped in ``docker run --rm -w /work -v {work_dir}:/work {image} gmx ...``
    so that GROMACS runs inside the container with the session directory
    bind-mounted at ``/work``.
    """

    def __init__(self, gmx_executable: str = "gmx", work_dir: str = "."):
        self.gmx = gmx_executable
        self.work_dir = Path(work_dir)
        self._mdrun_proc: Optional[subprocess.Popen] = None
        self._docker_image: Optional[str] = os.environ.get("GMX_DOCKER_IMAGE")
        # Ensure mdrun is terminated if Python exits unexpectedly
        atexit.register(self._cleanup)

    # ── Internal helpers ────────────────────────────────────────────────

    def _build_cmd(
        self,
        gmx_args: list[str],
        work_dir: Path,
        gpu_id: Optional[str] = None,
    ) -> list[str]:
        """Return the full command list, Docker-wrapped when image is configured."""
        if self._docker_image:
            docker_prefix = [
                "docker", "run", "--rm", "-i",
                "-w", "/work",
                "-v", f"{work_dir.resolve()}:/work",
            ]
            if gpu_id:
                docker_prefix += ["--gpus", f"device={gpu_id}"]
            return docker_prefix + [self._docker_image, self.gmx] + gmx_args
        return [self.gmx] + gmx_args

    def _run(
        self,
        args: list[str],
        stdin_text: Optional[str] = None,
        timeout: Optional[int] = None,
    ) -> GMXResult:
        """Run a blocking gmx subcommand."""
        cmd = self._build_cmd(args, self.work_dir)
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if stdin_text else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(self.work_dir),
            text=True,
        )
        stdout, stderr = proc.communicate(input=stdin_text, timeout=timeout)
        return GMXResult(proc.returncode, stdout, stderr)

    def _classify_grompp_output(self, result: GMXResult) -> GMXResult:
        """Distinguish grompp warnings (non-fatal) from errors (fatal)."""
        if result.returncode != 0:
            return result
        if "ERROR" in result.stderr:
            result.returncode = 1  # treat embedded errors as failure
        return result

    def _cleanup(self) -> None:
        proc = self._mdrun_proc
        if proc is None:
            return
        try:
            if proc.poll() is None:
                # Close the stdout pipe so the process doesn't block on writes
                # while flushing output / writing checkpoint after SIGTERM.
                if proc.stdout:
                    try:
                        proc.stdout.close()
                    except Exception:
                        pass
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        except Exception:
            pass
        finally:
            self._mdrun_proc = None

    # ── Public API ──────────────────────────────────────────────────────

    def grompp(
        self,
        mdp_file: str,
        topology_file: str,
        coordinate_file: str,
        output_tpr: str,
        index_file: Optional[str] = None,
        max_warnings: int = 0,
    ) -> dict[str, Any]:
        """Prepare a GROMACS .tpr run input file."""
        args = [
            "grompp",
            "-f", mdp_file,
            "-p", topology_file,
            "-c", coordinate_file,
            "-o", output_tpr,
            "-maxwarn", str(max_warnings),
        ]
        if index_file:
            args += ["-n", index_file]

        result = self._classify_grompp_output(self._run(args))
        out = result.to_dict()
        if result.success:
            out["output_files"]["tpr"] = output_tpr
        return out

    def mdrun(
        self,
        tpr_file: str,
        output_prefix: str,
        plumed_file: Optional[str] = None,
        n_cores: int = 1,
        gpu_id: Optional[str] = None,
        append: bool = False,
        cpt_file: Optional[str] = None,
        extra_flags: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Launch gmx mdrun as a NON-BLOCKING process.

        The process handle is stored in ``self._mdrun_proc``.
        Call ``wait_mdrun()`` to block until completion.
        """
        args = [
            "mdrun", "-v",
            "-s", tpr_file,
            "-deffnm", output_prefix,
            "-ntomp", str(n_cores),
        ]
        if plumed_file:
            args += ["-plumed", plumed_file]
        if gpu_id:
            args += ["-gpu_id", gpu_id]
        if append:
            args += ["-append"]
        if cpt_file:
            args += ["-cpi", cpt_file]
        if extra_flags:
            args.extend(extra_flags)

        self._mdrun_proc = subprocess.Popen(
            self._build_cmd(args, self.work_dir, gpu_id=gpu_id),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # merge stderr into stdout for live tailing
            cwd=str(self.work_dir),
            text=True,
        )
        return {
            "pid": self._mdrun_proc.pid,
            "status": "running",
            "output_prefix": output_prefix,
            "expected_files": {
                "log": f"{output_prefix}.log",
                "edr": f"{output_prefix}.edr",
                "xtc": f"{output_prefix}.xtc",
                "cpt": f"{output_prefix}.cpt",
            },
        }

    def wait_mdrun(self, timeout: Optional[int] = None) -> dict[str, Any]:
        """Block until the running mdrun process finishes."""
        if self._mdrun_proc is None:
            return {"error": "No mdrun process is running"}
        try:
            stdout, _ = self._mdrun_proc.communicate(timeout=timeout)
            rc = self._mdrun_proc.returncode
        except subprocess.TimeoutExpired:
            self._mdrun_proc.kill()
            stdout, _ = self._mdrun_proc.communicate()
            return {"returncode": -1, "error": "mdrun timed out and was killed"}
        return {
            "returncode": rc,
            "success": rc == 0,
            "stdout": stdout[-4000:] if stdout and len(stdout) > 4000 else stdout,
        }

    def is_mdrun_running(self) -> bool:
        """Return True if an mdrun process is alive."""
        return self._mdrun_proc is not None and self._mdrun_proc.poll() is None

    def run_gmx_command(
        self,
        subcommand: str,
        args: list[str],
        stdin_text: Optional[str] = None,
        work_dir: str = ".",
    ) -> dict[str, Any]:
        """Run an arbitrary gmx analysis subcommand (blocking)."""
        wd = Path(work_dir)
        cmd = self._build_cmd([subcommand] + args, wd)
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if stdin_text else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(wd),
            text=True,
        )
        stdout, stderr = proc.communicate(input=stdin_text)
        return GMXResult(proc.returncode, stdout, stderr).to_dict()

    def check_gromacs_energy(
        self,
        edr_file: str,
        terms: list[str],
        begin_time: float = 0.0,
        end_time: float = -1.0,
    ) -> dict[str, Any]:
        """Extract energy terms from a .edr file using ``gmx energy``.

        Pipes term indices to stdin by querying available terms first.
        Returns a dict of term → list of values, plus 'time' array.
        """
        # First, get the list of available terms
        probe = self._run(
            ["energy", "-f", edr_file, "-o", "/dev/null"],
            stdin_text="0\n",   # term 0 = quit after listing
        )
        # Parse term names and their indices from the output
        term_index_map: dict[str, int] = {}
        for line in probe.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0].isdigit():
                term_index_map[" ".join(parts[1:])] = int(parts[0])

        selected_indices = []
        for term in terms:
            for available_term, idx in term_index_map.items():
                if term.lower() in available_term.lower():
                    selected_indices.append(str(idx))
                    break

        if not selected_indices:
            return {"error": f"None of {terms} found in {edr_file}"}

        stdin = "\n".join(selected_indices) + "\n0\n"
        result = self._run(
            ["energy", "-f", edr_file, "-b", str(begin_time), "-e", str(end_time)],
            stdin_text=stdin,
        )
        return {
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
