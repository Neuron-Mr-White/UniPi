#!/usr/bin/env bash
# UNI-47 mixed-scenario launcher: lead + delegated sidekick in one transcript.
# Same resolution as uni-2-preview.sh (UNIPI_REPO → own dir → coffee default
# checkout). With NO flags defaults to the interactive mixed transcript in
# simple style; --print and other flags pass through (scenario mixed is
# injected unless explicitly given).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${UNIPI_REPO:-}"
if [ -z "$REPO" ]; then
  if [ -f "$SCRIPT_DIR/sidekick-preview.ts" ]; then
    REPO="$(dirname "$SCRIPT_DIR")"
  elif [ -f "$HOME/Projects/Personal/archived/unipi/scripts/sidekick-preview.ts" ]; then
    REPO="$HOME/Projects/Personal/archived/unipi"
  else
    echo "uni-2 mixed preview: no repo found (set UNIPI_REPO or copy this script into <repo>/scripts/)" >&2
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
  ARGS=(--interactive --scenario mixed --style simple)
else
  ARGS=("$@")
  case " ${ARGS[*]} " in
    *" --scenario "*) ;;
    *) ARGS=(--scenario mixed "${ARGS[@]}") ;;
  esac
fi
exec "$TSX" scripts/sidekick-preview.ts "${ARGS[@]}"
