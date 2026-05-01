---
title: "Context Savings Analytics — Implementation Plan"
type: plan
date: 2026-05-01
workbranch: feat/context-savings-analytics
specs:
  - .unipi/docs/specs/2026-05-01-context-savings-analytics-design.md
---

# Context Savings Analytics — Implementation Plan

## Overview

Port context-mode's `AnalyticsEngine` byte-tracking into the compactor package, redesign the Compactor info-screen group to show 6 budget-focused stats (tokens saved, cost saved, % reduction, top consuming tools, compactions, tool calls), wire `tool_result` events to accumulate per-tool byte consumption, and fix `overrideDefaultCompaction` default to `true` so compactor's deterministic pipeline actually fires.

## Tasks

- completed: Task 1 — Port AnalyticsEngine into compactor
  - Description: Create `compactor/src/session/analytics.ts` by porting the computation logic from context-mode's `AnalyticsEngine`. Only include what feeds into budget-focused stats — omit `formatReport()`, `categoryLabels`, `categoryHints`, visual bars, and `ThinkInCodeComparison`/`SandboxIO` statics.
  - Dependencies: None
  - Acceptance Criteria:
    - `AnalyticsEngine` class exists with `queryAll(runtimeStats)` method returning `FullReport`
    - Types exported: `RuntimeStats`, `ContextSavings`, `FullReport`, `DatabaseAdapter`
    - `queryAll()` computes savings (processed_kb, entered_kb, saved_kb, pct, by_tool, total_calls, kept_out, total_processed), session metadata, continuity data (total_events, compact_count), and project memory totals
    - `createMinimalDb()` fallback function exists for when SessionDB is unavailable
    - No dependency on context-mode code — self-contained
  - Steps:
    1. Create `compactor/src/session/analytics.ts`
    2. Port `DatabaseAdapter` interface, `RuntimeStats`, `ContextSavings`, `FullReport` types (trimmed to budget-focused fields only)
    3. Port `AnalyticsEngine` class with constructor taking `DatabaseAdapter`
    4. Port `queryAll()` method — compute savings from `RuntimeStats`, query session_meta and session_events from DB
    5. Port `createMinimalDb()` — in-memory SQLite fallback that satisfies `DatabaseAdapter` with empty tables
    6. Omit: `formatReport()`, `categoryLabels`, `categoryHints`, `ThinkInCodeComparison`, `SandboxIO`, `dataBar()`, visual formatting helpers
    7. Verify file compiles with `npx tsc --noEmit --skipLibCheck`

- completed: Task 2 — Add RuntimeStats tracking to compactor index
  - Description: Add `RuntimeStats` accumulator to `compactor/src/index.ts`, wire it into the `tool_result` handler to measure per-tool byte consumption, and add `measureResponseBytes()` helper.
  - Dependencies: Task 1 (needs RuntimeStats type)
  - Acceptance Criteria:
    - `runtimeStats` object initialized at module scope with `bytesReturned`, `calls`, `bytesIndexed`, `bytesSandboxed`, `sessionStart`, `cacheHits`, `cacheBytesSaved`
    - `tool_result` handler accumulates `bytesReturned[toolName]` and `calls[toolName]` for every tool call
    - `measureResponseBytes()` helper correctly measures Pi's event format (handles both string and array content)
    - Sandbox tools (`bash`, `Bash`) increment `bytesSandboxed`
    - Index tools (if applicable) increment `bytesIndexed`
    - `runtimeStats` is reset on `session_start`
    - Byte measurement errors are silently skipped (non-blocking)
  - Steps:
    1. Import `RuntimeStats` type from `./session/analytics.js`
    2. Add `const runtimeStats: RuntimeStats = { ... }` at module scope
    3. Create `measureResponseBytes(event)` helper that extracts byte size from `event.content` (array of content blocks with `text` fields) and `event.output`
    4. In `tool_result` handler, after existing event extraction, add `runtimeStats` accumulation
    5. Add `isSandboxTool()` helper (bash/Bash) and `isIndexTool()` helper (empty for now, future-proofing)
    6. Reset `runtimeStats` in `session_start` handler (set `sessionStart: Date.now()`, zero all accumulators)
    7. Pass `runtimeStats` to `getInfoScreenData()` call

- completed: Task 3 — Add SessionDB.getDb() method
  - Description: Expose the internal database handle from `SessionDB` so `AnalyticsEngine` can query it directly.
  - Dependencies: None
  - Acceptance Criteria:
    - `getDb()` method returns the internal `this.db` reference
    - Returns `null` if DB not initialized
    - JSDoc explains read-only usage intent
  - Steps:
    1. Add `getDb(): any { return this.db ?? null; }` method to `SessionDB` class
    2. Add JSDoc comment: `/** Expose the underlying db for AnalyticsEngine (read-only queries). Returns null if init failed. */`

