---
title: "Milestone commands missing from command-enchantment registry — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Milestone commands missing from command-enchantment registry — Quick Fix

## Bug
Even after fixing the `UNIPI_PREFIX` in `packages/milestone/commands.ts`, the milestone commands (`/unipi:milestone-onboard`, `/unipi:milestone-update`) still didn't appear in the enhanced autocomplete provided by `@pi-unipi/command-enchantment`.

## Root Cause
The command-enchantment package maintains a **static registry** in `packages/autocomplete/src/constants.ts` that lists every unipi command for enhanced display. This registry has 6 data structures that all need updating when adding a new package:

1. `PACKAGE_ORDER` — display priority (top-to-bottom)
2. `PACKAGE_COLORS` — ANSI color codes per package
3. `COMMAND_REGISTRY` — command name → package mapping
4. `COMMAND_DESCRIPTIONS` — short descriptions for autocomplete
5. `PACKAGE_LABELS` — pretty display names for tags
6. `NAMESPACE_ALIASES` (in `provider.ts`) — query aliases for namespace search

Milestone was missing from all 6.

## Fix
Added milestone to all registration points:

### Files Modified
- `packages/autocomplete/src/constants.ts`:
  - `PACKAGE_ORDER` — added `"milestone"` after `"memory"`
  - `PACKAGE_COLORS` — added `milestone: green`
  - `COMMAND_REGISTRY` — added `"unipi:milestone-onboard"` and `"unipi:milestone-update"` → `"milestone"`
  - `COMMAND_DESCRIPTIONS` — added descriptions for both commands
  - `PACKAGE_LABELS` — added `"milestone": "milestone"`

- `packages/autocomplete/src/provider.ts`:
  - `NAMESPACE_ALIASES` — added `"milestone"`, `"ms"`, `"goal"` aliases

## Verification
- Pattern matches all other packages (workflow, ralph, memory, mcp, etc.)
- Both commands now appear in `COMMAND_REGISTRY` with correct package mapping
- Namespace search works: typing `/milestone`, `/ms`, or `/goal` will surface milestone commands

## Notes
This is the third fix in the milestone registration chain:
1. `2026-04-28-milestone-package-not-registered-fix.md` — added to unipi index.ts and package.json
2. `2026-04-28-milestone-module-not-found-fix.md` — ran npm install for symlink
3. `2026-04-28-milestone-commands-missing-prefix-fix.md` — added UNIPI_PREFIX
4. **This fix** — added to command-enchantment static registry

When adding a new unipi package, all 4 steps are required.
