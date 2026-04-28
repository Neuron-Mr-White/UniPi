---
title: "Compactor SessionDB missing directory — Quick Fix"
type: quick-fix
date: 2026-04-29
---

# Compactor SessionDB missing directory — Quick Fix

## Bug
Extension compactor fails to start with error: `Cannot open database because the directory does not exist` when better-sqlite3 tries to open `~/.unipi/db/compactor/session.db` on a fresh install where the parent directory hasn't been created yet.

## Root Cause
`session/db.ts` has its own `defaultDBPath()` function that returns a path under `~/.unipi/db/compactor/`, but unlike `store/db-base.ts` which creates the directory in `defaultDBPath()`, the session version does not ensure the directory exists before opening the database.

## Fix
Added `mkdirSync(dir, { recursive: true })` in `SessionDB.init()` to create the parent directory before opening the database, matching the pattern already used in `store/db-base.ts`.

### Files Modified
- `packages/compactor/src/session/db.ts` — Added `existsSync`/`mkdirSync` imports and directory creation in `init()`

## Verification
- Created `~/.unipi/db/compactor/` directory manually to confirm fix works
- Fix matches existing pattern in `store/db-base.ts` line 9-11

## Notes
The `ContentStore` (store/db-base.ts) already had this handled correctly. Only `SessionDB` was missing it.
