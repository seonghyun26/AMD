"""Auth router — validates credentials against the local user DB."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from web.backend.db import init_db, verify_user
from web.backend.jwt_auth import create_token

router = APIRouter()

# Ensure DB tables and default users exist on first import
init_db()


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
async def login(req: LoginRequest):
    if verify_user(req.username, req.password):
        token = create_token(req.username)
        return {"success": True, "username": req.username, "token": token}
    raise HTTPException(status_code=401, detail="Invalid username or password")
