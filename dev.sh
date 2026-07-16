#!/usr/bin/env bash
#
# dev.sh — start both dev servers (Rust API + Vite web) with persistent logs.
#
# Usage:
#   ./dev.sh
#
# Starts the spider-api server on :3000 and the Vite web dev server on :5173
# (which proxies /api -> :3000). Both run in the background with their
# stdout/stderr appended to logs/api.log and logs/web.log, so if a server dies
# the log keeps a trace of why. Press Ctrl+C to stop both.
#
# Runnable from anywhere — paths are resolved relative to this script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"

# Locate the API release binary (.exe on Windows/Git Bash), building if needed.
API_BIN="$ROOT/target/release/spider-api"
[ -x "$API_BIN" ] || API_BIN="$ROOT/target/release/spider-api.exe"
if [ ! -x "$API_BIN" ]; then
  echo "Building spider-api (first run)..."
  ( cd "$ROOT" && cargo build --release -p spider-api )
  API_BIN="$ROOT/target/release/spider-api"
  [ -x "$API_BIN" ] || API_BIN="$ROOT/target/release/spider-api.exe"
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Start the API. `exec` makes this background job *be* the server process, so
# the recorded PID is the one to kill (no wrapper in between).
echo "=== api boot $(ts) ===" >> "$API_LOG"
( exec "$API_BIN" ) >> "$API_LOG" 2>&1 &
API_PID=$!

# Start Vite by invoking its entry script directly (not `npm run dev`), again so
# the recorded PID is the actual server, not an npm wrapper that would orphan it.
echo "=== web boot $(ts) ===" >> "$WEB_LOG"
( cd "$ROOT/web" && exec node node_modules/vite/bin/vite.js ) >> "$WEB_LOG" 2>&1 &
WEB_PID=$!

cleanup() {
  echo
  echo "Stopping servers (api=$API_PID web=$WEB_PID)..."
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "spider-api  -> http://localhost:3000   (log: $API_LOG)"
echo "spider-web  -> http://localhost:5173   (log: $WEB_LOG)"
echo "Press Ctrl+C to stop both."
echo

# Foreground on the logs so you see output live; Ctrl+C triggers cleanup. If
# either server exits on its own, stop the other too and surface it.
tail -f "$API_LOG" "$WEB_LOG" &
TAIL_PID=$!
wait -n "$API_PID" "$WEB_PID" 2>/dev/null || true
echo
echo "A server exited — check the logs above. Shutting the other down."
kill "$TAIL_PID" 2>/dev/null || true
cleanup
