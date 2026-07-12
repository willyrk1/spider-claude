#!/usr/bin/env bash
#
# demo-1suit.sh — show the solver cracking a 1-suit Spider deal.
#
# Usage:
#   ./demo-1suit.sh [SEED] [NODES]
#
# Defaults to seed 42 (solves in ~40ms). Run from the repo root.

set -euo pipefail

SEED="${1:-42}"
NODES="${2:-5000000}"
MOVES_TO_SHOW=15

# Locate the release binary (.exe on Windows/Git Bash), building it if needed.
BIN="./target/release/spider"
[ -x "$BIN" ] || BIN="./target/release/spider.exe"
if [ ! -x "$BIN" ]; then
  echo "Building release binary (first run)..."
  cargo build --release
  BIN="./target/release/spider"
  [ -x "$BIN" ] || BIN="./target/release/spider.exe"
fi

echo "======================================================================"
echo " Spider Solitaire solver — 1-suit demo (seed $SEED)"
echo "======================================================================"

# Capture the full run (initial board + solution + summary).
out="$("$BIN" --suits 1 --seed "$SEED" --nodes "$NODES")"

# 1) Show everything from the header down to the 'Solution:' line.
printf '%s\n' "$out" | sed -n '1,/^Solution:$/p'

# 2) Show the first few moves, then how many remain.
#    (sed reads all input, so no SIGPIPE — unlike `head` under `set -o pipefail`.)
moves="$(printf '%s\n' "$out" | grep -E '^[[:space:]]*[0-9]+\. ')"
total="$(printf '%s\n' "$moves" | grep -c '')"
printf '%s\n' "$moves" | sed -n "1,${MOVES_TO_SHOW}p"
if [ "$total" -gt "$MOVES_TO_SHOW" ]; then
  echo "  ... ($((total - MOVES_TO_SHOW)) more moves)"
fi

# 3) Restate the result line so it's the last thing on screen.
echo "----------------------------------------------------------------------"
printf '%s\n' "$out" | grep -E '^(SOLVED|NOT SOLVED)'
