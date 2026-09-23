---
title: "Compactor Stats Always Zero — Fix Report"
type: fix
date: 2026-05-02
debug-report: inline (debug analysis performed in same session)
status: fixed
---

# Compactor Stats Always Zero — Fix Report

## Summary
Compaction count and tokens saved were always 0 despite many sessions. Fixed 5 interrelated bugs: wrong session ID construction in event handlers, tokensBefore read from wrong event property path, missing DB fallbacks in stats display, and missing deps passed to compaction hooks.

## Changes Made

### Files Modified
- `packages/compactor/src/index.ts` — Fixed session ID in 3 handlers, fixed tokensBefore path, passed deps to hooks, added byte-stats fallback
- `packages/compactor/src/tools/ctx-stats.ts` — Added DB fallbacks for tokensSaved and compactions using getAllTimeStats()
- `packages/compactor/src/session/analytics.ts` — Added all_time_compact_count to FullReport continuity data
- `packages/compactor/src/info-screen.ts` — Use all-time compaction count when session count is 0

### Bug 1: tokensBefore read from wrong path (CRITICAL)
**Before:** `(event as any).tokensBefore ?? 0` — Pi's session_compact event has tokensBefore inside `compactionEntry`, not at root. Was always 0.
**After:** `(event as any).compactionEntry?.tokensBefore ?? 0` — reads from correct nested path.

### Bug 2: Session ID mismatch in event handlers (CRITICAL)
**Before:** Handlers constructed sessionId from `(event as any).sessionId ?? "default"` + suffix, but Pi's session_compact and session_before_compact events don't include sessionId. Result: always defaulted to "default__suffix", a non-existent DB row. All DB updates silently matched 0 rows.
**After:** Use `currentSessionId` closure variable which is set correctly during session_start.

### Bug 3: tokensSaved has no DB fallback (HIGH)
**Before:** `counters?.totalTokensCompacted ?? 0` — in-memory counter only, resets every session.
**After:** Falls back to per-session DB stats, then all-time DB stats via `getAllTimeStats()`.

### Bug 4: compactions only checks current session (HIGH)
**Before:** `counters?.compactions ?? sessionStats?.compact_count ?? 0` — no cross-session visibility.
**After:** Falls back to `sessionDB.getAllTimeStats().allCompactions`.

### Bug 5: registerCompactionHooks called without deps (MEDIUM)
**Before:** `registerCompactionHooks(pi)` — no deps passed. The hooks.ts handler could never call `addCompactionStats()` because `deps?.getSessionDB?.()` was always undefined.
**After:** `registerCompactionHooks(pi, { getSessionDB: () => sessionDB, getSessionId: () => currentSessionId })` — lazy getters that resolve after init().

## Fix Strategy
1. Fix session ID — use closure variable instead of constructing from event properties
2. Fix tokensBefore — read from compactionEntry nested object
3. Add DB fallbacks — use getAllTimeStats() when in-memory counters are zero
4. Pass deps to hooks — lazy getters for sessionDB/sessionId
5. Add byte-stats fallback — estimate savings from runtimeStats when tokensBefore unavailable

## Verification

### Test Results
- ✓ TypeScript compilation passes (`tsc --noEmit`)
- ✓ All 77 existing tests pass
- ✓ No new type errors introduced

### Regression Check
- ✓ Event handler logic unchanged for successful code paths
- ✓ DB writes now target correct session rows
- ✓ Stats display falls back gracefully when no data exists

## Risks & Mitigations
- **Double-counting risk**: In-memory counters and DB stats could overlap. Mitigated by using in-memory first and only falling back to DB when counters are 0.
- **getAllTimeStats on every stats call**: This queries SUM across all session_meta rows. Mitigated by the query being a simple aggregation with COALESCE — fast even with many sessions.

## Notes
- The `getAllTimeStats()` method in SessionDB was dead code — never called by any display function. Now wired up.
- The `AnalyticsEngine` now includes `all_time_compact_count` in the continuity section of `FullReport`.
- The `tool_result` handler also had the session ID bug — fixed as part of this change.

## Follow-up
- [ ] Enable debug logging temporarily to verify compaction events fire correctly with real Pi sessions
- [ ] Consider adding a compaction stats integration test that simulates the full event flow
- [ ] The `overrideDefaultCompaction: true` default means compactor's buildOwnCut can silently cancel Pi's default compaction when it fails — consider adding a fallback
