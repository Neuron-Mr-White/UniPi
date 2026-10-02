#!/usr/bin/env bash
# UNI-49 design-preview launcher: harness-origin user-content distinction.
# Resolution order: $UNIPI_REPO override → the directory this script lives in
# (when it sits in <repo>/scripts/) → the default checkout at
# ~/Projects/Personal/archived/unipi (coffee). Runs the repo's local tsx —
# no network. Default flags: interactive TUI, simple style, mixed scenario.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${UNIPI_REPO:-}"
if [ -z "$REPO" ]; then
  if [ -f "$SCRIPT_DIR/harness-message-preview.ts" ]; then
    REPO="$(dirname "$SCRIPT_DIR")"
  elif [ -f "$HOME/Projects/Personal/archived/unipi/scripts/harness-message-preview.ts" ]; then
    REPO="$HOME/Projects/Personal/archived/unipi"
  else
    echo "uni-harness preview: no repo found (set UNIPI_REPO or copy this script into <repo>/scripts/)" >&2
    exit 1
  fi
fi
cd "$REPO"
# mise-managed node (coffee has node only under the mise installs dir)
for NODE_DIR in "$HOME/.local/share/mise/installs/node/lts/bin" "$HOME/.local/share/mise/installs/node/current/bin"; do
  if [ -d "$NODE_DIR" ]; then
    PATH="$NODE_DIR:$PATH"
    break
  fi
done
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
fi
exec "$TSX" scripts/harness-message-preview.ts "${ARGS[@]}"
