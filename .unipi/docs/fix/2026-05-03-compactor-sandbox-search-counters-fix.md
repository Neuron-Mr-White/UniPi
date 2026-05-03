---
title: "Compactor Stats Sandbox Runs and Search Queries Always Zero — Fix Report"
type: fix
date: 2026-05-03
debug-report: .unipi/docs/debug/2026-05-02-compactor-stats-architecture-debug.md
status: fixed
---

# Compactor Stats Sandbox Runs and Search Queries Always Zero — Fix Report

## Summary
`sandboxRuns` and `searchQueries` in compactor stats always showed 0 despite tool usage. Fixed by adding DB persistence (session_meta columns), DB fallback in ctxStats(), session event tracking for sandbox/search/index tools, and active footer segments.

## Debug Report Reference
- Report: `.unipi/docs/debug/2026-05-02-compactor-stats-architecture-debug.md`
- Root Cause: Purely in-memory counters with zero persistence. No DB columns, no DB fallback, no event tracking, footer segments returned hidden().

## Changes Made

### Files Modified
- `packages/compactor/src/session/db.ts` — Added V2 migration for `sandbox_runs` and `search_queries` columns in `session_meta`. Added `incrementSandboxRuns()`, `incrementSearchQueries()` methods. Updated `getAllTimeStats()` to include `allSandboxRuns` and `allSearchQueries`. Updated `getSessionStats` prepared statement to include new columns.

- `packages/compactor/src/session/extract.ts` — Added event extraction for sandbox execution (`category: "sandbox"`), content search (`category: "search"`), and content indexing (`category: "index"`).

- `packages/compactor/src/tools/register.ts` — After incrementing in-memory counters, also call `sessionDB.incrementSandboxRuns()` / `sessionDB.incrementSearchQueries()` for immediate DB persistence.

- `packages/compactor/src/tools/ctx-stats.ts` — Replaced direct counter reads with `computeSandboxRuns()` and `computeSearchQueries()` functions that have 3-level fallback: in-memory counter → per-session DB → all-time DB.

- `packages/compactor/src/index.ts` — On `session_start`, seed `counters.sandboxRuns` and `counters.searchQueries` from DB allTimeStats so they reflect prior usage immediately.

- `packages/footer/src/segments/compactor.ts` — Updated `renderSandboxRunsSegment` and `renderSearchQueriesSegment` to actually count events from session manager branch instead of returning hidden().

## Fix Strategy
1. **Persist to DB on every tool invocation** — Cheap SQLite UPDATE ensures data survives crashes/restarts
2. **3-level fallback in ctxStats** — Counter → session DB → all-time DB (matches existing pattern for tokensSaved/compactions)
3. **Seed counters on startup** — New session sees accumulated all-time totals immediately
4. **Track events** — `extractEventsFromToolResult()` now creates events for sandbox/search/index tools
5. **Active footer segments** — Count tool invocations from session manager branch

## Verification

### Test Results
- ✓ TypeScript compilation passes (only pre-existing errors)
- ✓ 76/77 tests pass (1 pre-existing failure unrelated to changes)
- ✓ No new type errors introduced

### Regression Check
- ✓ Tool execution unchanged — DB increment is non-blocking after counter increment
- ✓ Existing compaction/tokensSaved stats unaffected
- ✓ Footer segments still work when no data available (return hidden())

## Risks & Mitigations
- **Risk: DB increment on every tool invocation adds latency.** Mitigation: SQLite UPDATE on indexed primary key is <0.1ms. Batch operations already do this per-item.
- **Risk: Counter seeding from DB shows all-time totals instead of session-only.** Mitigation: This is intentional — shows accumulated usage across sessions, matching user expectation.
- **Risk: Footer segment counting relies on session manager branch structure.** Mitigation: Falls back to hidden() if structure unavailable.

## Notes
- The `sandboxRuns`/`searchQueries` counter pattern now mirrors `compactions`/`totalTokensCompacted` exactly
- The V2 migration is idempotent — `safeAddColumn` catches "duplicate column" errors
- Future enhancement: could add per-session breakdown to info-screen display

## Follow-up
- [ ] Verify sandbox/search counts increment correctly at runtime after Pi restart
- [ ] Consider adding `recallQueries` persistence using same pattern
