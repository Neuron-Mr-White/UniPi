---
title: "Compactor Stats Always Zero — Debug Report"
type: debug
date: 2026-05-02
severity: high
status: root-caused
---

# Compactor Stats Always Zero — Debug Report

## Summary
Compactor stats display always shows zero for tokens saved, cost saved, % reduction, top tools, and tool calls — despite 5,921 session events stored in the DB and 1 confirmed compaction. Root cause: architectural flaw in the stats model combined with a likely runtime bug in `measureResponseBytes()`.

## Expected Behavior
Stats should show:
- Tokens saved from compaction (the ACTUAL value of the compactor)
- Tool call counts and per-tool byte breakdown
- % reduction from compaction
- Cost saved estimate based on actual tokens saved

## Actual Behavior
```
Tokens saved: 0 (No tool calls yet)
Cost saved:   $0.00 (~0 tokens × $2.85/M tokens)
% Reduction:  0% (0 processed → 0 entered context)
Top tools:    N/A (No tool calls yet)
Compactions:  1 (1 compaction(s) across all sessions)
Tool calls:   0 (0 total tool calls across 0 tools)
```

## Reproduction Steps
1. Use pi with compactor extension for any length of time
2. Make tool calls (read, bash, edit, write, grep, find)
3. Optionally trigger a compaction
4. Observe stats in footer/info-screen — all zeros except compaction count

## Environment
- Pi with `@pi-unipi/compactor` extension
- Node.js v24.14.1
- Session DB: `~/.unipi/db/compactor/session.db` (432 KB)
- Content DB: `~/.unipi/db/compactor/content.db` (9.2 MB)

## Root Cause Analysis

### THREE interrelated bugs, forming a cascade failure:

### Bug 1: Stats model measures the WRONG thing (CRITICAL — Architectural)

**File:** `packages/compactor/src/info-screen.ts:58`
**File:** `packages/compactor/src/session/analytics.ts:94-97`

The `tokensSaved` display uses `report.savings.kept_out`:
```typescript
// info-screen.ts
const tokensSaved = Math.round(report.savings.kept_out / 4);
```

Where `kept_out` is computed in `AnalyticsEngine.queryAll()`:
```typescript
// analytics.ts
const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
```

This is **fundamentally wrong**. It measures "bytes diverted from context by sandbox/index tools" — NOT "tokens saved by compaction". The compactor's ACTUAL value is in its 6-stage compaction pipeline that reduces context window size. This value IS tracked in the DB (`total_chars_before`, `total_chars_kept`) but the info-screen display doesn't use it.

Additionally:
- `bytesIndexed` is **always 0** because `isIndexTool()` always returns `false`
- `bytesSandboxed` only counts bash tool output — but bash output DOES enter the context

So even if the tracking worked perfectly, `kept_out` would only reflect bash output bytes, not actual compaction savings.

### Bug 2: `runtimeStats.calls` stays empty — measureResponseBytes returns 0 (CRITICAL)

**File:** `packages/compactor/src/index.ts:35-50` (measureResponseBytes)
**File:** `packages/compactor/src/index.ts:246-257` (tool_result handler)

The `tool_result` handler updates `runtimeStats.calls` only when `measureResponseBytes(event) > 0`:
```typescript
try {
    const responseBytes = measureResponseBytes(event);
    if (responseBytes > 0) {
        runtimeStats.calls[tName] = ...;
        runtimeStats.bytesReturned[tName] = ...;
    }
} catch { }
```

**Evidence that the handler fires:** 5,921 session events stored in DB from `extractEventsFromToolResult()`, which runs in the same handler BEFORE the stats tracking. The stored events include tool responses with `TextContent` structure: `[{"type":"text","text":"..."}]`.

**The mystery:** `measureResponseBytes` SHOULD work because Pi's `ToolResultEvent` has `content: (TextContent | ImageContent)[]` where `TextContent = { type: "text", text: string }`. The function checks `Array.isArray(content)` and `block?.text` — both should match.

**Hypothesis:** Either `event.content` is somehow empty/undefined at runtime despite TypeScript types saying otherwise, OR there's a subtle timing issue with async handler execution in Pi's extension system.

**Impact:** Since `runtimeStats.calls` and `runtimeStats.bytesReturned` stay empty, ALL computed stats are zero:
- `totalCalls = 0` → "0 tool calls"
- `totalBytesReturned = 0` → `totalProcessed = keptOut + 0 = 0` → `pctReduction = 0%`
- `keptOut = bytesIndexed + bytesSandboxed = 0 + 0 = 0` → `tokensSaved = 0`
- No per-tool breakdown possible

### Bug 3: DB compaction stats never populated — cascade from Bug 2 (HIGH)

**File:** `packages/compactor/src/index.ts:209-231` (session_compact handler)

The `session_compact` handler calls `addCompactionStats()` only when conditions are met:
```typescript
if (tokensBefore > 0) {
    sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, messagesSummarized);
} else {
    if (totalBytesProcessed > 0) {
        sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, messagesSummarized);
    }
}
```

