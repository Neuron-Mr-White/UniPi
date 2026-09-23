---
title: "Rename name-badge to badge-name — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Rename name-badge to badge-name — Quick Fix

## Bug
`/unipi:name-badge` command didn't follow the `badge-*` naming convention used by `/unipi:badge-gen` and `/unipi:badge-toggle`. Additionally, `name-gen` was accidentally registered as a kanboard command when it should only exist in utility.

## Root Cause
The name badge toggle command was registered as `name-badge` instead of `badge-name` for consistency with the `badge-*` pattern. The `name-gen` command was added to kanboard's command registry by mistake during a previous agent session.

## Fix
Renamed `name-badge` → `badge-name` in all registration and autocomplete files. Removed `name-gen` from kanboard command constants and command registration.

### Files Modified
- `packages/core/constants.ts` — Changed `NAME_BADGE: "name-badge"` → `BADGE_NAME: "badge-name"`, removed `NAME_GEN` from `KANBOARD_COMMANDS`
- `packages/utility/src/commands.ts` — Updated command registration from `NAME_BADGE` to `BADGE_NAME`
- `packages/utility/src/index.ts` — Updated command list from `NAME_BADGE` to `BADGE_NAME`
- `packages/kanboard/commands.ts` — Removed `name-gen` command handler and JSDoc reference
- `packages/autocomplete/src/constants.ts` — Updated `unipi:name-badge` → `unipi:badge-name`, removed `unipi:name-gen`

## Verification
Build passes cleanly across all packages.

## Notes
- File names (`name-badge.ts`, `name-badge-state.ts`) remain unchanged — these are internal implementation files, not user-facing commands
- The `BADGE_ENTRY_TYPE = "name-badge"` in `name-badge-state.ts` is a TUI entry type identifier, not a command name
