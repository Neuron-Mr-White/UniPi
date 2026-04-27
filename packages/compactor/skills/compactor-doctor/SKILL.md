---
name: compactor-doctor
description: Diagnostics — validate config, DB, FTS5, runtimes, troubleshoot issues.
---

# Compactor Doctor

Run diagnostics and troubleshoot compactor issues.

## Commands

- `/unipi:compact-doctor` — run all checks
- `ctx_doctor` tool — agent-callable diagnostics

## Checks Performed

| Check | What It Validates |
|-------|-------------------|
| **Config file** | `~/.unipi/config/compactor/config.json` exists and is valid |
| **Session DB** | SQLite connection works, schema correct |
| **Content Store** | FTS5 index accessible, tables exist |
| **Runtime: node** | Node.js available for sandbox |
| **Runtime: python3** | Python 3 available for sandbox |
| **Runtime: bash** | Bash available for sandbox |

## Status Icons

- ✅ **pass** — check succeeded
- ⚠️ **warn** — non-critical issue (e.g., optional runtime missing)
- ❌ **fail** — critical issue, feature may not work

## Common Issues

### "Config file: Using defaults"
- Normal on first run
- Config auto-created on next settings save
- Fix: `/unipi:compact-settings` → save

### "Session DB: Connection failed"
- SQLite not available
- Check if `better-sqlite3` is installed
- Fix: `npm install better-sqlite3`

### "Content Store: FTS5 error"
- SQLite FTS5 extension not available
- Requires SQLite 3.9+ with FTS5
- Fix: Update system SQLite

### "Runtime: python3 Not found"
- Python not installed or not in PATH
- Only needed for Python sandbox execution
- Fix: Install Python 3 or ignore if not needed

## Manual Diagnostics

### Check config
```bash
cat ~/.unipi/config/compactor/config.json
```

### Check DB files
```bash
ls -la ~/.unipi/db/compactor/
```

### Check SQLite version
```bash
sqlite3 --version
```

### Test FTS5
```bash
sqlite3 ':memory:' "CREATE VIRTUAL TABLE t USING fts5(x); SELECT 1;"
```
