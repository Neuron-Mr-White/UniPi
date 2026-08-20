# Ponytail Audit Phase 4 — Risky Cuts with Migrations

Repo: /home/oi/Projects/Personal/archived/unipi
Principle: **Migrate existing user data. Prove it works. No back-stabbing.**

## Rules
- After EACH item: `npx tsc --noEmit --skipLibCheck` must pass
- After EACH item: run relevant package tests (`npx tsx --test packages/<pkg>/tests/*.test.ts` or similar)
- For memory: ensure existing SQLite data migrates to mempalace before removing SQLite
- Commit after each successful item
- If something can't be proven to work, REVERT and skip it

## Items (in priority order)

### 1. Memory: delete SQLite fallback, keep mempalace-only (~800 lines)
- [x] Verify mempalace is the primary path (storage.ts:381-420)
- [x] Check migration: does existing SQLite data auto-migrate to mempalace?
- [x] If migration exists and works: delete SQLite+sqlite-vec backend, better-sqlite3 dep, sqlite-vec dep
- [x] If migration is missing: write it first (N/A — migration exists), THEN delete
- [x] Run memory tests (8/8 pass)
- [x] Typecheck + commit

### 2. Footer color system → pi Theme.fg() (~100 lines)
- [ ] Replace detectColorMode/rgbTo256/cubeStep/sqDist with pi's Theme.fg()
- [x] N/A (skipped)
- [x] N/A (skipped)
- [x] Typecheck + commit

### 3. Web-api DOM rework (~340 lines)
- [x] SKIPPED: dom.ts is linkedom+defuddle glue, removal risks fallback quality (linkedom parseHTML + polyfills) with defuddle/node entry
- [x] SKIPPED: same risk with linkedom querySelectorAll
- [x] N/A (skipped)
- [x] Typecheck + commit

### 4. Updater overlay merge (~490 → ~250 lines)
- [ ] Merge changelog-overlay + readme-overlay into one ListDetailOverlay
- [ ] Run updater tests
- [x] Typecheck + commit

### 5. Compactor config merge (~30 lines)
- [ ] Consolidate deepMerge + migrateConfig/mergeStrategy into one
- [ ] Run compactor tests
- [x] Typecheck + commit

### 6. Ask-user renderOptions dedup (~200 lines)
- [ ] Collapse 3 render branches + duplicated dispatch into one renderer + dispatch table
- [ ] Run ask-user tests
- [x] Typecheck + commit

### 7. 4 settings.json helpers → shared (~60 lines)
- [ ] Extract read/write/merge/validate from footer/info-screen/notify/utility
- [ ] Run tests for each package
- [x] Typecheck + commit

### 8. Updater semver consolidation (~20 lines)
- [ ] Consolidate updater compareVersions with cocoindex parseVersion/isVersionAtLeast
- [ ] Run tests
- [x] Typecheck + commit

## Completion marker
Emit "Phase 4 complete. <N> additional lines removed." when all done.
