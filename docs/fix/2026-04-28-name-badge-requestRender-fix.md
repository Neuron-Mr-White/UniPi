---
title: "Name Badge requestRender Wiring — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Name Badge requestRender Wiring — Quick Fix

## Bug
The `/unipi:badge-gen` command and name badge overlay were not updating the displayed name when the session name changed. The badge would show "Set a name now" even after a name was generated.

## Root Cause
In `packages/utility/src/tui/name-badge-state.ts`, the `requestRender` callback was being wired inside the factory function, but the `overlayHandle` was only set via the `onHandle` callback which runs **after** the factory. This meant `this.overlayHandle` was always `null` when the wiring code executed, so `requestRender` was never connected.

```typescript
// Bug: overlayHandle is null here
if (this.overlayHandle) {
  this.overlayHandle.requestRender = () => tui.requestRender(); // Never runs
}
```

## Fix
Store the `tui` reference in the factory function, then wire `requestRender` in the `onHandle` callback where the handle actually exists.

### Files Modified
- `packages/utility/src/tui/name-badge-state.ts` — Store `tuiRef` in factory, wire `requestRender` in `onHandle` callback

## Verification
- TypeScript compiles without errors (`npx tsc --noEmit`)
- The polling mechanism now properly triggers overlay re-renders when session name changes
- Badge overlay will update in real-time when `/unipi:badge-gen` generates a name

## Notes
The overlay is positioned with `anchor: "top-right"` and `nonCapturing: true`, which means it stays fixed in the terminal viewport and doesn't scroll with main content. If the badge appears to "scroll away", it may be because:
1. Terminal width is < 40 columns (overlay hides via `visible` callback)
2. Another overlay opened on top (overlays stack naturally)
