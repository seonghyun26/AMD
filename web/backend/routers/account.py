"""Per-user account settings — currently the profile avatar.

The avatar is stored server-side keyed by username and served through the authed
API (the ``outputs`` tree is not publicly mounted). Browser ``<img>`` tags can't
send an ``Authorization`` header, so the GET accepts the JWT via ``?token=`` —
the same mechanism the download routes use, enforced by the auth middleware.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

router = APIRouter()

_AVATAR_DIR = Path("outputs") / "_avatars"
_EXT_BY_TYPE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_MAX_BYTES = 4 * 1024 * 1024  # 4 MB


def _safe(username: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", username or "_") or "_"


def _find(username: str) -> Path | None:
    if not _AVATAR_DIR.is_dir():
        return None
    for p in sorted(_AVATAR_DIR.glob(f"{_safe(username)}.*")):
        if p.is_file():
            return p
    return None


def _remove_existing(username: str) -> None:
    for old in _AVATAR_DIR.glob(f"{_safe(username)}.*"):
        try:
            old.unlink()
        except Exception:
            pass


@router.get("/account/avatar")
async def get_avatar(request: Request):
    """Return the calling user's avatar image (404 if none set)."""
    username = getattr(request.state, "username", "") or ""
    p = _find(username)
    if not p:
        return Response(status_code=404)
    return FileResponse(str(p), headers={"Cache-Control": "no-store"})


@router.post("/account/avatar")
async def upload_avatar(request: Request, file: UploadFile = File(...)):
    """Set the calling user's avatar (png/jpg/webp/gif, ≤ 4 MB)."""
    username = getattr(request.state, "username", "") or ""
    ext = _EXT_BY_TYPE.get(file.content_type or "")
    if not ext:
        raise HTTPException(400, "Unsupported image type — use PNG, JPG, WebP or GIF.")
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(400, "Image too large (max 4 MB).")
    if not data:
        raise HTTPException(400, "Empty file.")
    _AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    _remove_existing(username)
    (_AVATAR_DIR / f"{_safe(username)}{ext}").write_bytes(data)
    return {"ok": True}


@router.delete("/account/avatar")
async def delete_avatar(request: Request):
    """Remove the calling user's avatar."""
    username = getattr(request.state, "username", "") or ""
    _remove_existing(username)
    return {"ok": True}