- completed: Task 4 — Redesign info-screen with budget-focused stats
  - Description: Replace the current 7-stat Compactor info-screen group with 6 budget-focused stats using `AnalyticsEngine.queryAll()`. Add cost estimation by wiring usage-parser's model pricing data.
  - Dependencies: Task 1 (AnalyticsEngine), Task 2 (RuntimeStats), Task 3 (getDb)
  - Acceptance Criteria:
    - `CompactorInfoData` interface has 6 fields: `tokensSaved`, `costSaved`, `pctReduction`, `topTools`, `compactions`, `toolCalls`
    - `getInfoScreenData()` uses `AnalyticsEngine.queryAll(runtimeStats)` to compute stats
    - `tokensSaved` shows formatted token count (e.g. "12.4k"), detail has full per-tool breakdown table
    - `costSaved` shows dollar amount (e.g. "$0.34") using current session model pricing, or "N/A" if unavailable
    - `pctReduction` shows percentage (e.g. "67.2%")
    - `topTools` shows top token-consuming tool (e.g. "bash: 8.2k"), detail has top 5 with call counts
    - `compactions` shows count, detail shows last compaction stats
    - `toolCalls` shows total call count
    - Old stats (sessionEvents, compressionRatio, indexedDocs, sandboxExecutions, searchQueries) are removed
    - Info-screen group registration in `index.ts` updated with new stat IDs and labels
    - Guard relaxed: registration works with just `sessionDB` (no longer requires `contentStore`)
    - `dataProvider` never throws — all errors return empty object
  - Steps:
    1. Update `CompactorInfoData` interface in `types.ts` with new 6-field shape
    2. Rewrite `info-screen.ts` — import `AnalyticsEngine`, `RuntimeStats`, `createMinimalDb`
    3. Change `getInfoScreenData()` signature to accept `runtimeStats: RuntimeStats` instead of `counters: RuntimeCounters`
    4. In `getInfoScreenData()`: get db via `sessionDB.getDb()`, create `AnalyticsEngine(db ?? createMinimalDb())`, call `queryAll(runtimeStats)`
    5. Map `FullReport` fields to 6 stats with formatting helpers
    6. Add cost estimation: import `parseUsageStats` from info-screen's usage-parser, find current model's cost-per-token rate, multiply by `tokensSaved`. If unavailable, show "N/A"
    7. Add per-tool breakdown as `detail` text for `tokensSaved` (full table) and `topTools` (top 5)
    8. Wrap entire `getInfoScreenData()` in try/catch returning zeroed stats on failure
    9. Update info-screen group registration in `index.ts` — replace old stat IDs with new ones, relax guard to `if (infoRegistry && sessionDB)`
    10. Pass `runtimeStats` to `getInfoScreenData()` in dataProvider

- completed: Task 5 — Change overrideDefaultCompaction default to true
  - Description: Fix the root cause — compactor's deterministic pipeline now runs by default for all compactions.
  - Dependencies: None
  - Acceptance Criteria:
    - `DEFAULT_COMPACTOR_CONFIG.overrideDefaultCompaction` is `true` (was `false`)
    - Existing config files on disk are NOT modified — `scaffoldConfig()` only creates new files
    - `loadConfig()` still respects existing user settings
  - Steps:
    1. Change `overrideDefaultCompaction: false` to `overrideDefaultCompaction: true` in `compactor/src/config/schema.ts`
    2. Verify `scaffoldConfig()` in `compactor/src/config/manager.ts` doesn't overwrite existing configs

- completed: Task 6 — Update session_compact handler to always record stats
  - Description: Currently compaction stats are only recorded when compactor's pipeline ran. Update the `session_compact` handler to always record stats using `runtimeStats` data, regardless of which compaction pipeline executed.
  - Dependencies: Task 2 (RuntimeStats)
  - Acceptance Criteria:
    - `session_compact` handler always calls `sessionDB.addCompactionStats()` with actual byte data
    - Stats reflect total bytes processed and kept, derived from `runtimeStats`
    - `counters.totalTokensCompacted` uses real byte measurements instead of `tokensBefore * 0.85` heuristic
  - Steps:
    1. In `session_compact` handler, compute `charsBefore` from `runtimeStats.totalBytesReturned` equivalent
    2. Use actual compaction event data when available (from `lastCompactionStats`), fall back to runtime stats
    3. Replace `Math.round(tokensBefore * 0.85)` heuristic with real measurement
    4. Call `sessionDB.addCompactionStats()` with accurate values

