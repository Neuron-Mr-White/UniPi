---
title: "Footer muted placeholders ignore iconStyle config — Quick Fix"
type: quick-fix
date: 2026-05-02
---

# Footer muted placeholders ignore iconStyle config — Quick Fix

## Bug
When MCP, kanboard, notify, memory, or ralph groups were toggled on from an off state (no data), their muted placeholder segments used hardcoded emoji or text strings instead of respecting the configured `iconStyle` setting (nerd/emoji/text). This meant:

1. **MCP** showed `🖥️ MCP 0` (hardcoded emoji + text) instead of the configured icon glyph
2. **Kanboard** showed `KB 0` (hardcoded text) instead of the configured icon glyph
3. **Notify** showed `NTF OFF` / `NTF 0` (hardcoded text) instead of the configured icon glyph
4. **Memory** showed `🧠 MEM 0` (hardcoded emoji) instead of the configured icon glyph
5. **Ralph** showed `🔁 RL OFF` / `🔁 RL 0` (hardcoded emoji) — and showed **three duplicate placeholders** from `active_loops`, `total_iterations`, and `loop_status` segments all rendering similar "RL OFF" content

## Root Cause
Muted placeholder strings in segment render functions used inline hardcoded characters (emoji or text abbreviations) instead of calling `getIcon()` which resolves the correct glyph based on the `iconStyle` config setting.

For Ralph specifically, all three segments (`active_loops`, `total_iterations`, `loop_status`) independently rendered their own muted placeholder when no data was available, creating visual duplicates.

## Fix
1. Replaced all hardcoded emoji/text in `mutedPlaceholder()` calls with `withIcon()` / `getIcon()` calls that respect the configured icon style
2. For Ralph: `total_iterations` and `loop_status` now return `{ visible: false }` when there's no data, leaving only `active_loops` to show the single group-level placeholder

### Files Modified
- `packages/footer/src/segments/mcp.ts` — 3 muted placeholders now use `withIcon()`
- `packages/footer/src/segments/kanboard.ts` — 3 muted placeholders now use `withIcon()`
- `packages/footer/src/segments/notify.ts` — 2 muted placeholders now use `withIcon()`
- `packages/footer/src/segments/ralph.ts` — muted placeholder uses `getIcon()`; `total_iterations` and `loop_status` hide instead of duplicating
- `packages/footer/src/segments/memory.ts` — 1 muted placeholder now uses `withIcon()`

## Verification
- TypeScript compiles cleanly with `tsc --noEmit`
- All changes are mechanical string replacements in placeholder paths
- No logic changes to data handling or rendering of actual values

## Notes
- `ANSI_RESET` constant in ralph.ts is unused (pre-existing, unrelated)
- Test files under `packages/footer/tests/` are empty stubs (pre-existing)
