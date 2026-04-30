---
title: "Compactor Gap Fixes — Implementation Plan"
type: plan
date: 2026-04-30
workbranch: ""
specs:
  - .unipi/docs/specs/2026-04-30-compactor-gap-fixes-design.md
---

# Compactor Gap Fixes — Implementation Plan

## Overview

Fix 4 wiring gaps in @pi-unipi/compactor: auto-indexing, stats tracking, security wiring, and ContentStore singleton reuse. Work directly on main branch (small focused changes).

## Tasks

- completed: Task 1 — ContentStore Singleton + Deps Fix
  - Description: Pass session-level ContentStore to all tools via CompactorToolDeps. Remove internal ContentStore creation from ctxSearch, ctxIndex, ctxBatchExecute, ctxFetchAndIndex.
  - Dependencies: None
  - Acceptance Criteria: All tools use deps.contentStore instead of creating their own. No `new ContentStore()` in tool files.
  - Steps:
    1. Update ctx-search.ts to accept ContentStore param ✓
    2. Update ctx-index.ts to accept ContentStore param ✓
    3. Update ctx-batch-execute.ts to accept ContentStore param ✓
    4. Update ctx-fetch-and-index.ts to accept ContentStore param ✓
    5. Update register.ts to pass deps.contentStore to all tools ✓
    6. Verify typecheck passes ✓

- completed: Task 2 — Runtime Stats Tracking
  - Description: Add RuntimeStats counters to extension state. Track sandbox runs, search queries, and tokens saved. Wire into ctxStats() and info-screen.
  - Dependencies: None
  - Acceptance Criteria: ctxStats() returns real data for sandboxRuns, searchQueries, tokensSaved. Info-screen shows live stats.
  - Steps:
    1. Add RuntimeStats interface to types.ts ✓
    2. Add runtime stats object to extension state in index.ts ✓
    3. Increment sandboxRuns in ctx_execute/ctx_execute_file tool handlers ✓
    4. Increment searchQueries in ctx_search/vcc_recall tool handlers ✓
    5. Capture tokensSaved from lastCompactionStats ✓
    6. Update ctx-stats.ts to accept and use runtime stats ✓
    7. Update info-screen.ts to use runtime stats ✓
    8. Verify typecheck passes ✓

- completed: Task 3 — Auto-Indexing on Session Start
  - Description: When fts5Index.mode === "auto", walk project directory and index files into FTS5 on session_start.
  - Dependencies: Task 1
  - Acceptance Criteria: With fts5Index.mode="auto", project files are indexed automatically on session start. No blocking of session init.
  - Steps:
    1. Create autoIndexProject() function in index.ts ✓
    2. Indexable extensions: .md, .txt, .ts, .js, .json, .py, .sh, .yaml, .yml, .toml, .cfg, .ini, .sql ✓
    3. Skip .git, node_modules, .unipi, hidden dirs ✓
    4. Max depth 4, max files 200 ✓
    5. Call from session_start when config.fts5Index.mode === "auto" ✓
    6. Run async (don't block session start) ✓
    7. Verify typecheck passes ✓

- completed: Task 4 — Security Scanner + Evaluator Wiring
  - Description: Wire security checks into input handler (pre-execution). Load .pi/settings.json permissions.
  - Dependencies: None
  - Acceptance Criteria: Bash commands evaluated against deny patterns. Non-shell code scanned for shell escapes. File paths checked against deny patterns. Fail-open on errors.
  - Steps:
    1. Update input handler to call evaluateCommand() for bash commands ✓
    2. Update input handler to call hasShellEscapes() for ctx_execute code ✓
    3. Update input handler to call evaluateFilePath() for file operations ✓
    4. Load security policies from .pi/settings.json using loadProjectPermissions() ✓
    5. Verify typecheck passes ✓

- completed: Task 5 — Ralph Loop Verification
  - Description: Iterate through context-mode and pi-vcc source to verify no features were missed in our gap fixes.
  - Dependencies: Tasks 1-4
  - Acceptance Criteria: All context-mode patterns for auto-indexing, stats, security, store reuse are verified implemented.
  - Steps:
    1. Check context-mode server.ts for getStore() pattern — verify our singleton matches ✓
    2. Check context-mode server.ts for RuntimeStats pattern — verify our counters match ✓
    3. Check context-mode server.ts for security wiring — verify our checks match ✓
    4. Check context-mode server.ts for auto-indexing — verify our autoIndex matches ✓
    5. Check context-mode analytics.ts for report format — verify our stats output matches ✓
    6. Run typecheck on final code ✓

## Sequencing

```
Task 1 (ContentStore singleton) ─┐
Task 2 (Stats tracking)          ├─→ Task 3 (Auto-index) ─→ Task 5 (Ralph verify)
Task 4 (Security wiring)         ┘
```

Tasks 1, 2, 4 can be done in parallel. Task 3 depends on Task 1. Task 5 depends on all.

## Risks

1. **Breaking tool APIs:** Changing tool function signatures could break registration. Mitigation: update both tool files and register.ts in same task.
2. **Security false positives:** Shell-escape scanning may flag legitimate code. Mitigation: fail-open, only block on explicit deny patterns.
3. **Auto-index performance:** Walking large project dirs could be slow. Mitigation: depth/file limits, async execution.

---

## Reviewer Remarks

REVIEWER-REMARK: Done 5/5 — all tasks complete, all 4 gaps fixed.

**Review date:** 2026-04-30
**Reviewer:** Ralph loop verification + typecheck
**Branch:** main

### Completed Tasks (5/5)

| Task | Status | Details |
|------|--------|--------|
| Task 1: ContentStore Singleton | ✅ Done | 4 tool files updated, register.ts passes deps.contentStore, commands updated |
| Task 2: Stats Tracking | ✅ Done | RuntimeStats interface, counters in tools, wired into ctxStats + info-screen |
| Task 3: Auto-Indexing | ✅ Done | autoIndexProject() called from session_start when mode=auto, async, depth/file limits |
| Task 4: Security Wiring | ✅ Done | evaluateCommand for bash, hasShellEscapes for code, evaluateFilePath for files, fail-open |
| Task 5: Ralph Verification | ✅ Done | All context-mode patterns verified implemented |

### Verification Results

**TypeScript:** ✅ Clean — 0 errors
**ContentStore singleton:** ✅ No `new ContentStore()` in tool files
**RuntimeStats:** ✅ sandboxRuns, searchQueries, tokensSaved tracked and displayed
**Auto-indexing:** ✅ Runs async on session_start when fts5Index.mode=auto
**Security:** ✅ evaluateCommand, hasShellEscapes, evaluateFilePath all wired into input handler
**Ralph loop:** ✅ All context-mode patterns verified against our implementation
