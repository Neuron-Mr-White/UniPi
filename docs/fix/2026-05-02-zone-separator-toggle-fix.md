---
title: "Zone separator between SES and CTX cannot be toggled — Quick Fix"
type: quick-fix
date: 2026-05-02
---

# Zone separator between SES and CTX cannot be toggled — Quick Fix

## Bug
The zone separator (`│`) that appears between the left zone (containing SES/session) and the center zone (containing CTX/context_pct) in the footer bar cannot be toggled on/off or customized. While `FooterSettings.zoneSeparator` exists as a config field, there is no UI to change it and the renderer does not handle hiding it.

## Root Cause
Two issues:
1. The settings TUI (`settings-tui.ts`) Appearance section had no option to control the zone separator — users could only change the **segment** separator style (powerline, pipe, etc.), not the **zone** separator.
2. The renderer (`renderer.ts`) always rendered the zone separator when adjacent zones both had content, with no check for `"none"` or empty values.

## Fix
- Added `ZONE_SEPARATOR_OPTIONS` to settings TUI with options: `│`, `╎`, `·`, `─`, `none`
- Added "Zone Separator" setting item to the Appearance section
- Updated renderer to detect `"none"` or empty `zoneSeparator` and skip rendering (also adjusts width calculations to reclaim the space)

### Files Modified
- `packages/footer/src/rendering/renderer.ts` — Added `zoneSepHidden` check; skips rendering and zeroes width when zone separator is "none"
- `packages/footer/src/tui/settings-tui.ts` — Added zone separator option to Appearance section with 5 styles including "none"

## Verification
- TypeScript compilation passes with no errors
- Zone separator widths correctly zeroed when hidden, reclaiming space for center zone content

## Notes
- The right-zone separator rendering code in `buildZoneRow` is effectively dead code (calculates position but never inserts the separator) — not touched in this fix.
- The segment separator (`sep:<style>`) command documented in README is also unimplemented but was not in scope for this fix.
