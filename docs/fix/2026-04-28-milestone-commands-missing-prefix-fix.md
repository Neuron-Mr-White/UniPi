---
title: "Milestone commands missing UNIPI_PREFIX — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Milestone commands missing UNIPI_PREFIX — Quick Fix

## Bug
`/unipi:milestone-onboard` and `/unipi:milestone-update` were not found in the command registry.

## Root Cause
Milestone commands were registered with bare names (`"milestone-onboard"`) instead of prefixed names (`"unipi:milestone-onboard"`). Every other unipi module uses the `${UNIPI_PREFIX}${COMMAND}` pattern, but milestone's `commands.ts` imported only `MILESTONE_COMMANDS` and `MILESTONE_DIRS` from `@pi-unipi/core`, omitting `UNIPI_PREFIX`.

## Fix
Added `UNIPI_PREFIX` import and wrapped both `registerCommand` calls with template literals:

```ts
// Before:
pi.registerCommand(MILESTONE_COMMANDS.ONBOARD, { ... });
pi.registerCommand(MILESTONE_COMMANDS.UPDATE, { ... });

// After:
pi.registerCommand(`${UNIPI_PREFIX}${MILESTONE_COMMANDS.ONBOARD}`, { ... });
pi.registerCommand(`${UNIPI_PREFIX}${MILESTONE_COMMANDS.UPDATE}`, { ... });
```

### Files Modified
- `packages/milestone/commands.ts` — Added `UNIPI_PREFIX` import, prefixed both command registrations

## Verification
- Pattern matches `packages/utility/src/commands.ts`, `packages/workflow/commands.ts`, and all other command registration files
- `UNIPI_PREFIX` = `"unipi:"` (from `@pi-unipi/core/constants.ts`)
- `MILESTONE_COMMANDS.ONBOARD` = `"milestone-onboard"` → full command: `"unipi:milestone-onboard"`

## Notes
- The notify module uses a different pattern (`notify-settings` not `unipi:notify-settings`) but that appears intentional — notify commands are registered through a separate mechanism
