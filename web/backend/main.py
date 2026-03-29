"""FastAPI application entry point."""

from __future__ import annotations

import os
import sys
from pathlib import Path

if not os.environ.get("ANTHROPIC_API_KEY"):
    import warnings

    warnings.warn("ANTHROPIC_API_KEY is not set — agent calls will fail", stacklevel=1)

# Allow imports of both web.backend.* and md_agent.* when running directly
_repo_root = str(Path(__file__).parents[2])
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402

from web.backend.jwt_auth import verify_token  # noqa: E402
from web.backend.routers import (  # noqa: E402
    agents,
    analysis,
    auth,
    chat,
    config,
    files,
    keys,
    server,
    simulate,
    trajectory,
)

app = FastAPI(title="AMD Web API", version="0.1.0")

_cors_origins = os.getenv(
    "AMD_CORS_ORIGINS", "http://localhost:3000,http://localhost:8000"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── JWT auth middleware ────────────────────────────────────────────────

# Paths that do not require authentication
_PUBLIC_PATHS = {"/api/auth/login", "/health"}
_PUBLIC_PREFIXES = ("/docs", "/openapi.json", "/redoc")
# Path fragments that are public (browser-initiated requests that can't carry auth headers)
_PUBLIC_FRAGMENTS = ("/files/download", "/ngl-traj/", "/ramachandran.png")


class JWTAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Skip auth for public paths, static assets, and preflight requests
        if (
            path in _PUBLIC_PATHS
            or path.startswith(_PUBLIC_PREFIXES)
            or not path.startswith("/api")
            or request.method == "OPTIONS"
            or any(frag in path for frag in _PUBLIC_FRAGMENTS)
        ):
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse({"detail": "Missing authorization token"}, status_code=401)

        try:
            verify_token(auth_header[7:])
        except Exception:
            return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)

        return await call_next(request)


app.add_middleware(JWTAuthMiddleware)

app.include_router(auth.router, prefix="/api")
app.include_router(agents.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(config.router, prefix="/api")
app.include_router(analysis.router, prefix="/api")
app.include_router(keys.router, prefix="/api")
app.include_router(server.router, prefix="/api")
app.include_router(simulate.router, prefix="/api")
app.include_router(trajectory.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}


# Serve the pre-built Next.js static export.
# Must be mounted LAST so /api/* routes take priority.
_static_dir = Path(__file__).parents[2] / "web" / "frontend" / "out"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="static")


def start():
    """Entry point for the amd-web console script."""
    import uvicorn

    uvicorn.run(
        "web.backend.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,  # reload breaks with StaticFiles mount after build
    )


if __name__ == "__main__":
    start()
