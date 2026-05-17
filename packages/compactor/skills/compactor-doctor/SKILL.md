---
name: compactor-doctor
description: Diagnostics — validate config, session DB, runtimes, and troubleshoot compactor issues.
---

# Compactor Doctor

Run diagnostics and troubleshoot compactor issues.

## Commands and Tools

- `/unipi:compact-doctor` — user-facing diagnostics
- `compactor_doctor` tool — agent-callable diagnostics
- `ctx_doctor` tool — deprecated alias

## Checks Performed

| Check | What It Validates |
|-------|-------------------|
| **Config file** | `~/.unipi/config/compactor/config.json` exists or defaults can be used |
| **Session DB** | SQLite connection works and session schema is usable |
| **Runtime: node** | Node.js available for sandbox/runtime helpers |
| **Runtime: python3** | Python 3 available for Python sandbox execution |
| **Runtime: bash** | Bash available for shell sandbox execution |

## Status Icons

- ✅ **pass** — check succeeded
- ⚠️ **warn** — non-critical issue, such as an optional runtime missing
- ❌ **fail** — critical issue; a feature may not work

## Common Issues

### "Config file: Using defaults"

- Normal on first run.
- Config is created by the extension or on settings save.
- Fix: open `/unipi:compact-settings`, adjust if desired, then save.

### "Session DB: Connection failed"

- SQLite or `better-sqlite3` may be unavailable.
- Compaction can still degrade gracefully, but stats/recall may be limited.
- Fix: verify dependencies and run package install/build steps.

### "Runtime: python3 Not found"

- Python is not installed or not in `PATH`.
- Only needed for Python sandbox execution.
- Fix: install Python 3 or ignore if not needed.

## Manual Diagnostics

### Check config
```bash
cat ~/.unipi/config/compactor/config.json
```

### Check DB files
```bash
ls -la ~/.unipi/db/compactor/
```

### Check runtimes
```bash
node --version
python3 --version
bash --version
```

Project content indexing diagnostics live in the CocoIndex package, not compactor.
