---
title: "Compactor Database is not a constructor — Quick Fix"
type: quick-fix
date: 2026-04-29
---

# Compactor "Database is not a constructor" — Quick Fix

## Bug
Compactor extension fails to initialize on Node 24 with:
```
TypeError: Database is not a constructor
  at SessionDB.init (db.ts:84)
```

## Root Cause
Node 24 has a built-in `node:sqlite` module (experimental). The compactor's SQLite auto-detection chain tried `bun:sqlite` → `node:sqlite` → `better-sqlite3`. On Node 24, `node:sqlite` succeeds but exports a completely different API (`DatabaseSync`, synchronous methods) — not the `Database` constructor that better-sqlite3 provides.

The resolution chain `sqlite.Database ?? sqlite.default?.Database ?? sqlite` then falls through to the module namespace object (not a constructor), causing "Database is not a constructor".

## Fix
Removed `node:sqlite` from the import chain since its API is incompatible with better-sqlite3's constructor pattern. The chain is now: `bun:sqlite` → `better-sqlite3`.

Also added `sqlite.default` to the Database resolution chain to properly handle better-sqlite3's CJS-to-ESM interop (the constructor lives at `mod.default` when imported via ESM `import()`).

### Files Modified
- `packages/compactor/src/session/db.ts` — Removed `node:sqlite` fallback, added `sqlite.default` to resolution chain
- `packages/compactor/src/store/db-base.ts` — Removed `node:sqlite` fallback from `loadSQLite()`
- `packages/compactor/src/store/index.ts` — Added `lib.default` to Database resolution chain

## Verification
Tested with jiti (same loader Pi uses) — both SessionDB and ContentStore initialize and operate correctly.

## Notes
- If `node:sqlite` support is needed in the future, it requires a different abstraction (synchronous `DatabaseSync` API vs async better-sqlite3/bun:sqlite)
- The fix was applied to source, installed copy, and worktree copy
