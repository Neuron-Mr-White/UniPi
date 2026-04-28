---
title: "Remove Subagent Startup Debug Message"
type: quick-work
date: 2026-04-28
---

# Remove Subagent Startup Debug Message

## Task
Remove the startup debug message that printed subagent config paths on every session start.

## Changes
- `packages/subagents/src/index.ts`: Removed `ctx.ui.notify()` call and unused `globalConfig`/`workspaceConfig` variables from `session_start` handler.

## Verification
- Build passes (`npm run build --workspace=packages/subagents`).
- Handler now only emits `MODULE_READY` event.

## Notes
The removed block printed global and workspace config/agent directory paths as an info notification on every session start — useful during development but noisy for users.
