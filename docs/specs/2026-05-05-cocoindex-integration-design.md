---
title: "CocoIndex Integration Experiment"
type: brainstorm
date: 2026-05-05
---

# CocoIndex Integration Experiment

## Problem Statement

Unipi's compactor package has a content indexing subsystem (FTS5-based chunking, search, and URL fetch-and-index) that is strictly inferior to CocoIndex's capabilities. CocoIndex provides AST-aware code chunking, incremental delta-only reprocessing, semantic vector search, knowledge graph extraction, and multi-source ingestion — none of which compactor has. We want to experiment with replacing compactor's content features entirely with CocoIndex, making it the single source of truth for content indexing and search.

## Context

### What CocoIndex Is
- Python+Rust framework for incremental data pipelines
- Walks sources (files, databases, APIs), transforms (chunk, embed, extract), writes to targets (Postgres, LanceDB, SQLite, etc.)
- CLI-driven: `cocoindex update main.py` — no Python imports needed from unipi
- Only reprocesses deltas (changed files), not everything
- Optional deps for embeddings: `cocoindex[sentence_transformers]`, `cocoindex[litellm]`, `cocoindex[sqlite]`

### What's Conflicting
Compactor's **content indexing subsystem** overlaps with CocoIndex:

| Feature | Compactor | CocoIndex |
|---------|-----------|-----------|
| Chunking | Heading/paragraph split | AST-aware code, recursive text |
| Search | FTS5 BM25 + trigram fuzzy | Vector embeddings + full-text |
| Incremental | None — full re-index every time | Delta-only |
| Scale | Single session, small corpus | Multi-GiB, parallel |
| Targets | Single SQLite FTS5 DB | Postgres, LanceDB, Qdrant, etc. |

### What's NOT Conflicting
- **Compaction pipeline** — compactor's core purpose (zero-LLM structured summaries, session continuity, resume snapshots)
- **Session recall** — BM25 search over current session's message history
- **Sandbox execution** — polyglot code execution
- **Security** — command evaluation, shell escape scanning
- **Context budget** — token estimation
- **Display overrides** — diff width clamping, tool output formatting
- **Memory** — stores curated facts/preferences, not raw document chunks. Complementary.

## Chosen Approach

Create a new `@pi-unipi/cocoindex` package in an experimental branch. Strip compactor's content indexing features. Route all content indexing/search through cocoindex CLI.

### Why CLI-Only Integration
1. **No language bridge needed** — unipi stays TypeScript, cocoindex stays Python
2. **No runtime deps in unipi** — Python + cocoindex are user-installed separately
3. **Already how cocoindex is designed to work** — declare a pipeline in `main.py`, run `cocoindex update`
4. **Simplest integration surface** — bash commands to `cocoindex update`, `cocoindex show`, etc.

## Design

### 1. New Package: `packages/cocoindex/`

```
packages/cocoindex/
├── package.json          # @pi-unipi/cocoindex
├── index.ts              # Extension entry
├── tools.ts              # Tool registration
├── commands.ts           # Command registration  
├── bridge.ts             # CLI interaction layer (spawn cocoindex)
├── skills/
│   └── cocoindex/
│       └── SKILL.md      # Agent skill for using cocoindex tools
└── README.md
```

**Core responsibility:** Bridge between the agent and cocoindex CLI.

#### bridge.ts — CLI Interaction

Runs `cocoindex` CLI commands and parses output:

```typescript
// Pseudocode — not implementation
interface CocoBridge {
  // Check if cocoindex is installed and available
  isAvailable(): Promise<boolean>
  
  // Index the current project (runs cocoindex update)
  indexProject(projectDir: string): Promise<IndexResult>
  
  // Search indexed content (queries the target store directly)
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  
  // Get indexing status
  status(): Promise<StatusInfo>
}
```

