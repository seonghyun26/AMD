"""JWT authentication helpers.

Generates and verifies HS256 tokens. The secret is derived from a
persistent random key stored at ``~/.amd/jwt_secret``. If the file
does not exist it is created automatically on first import.

Public API used by routers and middleware:
  create_token(username)  -> str
  verify_token(token)     -> {"username": str, "exp": int}
  get_current_user(req)   -> str          (FastAPI dependency)
"""

from __future__ import annotations

import os
import secrets
import time
from pathlib import Path

import jwt
from fastapi import HTTPException, Request

# ── Secret key ───────────────────────────────────────────────────────

_SECRET_PATH = Path(os.getenv("AMD_JWT_SECRET_PATH", str(Path.home() / ".amd" / "jwt_secret")))

def _load_secret() -> str:
    if _SECRET_PATH.exists():
        return _SECRET_PATH.read_text().strip()
    _SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_hex(32)
    _SECRET_PATH.write_text(secret)
    return secret

_SECRET = _load_secret()
_ALGORITHM = "HS256"
_EXPIRY_SECONDS = 7 * 24 * 3600  # 7 days


# ── Token helpers ────────────────────────────────────────────────────

def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "iat": int(time.time()),
        "exp": int(time.time()) + _EXPIRY_SECONDS,
    }
    return jwt.encode(payload, _SECRET, algorithm=_ALGORITHM)


def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, _SECRET, algorithms=[_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


# ── FastAPI dependency ───────────────────────────────────────────────

async def get_current_user(request: Request) -> str:
    """Extract and verify the Bearer token, returning the username.

    Raises 401 if the token is missing, expired, or invalid.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Missing authorization token")
    payload = verify_token(auth[7:])
    return payload["sub"]
