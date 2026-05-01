---
title: "Footer segments ignoring text icon style — Quick Fix"
type: quick-fix
date: 2026-05-01
---

# Footer segments ignoring text icon style — Quick Fix

## Bug
When `iconStyle` is set to "text" in footer settings, the ralph and workflow segments still display Nerd Font icons instead of text labels. This inconsistency means some segments show "LPS RL ●" while others show "󰼉 ●" even though text mode is selected.

## Root Cause
Two segment files had hardcoded Nerd Font icon constants that bypassed the icon style system:
- `ralph.ts` used `RALPH_ICON = "\udb81\udf09"` directly instead of calling `getIcon("activeLoops")`
- `workflow.ts` used `WORKFLOW_ICON = "\uf52e"` directly instead of calling `getIcon("currentCommand")`

Both files already had `getIcon` imported and a `withIcon` helper defined, but the render functions used the hardcoded constants.

## Fix
Replaced all hardcoded icon constants with dynamic `getIcon()` calls to respect the configured icon style.

### Files Modified
- `packages/footer/src/segments/ralph.ts` — Removed `RALPH_ICON` constant, replaced all usages with `getIcon("activeLoops")`
- `packages/footer/src/segments/workflow.ts` — Removed `WORKFLOW_ICON` constant, replaced usages with `getIcon("currentCommand")` and `withIcon()`

## Verification
- TypeScript compilation passes with no errors (`npx tsc --noEmit`)
- All segment renderers now consistently use the icon style system
- With `iconStyle: "text"`, all segments will display 3-letter text labels (e.g., "LPS", "CMD")

## Notes
- Other segment files (compactor, memory, mcp, kanboard, notify, status-ext) were already correctly using the icon system
- The core segments were also correctly using `withIcon` helper
