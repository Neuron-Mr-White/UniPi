# Compactor Gap Analysis & Stats Integration

## Goal
Audit `@pi-unipi/compactor` against upstream sources, identify missing functions, add token stats to compact command and info-screen.

## Checklist

- [x] **Research upstream repos** — Read context-mode and pi-vcc GitHub repos for all compaction functions
- [x] **Audit compactor package** — Map all functions in `@pi-unipi/compactor` against upstream
- [x] **Check token calculation** — Do upstream repos have token-saved calculation? Does compactor?
- [x] **Add token stats to compact command** — Calculate total tokens compacted, show in `/unipi:compact`
- [x] **Register all-time stats in info-screen** — Integrate cumulative token stats into `@pi-unipi/info-screen`
- [x] **Report unbridged functions** — List which upstream functions are NOT in compactor

## Conventions
- Read all relevant source files before writing code
- Follow existing patterns in each package
- Memory search before decisions

## Deliverables
1. Gap analysis report (which functions missing) ✅
2. Token stats in compact command ✅
3. All-time stats in info-screen ✅
4. Final report of unbridged functions ✅

---

## Final Report: Unbridged Functions

### ❌ NOT Bridged — Missing from @pi-unipi/compactor

| # | Feature | Source | What it does |
|---|---------|--------|-------------|
| 1 | `ctx_upgrade` | context-mode | Auto-upgrade from GitHub, rebuild, reconfigure hooks |
| 2 | `ctx_insight` | context-mode | Analytics dashboard — 90 metrics, 37 insight patterns, 4 composite scores (web UI) |
| 3 | TTL cache for `ctx_fetch_and_index` | context-mode | 24h cache — skip re-fetching URLs already indexed |
| 4 | Proximity reranking | context-mode | Multi-term queries reranked by term proximity distance |
| 5 | Timeline sort | context-mode | Unified search across ContentStore + SessionDB + auto-memory chronologically |
| 6 | Auto-injection on compact | context-mode | `buildAutoInjection()` — injects behavioral_directive, rules, skills on SessionStart(source="compact") with 500 token cap |
| 7 | Progressive throttling | context-mode | Calls 1-3 normal, 4-8 reduced results + warning, 9+ blocked → redirect to `ctx_batch_execute` |
| 8 | `mmap_size` pragma | context-mode | 256MB mmap for read-heavy FTS5 search performance |

### 🔧 Changes Made (token stats were broken)

| File | Change |
|------|--------|
| `session/db.ts` | Added `total_chars_before`, `total_chars_kept`, `total_messages_summarized` columns + `addCompactionStats()` + `getAllTimeStats()` methods |
| `compaction/hooks.ts` | Updated to accept `{ sessionDB, getSessionId }` deps, persists stats after each compaction |
| `tools/ctx-stats.ts` | Now queries cumulative stats from SessionDB instead of returning `tokensSaved: 0` |
| `commands/index.ts` | `/unipi:compact` now shows all-time token stats |
| `info-screen.ts` | Shows cumulative all-time token stats from SessionDB |
| `index.ts` | Registered compactor as info-screen group via `globalThis.__unipi_info_registry` |
| `types.ts` | Added `total_chars_before`, `total_chars_kept`, `total_messages_summarized` to `SessionMeta` |
