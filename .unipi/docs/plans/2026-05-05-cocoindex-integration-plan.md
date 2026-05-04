---
title: "CocoIndex Integration — Implementation Plan"
type: plan
date: 2026-05-05
workbranch: experiment/cocoindex
specs:
  - .unipi/docs/specs/2026-05-05-cocoindex-integration-design.md
---

# CocoIndex Integration — Implementation Plan

## Overview

Replace compactor's FTS5-based content indexing subsystem with a new `@pi-unipi/cocoindex` package that bridges to CocoIndex CLI. CocoIndex provides AST-aware chunking, incremental delta-only reprocessing, semantic vector search, and multi-source ingestion. The new package defaults to **LanceDB** as the target store (zero-config, local file-based) and reuses the memory package's embedding settings (OpenRouter API key + model selection) so both systems share the same vector space.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Target store | LanceDB (default) | Zero-config, local file-based, no Docker/Postgres needed. Postgres/Qdrant as future options. |
| Embedding model | Reuse memory package settings | Same `~/.unipi/memory/config.json` → same API key, model, dimensions. Cross-system vector search enabled. |
| Content fetch | Move to web-api as `cocoindex_fetch_url` tool | web-api already handles URL fetching; it pushes content to cocoindex bridge. |
| Search interface | Query LanceDB directly from TypeScript | LanceDB has a Node.js SDK (`@lancedb/lancedb`). No CLI round-trip for search. |
| Pipeline location | `.unipi/cocoindex/main.py` | Keeps unipi config organized per-project. |
| Branch | `experiment/cocoindex` | Isolated from main; easy to delete if experiment fails. |

## Tasks

- completed: Task 1 — Create experimental branch and cocoindex package scaffold
  - Description: Create the branch and set up the bare package structure
  - Dependencies: None
  - Acceptance Criteria: `npm run typecheck` passes with empty package, branch pushed
  - Steps:
    1. `git checkout -b experiment/cocoindex` from main
    2. Create `packages/cocoindex/` with `package.json` (`@pi-unipi/cocoindex`), `index.ts`, `bridge.ts`, `tools.ts`, `commands.ts`
    3. Create `skills/cocoindex/SKILL.md` placeholder
    4. Create `README.md` with package description
    5. Add `tsconfig.json` inheriting from root
    6. Verify `npm run typecheck` passes (empty exports)

- completed: Task 2 — Implement bridge.ts — CocoIndex CLI detection and indexing
  - Description: Build the CLI interaction layer that spawns `cocoindex` commands
  - Dependencies: Task 1
  - Acceptance Criteria: `bridge.isAvailable()` detects cocoindex CLI; `bridge.indexProject()` runs `cocoindex update` and parses output; `bridge.status()` reports indexing state
  - Steps:
    1. Implement `isAvailable()` — run `cocoindex --version`, parse output, cache result
    2. Implement `indexProject(projectDir)` — spawn `cocoindex update main.py` in `.unipi/cocoindex/` dir, stream stdout/stderr, return `{ success, chunksProcessed, durationMs }`
    3. Implement `status()` — read `.cocoindex/` state dir for last run info, return `{ indexed: boolean, lastRun: string, docCount: number }`
    4. Implement `initPipeline(projectDir)` — scaffold `.unipi/cocoindex/main.py` with default LanceDB target, localfs source, recursive splitter, and embedding config from memory settings
    5. Add error handling for missing Python, missing cocoindex, malformed pipeline
    6. Add `bridge.detectTargetStore()` — inspect `main.py` to determine which target (lancedb/postgres/qdrant) is configured

