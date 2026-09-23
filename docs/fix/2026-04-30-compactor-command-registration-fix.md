---
title: "Compactor Commands Sent as Pure String — Quick Fix"
type: quick-fix
date: 2026-04-30
---

# Compactor Commands Sent as Pure String — Quick Fix

## Bug
When typing `/unipi:compact-settings` (or any `/unipi:compact-*` command) in Pi, the command text was being sent as a literal message to the LLM instead of executing the command handler. The autocomplete showed the commands correctly, but execution failed silently — the text was dispatched to the agent as a regular prompt.

## Root Cause
In `packages/compactor/src/index.ts`, the `registerCommands()` call was placed ONLY inside the `session_start` event handler. Pi's extension runtime resolves commands synchronously when the extension factory function runs. If `registerCommands` is called inside an async event handler (even one that fires before user interaction), there's a risk the commands aren't available when Pi's command dispatcher checks for them.

Specifically:
1. When the user types `/unipi:compact-settings`, Pi calls `_tryExecuteExtensionCommand()` which extracts the command name and looks it up via `extensionRunner.getCommand()`
2. `getCommand()` iterates over all registered commands looking for a matching `invocationName`
3. If `registerCommands` hasn't been called yet (or was called in a handler that hasn't fired), the command is not found
4. Pi returns `false` from `_tryExecuteExtensionCommand()` and sends the text to the LLM as a regular prompt

The other unipi extensions (ask-user) follow the correct pattern of registering commands immediately in the extension factory function, not inside event handlers.

## Fix
Moved `registerCommands(pi, getCommandDeps())` to be called immediately in the extension factory function, before any event handler setup. This matches the pattern used by `ask-user`, `memory`, `mcp`, `notify`, and other unipi extensions.

### Files Modified
- `packages/compactor/src/index.ts` — Moved `registerCommands(pi, getCommandDeps())` from inside `session_start` handler to immediately after `getCommandDeps` definition. Removed the duplicate call. Updated comments.

## Verification
- Verified all 9 compact commands are registered with the correct `unipi:` prefix (`unipi:compact`, `unipi:compact-settings`, etc.)
- Commands are now available immediately when the extension loads, before `session_start` fires
- Pi's command dispatcher should now find and execute the commands when `/unipi:compact-*` is typed

## Notes
- The npm published version (0.1.7) already had this fix applied during the release process, but the main branch source code did not. This fix synchronizes the main branch with the npm version.
- The underlying issue was identified in a previous fix (2026-04-29, see memory `compactor_commands_need_unipi_prefix`). The command prefix (`unipi:`) was already correct; only the registration timing was wrong.
