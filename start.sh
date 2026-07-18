#!/usr/bin/env bash
# Start the AMD web server.
#
# Usage:
#   ./start.sh                    Build frontend (if needed) + start FastAPI on :8000
#   ./start.sh --port 8001        Start FastAPI on a specific port
#   ./start.sh --dev --port 8001  Dev mode + file watcher on a specific port
#   ./start.sh --build            Force-rebuild the frontend even if out/ exists
#   ./start.sh --port 8001 --force   Stop whatever already listens on :PORT, then start

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
KILL_EXISTING=0
PORT="${AMD_PORT:-8000}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dev)
      DEV=1
      ;;
    --build)
      FORCE_BUILD=1
      ;;
    --force)
      KILL_EXISTING=1
      ;;
    --port)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --port requires a port number"
        exit 2
      fi
      PORT="$2"
      shift
      ;;
    --port=*)
      PORT="${1#*=}"
      ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      exit 2
      ;;
  esac
  shift
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ERROR: Invalid port: $PORT"
  exit 2
fi

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

# ── Port preflight: refuse to double-start ────────────────────────────
# Two machines/editors starting the server on the same port is the usual
# cause of the "it crashes when the other machine connects" behaviour: the
# second uvicorn cannot bind $PORT and dies immediately. Detect that here
# and give a clear message instead of a cryptic bind traceback. With
# --force, stop the existing listener and take over.

port_pids() {
  # PIDs listening on $PORT (best-effort; empty if not permitted to see them).
  if command -v ss &>/dev/null; then
    ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u
  elif command -v lsof &>/dev/null; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u
  fi
}

port_in_use() {
  if command -v ss &>/dev/null; then
    ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN
  elif command -v lsof &>/dev/null; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -t &>/dev/null
  else
    # Fallback: try to open a TCP connection to the port.
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
    return 1
  fi
}

if port_in_use; then
  existing="$(port_pids | tr '\n' ' ')" || true
  if [ "$KILL_EXISTING" -eq 1 ]; then
    echo "Port $PORT already in use by PID(s): ${existing:-unknown} — stopping them (--force)."
    for pid in $existing; do kill -TERM "$pid" 2>/dev/null || true; done
    for _ in 1 2 3 4 5; do port_in_use || break; sleep 0.3; done
    if port_in_use; then
      echo "Still listening after SIGTERM — escalating to SIGKILL."
      for pid in $(port_pids); do kill -KILL "$pid" 2>/dev/null || true; done
      for _ in 1 2 3 4 5; do port_in_use || break; sleep 0.3; done
    fi
    if port_in_use; then
      echo "ERROR: Port $PORT still in use after SIGKILL. Aborting." >&2
      exit 1
    fi
    echo "Port $PORT freed — continuing."
  else
    echo "ERROR: Port $PORT is already in use by PID(s): ${existing:-unknown}." >&2
    echo "       An AMD server is probably already running (e.g. started from your other machine)." >&2
    echo "       • To use it:      just forward/connect to :$PORT — don't start a second one." >&2
    echo "       • To take over:   re-run with --force to stop the old one first." >&2
    echo "       • Or use a port:  ./start.sh --port <other>" >&2
    exit 1
  fi
fi

# ── Dev mode: frontend watcher + FastAPI ─────────────────────────────

if [ "$DEV" -eq 1 ]; then
  cleanup() {
    echo -e "\nShutting down..."
    kill "$BACKEND_PID" "$WATCHER_PID" 2>/dev/null
    wait "$BACKEND_PID" "$WATCHER_PID" 2>/dev/null
  }
  trap cleanup INT TERM

  # Ensure an initial build exists so FastAPI can serve something immediately
  if [ ! -d "$OUT_DIR" ]; then
    echo "Initial frontend build..."
    npm --prefix "$FRONTEND_DIR" run build
  fi

  echo "Dev mode (watch + auto-rebuild):"
  echo "  Server  → http://localhost:$PORT  (FastAPI, auto-reload)"
  echo "  Watcher → rebuilds frontend on source changes"
  echo "  Open http://localhost:$PORT in your browser."
  echo ""

  cd "$REPO_ROOT"
  python -m uvicorn web.backend.main:app --host 0.0.0.0 --port "$PORT" --reload &
  BACKEND_PID=$!

  node "$FRONTEND_DIR/watch.mjs" &
  WATCHER_PID=$!

  wait "$BACKEND_PID" "$WATCHER_PID"
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
echo "Starting AMD server → http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""

cd "$REPO_ROOT"
exec python -m uvicorn web.backend.main:app --host 0.0.0.0 --port "$PORT"
