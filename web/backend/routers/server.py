"""Server status endpoints — GPU/CPU monitoring and resource tracking."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()


def _nvidia_smi_query() -> list[dict]:
    """Query nvidia-smi for per-GPU stats. Returns [] on failure."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return []
        gpus = []
        for line in result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 6:
                continue
            gpus.append(
                {
                    "index": int(parts[0]),
                    "name": parts[1],
                    "memory_used_mb": int(parts[2]),
                    "memory_total_mb": int(parts[3]),
                    "utilization_pct": int(parts[4]),
                    "temperature_c": int(parts[5]),
                }
            )
        return gpus
    except Exception:
        return []


def _nvidia_smi_processes() -> list[dict]:
    """Query nvidia-smi for GPU compute processes."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=gpu_uuid,pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return []
        # Map GPU UUID → index
        uuid_result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        uuid_to_idx: dict[str, int] = {}
        for line in uuid_result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2:
                uuid_to_idx[parts[1]] = int(parts[0])

        procs = []
        for line in result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                continue
            gpu_uuid = parts[0]
            procs.append(
                {
                    "gpu_index": uuid_to_idx.get(gpu_uuid, -1),
                    "pid": int(parts[1]),
                    "memory_mb": int(parts[2]),
                }
            )
        return procs
    except Exception:
        return []


def _cpu_info() -> dict:
    """Return basic CPU utilization info."""
    try:
        # Use /proc/loadavg for load averages
        loadavg = Path("/proc/loadavg").read_text().split()
        # Count CPUs
        cpu_count = 0
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("processor"):
                    cpu_count += 1

        # Memory from /proc/meminfo
        meminfo: dict[str, int] = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(":"):
                    key = parts[0].rstrip(":")
                    meminfo[key] = int(parts[1])  # kB

        mem_total_mb = meminfo.get("MemTotal", 0) // 1024
        mem_avail_mb = meminfo.get("MemAvailable", meminfo.get("MemFree", 0)) // 1024

        # Disk usage
        import shutil

        disk = shutil.disk_usage("/")
        disk_total_gb = disk.total / (1024**3)
        disk_used_gb = disk.used / (1024**3)

        return {
            "load_1m": float(loadavg[0]),
            "load_5m": float(loadavg[1]),
            "load_15m": float(loadavg[2]),
            "cpu_count": cpu_count,
            "mem_total_mb": mem_total_mb,
            "mem_used_mb": mem_total_mb - mem_avail_mb,
            "disk_total_gb": round(disk_total_gb, 1),
            "disk_used_gb": round(disk_used_gb, 1),
        }
    except Exception:
        return {}


def _session_gpu_map() -> dict[int, dict]:
    """Map GPU index → session info by matching mdrun PIDs to GPU processes."""
    gpu_procs = _nvidia_smi_processes()
    if not gpu_procs:
        return {}

    # Collect PIDs using each GPU
    gpu_pids: dict[int, list[int]] = {}
    for p in gpu_procs:
        gpu_pids.setdefault(p["gpu_index"], []).append(p["pid"])

    # Scan session.json files to match PIDs
    from web.backend.session_manager import _sessions

    pid_to_session: dict[int, dict] = {}
    for sid, session in _sessions.items():
        sim = session.sim_status or {}
        pid = sim.get("pid")
        if pid:
            pid_to_session[pid] = {
                "session_id": sid,
                "nickname": session.nickname,
            }

    # Also scan session.json files on disk for sessions not in memory
    from web.backend.session_store import read_all_sessions

    for data in read_all_sessions():
        if data.get("run_status") != "running":
            continue
        sid = data.get("session_id", "")
        if sid in _sessions:
            continue
        sim_meta = data.get("sim_status") or {}
        pid = sim_meta.get("pid")
        if pid:
            pid_to_session[pid] = {
                "session_id": sid,
                "nickname": data.get("nickname", ""),
            }

    # Build result
    result: dict[int, dict] = {}
    for gpu_idx, pids in gpu_pids.items():
        for pid in pids:
            if pid in pid_to_session:
                result[gpu_idx] = pid_to_session[pid]
                break
        if gpu_idx not in result:
            # Unknown process
            result[gpu_idx] = {"session_id": None, "nickname": None, "pids": pids}

    return result


@router.get("/server/status")
async def server_status():
    """Return comprehensive server status: CPU, memory, GPU utilization, and session→GPU mapping."""
    gpus = _nvidia_smi_query()
    cpu = _cpu_info()
    session_map = _session_gpu_map()

    # Annotate GPUs with session info
    for gpu in gpus:
        mapping = session_map.get(gpu["index"])
        if mapping:
            gpu["session_id"] = mapping.get("session_id")
            gpu["session_nickname"] = mapping.get("nickname")
        else:
            gpu["session_id"] = None
            gpu["session_nickname"] = None
        # Consider GPU "available" if utilization < 10% and no session is using it
        gpu["available"] = gpu["utilization_pct"] < 10 and gpu["session_id"] is None

    return {
        "cpu": cpu,
        "gpus": gpus,
    }


@router.get("/server/available-gpu")
async def available_gpu():
    """Return the first available GPU index, or null if none available."""
    gpus = _nvidia_smi_query()
    session_map = _session_gpu_map()

    for gpu in gpus:
        mapping = session_map.get(gpu["index"])
        in_use = mapping is not None
        if not in_use and gpu["utilization_pct"] < 10:
            return {"gpu_id": str(gpu["index"]), "available": True}

    return {"gpu_id": None, "available": False}
