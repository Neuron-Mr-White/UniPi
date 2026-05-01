---
title: "Footer time segment not updating — Quick Fix"
type: quick-fix
date: 2026-05-01
---

# Footer time segment not updating — Quick Fix

## Bug
The time segment in the footer showed a static time and never updated. It should continuously update using `tui.requestRender()` to trigger periodic redraws.

## Root Cause
The footer renderer had a `scheduleRender()` method that set `layoutDirty = true` on a debounce timer, but never called `tui.requestRender()` to actually trigger the TUI to redraw. Without a periodic refresh mechanism, the time segment rendered once at initialization and never changed.

## Fix
Added a 1-second `setInterval` in the `setFooter` callback that:
1. Resets the layout cache so segments are re-rendered with fresh data
2. Calls `tuiRef.requestRender()` to trigger a TUI redraw

The interval is cleared on `session_shutdown` to prevent leaks.

### Files Modified
- `packages/footer/src/index.ts` — Added `refreshTimer` to `FooterState`, 1s interval in `setupFooterUI`, cleanup in `session_shutdown`

## Verification
- TypeScript compilation: clean
- All 41 tests pass

## Notes
- 1-second interval ensures the clock updates promptly each minute
- Only active when the footer is enabled and a session is running
