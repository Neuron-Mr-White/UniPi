---
title: "Footer Renderer Width Overflow Crash — Debug Report"
type: debug
date: 2026-05-02
severity: critical
status: root-caused
---

# Footer Renderer Width Overflow Crash — Debug Report

## Summary
Footer extension crashes pi when terminal is narrowed — rendered line exceeds terminal width.

## Expected Behavior
Footer adapts to terminal width, dropping segments that don't fit, never exceeding terminal width.

## Actual Behavior
pi crashes with: `Rendered line 234 exceeds terminal width (71 > 51)`.

## Reproduction Steps
1. Start pi with footer extension enabled
2. Narrow terminal window to ~46 columns
3. Crash within seconds (render loop)

## Environment
- pi v0.72.0
- Terminal: any (reproduced at 46 and 51 columns)
- Footer preset: default (12 segments across left/center/right zones)

## Root Cause Analysis

### Failure Chain
1. Terminal narrows to 46 columns
2. `computeLayout(46)` renders all 12 enabled segments (model, api_state, tool_count, git, tps, context_pct, cost, compactions, tokens_saved, current_command, clock, duration)
3. `buildZoneRow()` joins left + center + right zones → total visible width = 71
4. **No `truncateToWidth()` applied to final output**
5. pi-tui's `doRender()` validates line widths → finds 71 > 46 → throws error

### Root Cause
`FooterRenderer` in `packages/footer/src/rendering/renderer.ts`:
- Imports `truncateToWidth` but never calls it
- `buildZoneRow()` returns untruncated string
- `buildContentFromParts()` returns untruncated string
- Only center-zone overflow was handled (progressive drop); left+right zones never dropped

### Evidence
- Crash log: `/home/pi/.pi/agent/pi-crash.log` — line [3] w=71, line [7] w=56, terminal width=46
- File: `renderer.ts:12` — `truncateToWidth` imported but unused
- File: `renderer.ts` `buildZoneRow()` — no truncation before return
- File: `renderer.ts` `buildContentFromParts()` — no width param, no truncation

## Affected Files
- `packages/footer/src/rendering/renderer.ts` — missing truncation + missing right-zone overflow handling

## Suggested Fix
1. Add `truncateToWidth(result, fullWidth)` at end of `buildZoneRow()`
2. Add width param + truncation to `buildContentFromParts()`
3. Add progressive right-zone segment dropping (like existing center-zone overflow)
4. Guard: skip right zone when gap < 0

## Verification Plan
1. Start pi with footer enabled
2. Narrow terminal to 30, 40, 46, 50 columns
3. Verify no crash, footer content truncated or segments dropped gracefully
4. Widen terminal — verify full footer returns
