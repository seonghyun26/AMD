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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from web.backend.routers import agents, analysis, auth, chat, config, files, keys, server, simulate, trajectory

app = FastAPI(title="AMD Web API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
