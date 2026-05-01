---
title: "Footer status short labels should be uppercase — Quick Fix"
type: quick-fix
date: 2026-05-01
---

# Footer status short labels should be uppercase — Quick Fix

## Bug
Footer status extension labels (`wf`, `mem`, `rl`, etc.) were displayed in lowercase instead of uppercase. Additionally, `projectCount` text icon was `"mem"` instead of `"MEM"`, and the `unipi-memory` entry was a duplicate of `memory` in `STATUS_DISPLAY`.

## Root Cause
The `STATUS_DISPLAY` map in `status-ext.ts` used lowercase `short` values (`"wf"`, `"rl"`, `"cmp"`, etc.), and the text icon style in `icons.ts` had `"mem"` for `projectCount` instead of `"MEM"`. The `unipi-memory` entry in `STATUS_DISPLAY` was redundant since incoming status keys with that prefix are already handled by the `cleanStatusValue` name patterns.

## Fix
- `icons.ts` — Changed `projectCount: "mem"` → `"MEM"` in the text icon style
- `status-ext.ts` — Uppercased all `short` values in `STATUS_DISPLAY` (`"wf"`→`"WF"`, `"rl"`→`"RL"`, `"cmp"`→`"CMP"`, `"mcp"`→`"MCP"`, `"ntf"`→`"NTF"`, `"kb"`→`"KB"`, `"info"`→`"INF"`, `"sa"`→`"SA"`)
- `status-ext.ts` — Removed duplicate `"unipi-memory"` entry from `STATUS_DISPLAY` (the `cleanStatusValue` name patterns still handle stripping the prefix from incoming values)

### Files Modified
- `packages/footer/src/rendering/icons.ts` — `projectCount` text icon uppercase
- `packages/footer/src/segments/status-ext.ts` — All `short` labels uppercase, removed duplicate entry, updated doc comment

## Verification
- TypeScript compilation: clean
- All 41 tests pass
