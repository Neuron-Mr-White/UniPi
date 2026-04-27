---
title: "Fix disk I/O error handling in memory extension"
type: quick-work
date: 2026-04-28
status: complete
---

# Fix disk I/O error handling in memory extension

## Problem
The memory extension throws "disk I/O error" on startup when 4+ Pi sessions start simultaneously and all try to open the same SQLite database on WSL/Windows filesystem (`/mnt/d/`). The original fix (2026-04-28) added recovery at the verification step, but the **first** `this.db.pragma("journal_mode = WAL")` call was unprotected — it crashed before any error handling could run.

## Root cause
`init()` created the Database and immediately called `this.db.pragma("journal_mode = WAL")` without any try/catch. The existing recovery code only kicked in at a later verification step. Concurrent sessions all racing to open the same `.db` file caused the pragma to fail.

## Fix
Rewrote `init()` in `packages/memory/storage.ts`:

1. **Extracted `initDb()` private method** — contains all the DB setup logic (open, pragma, load vec, create tables, verify)
2. **Added retry loop in `init()`** — wraps `initDb()` with up to 5 attempts
3. **Exponential backoff** — 50ms, 100ms, 200ms, 400ms between retries (synchronous busy-wait since `init()` is sync)
4. **Handles multiple error codes** — `SQLITE_IOERR`, `SQLITE_BUSY`, "database is locked", "disk I/O error"
5. **Recovery fallback** — if retries exhausted on IO errors, deletes DB files and tries one fresh init
6. **Non-IO errors propagate immediately** — no retry for unrelated errors

## Verification
- TypeScript compilation passes (`npx tsc --noEmit --skipLibCheck`)
- No other SQLite init points in memory extension share this pattern
- Compactor DBs use separate paths, not affected
