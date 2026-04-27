---
title: "Fix Telegram Setup Spinner Not Animating"
type: quick-work
date: 2026-04-27
---

# Fix Telegram Setup Spinner Not Animating

## Task
Fix the Telegram setup overlay's third step (polling phase) where:
- The spinner was not spinning (static frame)
- The countdown timer was not updating

## Root Cause
The `setInterval` callback in `startPolling()` updated `spinnerFrame` but never called `this.requestRender?.()`. The TUI only re-renders when `requestRender()` is called, so the UI remained static.

## Changes
- `packages/notify/tui/telegram-setup.ts`: Added `this.requestRender?.()` to the spinner `setInterval` callback

## Verification
- `npm run typecheck` passed (no errors)
- Committed as `6ff230b`

## Pattern Reference
This matches the pattern used in pi-mono's `CountdownTimer`:
```typescript
this.intervalId = setInterval(() => {
  this.remainingSeconds--;
  this.onTick(this.remainingSeconds);
  this.tui?.requestRender();  // ← Required for re-render
}, 1000);
```

## Notes
- Other overlays (`ask-ui.ts`, `settings-overlay.ts`, `add-overlay.ts`) were checked — no similar issues found
- The `requestRender` callback is wired up in `commands.ts` but only triggered by `handleInput`, not timers