Both conditions depend on populated data:
- `tokensBefore` = `compactionEntry?.tokensBefore ?? 0` — may be 0 if Pi doesn't provide it
- `totalBytesProcessed` = `bytesIndexed + bytesSandboxed + totalBytesReturned` — all depend on runtimeStats, which is empty (Bug 2)

**Result:** `addCompactionStats` is NEVER called → DB `total_chars_before`, `total_chars_kept`, `total_messages_summarized` all stay at 0.

**Evidence from DB:**
```json
{
    "compact_count": 1,
    "total_chars_before": 0,
    "total_chars_kept": 0,
    "total_messages_summarized": 0
}
```

### Failure Chain

```
1. measureResponseBytes returns 0 (Bug 2 — cause unclear)
   → runtimeStats.calls and runtimeStats.bytesReturned stay empty
   → runtimeStats.bytesSandboxed stays 0

2. kept_out = bytesIndexed(0) + bytesSandboxed(0) = 0
   → tokensSaved display = 0 (Bug 1 — wrong metric)
   → pctReduction = 0%

3. totalBytesProcessed = 0 + 0 + 0 = 0
   → addCompactionStats() never called (Bug 3)
   → DB compaction stats stay 0
   → Even DB fallback for tokensSaved shows 0

4. by_tool array is empty (no calls to populate it)
   → "No tool calls yet" for top tools and breakdown
   → totalCalls = 0
```

## Affected Files
- `packages/compactor/src/index.ts` — tool_result handler (measureResponseBytes), session_compact handler (addCompactionStats conditions)
- `packages/compactor/src/info-screen.ts` — tokensSaved uses wrong metric (kept_out instead of compaction savings)
- `packages/compactor/src/session/analytics.ts` — kept_out calculation is architecturally wrong
- `packages/compactor/src/tools/ctx-stats.ts` — ctxStats tool has DB fallback but info-screen doesn't use same approach
- `packages/compactor/src/compaction/hooks.ts` — session_before_compact also calls addCompactionStats but it's unclear if it succeeded

## Suggested Fix

### Fix Strategy

**1. Replace `kept_out` metric with actual compaction savings (Bug 1)**

In `info-screen.ts`, compute `tokensSaved` from DB compaction stats:
```typescript
// Current (WRONG):
const tokensSaved = Math.round(report.savings.kept_out / 4);

// Should be:
const allTime = sessionDB.getAllTimeStats();
const tokensSaved = Math.round((allTime.allCharsBefore - allTime.allCharsKept) / 4);
// Or from runtimeStats counter:
const tokensSaved = counters?.totalTokensCompacted ?? 0;
```

**2. Fix `measureResponseBytes` or bypass it entirely (Bug 2)**

Option A: Add defensive logging and check if `event.content` exists at runtime.
Option B: Use DB event counts as fallback for tool calls:
```typescript
// Fallback from session_events table
const toolEvents = db.prepare(
    "SELECT category, COUNT(*) as cnt FROM session_events WHERE session_id = ? GROUP BY category"
).all(sessionId);
```

**3. Fix addCompactionStats conditions (Bug 3)**

Always call `addCompactionStats` from the `session_before_compact` handler (hooks.ts), which has direct access to the messages being compacted:
```typescript
// Always write stats, don't condition on runtimeStats
sessionDB.addCompactionStats(sessionId, charsBefore, keptChars, agentMessages.length);
```

**4. Restructure the stats model**

Replace the current `kept_out` model with:
- `tokensSaved` = actual compaction token reduction (from DB or counter)
- `toolCalls` = count from session_events table (reliable)
- `pctReduction` = from compaction ratios stored in DB
- `costSaved` = tokensSaved × cost per token

### Risk Assessment
- **Risk: Runtime behavior of measureResponseBytes unclear.** Mitigation: Add temporary debug logging to verify event structure.
- **Risk: Changing stats model breaks ctx-stats tool.** Mitigation: Update ctx-stats tool to use same approach.
- **Risk: DB queries in dataProvider may be slow.** Mitigation: Cache allTimeStats for the session duration.

## Verification Plan
1. After fix, check `compactor_stats` tool shows non-zero tokens saved
2. Verify DB `total_chars_before` and `total_chars_kept` are populated after compaction
3. Verify info-screen shows tool call counts from session_events
4. Verify % reduction reflects actual compaction ratio

## Notes
- The `compactor_stats` tool (`ctxStats`) has proper DB fallbacks (getAllTimeStats) but the info-screen display does NOT use the same approach
- The previous fix (`.unipi/docs/fix/2026-05-02-compactor-stats-always-zero-fix.md`) addressed session ID mismatches and tokensBefore path, but the stats are STILL zero — suggesting the root cause is deeper
- The DB has only ONE session ("default") despite multiple days of use — this means either sessions are being cleaned up, or the worktree suffix is causing session ID mismatches
- 412 indexed docs with 16,350 chunks exist in the content store — the compactor IS doing useful work, but the stats don't reflect it