The search path is important: cocoindex writes to a target store (SQLite, Postgres, etc.). The bridge queries that store directly — it doesn't go through cocoindex CLI for searches (too slow). This means:

- For `cocoindex[sqlite]`: bridge reads the SQLite DB directly via `better-sqlite3` (already a dependency in memory package)
- For `cocoindex[postgres]`/`lancedb`: bridge would need their respective client libs

**Recommendation:** Default to `cocoindex[sqlite]` for zero-config. The SQLite target gives us vector search via sqlite-vec (already used by memory package).

#### tools.ts — Agent Tools

| Tool | Replaces | Description |
|------|----------|-------------|
| `cocoindex_search` | `content_search` / `ctx_search` | Search indexed content (semantic + full-text) |
| `cocoindex_status` | (part of `compactor_stats`) | Show indexing status, freshness, doc count |

Note: `content_index`, `content_fetch` are **removed** — indexing is a `cocoindex update` operation, not an agent tool. The agent triggers it via bash or command, not as an in-context tool call.

#### commands.ts — Commands

| Command | Description |
|---------|-------------|
| `/unipi:cocoindex-update` | Run `cocoindex update` on current project |
| `/unipi:cocoindex-status` | Show indexing status |
| `/unipi:cocoindex-init` | Scaffold a cocoindex `main.py` for the project |
| `/unipi:cocoindex-settings` | Configure cocoindex connection |

### 2. Compactor Changes: What Gets Removed

**Files to delete from compactor:**
- `src/store/chunking.ts` — chunking logic (cocoindex does this)
- `src/store/index.ts` — ContentStore class (FTS5 DB)
- `src/store/db-base.ts` — SQLite FTS5 database layer
- `src/store/unified.ts` — unified search across ContentStore + SessionDB
- `src/tools/ctx-index.ts` — content_index tool impl
- `src/tools/ctx-search.ts` — content_search tool impl
- `src/tools/ctx-fetch-and-index.ts` — content_fetch tool impl

**Files to modify in compactor:**
- `src/index.ts` — Remove ContentStore initialization, remove `contentStore` from tool deps
- `src/tools/register.ts` — Remove content_index, content_search, content_fetch tools and their deprecated aliases
- `src/commands/index.ts` — Remove content-index, content-search, content-purge commands and their deprecated aliases
- `src/types.ts` — Remove ContentStore-related types if any

**What stays in compactor (untouched):**
- `compact` tool — context compaction
- `session_recall` / `vcc_recall` — session history search
- `sandbox` / `ctx_execute` — code execution
- `sandbox_file` / `ctx_execute_file` — file execution
- `sandbox_batch` / `ctx_batch_execute` — batch execution
- `compactor_stats` / `ctx_stats` — stats (modified to remove ContentStore metrics)
- `compactor_doctor` / `ctx_doctor` — diagnostics (modified to remove FTS5 checks)
- `context_budget` — token estimation
- All compaction pipeline code (`src/compaction/`)
- All session code (`src/session/`)
- Security (`src/security/`)
- Display overrides (`src/display/`)
- TUI settings
- Config management

**Constants to update in `@pi-unipi/core`:**
- Remove from `COMPACTOR_TOOLS`: `CTX_INDEX`, `CTX_SEARCH`, `CTX_FETCH_AND_INDEX`
- Remove from `COMPACTOR_COMMANDS`: `COMPACT_INDEX`, `COMPACT_SEARCH`, `COMPACT_PURGE`

### 3. Core Constants Changes

Add to `MODULES`:
```typescript
COCOINDEX: "@pi-unipi/cocoindex"
```

Add new event constants for cocoindex operations.

### 4. Umbrella Package Changes

`package.json`:
- Add `"@pi-unipi/cocoindex": "*"` to dependencies
- Add cocoindex extension to `pi.extensions`
- Add cocoindex skills to `pi.skills`

### 5. Footer / Info-Screen Integration

