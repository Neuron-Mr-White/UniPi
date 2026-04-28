---
title: "Compactor SessionDB — Database is not a constructor"
type: debug
date: 2026-04-28
severity: high
status: root-caused
---

# Compactor SessionDB — Database is not a constructor

## Summary
`SessionDB.init()` throws `Database is not a constructor` when initializing the compactor extension because the ESM dynamic import fallback chain fails to resolve the `better-sqlite3` constructor.

## Expected Behavior
`SessionDB.init()` should successfully create a SQLite database connection.

## Actual Behavior
```
Database is not a constructor
  at SessionDB.init (db.ts:83:15)
```

## Reproduction Steps
1. Load the compactor extension with `better-sqlite3` as the available SQLite backend
2. Extension emits `session_start` event
3. `init()` is called → `getSQLite()` returns the ESM module namespace
4. `new Database(this.dbPath)` throws because namespace object is not a constructor

## Environment
- Node.js v24.14.1
- ESM modules (`"type": "module"` in package.json)
- `better-sqlite3` available (CJS module imported via ESM)
- `bun:sqlite` and `node:sqlite` NOT available

## Root Cause Analysis

### Failure Chain
1. `SessionDB.init()` calls `await getSQLite()`
2. `getSQLite()` tries `bun:sqlite` → fails, tries `node:sqlite` → fails
3. Falls through to `await import("better-sqlite3")` → returns ESM module namespace object
4. Line 83: `const Database = sqlite.Database ?? sqlite.default?.Database ?? sqlite`
   - `sqlite.Database` → `undefined` (no named export)
   - `sqlite.default?.Database` → `undefined` (`default` IS the constructor, not an object with `.Database`)
   - `sqlite` → module namespace object (NOT a constructor)
5. `new Database(this.dbPath)` → **"Database is not a constructor"**

### Root Cause
ESM dynamic import of CommonJS `better-sqlite3` produces a module namespace where:
- `namespace.default` = the Database constructor function
- `namespace.Database` = undefined
- `namespace` itself = not a constructor

The fallback chain `sqlite.Database ?? sqlite.default?.Database ?? sqlite` never checks `sqlite.default` as a standalone constructor.

### Evidence
- File: `src/session/db.ts:83` — `const Database = sqlite.Database ?? sqlite.default?.Database ?? sqlite`
- Confirmed via Node.js ESM import: `Object.keys(namespace)` = `['SqliteError', 'default', 'module.exports']`

## Affected Files
- `src/session/db.ts` — SQLite initialization with incomplete ESM fallback chain

## Fix Applied

### Change
```typescript
// Before
const Database = sqlite.Database ?? sqlite.default?.Database ?? sqlite;

// After
const Database = sqlite.Database ?? sqlite.default?.Database ?? sqlite.default ?? sqlite;
```

Added `sqlite.default` to the fallback chain before `sqlite`, correctly resolving the `better-sqlite3` constructor when imported as an ESM namespace.

### Risk Assessment
- Low risk: only adds an additional fallback, doesn't change behavior for working cases
- `bun:sqlite` and `node:sqlite` paths still resolve first via `sqlite.Database` or `sqlite.default?.Database`

## Verification Plan
1. Load compactor extension → no "Database is not a constructor" error
2. `SessionDB.init()` completes successfully
3. Session events can be stored and retrieved

## Notes
This is a common ESM/CJS interop issue. When a CJS module's `module.exports = function`, ESM dynamic import wraps it as `namespace.default = function` while `namespace` itself is not callable.
