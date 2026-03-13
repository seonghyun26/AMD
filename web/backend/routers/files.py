"""File management endpoints: upload, list, download."""

from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from md_agent.utils.file_utils import list_files
from web.backend.session_manager import get_or_restore_session

router = APIRouter()


def _session_root(work: Path) -> Path:
    """Return session root for a work dir (typically .../<session>/data)."""
    return work.parent if work.name == "data" else work


def _resolve_path(path: str, work: Path) -> Path:
    """Resolve a user-supplied path to an absolute Path inside work_dir.

    Accepts:
    - Absolute paths (e.g. /home/user/.../data/file.pdb)
    - Paths relative to project CWD (e.g. outputs/.../data/file.pdb)
    - Paths relative to work_dir (e.g. file.pdb, simulation/md.xtc)
    """
    p = Path(path)
    if p.is_absolute():
        return p.resolve()
    # Try as-is relative to CWD (e.g. full outputs/... path from the API)
    resolved = p.resolve()
    if resolved.is_relative_to(work):
        return resolved
    # Fall back: treat as relative to work_dir
    return (work / p).resolve()


def _migrate_legacy_config(work: Path) -> None:
    """Move legacy data/config.yaml to session-root config.yaml when present."""
    legacy = work / "config.yaml"
    if not legacy.exists():
        return
    root_cfg = _session_root(work) / "config.yaml"
    try:
        if not root_cfg.exists():
            shutil.move(str(legacy), str(root_cfg))
        else:
            legacy.unlink()
    except Exception:
        pass


@router.get("/sessions/{session_id}/files")
async def list_session_files(session_id: str, pattern: str = "*", recursive: bool = True):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work = Path(session.work_dir).resolve()
    _migrate_legacy_config(work)
    files = [str(Path(f).resolve()) for f in list_files(session.work_dir, pattern=pattern, recursive=recursive)]
    # Hide the archive subfolder and GROMACS #...# backup files
    archive_prefix = str(_session_root(work) / "archive") + "/"
    files = [
        f for f in files
        if not f.startswith(archive_prefix)
        and not Path(f).name.startswith("#")
    ]
    return {"files": files, "work_dir": session.work_dir}


@router.post("/sessions/{session_id}/files/upload")
async def upload_file(session_id: str, file: UploadFile):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    dest = Path(session.work_dir) / (file.filename or "upload")
    dest.parent.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    dest.write_bytes(content)
    return {"saved_path": str(dest), "size_bytes": len(content)}


@router.get("/sessions/{session_id}/files/download")
async def download_file(session_id: str, path: str):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work = Path(session.work_dir).resolve()
    target = _resolve_path(path, work)
    if not target.is_relative_to(work):
        raise HTTPException(403, "Path outside session work directory")
    if not target.exists():
        raise HTTPException(404, "File not found")
    # Read the file content as a snapshot to avoid Content-Length mismatch
    # when GROMACS is actively writing to the file.
    import mimetypes
    content = target.read_bytes()
    media_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return StreamingResponse(
        iter([content]),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{target.name}"', "Content-Length": str(len(content))},
    )


@router.delete("/sessions/{session_id}/files")
async def delete_file(session_id: str, path: str):
    """Move a file to the session-level archive/ folder instead of permanently deleting it."""
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work = Path(session.work_dir).resolve()
    target = _resolve_path(path, work)
    if not target.is_relative_to(work):
        raise HTTPException(403, "Path outside session work directory")
    if not target.exists():
        raise HTTPException(404, "File not found")

    archive_dir = _session_root(work) / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)

    dest = archive_dir / target.name
    if dest.exists():
        stem, suffix = target.stem, target.suffix
        for i in range(1, 1001):
            dest = archive_dir / f"{stem}_{i}{suffix}"
            if not dest.exists():
                break
        else:
            raise HTTPException(500, "Too many archived copies of this file")

    shutil.move(str(target), str(dest))
    return {"archived": str(dest)}


@router.get("/sessions/{session_id}/files/download-zip")
async def download_zip(session_id: str):
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work = Path(session.work_dir).resolve()
    if not work.exists():
        raise HTTPException(404, "Work directory not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(work.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(work))
    buf.seek(0)

    filename = f"session_{session_id[:8]}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/sessions/{session_id}/files/archive")
async def list_archive_files(session_id: str):
    """List files currently in the session-level archive folder."""
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work = Path(session.work_dir).resolve()
    archive_dir = _session_root(work) / "archive"
    if not archive_dir.exists():
        return {"files": []}
    files = sorted(str(f) for f in archive_dir.iterdir() if f.is_file())
    return {"files": files}


@router.post("/sessions/{session_id}/files/restore")
async def restore_file(session_id: str, path: str = Body(..., embed=True)):
    """Move a file from the archive folder back into the session work directory."""
    session = get_or_restore_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    work = Path(session.work_dir).resolve()
    archive_dir = (_session_root(work) / "archive").resolve()

    target = Path(path).resolve()
    if not target.is_relative_to(archive_dir):
        raise HTTPException(403, "Path outside archive directory")
    if not target.exists():
        raise HTTPException(404, "File not found in archive")

    dest = work / target.name
    if dest.exists():
        stem, suffix = target.stem, target.suffix
        for i in range(1, 1001):
            dest = work / f"{stem}_{i}{suffix}"
            if not dest.exists():
                break
        else:
            raise HTTPException(500, "Too many copies of this file in work directory")

    shutil.move(str(target), str(dest))
    return {"restored": str(dest)}
