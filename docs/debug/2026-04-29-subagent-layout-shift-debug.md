---
title: "Subagent Layout Shift from Extension Logging — Debug Report"
type: debug
date: 2026-04-29
severity: medium
status: root-caused
---

# Subagent Layout Shift from Extension Logging — Debug Report

## Summary
When @pi-unipi/subagents spawns an agent (or badge generation triggers), the UI experiences repetitive layout shifts caused by extension MODULE_READY events and console output during session initialization.

## Expected Behavior
Subagent spawning should be silent — no layout shifts, no console output, no unnecessary extension loading.

## Actual Behavior
1. **Info-screen re-renders 12+ times** during startup as each extension emits MODULE_READY individually
2. **Console.log/warn output** from MCP, memory, kanboard, milestone, notify packages causes terminal layout shift
3. **Non-isolated subagents load ALL parent extensions** despite agent config specifying `extensions: false`

## Reproduction Steps
1. Start pi with unipi extensions loaded
2. Observe info-screen overlay flickering during boot
3. Spawn a subagent via `spawn_helper` tool
4. Observe the same MODULE_READY cascade in the subagent's session

## Environment
- All unipi extension packages
- Pi interactive mode with info-screen showOnBoot: true

## Root Cause Analysis

### Failure Chain
1. `spawn_helper.execute()` → `manager.spawn()` → `agent-runner.ts:runAgent()`
2. `DefaultResourceLoader({ noExtensions: options.isolated })` — only checks `isolated`, ignores `agentConfig.extensions`
3. `session.bindExtensions()` fires unconditionally — triggers `session_start` for all loaded extensions
4. Each extension emits MODULE_READY → info-screen invalidates cache per event
5. 12+ extensions × 2 cache invalidations (overview + tools) = ~24 re-renders

### Root Cause
**3 distinct issues:**

1. **agent-runner.ts ignores agentConfig.extensions/skills flags**: The `DefaultResourceLoader` only respects `options.isolated`, but BUILTIN_CONFIGS for explore/work both set `extensions: false` and `skills: false`. These flags are parsed by custom-agents.ts but never consumed by agent-runner.ts.

2. **No debouncing on info-screen MODULE_READY handler**: Each module announcement triggers `invalidateCache()` + `getGroupData()` individually, causing rapid re-rendering.

3. **Console.log/warn in session_start handlers**: MCP, memory, kanboard, milestone, notify packages emit console output during startup.

### Evidence
- `packages/subagents/src/agent-runner.ts:179` — `noExtensions: options.isolated` (ignores agentConfig)
- `packages/subagents/src/types.ts:30-31` — explore/work configs have `extensions: false, skills: false`
- `packages/info-screen/index.ts:36-57` — MODULE_READY handler invalidates per-event
- `packages/mcp/src/index.ts:91` — `console.log("[MCP] Started server...")`
- `packages/memory/index.ts:82,85` — `console.warn("[unipi/memory]...")`
- `packages/kanboard/server/index.ts:111` — `console.log("[kanboard] Server running...")`

## Affected Files
- `packages/subagents/src/agent-runner.ts` — extension loading logic
- `packages/info-screen/index.ts` — MODULE_READY event handling
- `packages/mcp/src/index.ts` — startup console.log
- `packages/mcp/src/bridge/registry.ts` — startup console.error
- `packages/memory/index.ts` — startup console.warn/debug
- `packages/memory/storage.ts` — init console.warn
- `packages/memory/embedding.ts` — embedding error console.warn
- `packages/kanboard/server/index.ts` — startup console.log
- `packages/milestone/coexist.ts` — event console.log
- `packages/notify/settings.ts` — config load console.warn

## Suggested Fix
1. In agent-runner.ts, use `agentConfig?.extensions === false` to set `noExtensions: true`
2. Skip `bindExtensions()` when extensions are skipped
3. Debounce info-screen MODULE_READY handling with 150ms batch window
4. Remove all startup-path console.log/warn statements