- completed: Task 7 — Update CompactorInfoData type and clean up RuntimeCounters
  - Description: Update `CompactorInfoData` in `types.ts` to match the new budget-focused stats. Remove unused fields from `RuntimeCounters` that are no longer needed by the info-screen (sandboxRuns, searchQueries, recallQueries remain for internal use but aren't displayed).
  - Dependencies: Task 4 (info-screen redesign)
  - Acceptance Criteria:
    - `CompactorInfoData` in `types.ts` matches the new 6-field interface
    - Old `InfoScreenData` interface in `info-screen.ts` replaced with new `CompactorInfoData`
    - `RuntimeCounters` interface preserved (still used internally) but no longer drives info-screen display
  - Steps:
    1. Update `CompactorInfoData` in `types.ts` to: `tokensSaved`, `costSaved`, `pctReduction`, `topTools`, `compactions`, `toolCalls` — each with `{ value: string; detail: string }`
    2. Remove old `InfoScreenData` interface from `info-screen.ts`
    3. Keep `RuntimeCounters` as-is (internal use only)

- completed: Task 8 — Type-check and test
  - Description: Run TypeScript type-checking and existing test suite to verify no regressions.
  - Dependencies: All previous tasks
  - Acceptance Criteria:
    - `npx tsc --noEmit --skipLibCheck` passes in `packages/compactor`
    - `bun test packages/compactor/tests/` passes
    - No new type errors introduced
  - Steps:
    1. Run `npx tsc --noEmit --skipLibCheck` in `packages/compactor`
    2. Fix any type errors
    3. Run `bun test packages/compactor/tests/`
    4. Fix any test failures (likely: config test expecting `overrideDefaultCompaction: false`)

## Sequencing

```
Task 1 (AnalyticsEngine) ─────────┐
Task 3 (getDb) ────────────────────┤
Task 5 (overrideDefault) ──────────┤  ← Independent, can start immediately
                                   │
Task 2 (RuntimeStats) ─────────────┤  ← Depends on Task 1 (needs RuntimeStats type)
                                   │
Task 6 (session_compact) ──────────┤  ← Depends on Task 2 (needs runtimeStats)
                                   │
Task 4 (info-screen redesign) ─────┤  ← Depends on Tasks 1, 2, 3
                                   │
Task 7 (type cleanup) ─────────────┤  ← Depends on Task 4
                                   │
Task 8 (type-check + test) ────────┘  ← Depends on all
```

Parallelizable: Tasks 1, 3, 5 can start simultaneously.
Critical path: Task 1 → Task 2 → Task 4 → Task 7 → Task 8.

## Risks

1. **Cross-package import (compactor → info-screen)** — Cost estimation needs `parseUsageStats` from `packages/info-screen/usage-parser.ts`. If this creates a circular or awkward dependency, we may need to inline the cost calculation or extract a shared utility. Mitigation: usage-parser is a standalone file with no imports from other info-screen modules, so a direct import should work.

2. **Pi event format variance** — `measureResponseBytes()` needs to handle Pi's `tool_result` event format reliably. The `content` field can be a string, array of content blocks, or undefined. Mitigation: add defensive checks for all shapes, default to 0 bytes on unrecognized format.

3. **Config default change impact** — Setting `overrideDefaultCompaction: true` means compactor's deterministic pipeline fires by default for all users. This changes existing behavior. Mitigation: existing `config.json` files keep their settings; only new installations get the new default.

4. **AnalyticsEngine DB queries on uninitiated DB** — If `SessionDB.init()` failed, `getDb()` returns null and `createMinimalDb()` fallback is used. This means stats show zeroes rather than errors. Acceptable tradeoff.

5. **Test regression from config default change** — The config test likely asserts `overrideDefaultCompaction: false`. Will need updating in Task 8.

---

## Reviewer Remarks

REVIEWER-REMARK: Done

All 8 tasks verified against acceptance criteria:

- **Task 1 (AnalyticsEngine):** ✅ `AnalyticsEngine` class with `queryAll()`, `DatabaseAdapter`/`RuntimeStats`/`ContextSavings`/`FullReport` types exported, `createMinimalDb()` fallback, self-contained — no context-mode dependency
- **Task 2 (RuntimeStats tracking):** ✅ `runtimeStats` accumulator at module scope, `tool_result` handler accumulates per-tool bytes/calls, `measureResponseBytes()` handles string/array/output formats, `isSandboxTool()`/`isIndexTool()` helpers, reset on `session_start`
- **Task 3 (SessionDB.getDb()):** ✅ `getDb()` method returns `this.db ?? null` with JSDoc
- **Task 4 (Info-screen redesign):** ✅ 6 budget-focused stats (tokensSaved, costSaved, pctReduction, topTools, compactions, toolCalls), uses `AnalyticsEngine.queryAll()`, cost estimation via `parseUsageStats`, per-tool breakdowns in details, guard relaxed to `sessionDB` only, dataProvider never throws
- **Task 5 (overrideDefaultCompaction):** ✅ Default is `true` in schema.ts, existing configs untouched
- **Task 6 (session_compact handler):** ✅ Always records stats with actual `tokensBefore`/`tokensAfter` from Pi event, no more `0.85` heuristic, graceful fallback
- **Task 7 (CompactorInfoData type):** ✅ 6-field interface with `{ value: string; detail: string }` in both `types.ts` and `info-screen.ts`, `RuntimeCounters` preserved internally
- **Task 8 (Type-check + test):** ✅ `tsc --noEmit --skipLibCheck` passes, `bun test` — 77 pass / 0 fail

Codebase Checks:
- ✓ Type check passed (`tsc --noEmit --skipLibCheck`)
- ✓ Tests passed (77/77, 0 failures)
- ○ Lint — not configured for this package
- ○ Build — not configured (TypeScript-only extension loaded by Pi runtime)

Ralph context: No active Ralph loop for this plan. Prior `compactor-complete` loop (completed 2026-04-27) predates this work.
