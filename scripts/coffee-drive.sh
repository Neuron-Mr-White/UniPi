#!/usr/bin/env bash
# Drive a pi session inside coffee's tmux reliably, then capture the pane.
#
#   scripts/coffee-drive.sh "<text>" [--name 60-thing] [--wait 8] [--session unipi-hub]
#
# Why this exists: `tmux send-keys -l "<text>"; send-keys Enter` is not reliable —
# pi's autocomplete popup can swallow the Return, and Escape *clears* the editor
# (which silently drops flags). This script:
#   1. Escape          — close any open popup (only safe while the editor is empty)
#   2. send-keys -l    — type the text literally
#   3. capture-pane    — VERIFY the text is in the editor; retype up to 3 times
#   4. send-keys Right — dismiss the autocomplete popup without touching the text
#   5. send-keys Enter — submit
#   6. wait + capture  — verify the editor is empty (submitted), retry Enter if not
#
# Exit code is non-zero when the text could not be submitted, so callers can fail.
set -uo pipefail

SESSION="unipi-hub"
NAME=""
WAIT=8
TEXT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --wait) WAIT="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    *) TEXT="$1"; shift ;;
  esac
done

if [ -z "$TEXT" ]; then
  echo "usage: $0 \"<text>\" [--name <evidence-name>] [--wait <seconds>] [--session <name>]" >&2
  exit 2
fi

COFFEE="${COFFEE_HOST:-coffee}"
EVIDENCE="${EVIDENCE_DIR:-/tmp/coffee-evidence}"
mkdir -p "$EVIDENCE"

# A short marker proves the text reached the editor even if the tail is elided.
MARK="$(printf '%s' "$TEXT" | head -c 24)"

remote() { ssh -n "$COFFEE" "$@"; }
pane()   { remote "tmux capture-pane -t $SESSION -p" 2>/dev/null; }

submitted=0
for attempt in 1 2 3; do
  # 1. make sure the editor is empty/clean (Escape only clears, never submits,)
  remote "tmux send-keys -t $SESSION Escape" >/dev/null 2>&1
  sleep 0.3
  # 2. type
  remote "tmux send-keys -t $SESSION -l $(printf '%q' "$TEXT")" >/dev/null 2>&1
  sleep 0.7
  # 3. verify the text is in the editor
  if ! pane | grep -qF -- "$MARK"; then
    echo "attempt $attempt: text not in the editor yet, retrying" >&2
    continue
  fi
  # 4./5. dismiss the popup, then submit
  remote "tmux send-keys -t $SESSION Right" >/dev/null 2>&1
  sleep 0.25
  remote "tmux send-keys -t $SESSION Enter" >/dev/null 2>&1
  sleep 1.2
  # 6. did it submit? the composer line must no longer hold the text
  if pane | tail -3 | grep -qF -- "$MARK"; then
    echo "attempt $attempt: Return was swallowed, retrying" >&2
    remote "tmux send-keys -t $SESSION Enter" >/dev/null 2>&1
    sleep 1.2
    pane | tail -3 | grep -qF -- "$MARK" || { submitted=1; break; }
    continue
  fi
  submitted=1
  break
done

if [ "$submitted" != "1" ]; then
  echo "FAILED to submit: $TEXT" >&2
  pane | tail -12 >&2
  exit 1
fi

sleep "$WAIT"
if [ -n "$NAME" ]; then
  pane > "$EVIDENCE/$NAME.txt"
  echo "captured $EVIDENCE/$NAME.txt"
fi
pane | grep -v '^[[:space:]]*$' | tail -20