Cocoindex package emits `MODULE_READY` and subscribes to the event system like all other packages. Footer shows indexing status. Info-screen gets a "CocoIndex" group.

## Implementation Checklist

- [x] Create experimental branch `experiment/cocoindex` — Task 1
- [x] Create `packages/cocoindex/` with `package.json`, `index.ts`, `bridge.ts`, `tools.ts`, `commands.ts` — Task 1
- [x] Implement `bridge.ts` — cocoindex CLI detection, `update`, `status` — Task 2
- [x] Implement `bridge.ts` — direct LanceDB target store querying for search — Task 3 (changed from SQLite to LanceDB)
- [x] Register cocoindex tools (`cocoindex_search`, `cocoindex_status`) — Task 4
- [x] Register cocoindex commands (`cocoindex-update`, `cocoindex-status`, `cocoindex-init`, `cocoindex-settings`) — Task 4
- [x] Add cocoindex skill (`skills/cocoindex/SKILL.md`) — teaches agent when/how to use cocoindex — Task 5
- [x] Add `MODULES.COCOINDEX` to `@pi-unipi/core/constants.ts` — Task 5
- [x] Add cocoindex events to `@pi-unipi/core/events.ts` — Task 5
- [x] Remove content store files from compactor (`store/chunking.ts`, `store/index.ts`, `store/db-base.ts`, `store/unified.ts`) — Task 6
- [x] Remove content tool files from compactor (`tools/ctx-index.ts`, `tools/ctx-search.ts`, `tools/ctx-fetch-and-index.ts`) — Task 6
- [x] Modify `compactor/src/index.ts` — remove ContentStore init, remove from deps — Task 6
- [x] Modify `compactor/src/tools/register.ts` — remove 6 content-related tool registrations — Task 6
- [x] Modify `compactor/src/commands/index.ts` — remove 6 content-related command registrations — Task 6
- [x] Modify `compactor/src/types.ts` — remove ContentStore types — Task 6
- [x] Update `@pi-unipi/core/constants.ts` — remove content tool/command names from COMPACTOR_TOOLS/COMPACTOR_COMMANDS — Task 8
- [x] Update umbrella `package.json` — add cocoindex dependency, extension, skills — Task 8
- [x] Update footer/info-screen to show cocoindex status instead of content store metrics — Task 9
- [x] Update compactor stats/doctor to work without ContentStore — Task 7
- [x] Test: `npm run typecheck` passes — Task 11
- [ ] Test: `npm test` passes — deferred (requires runtime test environment)
- [x] Create default cocoindex pipeline template (LanceDB target, localfs source, recursive splitter) — Task 10 (changed from SQLite to LanceDB)
- [x] Write README for `@pi-unipi/cocoindex` — Task 11

## Open Questions — Resolved

1. **Target store choice** → **LanceDB** — Zero-config, local file-based, no Docker/Postgres needed. Postgres/Qdrant as future options.
2. **Search interface** → **Query LanceDB directly from TypeScript** via `@lancedb/lancedb` Node.js SDK. No CLI round-trip.
3. **Pipeline definition** → **`.unipi/cocoindex/main.py`** — Auto-generated by `cocoindex-init`, user can customize.
4. **Watch mode** → **Out of scope for initial experiment.** Phase 2 consideration.
5. **Embedding model alignment** → **Reuse memory package settings** (`~/.unipi/memory/config.json`). Same API key, model, dimensions. Cross-system search enabled.
6. **Compactor's `content_fetch`** → **Move to web-api** as `cocoindex_fetch_url` tool. web-api already handles URL fetching.

## Open Questions — Remaining

- (none currently)

## Out of Scope

- Modifying cocoindex source code
- Removing the memory package (complementary, not conflicting)
- Removing compactor's core compaction/sandbox/session features
- Cocoindex Enterprise features
- Knowledge graph extraction (could be phase 2)
- MCP server integration with cocoindex-code (separate experiment)
