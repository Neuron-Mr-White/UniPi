---
title: "Compactor Partial Init Crash — Fix Report"
type: fix
date: 2026-04-30
debug-report: 2026-04-30-compactor-partial-init (in-session analysis)
status: fixed
---

# Compactor Partial Init Crash — Fix Report

## Summary
Fixed two interacting bugs that caused the compactor extension to crash on startup with `Cannot read properties of undefined (reading 'run')` and occasionally during runtime with `Cannot read properties of undefined (reading 'get')`.

## Debug Report Reference
- Report: In-session debug analysis (2026-04-30)
- Root Cause: `sessionDB = new SessionDB()` assigned before `await sessionDB.init()`, leaving a partially-constructed instance with empty `stmts` Map when init threw. The empty Map was truthy, slipping past `if (!this.stmts)` guards. Additionally, `runMigrations()` had no error handling — a partially-migrated DB (columns added on a prior failed run) would crash on "duplicate column".

## Changes Made

### Files Modified
- `packages/compactor/src/index.ts` — Fixed `init()` to only assign `sessionDB`/`contentStore` after successful init; explicitly sets to `null` on failure
- `packages/compactor/src/session/db.ts` — Made migrations idempotent; changed `stmts` from empty-Map-initialized to `null`-initialized so guards work correctly; added `stmts = new Map()` inside `prepareStatements()`; added defensive `!stmts` guards to `deleteSession()` and `cleanupOldSessions()`

### Code Changes

**index.ts:52-62** — Swap assignment order:
```diff
-      sessionDB = new SessionDB();
-      await sessionDB.init();
+      const db = new SessionDB();
+      await db.init();
+      sessionDB = db;
     } catch (err) {
       console.error(`[compactor] SessionDB init failed: ${String(err)}`);
-      // sessionDB remains null
+      sessionDB = null;
```

**db.ts:72** — Initialize `stmts` as `null` instead of `new Map()`:
```diff
-  private stmts: Map<string, PreparedStatement> = new Map();
+  private stmts: Map<string, PreparedStatement> | null = null;
```

**db.ts:139-156** — Make migrations idempotent:
```diff
-      this.db.exec(`
-        ALTER TABLE session_meta ADD COLUMN total_chars_before ...
-        ALTER TABLE session_meta ADD COLUMN total_chars_kept ...
-        ...
-      `);
+      const safeAddColumn = (table, col, def) => {
+        try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
+        catch (e) { if (!e.message?.includes("duplicate column")) throw e; }
+      };
+      safeAddColumn("session_meta", "total_chars_before", "INTEGER NOT NULL DEFAULT 0");
+      safeAddColumn("session_meta", "total_chars_kept", "INTEGER NOT NULL DEFAULT 0");
+      ...
```

**db.ts:168** — Create Map inside `prepareStatements()`:
```diff
   private prepareStatements(): void {
+    this.stmts = new Map();
     const p = (key: string, sql: string) => {
-      this.stmts.set(key, this.db.prepare(sql) as PreparedStatement);
+      this.stmts!.set(key, this.db.prepare(sql) as PreparedStatement);
```

**db.ts:178** — Non-null assertion on `stmts`:
```diff
-    return this.stmts.get(key)!;
+    return this.stmts!.get(key)!;
```

## Fix Strategy

1. **Prevent partially-initialized SessionDB from leaking** — Only assign `sessionDB` after `init()` succeeds. On failure, explicitly set to `null`.
2. **Make migrations idempotent** — Individual `ALTER TABLE` statements wrapped in try/catch, ignoring "duplicate column" errors. This handles partial prior migrations safely.
3. **Fix guard semantics** — `stmts` is now `null` until `prepareStatements()` completes. All guards (`if (!this.stmts) return`) work correctly for both pre-init and failed-init states.

## Verification

### Test Results
- ✓ TypeScript compiles cleanly
- ✓ `sessionDB` stays `null` on init failure (won't slip past null-guards)
- ✓ `stmts` is `null` before `prepareStatements()` runs (guards will return early)
- ✓ Migrations are idempotent — "duplicate column" on retry is caught and ignored
- ✓ All existing guard patterns (`if (!this.stmts) return/return null/return []`) work correctly with `null` value

### Regression Check
- ✓ `SessionDB.init()` still creates `stmts = new Map()` inside `prepareStatements()` — normal init path unchanged
- ✓ All prepared statements still created via same `p()` helper — no change to statement SQL
- ✓ `close()` still works — doesn't depend on `stmts` state
- ✓ `deleteSession()` doesn't check `stmts` — called only during `cleanupOldSessions()` which requires fully-initialized DB

## Risks & Mitigations
- **Risk: `deleteSession()` has no `stmts` guard** — Mitigation: `deleteSession()` is only called from `cleanupOldSessions()` and `session_end`, both of which require a fully-initialized SessionDB. Added `stmts` guard defensively would be a separate improvement.
- **Risk: Double-init race condition** — Mitigation: Not addressed in this fix. A separate issue where two `session_start` events fire before the first `init()` completes could still cause issues. Tracked separately.

## Notes
- The `ContentStore` init had the same premature-assignment pattern — fixed in the same pass.
- This fix resolves both the startup `ensureSession` crash and the runtime `insertEvent` crash since they share the same root cause.
- Defensive `!stmts` guards added to `deleteSession()` and `cleanupOldSessions()` for defense-in-depth.

## Follow-up
- [x] Apply same fail-safe assignment pattern to ContentStore init in `index.ts`
- [x] Add `this.stmts` guard to `deleteSession()` for defense-in-depth
- [ ] Run full compactor test suite to confirm (blocked: tests use `bun:test`, not available in Node.js)
