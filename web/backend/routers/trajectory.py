"""NGL-compatible trajectory server using mdtraj.

NGL 2.4.x RemoteTrajectory protocol (requires NGL.TrajectoryDatasource to be configured):
  GET  /sessions/{id}/ngl-traj/{combined_b64}/numframes  → plain-text integer
  POST /sessions/{id}/ngl-traj/{combined_b64}/frame/{i}  → binary frame data

Binary frame response format:
  Bytes  0-3:  Int32 LE   — total frame count
  Bytes  4-7:  padding
  Bytes  8-43: Float32×9  — box vectors (Angstroms, row-major 3×3)
  Bytes 44+:   Float32×N*3 — XYZ coordinates (Angstroms, flat)

`combined_b64` is URL-safe base64url(JSON {"xtc": "<path>", "top": "<path>"}).
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, Response

from web.backend.session_manager import get_or_restore_session

router = APIRouter()

# Simple in-process cache: xtc_path → (mtime, frame_count)
_frame_count_cache: dict[str, tuple[float, int]] = {}


def _decode_paths(combined_b64: str) -> tuple[str, str]:
    try:
        padded = combined_b64 + "=" * (-len(combined_b64) % 4)
        decoded = base64.urlsafe_b64decode(padded).decode()
        data = json.loads(decoded)
        return data["xtc"], data["top"]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid path encoding: {e}")


def _get_work(session_id: str) -> Path:
    session = get_or_restore_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return Path(session.work_dir).resolve()


def _resolve_file(path_str: str, work: Path) -> Path:
    p = Path(path_str)
    resolved = p.resolve() if p.is_absolute() else (work / p).resolve()
    if not resolved.is_relative_to(work):
        raise HTTPException(status_code=403, detail="Path outside session work directory")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path_str}")
    return resolved


def _count_frames(xtc_path: Path, top_path: Path) -> int:
    key = str(xtc_path)
    try:
        current_mtime = xtc_path.stat().st_mtime
    except Exception:
        current_mtime = 0.0
    cached = _frame_count_cache.get(key)
    if cached is not None:
        cached_mtime, cached_count = cached
        if cached_mtime == current_mtime:
            return cached_count
    import mdtraj

    try:
        with mdtraj.open(str(xtc_path)) as f:
            n = len(f)
    except Exception:
        traj = mdtraj.load(str(xtc_path), top=str(top_path))
        n = traj.n_frames
    _frame_count_cache[key] = (current_mtime, n)
    return n


def _read_frame(trajectory_path: Path, frame_index: int) -> tuple[np.ndarray, np.ndarray]:
    """Read one frame without reparsing the topology file."""
    import mdtraj

    with mdtraj.open(str(trajectory_path)) as trajectory:
        trajectory.seek(frame_index)
        coordinates, _time, _step, box_vectors = trajectory.read(n_frames=1)

    if coordinates.shape[0] != 1:
        raise IndexError(f"Frame {frame_index} is unavailable")

    coords = np.ascontiguousarray(coordinates[0] * 10.0, dtype=np.float32)

    if box_vectors is not None and len(box_vectors) == 1:
        box = np.ascontiguousarray(box_vectors[0] * 10.0, dtype=np.float32)
    else:
        box = np.zeros((3, 3), dtype=np.float32)

    return coords.reshape(-1), box.reshape(-1)


def _load_frame_data(
    trajectory_path: Path, topology_path: Path, frame_index: int
) -> tuple[int, np.ndarray, np.ndarray]:
    n_frames = _count_frames(trajectory_path, topology_path)
    if frame_index < 0 or frame_index >= n_frames:
        raise HTTPException(status_code=404, detail=f"Frame out of range: {frame_index}")
    coords, box = _read_frame(trajectory_path, frame_index)
    return n_frames, coords, box


@router.get("/sessions/{session_id}/ngl-traj/{combined_b64}/numframes")
async def get_numframes(session_id: str, combined_b64: str) -> PlainTextResponse:
    """Return frame count (NGL RemoteTrajectory protocol — GET)."""
    xtc_str, top_str = _decode_paths(combined_b64)
    work = _get_work(session_id)
    xtc_path = _resolve_file(xtc_str, work)
    top_path = _resolve_file(top_str, work)
    try:
        n = _count_frames(xtc_path, top_path)
        return PlainTextResponse(str(n))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to count frames: {e}")


@router.post("/sessions/{session_id}/ngl-traj/{combined_b64}/frame/{frame_index}")
async def get_frame(
    session_id: str,
    combined_b64: str,
    frame_index: int,
) -> Response:
    """Return frame data in NGL binary format (NGL RemoteTrajectory protocol — POST).

    Binary layout:
      [0-3]   Int32 LE  — total frame count
      [4-7]   4 bytes padding
      [8-43]  Float32×9 — box vectors in Angstroms (row-major 3×3)
      [44+]   Float32×N*3 — XYZ coordinates in Angstroms
    """
    xtc_str, top_str = _decode_paths(combined_b64)
    work = _get_work(session_id)
    xtc_path = _resolve_file(xtc_str, work)
    top_path = _resolve_file(top_str, work)

    try:
        n_frames, coords, box = _load_frame_data(xtc_path, top_path, frame_index)

        # Pack header: Int32(frame_count) + 4 bytes padding
        header = struct.pack("<i", n_frames) + b"\x00" * 4

        return Response(
            content=header + box.tobytes() + coords.tobytes(),
            media_type="application/octet-stream",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load frame {frame_index}: {e}")
