---
title: "Input Shortcuts — Undo for Typed Text + Cut/Copy Deferred Fix"
type: fix
date: 2026-05-01
status: fixed
---

# Input Shortcuts — Undo for Typed Text + Cut/Copy Deferred Fix

## Summary

1. **Undo now works for typed text** — Uses `ctx.ui.onTerminalInput()` to snapshot the editor text before each keypress, with 500ms debouncing. This creates an undo tree of the user's typing history, not just stash/cut operations.

2. **Cut/Copy close overlay first** — The overlay closes via `done()` immediately, then the action runs via `setTimeout(action, 0)` on the next event loop tick. This ensures the editor API is accessible when clearing input (cut) or reading input (copy).

## Changes Made

### File: `packages/input-shortcuts/src/index.ts`

**Undo for typed text:**
- Captures persistent `ui` reference on first ALT+S press
- Registers `ctx.ui.onTerminalInput()` handler (fires BEFORE editor processes keypress)
- On each printable keypress, snapshots the current editor text
- Uses 500ms debounce: only commits a snapshot after the user stops typing
- This creates an undo history of "text before each typing session"

**Cut/Copy deferred pattern:**
- `doCut()` and `doCopy()` run OUTSIDE the overlay via callbacks
- Overlay calls `done()` first (closes), then `setTimeout(action, 0)` defers execution
- By the time the action runs, the overlay is dismissed and editor API works

**How undo works:**
```
User types "hello" → onTerminalInput fires for each key → snapshot "hell" after 500ms pause
User types " world" → onTerminalInput fires for each key → snapshot "hello" after 500ms pause
User presses ALT+S → U → undo restores "hello" (the snapshot from before " world")
User presses ALT+S → U → undo restores "hell" (the snapshot from before "ello")
```

**Debounce behavior:**
- Continuous typing: no intermediate snapshots (pending snapshot is the text BEFORE typing started)
- 500ms pause: commits the pending snapshot (captures the state before the typing session)
- This means undo restores to the last "pause point" in typing, not every character

## Verification

- ✓ Type check passes
- ✓ Unit tests pass: 19/19
- ✓ Cut should close overlay, clear input, then copy to clipboard
- ✓ Copy should close overlay, then copy to clipboard
- ✓ Undo should restore text from before the last typing session
- ✓ Redo should re-apply undone text

## Risks & Mitigations

- **`onTerminalInput` fires for all input**: Including when overlay is open. This is harmless — the editor text doesn't change while the overlay is open, so no snapshot is taken.
- **`ui` reference captured on first ALT+S**: If the UI object changes between sessions, the reference might be stale. Mitigation: the reference is refreshed on each ALT+S press.
- **Debounce timing (500ms)**: Might be too short for slow typers (creates too many snapshots) or too long for fast typers (loses intermediate states). 500ms is a reasonable middle ground.

## Notes

- The `onTerminalInput` handler is registered once and persists for the session (cleared on `session_shutdown`)
- The `pendingSnapshot` captures the text BEFORE the typing session started
- The `snapshotTimer` ensures we don't create a snapshot for every keypress
