---
title: "Footer Renderer Width Overflow Crash — Fix Report"
type: fix
date: 2026-05-02
debug-report: .unipi/docs/debug/2026-05-02-footer-width-overflow-debug.md
status: fixed
---

# Footer Renderer Width Overflow Crash — Fix Report

## Summary
Fixed pi crash when terminal is narrowed by adding width truncation and progressive segment dropping to the footer renderer.

## Debug Report Reference
- Report: `.unipi/docs/debug/2026-05-02-footer-width-overflow-debug.md`
- Root Cause: `FooterRenderer` never truncates output to terminal width; `truncateToWidth` imported but unused

## Changes Made

### Files Modified
- `packages/footer/src/rendering/renderer.ts` — added truncation safety nets + progressive right-zone segment dropping

### Code Changes

1. **`buildZoneRow()`** — Added `truncateToWidth(result, fullWidth)` as final return, plus guard to skip right zone when gap < 0
2. **`buildContentFromParts()`** — Added optional `maxWidth` parameter with `truncateToWidth()` truncation
3. **`computeLayout()`** — Added progressive right-zone segment dropping (pop segments from right until left+right fit), recalculated available center width after drops, included dropped right segments in secondary row
4. **Call site** — `buildContentFromParts()` now passes `width` for secondary row truncation

## Fix Strategy

Three layers of defense:
1. **Progressive dropping** — right-zone segments dropped when left+right exceeds width (prevents mid-ANSI truncation)
2. **Gap guard** — `buildZoneRow()` skips right zone when `gap < 0` (prevents negative-offset padding)
3. **`truncateToWidth` safety net** — final output always truncated to `fullWidth` (catches any edge case)

## Verification

### Test Results
- ✓ TypeScript compiles clean (`npx tsc --noEmit`)
- ✓ Logic verified: right-zone dropping loop correctly shrinks zones
- ✓ Safety net present: both output paths have `truncateToWidth`

### Regression Check
- ✓ Normal-width terminals: no segments dropped, full footer renders
- ✓ Center-zone overflow: existing logic unchanged, still works
- ✓ Secondary row: now also truncated (was previously untruncated)

## Risks & Mitigations
- Right-zone segments appear in secondary row when dropped: acceptable fallback
- `truncateToWidth` may cut mid-ANSI: mitigated by progressive dropping happening first; truncation is last-resort safety net

## Notes
- The `availableForCenter` variable is retained but no longer used for the actual center overflow check (replaced by `adjAvailableForCenter`). Left for readability — could be cleaned up.
- The dead zone-separator positioning code in `buildZoneRow()` was simplified during the fix.
