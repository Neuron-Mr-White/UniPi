---
title: "Memory Settings TUI Crash — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Memory Settings TUI Crash — Quick Fix

## Bug
`/unipi:memory-settings` command throws `Cannot read properties of undefined (reading 'select')`, crashing the extension.

## Root Cause
`settings-tui.ts` accessed `(pi as any).ui` expecting TUI methods (`select`, `input`, `notify`), but the `ExtensionAPI` object (`pi`) does not have a `ui` property. The TUI methods are available on `ctx.ui` (`ExtensionCommandContext`), not on `pi`. Additionally, the function used an object-based API signature (`{ title, message, options }`) instead of the actual positional-arg API (`ctx.ui.select(title, labels)`).

## Fix
Rewrote `showMemorySettings` to accept `ctx: ExtensionCommandContext` instead of `pi: ExtensionAPI`, and updated all UI calls to use the correct positional-arg API matching the pattern used in `web-api/src/tui/settings-dialog.ts`.

### Files Modified
- `packages/memory/tui/settings-tui.ts` — Rewrote to use `ctx.ui` with correct API signatures (`select(title, labels)`, `input(message, placeholder)`, `notify(message, level)`)
- `packages/memory/commands.ts` — Pass `ctx` instead of `pi` to `showMemorySettings`
- `packages/memory/embedding.ts` — Updated `reembedAllMemories` to accept `ExtensionCommandContext`
- `packages/memory/storage.ts` — Added `busy_timeout` pragma and `timeout` option to `better-sqlite3` constructor for better concurrent session handling

## Verification
TypeScript compilation passes with no errors. The fix follows the same pattern used by `packages/web-api/src/tui/settings-dialog.ts` which works correctly.

## Notes
The error message also mentioned "other session may have the DB locked" — this is a separate concurrent access issue. The storage already had WAL mode and retry logic; added `busy_timeout = 5000` and constructor `timeout: 5000` to `better-sqlite3` for more robust handling.
