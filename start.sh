#!/usr/bin/env bash
# Start the AMD web server.
#
# Usage:
#   ./start.sh          Build frontend (if needed) + start FastAPI on :8000
#   ./start.sh --dev    Dev mode: Next.js HMR on :3000 + FastAPI :8000 (auto-reload)
#                       (instant hot-reload on frontend changes)
#   ./start.sh --build  Force-rebuild the frontend even if out/ exists

set -e

# Load nvm if node is not already on PATH
if ! command -v node &>/dev/null; then
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$REPO_ROOT/web/frontend"
OUT_DIR="$FRONTEND_DIR/out"

# Load .env if present
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env"
  set +a
fi

DEV=0
FORCE_BUILD=0
for arg in "$@"; do
  case $arg in
    --dev)   DEV=1 ;;
    --build) FORCE_BUILD=1 ;;
  esac
done

# ── Dependency checks ─────────────────────────────────────────────────

if ! python -c "import fastapi" 2>/dev/null; then
  echo "ERROR: Python web deps missing. Run: pip install -e '.[web]'"
  exit 1
fi

if ! node --version &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node 18+ first."
  echo "  nvm install 20 && nvm use 20"
  exit 1
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm --prefix "$FRONTEND_DIR" install --silent
fi

# ── Dev mode: Next.js HMR on :3000 + FastAPI on :8000 ────────────────

if [ "$DEV" -eq 1 ]; then
  cleanup() {
    echo -e "\nShutting down..."
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
  }
  trap cleanup INT TERM

  echo "Dev mode (HMR):"
  echo "  Frontend → http://localhost:3000  (Next.js dev, instant HMR)"
  echo "  Backend  → http://localhost:8000  (FastAPI, auto-reload)"
  echo "  Open http://localhost:3000 in your browser."
  echo ""

  cd "$REPO_ROOT"
  python -m uvicorn web.backend.main:app --host 0.0.0.0 --port 8000 --reload &
  BACKEND_PID=$!

  NEXT_DEV=1 npm --prefix "$FRONTEND_DIR" run dev &
  FRONTEND_PID=$!

  wait "$BACKEND_PID" "$FRONTEND_PID"
  exit 0
fi

# ── Production mode: build once, serve from FastAPI ───────────────────

needs_build() {
  [ ! -d "$OUT_DIR" ] || [ "$FORCE_BUILD" -eq 1 ]
}

if needs_build; then
  echo "Building frontend..."
  npm --prefix "$FRONTEND_DIR" run build
  echo "Build complete → $OUT_DIR"
else
  echo "Frontend already built (use --build to rebuild)"
fi

echo ""
echo "Starting AMD server → http://localhost:8000"
echo "Press Ctrl+C to stop."
echo ""

cd "$REPO_ROOT"
exec python -m uvicorn web.backend.main:app --host 0.0.0.0 --port 8000
