#!/usr/bin/env bash
# UNI-2 design-mockup launcher: run the sidekick rail preview from the repo.
# Resolution order: $UNIPI_REPO override → the directory this script lives in
# (when it sits in <repo>/scripts/) → the default checkout at
# ~/Projects/Personal/archived/unipi (coffee). Runs the repo's local tsx —
# no network. Default flags: --print (every style × state into scrollback).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${UNIPI_REPO:-}"
if [ -z "$REPO" ]; then
  if [ -f "$SCRIPT_DIR/sidekick-preview.ts" ]; then
    REPO="$(dirname "$SCRIPT_DIR")"
  elif [ -f "$HOME/Projects/Personal/archived/unipi/scripts/sidekick-preview.ts" ]; then
    REPO="$HOME/Projects/Personal/archived/unipi"
  else
    echo "uni-2 preview: no repo found (set UNIPI_REPO or copy this script into <repo>/scripts/)" >&2
    exit 1
  fi
fi
cd "$REPO"
TSX="$REPO/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "tsx not found at $TSX — run npm install in $REPO first" >&2
  exit 1
fi
ARGS=()
if [ "$#" -eq 0 ]; then
  ARGS=(--print)
else
  ARGS=("$@")
fi
exec "$TSX" scripts/sidekick-preview.ts "${ARGS[@]}"