- completed: Task 3 — Implement bridge.ts — LanceDB direct query for search
  - Description: Enable search by querying LanceDB directly from TypeScript (no CLI round-trip)
  - Dependencies: Task 2
  - Acceptance Criteria: `bridge.search("query")` returns ranked results from LanceDB tables
  - Steps:
    1. Add `@lancedb/lancedb` as optional dependency in `package.json`
    2. Implement `search(query, options)` — open LanceDB at `.unipi/cocoindex/.lancedb/`, convert query text to embedding (reuse memory's `generateEmbedding`), perform vector search
    3. Implement hybrid search: vector similarity + full-text fallback (LanceDB supports both)
    4. Handle LanceDB not installed gracefully — return "search unavailable, install @lancedb/lancedb"
    5. Add result formatting: `{ title, content, source, rank, contentType, matchLayer }` — same shape as current `SearchResult` type for compatibility

- completed: Task 4 — Register cocoindex tools and commands
  - Description: Expose cocoindex operations as Pi tools and commands
  - Dependencies: Task 3
  - Acceptance Criteria: `cocoindex_search` and `cocoindex_status` tools registered; `/unipi:cocoindex-update`, `/unipi:cocoindex-status`, `/unipi:cocoindex-init`, `/unipi:cocoindex-settings` commands work
  - Steps:
    1. In `tools.ts` — register `cocoindex_search` tool with TypeBox schema (query, limit, offset), delegates to `bridge.search()`
    2. In `tools.ts` — register `cocoindex_status` tool, delegates to `bridge.status()`
    3. In `commands.ts` — register `cocoindex-update` command, runs `bridge.indexProject(cwd)`
    4. In `commands.ts` — register `cocoindex-status` command, shows indexing state
    5. In `commands.ts` — register `cocoindex-init` command, scaffolds default `main.py`
    6. In `commands.ts` — register `cocoindex-settings` command, TUI for target store, embedding model, etc.
    7. Wire everything in `index.ts` — extension entry that registers tools/commands on `session_start`

- completed: Task 5 — Add cocoindex skill and core constants
  - Description: Create agent skill for cocoindex usage, update core constants and events
  - Dependencies: Task 4
  - Acceptance Criteria: Skill teaches agent when/how to use cocoindex; `MODULES.COCOINDEX` exists; cocoindex events defined
  - Steps:
    1. Write `skills/cocoindex/SKILL.md` — teach agent: use `cocoindex_search` instead of `content_search`, trigger indexing via `/unipi:cocoindex-update`, when to init a pipeline, how results differ from old FTS5
    2. Add `COCOINDEX: "@pi-unipi/cocoindex"` to `MODULES` in `packages/core/constants.ts`
    3. Add `COCOINDEX_TOOLS` constant: `{ SEARCH: "cocoindex_search", STATUS: "cocoindex_status" }`
    4. Add `COCOINDEX_COMMANDS` constant: `{ UPDATE: "cocoindex-update", STATUS: "cocoindex-status", INIT: "cocoindex-init", SETTINGS: "cocoindex-settings" }`
    5. Add cocoindex events to `packages/core/events.ts`: `COCOINDEX_UPDATE_STARTED`, `COCOINDEX_UPDATE_COMPLETED`, `COCOINDEX_SEARCH_PERFORMED`

- completed: Task 6 — Remove content indexing from compactor
  - Description: Strip FTS5-based content store, tools, and commands from compactor package
  - Dependencies: Task 5 (constants must be ready so removal doesn't leave dangling refs)
  - Acceptance Criteria: No ContentStore references remain; compactor still works for compaction, session recall, sandbox, stats, doctor; `npm run typecheck` passes
  - Steps:
    1. Delete `compactor/src/store/chunking.ts`
    2. Delete `compactor/src/store/index.ts` (ContentStore class)
    3. Delete `compactor/src/store/db-base.ts` (SQLite FTS5 database layer — only if not used by SessionDB; SessionDB has its own SQLite path, so safe to delete)
    4. Delete `compactor/src/store/unified.ts` (cross-source search)
    5. Delete `compactor/src/tools/ctx-index.ts`
    6. Delete `compactor/src/tools/ctx-search.ts`
    7. Delete `compactor/src/tools/ctx-fetch-and-index.ts`
    8. Modify `compactor/src/tools/register.ts` — remove 6 content-related tool registrations (content_index, ctx_index, content_search, ctx_search, content_fetch, ctx_fetch_and_index) and their schemas/imports
    9. Modify `compactor/src/tools/register.ts` — update `CompactorToolDeps` to remove `contentStore`; update `sandbox_batch` to not accept search items (or delegate search to cocoindex)
    10. Modify `compactor/src/commands/index.ts` — remove content-index, content-search, content-purge commands and their deprecated aliases; update command deps to remove ContentStore
    11. Modify `compactor/src/index.ts` — remove ContentStore import, init, and all references; remove `fts5Index` config check; remove `contentStore?.checkpointWAL()` from shutdown
    12. Modify `compactor/src/types.ts` — remove `IndexResult`, `SearchResult`, `StoreStats` types
    13. Remove `compactor/src/store/` directory if empty

- completed: Task 7 — Update compactor stats and doctor without ContentStore
  - Description: Refactor ctx-stats and ctx-doctor to work without ContentStore dependency
  - Dependencies: Task 6
  - Acceptance Criteria: `compactor_stats` shows session stats without indexed docs count; `compactor_doctor` passes without FTS5 check; both accept null contentStore
  - Steps:
    1. Modify `compactor/src/tools/ctx-stats.ts` — remove `contentStore` parameter, remove `storeStats`, remove `indexedDocs`/`indexedChunks` from result
    2. Modify `compactor/src/tools/ctx-doctor.ts` — remove `contentStore` parameter, remove "Content Store" check
    3. Update `compactor/src/tools/register.ts` — stats and doctor tool executors pass null/no contentStore
    4. Update `compactor/src/commands/index.ts` — stats and doctor command handlers don't require contentStore
    5. Update `compactor/src/info-screen.ts` — if it references contentStore metrics, remove those
    6. Update `compactor/src/index.ts` — remove contentStore from info-screen data provider if present

- completed: Task 8 — Update umbrella package and core constants cleanup
  - Description: Wire cocoindex into the umbrella package, remove old content tool/command constants from core
  - Dependencies: Task 7
  - Acceptance Criteria: Umbrella `package.json` includes cocoindex; `npm run typecheck` passes at root; old content constants removed from core
  - Steps:
    1. Add `"@pi-unipi/cocoindex": "*"` to umbrella `dependencies`
    2. Add `"node_modules/@pi-unipi/cocoindex/index.ts"` to `pi.extensions`
    3. Add `"node_modules/@pi-unipi/cocoindex/skills"` to `pi.skills`
    4. Remove from `COMPACTOR_TOOLS` in `core/constants.ts`: `CTX_INDEX`, `CTX_SEARCH`, `CTX_FETCH_AND_INDEX`
    5. Remove from `COMPACTOR_COMMANDS` in `core/constants.ts`: `COMPACT_INDEX`, `COMPACT_SEARCH`, `COMPACT_PURGE`
    6. Remove `FTS5_CHUNK_SIZE` from `COMPACTOR_DEFAULTS` in `core/constants.ts`
    7. Update `UnipiCompactorStatsEvent` in `core/events.ts` — remove `indexedDocs` field
    8. Run `npm run typecheck` at root — must pass

- in-progress: Task 9 — Update footer to show cocoindex status instead of content metrics
  - Description: Replace footer's `indexed_docs` segment with cocoindex indexing status
  - Dependencies: Task 8
  - Acceptance Criteria: Footer shows cocoindex status (indexed/no-index) instead of FTS5 doc count; no broken references to content store
  - Steps:
    1. Check `footer/src/segments/compactor.ts` — update `indexed_docs` segment to query cocoindex bridge status instead of content store
    2. Check `footer/src/presets.ts` — update references to `indexed_docs` if needed
    3. Check `footer/src/rendering/icons.ts` — keep icon, change label to "CocoIndex" or "Indexed"
    4. Check `footer/src/rendering/renderer.ts` — update compactorIds list if needed
    5. Check `footer/src/help.ts` — update help text for the segment

- unstarted: Task 10 — Create default cocoindex pipeline template
  - Description: Write the default `main.py` template that `cocoindex-init` scaffolds
  - Dependencies: Task 5
  - Acceptance Criteria: Template uses LanceDB target, localfs source, recursive splitter, EmbedText with OpenRouter, and works with `cocoindex update`
  - Steps:
    1. Write template as a string constant in `bridge.ts` or a separate `template.ts`
    2. Template reads embedding config from `~/.unipi/memory/config.json` (or env vars)
    3. Uses `cocoindex.add_source()` with `LocalFile` pointing at project root
    4. Uses `SplitRecursively` for chunking
    5. Uses `EmbedText` with OpenRouter provider for embeddings
    6. Exports to LanceDB at `.unipi/cocoindex/.lancedb/`
    7. Template is customizable — user can edit `main.py` after init

- unstarted: Task 11 — Write README and test typecheck
  - Description: Document the cocoindex package and verify everything compiles
  - Dependencies: Task 10
  - Acceptance Criteria: `npm run typecheck` passes; README explains setup, usage, architecture
  - Steps:
    1. Write `packages/cocoindex/README.md` — overview, prerequisites (Python, cocoindex, LanceDB), quickstart, architecture diagram, configuration, tool/command reference
    2. Run `npm run typecheck` at root — must pass with zero errors
    3. Verify `npm run typecheck --workspace=@pi-unipi/cocoindex` passes
    4. Commit all changes with message `feat(cocoindex): add cocoindex integration experiment, remove FTS5 content store`

## Sequencing

```
Task 1 (scaffold)
  └─→ Task 2 (bridge: CLI)
       └─→ Task 3 (bridge: LanceDB search)
            └─→ Task 4 (tools/commands)
  └─→ Task 5 (skill + constants)  [parallel with 2-4]
       ├─→ Task 6 (remove from compactor)
       │    └─→ Task 7 (fix stats/doctor)
       │         └─→ Task 8 (umbrella + constants cleanup)
       │              └─→ Task 9 (footer)
       └─→ Task 10 (pipeline template)
Task 11 (README + typecheck)  [after all above]
```

Parallelism: Tasks 2-4 and Task 5 can proceed in parallel. Tasks 6-9 are sequential (each depends on the previous). Task 10 only needs Task 5. Task 11 is the final gate.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| CocoIndex CLI not installed | Package gracefully degrades — tools return "not available", commands show setup instructions | `bridge.isAvailable()` check on every operation |
| LanceDB Node.js SDK incompatible with Bun | Bun doesn't support all native Node modules | Test early; fallback to Python-based query via CLI |
| LanceDB SDK missing or breaking changes | Newer package, less stable than SQLite | Pin version; add fallback to basic file-based search |
| `content_fetch` removal breaks agent workflows | Agent may try to use `content_fetch` tool | Keep tool name registered as stub that returns "use cocoindex" message in phase 1 |
| `sandbox_batch` loses search item type | Batch tool had `type: "search"` items | Remove search type from batch; search is now cocoindex-only |
| Large compactor removal breaks imports elsewhere | Other packages may import from compactor store | Search entire codebase for ContentStore imports before removing |
| User has existing FTS5 indexed content | Removing content store loses their data | Add migration note in README; consider keeping content store files but disabled |
| CocoIndex pipeline definition in Python requires user to know Python | Non-Python users can't customize | Default template auto-generated; README explains customization is optional |
