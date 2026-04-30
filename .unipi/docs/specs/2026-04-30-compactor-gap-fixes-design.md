---
title: "Compactor Gap Fixes — Design Spec"
type: brainstorm
date: 2026-04-30
related:
  - .unipi/docs/context-gathered/2026-04-30-compactor-context.md
  - .unipi/docs/specs/2026-04-27-compactor-design.md
  - https://github.com/mksglu/context-mode
  - https://github.com/sting8k/pi-vcc
---

# Compactor Gap Fixes — Design Spec

## Problem Statement

The compactor package has 4 wiring gaps that prevent it from reaching its full potential as described in the original design spec. These gaps were identified during a codebase audit comparing the implemented code against the original spec and the reference implementations (context-mode, pi-vcc).

## Gap 1: Auto-Indexing on Session Start

**Current state:** In `index.ts`, there's a TODO comment:
```typescript
if (config.fts5Index.mode === "auto" && contentStore) {
  // TODO: index project files
}
```

**Reference:** context-mode's `getStore()` auto-indexes session events and stale source cleanup. pi-vcc doesn't auto-index (manual only).

**Design:** When `fts5Index.mode === "auto"`, walk the project directory on `session_start` and index all indexable files into FTS5. Follow the same pattern as `/unipi:compact-index` command but automatic.

**Implementation:**
- Extract the file-walking logic from the `compact-index` command into a reusable `autoIndexProject()` function
- Call it from the `session_start` handler when `fts5Index.mode === "auto"`
- Respect `chunkSize` from config
- Skip `.git`, `node_modules`, `.unipi`, hidden dirs
- Indexable extensions: `.md`, `.txt`, `.ts`, `.js`, `.json`, `.py`, `.sh`, `.yaml`, `.yml`, `.toml`, `.cfg`, `.ini`, `.env`, `.dockerfile`, `.sql`
- Max depth: 4, max files: 200
- Run async to not block session start

## Gap 2: Stats Tracking (tokensSaved, sandboxRuns, searchQueries)

**Current state:** `ctxStats()` returns hardcoded `tokensSaved: 0`, `sandboxRuns: 0`, `searchQueries: 0`. The compaction stats are tracked in-memory (`lastStats`) but not persisted. Sandbox runs and search queries aren't counted at all.

**Reference:** context-mode's `RuntimeStats` object tracks `bytesReturned`, `bytesIndexed`, `bytesSandboxed`, `cacheHits`, `cacheBytesSaved` during a live session. Its `AnalyticsEngine.queryAll()` merges runtime stats with DB data for a unified report.

**Design:** Add runtime stat counters to the extension state, persist them to SessionDB, and wire them into `ctxStats()` and the info-screen data provider.

**Implementation:**
- Add `RuntimeStats` interface to `types.ts`
- Add runtime stats object to extension state in `index.ts`
- Track sandbox runs in `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute` handlers
- Track search queries in `ctx_search`, `vcc_recall` handlers
- Track tokens saved from compaction stats (already available via `lastStats`)
- Persist stats to `session_meta` table (add columns) or a new `session_stats` table
- Wire into `ctxStats()` and `getInfoScreenData()`

## Gap 3: Security Scanner + Evaluator Wiring

**Current state:** `security/scanner.ts` (shell-escape detection) and `security/evaluator.ts` (command/file-path evaluation) exist as pure functions but are never called from the executor or tool handlers.

**Reference:** context-mode's `server.ts` has:
- `checkDenyPolicy()` — evaluates bash commands against deny patterns
- `checkNonShellDenyPolicy()` — scans non-shell code for shell-escape calls, evaluates embedded commands against deny patterns
- `checkFilePathDenyPolicy()` — evaluates file paths against Read deny patterns
- All called BEFORE tool execution, returning error ToolResult if denied

**Design:** Wire security checks into the `input` event handler (pre-execution) and the `tool_result` handler (post-execution logging). Follow context-mode's fail-open pattern for server-side checks.

**Implementation:**
- In `input` handler: evaluate bash commands against deny patterns using `evaluateCommand()`
- In `input` handler: for `ctx_execute`, scan code for shell escapes using `hasShellEscapes()` and evaluate extracted commands
- In `tool_result` handler: log security-relevant events (blocked commands, shell-escape attempts)
- Load security policies from `.pi/settings.json` using `loadProjectPermissions()`
- Fail-open: if security check throws, allow through (hooks are primary enforcement)

## Gap 4: ContentStore Singleton Reuse

**Current state:** `ctxSearch()`, `ctxIndex()`, `ctxBatchExecute()`, and `ctxFetchAndIndex()` each create a new `ContentStore()` instance per call, init it, use it, and close it. This is wasteful and loses state (vocabulary, cache).

**Reference:** context-mode's `getStore()` uses a module-level singleton with lazy initialization:
```typescript
let _store: ContentStore | null = null;
function getStore(): ContentStore {
  if (!_store) {
    _store = new ContentStore(dbPath);
    // one-time startup cleanup
  }
  return _store;
}
```

**Design:** Add a `getContentStore()` accessor to the extension's dependency injection system, similar to how `sessionDB` is already passed. Tools receive the session-level ContentStore via `deps.contentStore` instead of creating their own.

**Implementation:**
- Pass `contentStore` through `CompactorToolDeps` (already there but not used by all tools)
- Update `ctxSearch()`, `ctxIndex()`, `ctxBatchExecute()`, `ctxFetchAndIndex()` to accept ContentStore as parameter
- Update tool registration in `register.ts` to pass the session-level contentStore
- Remove internal ContentStore creation from tool implementations
- Add stale source cleanup on session start (like context-mode's 14-day cleanup)

## Out of Scope

- AnalyticsEngine full port (context-mode's `analytics.ts` is too complex; we just need basic counters)
- Network I/O tracking in sandbox (context-mode tracks `bytesSandboxed` via network hooks; we skip this)
- Project memory across sessions (context-mode aggregates events across all sessions; we focus on current session)
- TTL cache for fetched URLs (future enhancement)

## Implementation Checklist

- [x] Gap 1: Extract `autoIndexProject()` from compact-index command
- [x] Gap 1: Call `autoIndexProject()` in session_start when mode=auto
- [x] Gap 2: Add RuntimeStats interface and counters to extension state
- [x] Gap 2: Track sandbox runs in execute tool handlers
- [x] Gap 2: Track search queries in search/recall tool handlers
- [x] Gap 2: Track tokens saved from compaction stats
- [x] Gap 2: Wire stats into ctxStats() and info-screen
- [x] Gap 3: Wire evaluateCommand() into input handler for bash
- [x] Gap 3: Wire hasShellEscapes() into input handler for ctx_execute
- [x] Gap 3: Wire evaluateFilePath() into tool_result for file ops
- [x] Gap 3: Load .pi/settings.json permissions
- [x] Gap 4: Pass session-level ContentStore to all tools via deps
- [x] Gap 4: Remove internal ContentStore creation from tool files
- [x] Gap 4: Add stale source cleanup on session start
