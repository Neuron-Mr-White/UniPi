---
title: "Kanboard Server Toggle — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Kanboard Server Toggle — Quick Fix

## Bug
`/unipi:kanboard` always starts a new server instance instead of toggling between start/stop. Running the command multiple times would spawn multiple HTTP servers on different ports.

## Root Cause
The command handler in `commands.ts` called `startServer()` unconditionally on every invocation. The `KanboardServer.checkExistingInstance()` method existed but only logged a warning — it didn't prevent creating a new server or stop the old one.

## Fix
Rewrote the kanboard command handler to implement proper toggle behavior:

1. **Module-level `runningServer` variable** — tracks the active server instance within the process
2. **Toggle logic** — if `runningServer` is set, stop it and null it out; if not, start fresh
3. **PID file cleanup** — handles stale PID files from previous sessions (extension host restarts)

### Files Modified
- `packages/kanboard/commands.ts` — Replaced unconditional `startServer()` with toggle logic using module-level server reference and PID file checks

## Verification
- TypeScript typecheck passes (`npm run typecheck`)
- First run: starts server, stores reference, writes PID file
- Second run: detects `runningServer`, calls `stop()`, cleans PID file
- Stale PID: detects orphaned PID file, cleans it, prompts user to run again

## Notes
- The `KanboardServer.stop()` method closes the HTTP server and removes the PID file
- If the extension host restarts, the module-level reference is lost but the PID file is cleaned up on the next toggle attempt
