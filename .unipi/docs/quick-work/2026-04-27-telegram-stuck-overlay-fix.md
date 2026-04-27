---
title: "Fix Telegram Overlay Stuck After Poll Success"
type: quick-work
date: 2026-04-27
---

# Fix Telegram Overlay Stuck After Poll Success

## Task
Fix the overlay getting stuck on screen after polling succeeds (receives message). The timer stopped, spinner stopped, but the overlay wouldn't update or close.

## Root Cause
In `doPoll()`, when success/error/timeout occurred:
1. Phase was changed but `requestRender()` was never called
2. The UI stayed stuck showing the polling state
3. On success, no auto-close was implemented

## Changes
- `packages/notify/tui/telegram-setup.ts`:
  - Added `this.requestRender?.()` after phase changes in all three exit paths (success, timeout, error)
  - Added auto-close with 1s delay on success (`setTimeout(() => this.onClose?.(), 1000)`)
  - Timeout and error states still require Enter/Esc to close (user should see the error message)

## Verification
- `npm run typecheck` passed
- Committed as `50f110d`

## Behavior After Fix
- **Success**: Shows "✓ Telegram bot configured!" for 1 second, then auto-closes
- **Timeout**: Shows "⏰ Timed out after 5 minutes" - user presses Enter/Esc to close
- **Error**: Shows error message - user presses Enter/Esc to close

## Notes
- Pattern matches `settings-overlay.ts` which also auto-closes after save
- The `onClose` callback was already wired up in `commands.ts` but never called on async completion
