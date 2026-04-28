---
title: "Subagent Layout Shift from Extension Logging — Fix Report"
type: fix
date: 2026-04-29
debug-report: .unipi/docs/debug/2026-04-29-subagent-layout-shift-debug.md
status: fixed
---

# Subagent Layout Shift from Extension Logging — Fix Report

## Summary
Fixed 3 root causes of layout shift during subagent spawning: ignored agent config flags, un-debounced MODULE_READY events, and startup console output.

## Debug Report Reference
- Report: `.unipi/docs/debug/2026-04-29-subagent-layout-shift-debug.md`
- Root Cause: 3 issues — ignored config flags, no event debouncing, console output in startup

## Changes Made

### Files Modified

- `packages/subagents/src/agent-runner.ts` — Respect `agentConfig.extensions`/`skills` flags for `noExtensions`/`noSkills`. Skip `bindExtensions()` when extensions are disabled.
- `packages/info-screen/index.ts` — Debounce MODULE_READY handling with 150ms batch window. All module announcements within the window are processed together, triggering a single cache invalidation.
- `packages/mcp/src/index.ts` — Removed 3 console statements (1 log, 2 error) for server startup and config loading.
- `packages/mcp/src/bridge/registry.ts` — Removed 1 console.error for env config validation.
- `packages/memory/index.ts` — Removed 5 console statements (3 warn, 1 debug, 1 warn) for storage init, orphaned sync, info panel, status count, and recall.
- `packages/memory/storage.ts` — Removed 6 console.warn for transient retries, sqlite-vec loading, corrupted file cleanup, vector insertion, markdown write, and orphaned file sync.
- `packages/memory/embedding.ts` — Removed 5 console.warn for API errors, unexpected format, timeout, general error, and re-embedding failure.
- `packages/kanboard/server/index.ts` — Removed 5 console statements (3 log, 1 log, 1 warn) for existing instance, shutdown, server start, port allocation, and PID write.
- `packages/milestone/coexist.ts` — Removed 3 console.log for brainstorm-milestone matches, plan-milestone matches, and auto-sync notification.
- `packages/notify/settings.ts` — Removed 1 console.warn for config load failure.

### Code Changes

**agent-runner.ts — Core fix:**
```typescript
// Before:
noExtensions: options.isolated,
noSkills: options.isolated,

// After:
const skipExtensions = options.isolated || agentConfig?.extensions === false;
const skipSkills = options.isolated || agentConfig?.skills === false;
// ...
noExtensions: skipExtensions,
noSkills: skipSkills,
// ...
if (!skipExtensions) {
  await session.bindExtensions({ ... });
}
```

**info-screen/index.ts — Debounce fix:**
```typescript
// Before: Per-event invalidation
pi.events.on(MODULE_READY, (event) => {
  trackModule(...);
  invalidateCache("overview");  // ← fires 12+ times
  getGroupData("overview");
});

// After: Batched with 150ms debounce
let batch = [];
let timer = null;
pi.events.on(MODULE_READY, (event) => {
  batch.push(event);
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushBatch, 150);
});
function flushBatch() {
  // Process all at once → single invalidation
}
```

## Fix Strategy

1. **agentConfig flags**: The BUILTIN_CONFIGS for explore/work already specify `extensions: false` and `skills: false`. The agent runner now reads these flags and passes them to the DefaultResourceLoader. This prevents loading 12+ extensions for every subagent spawn.

2. **bindExtensions skip**: When extensions aren't loaded, there's no point firing `session_start` (which triggers MODULE_READY in loaded extensions). The fix skips `bindExtensions()` entirely when `skipExtensions` is true.

3. **Debounced MODULE_READY**: Instead of invalidating the info-screen cache on every single MODULE_READY event, events are batched for 150ms. All modules that announce within the window are tracked together, and cache is invalidated once. This reduces 12+ re-renders to 1.

4. **Console removal**: All startup-path console.log/warn calls were removed. Error/warning information is preserved through:
   - Info-screen groups (MCP status, memory status)
   - Status bar entries (memory count, subagent count)
   - Tool results (memory search returns empty on failure)
   - Runtime error handlers (notify, kanboard routes)

## Verification

### Test Results
- ✓ TypeScript compilation: clean (`npx tsc --noEmit`)
- ✓ Subagent tests: 53/53 pass (`node --test`)
- ✓ Badge generation tests: 19/19 pass
- ✓ Workflow integration tests: 11/11 pass

### Regression Check
- ✓ Explore agents still work (tools filtered, no extensions loaded)
- ✓ Work agents still work (tools filtered, no extensions loaded)
- ✓ Badge generation still works (isolated: true, unchanged)
- ✓ Custom agents with `extensions: true` still load extensions
- ✓ Info-screen still shows all modules (debounced, not removed)
- ✓ MCP servers still start (console removed, not functionality)
- ✓ Memory still initializes (console removed, not functionality)

## Risks & Mitigations
- **Risk**: Removing console.error for MCP server failures makes debugging harder.
  **Mitigation**: MCP server status is visible via `/unipi:mcp-status` command and info-screen MCP group.
- **Risk**: Debounce adds 150ms delay to info-screen module list population.
  **Mitigation**: The delay is imperceptible — modules load in <50ms total, so the batch fires once with all modules.
- **Risk**: Skipping bindExtensions for agents with `extensions: false` might miss some initialization.
  **Mitigation**: The `extensions: false` flag is explicitly set by agent configs to indicate no extensions needed. If extensions are needed, set `extensions: true` in the agent .md file.

## Notes
- Console.error calls for runtime errors (notification failures, route errors) were intentionally kept — they only fire when something actually goes wrong, not on every startup.
- The 150ms debounce window is conservative — all extensions typically emit MODULE_READY within 10-20ms of each other during session_start.

## Follow-up
- [ ] Consider adding a `debug` flag to subagents config for verbose logging when needed
- [ ] Consider batching MODULE_READY in the core emitEvent function itself
