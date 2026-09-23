---
title: "Footer Segments Not Rendered When Toggled On — Quick Fix"
type: quick-fix
date: 2026-05-02
---

# Footer Segments Not Rendered When Toggled On — Quick Fix

## Bug
When toggling segments "on" in the footer settings TUI (e.g., `thinking_level`, `tps`), they still don't appear in the rendered footer. The settings are saved correctly, but the visual output doesn't change.

## Root Cause
The `FooterRenderer.computeLayout()` method only iterates over segment IDs defined in the **active preset's** `leftSegments`, `rightSegments`, and `secondarySegments` arrays. Segments that exist in the system but are not listed in the preset are never considered for rendering, regardless of whether the user has explicitly enabled them via the settings TUI.

For example, `thinking_level` is only in the `full` and `nerd` presets' `secondarySegments`. If the user is on the `default` preset and toggles it on, the renderer never sees it.

## Fix
Added logic to `computeLayout()` that, after collecting preset segment IDs, also checks all known segments for any that are **explicitly enabled** by the user but not included in the preset. These segments are appended to the primary segment list and rendered in their defined zone.

### Changes:
1. **`src/rendering/renderer.ts`** — Expanded `SegmentLookup` interface with `allIds()` method. In `computeLayout()`, added post-preset pass that collects user-toggled segments not in the preset.
2. **`src/config.ts`** — Added `isSegmentExplicitlyEnabled()` function that returns `true` only if a segment is explicitly set to `true` in settings (not just defaulting to enabled).
3. **`src/index.ts`** — Updated `SegmentLookup` instantiation to provide `allIds()` backed by the segment map keys.

### Files Modified
- `packages/footer/src/rendering/renderer.ts` — Added `allIds` to interface, import `isSegmentExplicitlyEnabled`, added user-enabled segment collection in `computeLayout`
- `packages/footer/src/config.ts` — Added `isSegmentExplicitlyEnabled()` export
- `packages/footer/src/index.ts` — Updated `SegmentLookup` instantiation with `allIds()`

## Verification
- TypeScript compilation: no new errors (4 pre-existing `globalThis` errors unchanged)
- Existing tests: no regressions (all suites were pre-existing empty)
- Manual verification: toggling `thinking_level` on in default preset should now render it in the center zone

## Notes
- Segments are appended to the end of the primary ID list, so they appear after preset-defined segments
- The zone placement comes from the segment's `zone` property, not the preset
- This fix is additive — no existing behavior is changed for segments already in presets
