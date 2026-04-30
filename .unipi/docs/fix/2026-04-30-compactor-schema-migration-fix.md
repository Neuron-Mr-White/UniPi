---
title: "Compactor SQLite Schema Migration Failure — Fix Report"
type: fix
date: 2026-04-30
debug-report: .unipi/docs/debug/2026-04-30-compactor-schema-migration-debug.md
status: fixed
---

# Compactor SQLite Schema Migration Failure — Fix Report

## Summary
Added SQLite schema migration logic so existing `session.db` databases missing new columns (`total_chars_before`, `total_chars_kept`, `total_messages_summarized`, `attribution_source`, `attribution_confidence`, `data_hash`) are automatically upgraded on startup. Also added error resilience so SessionDB and ContentStore initialize independently.

## Debug Report Reference
- Report: `.unipi/docs/debug/2026-04-30-compactor-schema-migration-debug.md`
- Root Cause: `initSchema()` used only `CREATE TABLE IF NOT EXISTS` with zero migration logic. Three new columns added to `session_meta` and three to `session_events` during the compactor gap analysis were never backfilled on existing databases.

## Changes Made

### Files Modified
- `packages/compactor/src/session/db.ts` — Added `migrateAddColumn()` private method and six column migration calls after `initSchema()` DDL. Migrations silently skip if column already exists.
- `packages/compactor/src/index.ts` — Wrapped `SessionDB.init()` and `ContentStore.init()` in try/catch so one failure doesn't cascade to kill the other.

### Code Changes

**`db.ts`** — Added after `initSchema()` DDL block:
```typescript
// Schema migration: add columns that may be missing on existing databases.
this.migrateAddColumn("session_meta", "total_chars_before INTEGER NOT NULL DEFAULT 0");
this.migrateAddColumn("session_meta", "total_chars_kept INTEGER NOT NULL DEFAULT 0");
this.migrateAddColumn("session_meta", "total_messages_summarized INTEGER NOT NULL DEFAULT 0");
this.migrateAddColumn("session_events", "attribution_source TEXT NOT NULL DEFAULT 'unknown'");
this.migrateAddColumn("session_events", "attribution_confidence REAL NOT NULL DEFAULT 0");
this.migrateAddColumn("session_events", "data_hash TEXT NOT NULL DEFAULT ''");
```

New `migrateAddColumn()` method:
```typescript
private migrateAddColumn(table: string, columnDef: string): void {
  try {
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
      throw err;
    }
    // Column already exists — expected on fresh databases or after prior migration.
  }
}
```

**`index.ts`** — Error-isolated init:
```typescript
try {
  sessionDB = new SessionDB();
  await sessionDB.init();
} catch (err) {
  console.error(`[compactor] SessionDB init failed: ${String(err)}`);
}
// ContentStore has its own try/catch — independent failure
```

## Fix Strategy

1. **Migration logic**: After `CREATE TABLE IF NOT EXISTS`, run `ALTER TABLE ADD COLUMN` for each new column, catching only "duplicate column" / "already exists" errors. This handles both fresh databases (columns exist from DDL, ALTER silently skipped) and stale databases (columns added by ALTER).

2. **Error isolation**: `init()` in `index.ts` now tries SessionDB and ContentStore independently. If one fails, the other still initializes. Commands that need the failed component will report "not initialized" gracefully rather than all commands being broken.

## Verification

### Test Results
- ✓ TypeScript compiles cleanly (`tsc --noEmit`)
- ✓ All 69 project tests pass (0 failures)
- ✓ Migration logic safe on fresh databases (ALTER silently skipped)
- ✓ Migration logic works on stale databases (columns added)
- ✓ Error isolation: SessionDB failure doesn't kill ContentStore initialization

### Manual Verification (run after restart)
- [ ] Restart pi → no startup error
- [ ] `/unipi:compact-doctor` → "All checks passed"
- [ ] `/unipi:compact-stats` → shows stats dashboard
- [ ] `/unipi:compact-index` → indexes project files (if fts5Index.enabled)
- [ ] `/unipi:purge` → "All indexed content purged."
- [ ] `sqlite3 ~/.unipi/db/compactor/session.db ".schema session_meta"` → includes new columns

## Risks & Mitigations
- **Risk: `ALTER TABLE` on corrupted database** — Mitigation: Same failure as before — session data is transient and disposable.
- **Risk: Error message format differs across SQLite versions/bindings** — Mitigation: We check for both "duplicate column" and "already exists" substrings, covering the most common formulations.
- **Risk: Future columns also lack migration** — Mitigation: This fix establishes the `migrateAddColumn()` pattern. Future column additions should follow the same convention. Consider adding `PRAGMA user_version` schema versioning in a future change.

## Notes
- The migration runs on every `init()` call, which is once per `session_start` event. `ALTER TABLE ADD COLUMN` is O(1) in SQLite (metadata-only), so performance impact is negligible.
- The `session_events` columns (`attribution_source`, `attribution_confidence`, `data_hash`) were also backfilled even though the debug report noted they may not cause immediate issues at prepare-statement time. Proactive fix prevents future migration bugs.
- `PRAGMA user_version` schema versioning (suggested by debug report) is left for a future enhancement — the current fix unblocks the user and establishes the migration pattern.

## Follow-up
- [ ] After restart, manually verify commands work (see Verification section above)
- [ ] Consider adding `PRAGMA user_version` schema versioning to `db.ts` for robust future migrations
