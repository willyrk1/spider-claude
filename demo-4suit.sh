#!/usr/bin/env bash
#
# demo-4suit.sh — show the solver cracking a full 4-suit Spider deal (hard mode).
#
# Usage:
#   ./demo-4suit.sh [SEED] [NODES]
#
# Defaults to seed 0 (solves in well under a second). Uses the default parallel
# portfolio of search configs. Not every 4-suit deal is solvable within budget;
# if one seed doesn't solve, try another. Run from the repo root.

set -euo pipefail

SEED="${1:-0}"
NODES="${2:-20000000}"
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
echo " Spider Solitaire solver — 4-suit demo (seed $SEED, portfolio search)"
echo "======================================================================"

out="$("$BIN" --suits 4 --seed "$SEED" --nodes "$NODES")"

# Board + summary + verification line, down to the 'Solution:' header (if any).
printf '%s\n' "$out" | sed -n '1,/^Solution:$/p'

# First few moves, then how many remain (sed avoids SIGPIPE under pipefail).
moves="$(printf '%s\n' "$out" | grep -E '^[[:space:]]*[0-9]+\. ' || true)"
if [ -n "$moves" ]; then
  total="$(printf '%s\n' "$moves" | grep -c '')"
  printf '%s\n' "$moves" | sed -n "1,${MOVES_TO_SHOW}p"
  if [ "$total" -gt "$MOVES_TO_SHOW" ]; then
    echo "  ... ($((total - MOVES_TO_SHOW)) more moves)"
  fi
fi

echo "----------------------------------------------------------------------"
printf '%s\n' "$out" | grep -E '^(SOLVED|NOT SOLVED)'
