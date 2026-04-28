---
title: "Subagent Type Differentiation"
type: quick-work
date: 2026-04-28
---

# Subagent Type Differentiation

## Task
Fix subagent system to properly differentiate between "explore" and "work" agent types. Previously, both types had identical behavior despite being declared as separate builtin types.

## Changes

### `packages/subagents/src/types.ts`
- Added `READ_ONLY_TOOLS` constant: `["read", "bash", "grep", "find", "ls"]`
- Added `ALL_TOOLS` constant: `["read", "bash", "edit", "write", "grep", "find", "ls"]`
- Added `BUILTIN_CONFIGS` record with proper configurations for each agent type:
  - **explore**: Read-only tools, no edit/write, system prompt emphasizes no file modifications
  - **work**: All tools including edit/write, system prompt for implementing changes

### `packages/subagents/src/agent-runner.ts`
- Imported `BUILTIN_CONFIGS` from types
- Added `agentConfig` field to `RunOptions` interface
- Added `resolveAgentConfig()` function that merges explicit config with builtin defaults
- Updated `runAgent()` to:
  - Use agent config for system prompt (supports "replace" mode)
  - Use agent config for tool names via `getToolNamesForType()`

### `packages/subagents/src/agent-manager.ts`
- Imported `BUILTIN_CONFIGS` and `loadCustomAgents`
- Added `customAgents` field to store loaded custom agent configs
- Added `getAgentConfig()` method that resolves from custom agents then builtins
- Updated `startAgent()` to pass `agentConfig` to `runAgent()`

## Verification
- Built package successfully with `npm run build`
- Verified dist files contain the new BUILTIN_CONFIGS and agentConfig resolution logic

## Notes
- Custom agents from `.md` files are now properly loaded via `loadCustomAgents()`
- Explore agents are restricted to read-only tools (no edit, write)
- Work agents have full tool access including file modification
- Agent configs can be overridden via project/global `.md` files
