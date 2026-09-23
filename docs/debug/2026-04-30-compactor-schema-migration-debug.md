---
title: "Compactor SQLite Schema Migration Failure — Debug Report"
type: debug
date: 2026-04-30
severity: critical
status: root-caused
---

# Compactor SQLite Schema Migration Failure — Debug Report

## Summary
Compactor extension crashes on startup with `no such column: total_chars_before` because existing SQLite databases created by older code lack three columns added in a recent schema change, and no migration logic exists to backfill them.

## Expected Behavior
All `/unipi:compact-*` commands (`compact-doctor`, `compact-stats`, `compact-index`, `compact-purge`, `compact`, `compact-preset`) and `/unipi:purge`, `/unipi:stats` execute normally against a fully initialized SessionDB and ContentStore.

## Actual Behavior
- **Startup:** `Extension "/mnt/d/home/pi-extensions/unipi/packages/unipi/index.ts" error: no such column: total_chars_before`
- **`/unipi:compact-doctor`:** "Compactor services not initialized."
- **`/unipi:compact-stats`:** "Compactor services not initialized."
- **`/unipi:compact-index`:** "Content store not initialized. Enable fts5Index in config."
- **`/unipi:purge`:** "Content store not initialized."
- **`/unipi:stats`:** "Content store not initialized."
- **`/unipi:compact`:** Works (doesn't depend on `deps.sessionDB` for primary path).
- **`/unipi:compact-preset`:** Works (only writes config, doesn't touch DB).

## Reproduction Steps
1. Start pi with the compactor extension enabled
2. Observe startup error in logs/notifications
3. Run `/unipi:compact-doctor` → fails
4. Run `/unipi:compact-stats` → fails
5. The `~/.unipi/db/compactor/session.db` file already exists from a prior version of the compactor code

## Environment
- Extension path: `/mnt/d/home/pi-extensions/unipi/packages/compactor/src/`
- DB path: `~/.unipi/db/compactor/session.db`
- SQLite driver: `better-sqlite3` (CJS imported via ESM)
- pi version: `@mariozechner/pi-coding-agent` v24.14.1 (from mise)
- Recent change: Three new columns added to `session_meta` table as part of compactor gap analysis (see `.unipi/ralph/compactor-gap-analysis.md`)

## Root Cause Analysis

### Failure Chain
1. **Extension startup** → `session_start` event fires → `init()` called (`src/index.ts:42-53`)
2. **SessionDB created and init'd** → `sessionDB = new SessionDB(); await sessionDB.init();` (`db.ts:80-93`)
3. **`initSchema()` runs** → `CREATE TABLE IF NOT EXISTS session_meta (...)` — table already exists from older code, so DDL is silently skipped. New columns are NOT added (`db.ts:95-126`)
4. **`prepareStatements()` runs** → tries to compile `getSessionStats` statement referencing `total_chars_before` column that doesn't exist in the table (`db.ts:149`)
5. **SQLite throws** → `no such column: total_chars_before` — `init()` throws, `sessionDB` stays `null`
6. **Cascade** → `ContentStore` never created (code below never reached). All commands see `deps?.sessionDB === null` and `deps?.contentStore === null`

### Root Cause
**The `initSchema()` method in `SessionDB` uses `CREATE TABLE IF NOT EXISTS` exclusively — there is zero migration logic.** When the `session_meta` table was first created by an older version of the compactor code (without `total_chars_before`, `total_chars_kept`, `total_messages_summarized`), those columns are never backfilled. No `ALTER TABLE ADD COLUMN` calls exist anywhere, and no `PRAGMA user_version` schema versioning is used.

The three new columns were added in the compactor gap analysis changes but the migration step was overlooked.

### Evidence
- **File:** `packages/compactor/src/session/db.ts:119-122` — Columns `total_chars_before`, `total_chars_kept`, `total_messages_summarized` exist in `CREATE TABLE` but only for new databases
- **File:** `packages/compactor/src/session/db.ts:149` — `getSessionStats` prepared statement references missing column
- **File:** `packages/compactor/src/session/db.ts:151` — `addCompactionStats` prepared statement also references missing column
- **File:** `packages/compactor/src/session/db.ts:152` — `getAllTimeStats` prepared statement also references missing column
- **File:** `packages/compactor/src/index.ts:42-53` — `init()` has no error isolation; one failure kills both SessionDB and ContentStore initialization
- **Grep:** `ALTER TABLE` — zero matches in entire compactor source tree
- **Grep:** `user_version` — zero matches in entire compactor source tree
- **File:** `.unipi/ralph/compactor-gap-analysis.md` — Documents the column additions as "Changes Made (token stats were broken)" but no migration step listed

## Affected Files
- `packages/compactor/src/session/db.ts` — **Primary bug site**: `initSchema()` lacks migration; three prepared statements reference missing columns
- `packages/compactor/src/index.ts` — **Secondary**: `init()` has no error resilience; one DB failure cascades to kill ContentStore too
- `packages/compactor/src/commands/index.ts` — **Tertiary**: `compact-stats`, `compact-doctor`, `compact-index`, `compact-purge` all fail with "not initialized"
- `~/.unipi/db/compactor/session.db` — **Victim**: stale SQLite database with old schema (missing three columns)

## Suggested Fix
Add database schema migration logic so existing `session.db` files are upgraded to include the new columns.

### Fix Strategy
1. **Quick fix (unblock user):** Delete `~/.unipi/db/compactor/session.db` and restart pi. The DB will recreate with full schema. Safe because session data is transient.
2. **Proper fix (prevent recurrence):** In `initSchema()`, after `CREATE TABLE IF NOT EXISTS`, run `ALTER TABLE ADD COLUMN` for each new column, wrapping each in try/catch to handle "duplicate column" errors (SQLite lacks `ADD COLUMN IF NOT EXISTS`).
3. **Schema versioning:** Add `PRAGMA user_version` tracking with conditional migrations to prevent future occurrences of this class of bug.

### Risk Assessment
- **Risk: Deleting DB loses session event history** — Mitigation: Session events are transient instrumentation data with no production impact if lost. Compactor will repopulate with new events.
- **Risk: `ALTER TABLE` on large DB** — Mitigation: SQLite `ALTER TABLE ADD COLUMN` is an O(1) metadata operation, not a table rebuild. Near-instant even on large databases.
- **Risk: Try/catch swallowing legitimate errors** — Mitigation: Only catch the specific "duplicate column" error message, not all errors.

## Verification Plan
After fix, verify each command works:
1. Restart pi → no startup error
2. `/unipi:compact-doctor` → "All checks passed"
3. `/unipi:compact-stats` → shows stats dashboard
4. `/unipi:compact-index` → indexes project files (if fts5Index.enabled)
5. `/unipi:purge` → "All indexed content purged."
6. Manual check: `sqlite3 ~/.unipi/db/compactor/session.db ".schema session_meta"` → includes `total_chars_before`, `total_chars_kept`, `total_messages_summarized`

## Related Issues
- `.unipi/ralph/compactor-gap-analysis.md` — The changes that introduced the new columns without migration
- `packages/compactor/src/types.ts:157` — `SessionMeta` type includes the three new fields

## Notes
- The `session_events` table was also modified (`data_hash`, `attribution_source`, `attribution_confidence` columns added) — same class of bug may affect that table too, but `CREATE TABLE IF NOT EXISTS` works for `session_events` if no old events reference the new columns at prepare-statement time
- `ContentStore` (`content.db`) uses FTS5 virtual tables which are handled differently by `CREATE VIRTUAL TABLE IF NOT EXISTS`
- The `init()` function in `index.ts` should ideally be made resilient: initialize SessionDB and ContentStore independently, log failures instead of throwing, so partial functionality can work
