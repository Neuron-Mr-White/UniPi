# Compactor Feature Bridging — COMPLETE ✅

## Goal
Implement 6 missing features from context-mode into @pi-unipi/compactor, plus add TUI settings to toggle each pipeline stage.

## Checklist

### Feature 1: TTL Cache for ctx_fetch_and_index ✅
- [x] Study `src/store.ts` TTL cache implementation (24h)
- [x] Add `getSourceMeta()` method to ContentStore
- [x] Skip re-fetch if < 24h old (unless `force: true`)
- [x] Return cache hit info in IndexResult

### Feature 2: Proximity Reranking ✅
- [x] Study search reranking in `src/store.ts`
- [x] After RRF merge, rerank by proximity of query terms in content
- [x] Boost results where terms appear close together

### Feature 3: Timeline Sort (Unified Search) ✅
- [x] Study `src/search/unified.ts`
- [x] Add `sort: "timeline" | "relevance"` option to ctx_search
- [x] Timeline mode searches ContentStore + SessionDB events chronologically

### Feature 4: Auto-Injection on Compact ✅
- [x] Study `src/session/snapshot.ts` auto-injection
- [x] Build auto-injection with P1-P4 priority tiers
- [x] 500 token hard cap with priority-based overflow

### Feature 5: Progressive Throttling ✅
- [x] Study throttling in `src/server.ts`
- [x] Track ctx_* call count per session (60s window)
- [x] Calls 1-3: normal results
- [x] Calls 4-8: reduced results + warning
- [x] Calls 9+: blocked → suggest ctx_batch_execute

### Feature 6: mmap_size Pragma ✅
- [x] Study `src/db-base.ts` mmap_size
- [x] Add `PRAGMA mmap_size = 268435456` (256MB) to SQLite connections
- [x] Wrap in try/catch for runtimes where mmap unsupported

### TUI Settings Toggle ✅
- [x] Each pipeline stage toggleable in TUI
- [x] Group stages by when they run (On Compaction, On Search, On Index)
- [x] Visual: `[●]` enabled / `[○]` disabled

## Files Changed (16 files, +592 lines)
- `store/db-base.ts` — mmap pragma with config toggle
- `store/index.ts` — TTL cache method, proximity reranking functions
- `store/unified.ts` — NEW: unified search across sources
- `tools/ctx-fetch-and-index.ts` — TTL cache with force bypass
- `tools/ctx-search.ts` — throttling, timeline sort
- `tools/register.ts` — updated schemas for new params
- `session/auto-inject.ts` — NEW: auto-injection on compact
- `session/resume-inject.ts` — integrated auto-injection
- `commands/index.ts` — throttling warnings
- `config/schema.ts` — pipeline defaults
- `config/manager.ts` — pipeline merge
- `types.ts` — pipeline config type
- `tui/settings-overlay.ts` — pipeline mode UI

## Status: COMPLETE