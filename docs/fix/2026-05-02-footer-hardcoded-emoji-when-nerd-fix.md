---
title: "Footer hardcoded emoji overriding nerd icon style — Quick Fix"
type: quick-fix
date: 2026-05-02
---

# Footer Hardcoded Emoji Overriding Nerd Icon Style — Quick Fix

## Bug
When selecting "nerd" icon style in the footer settings, some segments in the context/center area still displayed emoji icons (📈, 🗜️) instead of Nerd Font glyphs. Additionally, the `cost` segment had no icon at all, bypassing the icon system entirely.

## Root Cause
Several segment renderers had hardcoded emoji and symbols that bypassed the centralized `getIcon()` / `withIcon()` icon system:

1. **`compactor.ts`** — `mutedPlaceholder("📈 CMP 0")` and `mutedPlaceholder("🗜️ CMP 0")` hardcoded emoji characters directly in placeholder strings
2. **`core.ts`** — `renderCostSegment()` called `color()` directly without `withIcon()`, so the cost segment never displayed any icon regardless of the configured style

Secondary findings (cosmetic, not user-reported):
3. **`ralph.ts`** — Hardcoded `▶`, `⏸`, `✓` symbols (these are basic geometric characters that render consistently across all fonts, not emoji — kept as-is with unicode escape clarification)
4. **`workflow.ts`** — Same `▶`/`✓` symbols (kept as-is for same reason)

## Fix
- Replaced hardcoded emoji in `compactor.ts` placeholders with `withIcon()` calls that respect the configured icon style
- Added `withIcon("cost", ...)` wrapper to the cost segment renderer in `core.ts`
- Clarified ralph.ts and workflow.ts inline symbol usage with comments

### Files Modified
- `packages/footer/src/segments/compactor.ts` — Replaced `"📈 CMP 0"` → `withIcon("sessionEvents", "0")`, `"🗜️ CMP 0"` → `withIcon("compactions", "0")`
- `packages/footer/src/segments/core.ts` — Wrapped cost display in `withIcon("cost", ...)`
- `packages/footer/src/segments/ralph.ts` — Added clarifying comment, converted to unicode escapes
- `packages/footer/src/segments/workflow.ts` — Added clarifying comment, converted to unicode escapes

## Verification
- TypeScript compilation: no new errors (4 pre-existing `globalThis` errors unchanged)
- All segment renderers now consistently use `getIcon()`/`withIcon()` for their primary icon

## Notes
- The ▶ (U+25B6), ⏸ (U+23F8), and ✓ (U+2713) characters are **not** emoji — they are basic geometric/symbol characters that render consistently in all terminal fonts including Nerd Fonts. These were kept as status indicators since they're used for tiny state markers (active/paused/completed) alongside the main icon.
