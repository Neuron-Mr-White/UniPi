---
title: "feat: Unipi Memory — Persistent Cross-Session Memory with Vector Search"
type: plan
date: 2026-04-26
status: completed
brainstorm: docs/brainstorms/2026-04-26-unipi-memory-brainstorm.md
confidence: medium
---

# Unipi Memory: Persistent Cross-Session Memory with Vector Search

## Problem Statement

Agent forgets everything between sessions. User preferences, project decisions, coding style, architectural patterns — all lost on restart. Pi compaction generates summaries but they're session-scoped and ephemeral. No cross-session recall exists.

## Target End State

Working `@unipi/memory` package that provides:
- **Two-tier storage:** SQLite + sqlite-vec for vector search, markdown files for human-readable memory
- **Project-scoped + global memory:** Each project gets its own DB, global memories accessible cross-project
- **Agent tools:** `memory_store`, `memory_search`, `memory_delete` — agent calls autonomously
- **User commands:** `/unipi:memory-process`, `/unipi:memory-search`, `/unipi:memory-consolidate`, plus global variants
- **Session injection:** Titles-only memory list at session start via `before_agent_start`
- **Auto-consolidation:** On compaction, extract memory from summary and store
- **Skill:** `SKILL.md` teaching agent memory management best practices

## Scope and Non-Goals

**In scope:**
- `@unipi/memory` package with tools, commands, skill
- `better-sqlite3` + `sqlite-vec` for vector search
- Markdown memory files with YAML frontmatter
- Hybrid search (vector + fuzzy text)
- Project-scoped and global memory scopes
- Session start injection (titles only)
- Auto-consolidation on compaction
- `/unipi:memory-consolidate` manual command
- `/unipi:memory-process <text>` — agent extracts and stores memory
- `/unipi:memory-search <term>` — manual search
- `/unipi:global-memory-process`, `/unipi:global-memory-search`, `/unipi:global-memory-list`
- `memory_delete` tool and `/unipi:memory-forget` command
- Integration with `@unipi/core` events and constants

**Out of scope:**
- Remote vector services (Pinecone, Weaviate Cloud)
- Real-time embedding model (embeddings via LLM prompt, fuzzy fallback)
- Memory sharing between users
- Memory UI/TUI components
- Modifying pi core

## Proposed Solution

### Storage Layout

```
~/.unipi/memory/
├── global/
│   ├── memory.db              # Global vector DB
│   └── *.md                   # Global memory files
└── <project_name>/
    ├── memory.db              # Project vector DB
    └── *.md                   # Project memory files
```

Project name: `sanitize(cwd)` — replace non-alphanumeric with `_`, collapse repeats.

### Memory File Format

```markdown
---
title: auth_jwt_prefer_refresh_tokens
tags: [auth, jwt, preferences]
project: my-app
created: 2026-04-26T10:00:00Z
updated: 2026-04-26T15:30:00Z
type: preference
---

# Auth: Prefer Refresh Tokens

User prefers short-lived access tokens (15min) with long-lived refresh tokens (30d).
Always implement token rotation on refresh.
```

**Type values:** `preference`, `decision`, `pattern`, `summary`

**Naming:** `<most_important>_<less_important>_<lesser>` — matches vector title and filename.

### Vector Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,            -- JSON array
  project TEXT,
  type TEXT,
  created TEXT,
  updated TEXT,
  embedding BLOB
);

CREATE VIRTUAL TABLE memories_vec USING vec0(
  embedding float[384]
);
```

### Session Injection

`before_agent_start` event injects titles-only:

```xml
<memory>
Available memories (project: my-app):
- auth_jwt_prefer_refresh_tokens
- db_postgres_use_connection_pooling
- style_typescript_strict_mode_always

Global memories:
- [my-app] auth_jwt_prefer_refresh_tokens
- [other-project] api_rest_versioning_v2

Use memory_search to retrieve full content. Use memory_store to save new memories.
</memory>
```

### Auto-Consolidation

1. Listen to `session_before_compact` event
2. Extract compaction summary
3. Use LLM to identify extractable memory items
4. Update existing or create new memories
5. Return compaction summary unchanged

### Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store/update memory (project scope) |
| `memory_search` | Search memories (project scope) |
| `memory_delete` | Delete memory by ID |
| `global_memory_store` | Store/update memory (global scope) |
| `global_memory_search` | Search memories (global scope) |
| `global_memory_list` | List all global memories |

### Commands

| Command | Description |
|---------|-------------|
| `/unipi:memory-process <text>` | Agent extracts and stores memory from text |
| `/unipi:memory-search <term>` | Manual search (project scope) |
| `/unipi:memory-consolidate` | Consolidate session into memory |
| `/unipi:memory-forget <title>` | Delete memory by title |
| `/unipi:global-memory-process <text>` | Agent extracts and stores to global |
| `/unipi:global-memory-search <term>` | Manual search (global scope) |
| `/unipi:global-memory-list` | List all global memories |

### Search Algorithm

Hybrid: vector similarity + fuzzy text matching

1. Vector search: embed term, find top-5 similar memories
2. Fuzzy search: match term against titles and content (case-insensitive substring)
3. Merge results, deduplicate, rank by combined score
4. Return titles with snippets

Fallback: If no embeddings (NULL embedding column), fuzzy-only search.

### Embedding Strategy

**Primary:** Use pi's active LLM to generate embeddings via prompt:
```
Embed the following text as a dense vector for similarity search.
Return ONLY a JSON array of 384 floats, no other text.
Text: {text}
```

**Fallback:** If LLM embedding fails, use fuzzy text search only. Vector column remains NULL.

## Implementation Tasks

### Task 1: Scaffold `packages/memory/`
- Create `packages/memory/package.json` with dependencies:
  - `better-sqlite3` (peer or dep)
  - `sqlite-vec` (dep)
  - `js-yaml` (dep, for frontmatter parsing)
  - `@unipi/core` (dep)
  - `@mariozechner/pi-coding-agent` (peer)
  - `@sinclair/typebox` (peer)
- Create directory structure:
  ```
  packages/memory/
  ├── package.json
  ├── index.ts           # Extension entry
  ├── storage.ts         # SQLite + markdown storage layer
  ├── search.ts          # Hybrid search algorithm
  ├── embedding.ts       # LLM-based embedding generation
  ├── tools.ts           # Tool registration
  ├── commands.ts        # Command registration
  └── skills/
      └── memory/
          └── SKILL.md   # Memory management skill
  ```
- **Depends on:** Nothing
- **Acceptance:** `npm install` succeeds, structure matches plan

### Task 2: Implement `storage.ts` — Storage Layer
- `MemoryStorage` class:
  - `constructor(projectName: string, globalScope: boolean)`
  - `init()` — create DB, tables, load sqlite-vec extension
  - `store(memory: MemoryRecord)` — insert/update markdown + vector
  - `getById(id: string)` — retrieve single memory
  - `listAll()` — list all memories (titles only)
  - `delete(id: string)` — delete markdown + vector entry
  - `search(query: string, limit?: number)` — hybrid search
- `MemoryRecord` interface:
  - `id`, `title`, `content`, `tags`, `project`, `type`, `created`, `updated`, `embedding`
- `parseMemoryFile(path: string)` — parse markdown frontmatter
- `writeMemoryFile(path: string, record: MemoryRecord)` — write markdown with frontmatter
- `getProjectDir(projectName: string)` — resolve `~/.unipi/memory/<project>/`
- `getGlobalDir()` — resolve `~/.unipi/memory/global/`
- `sanitizeProjectName(cwd: string)` — derive project name from cwd
- **Depends on:** Task 1
- **Acceptance:** Can create DB, store record, retrieve record, list all

### Task 3: Implement `embedding.ts` — Embedding Generation
- `generateEmbedding(text: string, pi: ExtensionAPI): Promise<Float32Array | null>`
  - Use pi's LLM via prompt to generate 384-dim vector
  - Parse JSON array from response
  - Return null on failure (fallback to fuzzy)
- `vectorToBuffer(vec: Float32Array): Buffer` — for sqlite storage
- `bufferToVector(buf: Buffer): Float32Array` — for sqlite retrieval
- **Depends on:** Task 1
- **Acceptance:** Can generate embedding from text, convert to/from buffer

### Task 4: Implement `search.ts` — Hybrid Search
- `hybridSearch(db, query, limit)` — combine vector + fuzzy
  1. If embeddings available: vector similarity search (top-5)
  2. Fuzzy text search on title + content (case-insensitive substring)
  3. Merge, deduplicate by ID, rank by combined score
  4. Return results with snippets
- `fuzzyMatch(text: string, query: string): number` — match score (0-1)
- `extractSnippet(content: string, query: string, chars?: number)` — context around match
- **Depends on:** Task 2
- **Acceptance:** Can search by term, returns ranked results with snippets

### Task 5: Implement `tools.ts` — Tool Registration
- `memory_store` tool:
  - Params: `title`, `content`, `tags?`, `type?`, `project?`
  - Auto-generate ID, timestamps
  - Store to project scope (default) or global (if `global_memory_store`)
- `memory_search` tool:
  - Params: `query`, `limit?`, `global?`
  - Hybrid search, return results with snippets
- `memory_delete` tool:
  - Params: `id` or `title`
  - Delete from markdown + vector
- `global_memory_store`, `global_memory_search`, `global_memory_list` tools
- **Depends on:** Tasks 2, 3, 4
- **Acceptance:** All tools registered, can store/search/delete via tool calls

### Task 6: Implement `commands.ts` — Command Registration
- `/unipi:memory-process <text>`:
  - Agent analyzes text, extracts memory items
  - For each: check if similar exists → update or create
  - Report what was stored/updated
- `/unipi:memory-search <term>`:
  - Hybrid search, display results
- `/unipi:memory-consolidate`:
  - Review current session, extract memories, store
- `/unipi:memory-forget <title>`:
  - Find by title, confirm, delete
- `/unipi:global-memory-process <text>`:
  - Same as memory-process but global scope
- `/unipi:global-memory-search <term>`:
  - Same as memory-search but global scope
- `/unipi:global-memory-list`:
  - List all global memories with project prefixes
- **Depends on:** Task 5
- **Acceptance:** All commands registered, `/unipi:memory-search test` returns results

### Task 7: Implement `index.ts` — Extension Entry
- Export default function receiving `pi: ExtensionAPI`
- On `session_start`:
  - Initialize storage for current project
  - Emit `UNIPI_EVENTS.MODULE_READY` with module info
  - Detect `@unipi/workflow` presence for integration
- On `before_agent_start`:
  - Load all memory titles (project + global)
  - Inject titles-only XML block into system prompt
- On `session_before_compact`:
  - Extract compaction summary
  - Use LLM to identify memory items
  - Store/Update memories
  - Return summary unchanged (don't add to context)
- On `session_shutdown`:
  - Close DB connections
- Register tools and commands
- Load skill directory
- **Depends on:** Tasks 5, 6
- **Acceptance:** Module loads, injects memory at start, consolidates on compaction

### Task 8: Write `SKILL.md` — Memory Skill
- Frontmatter with name, description, allowed-tools
- Instructions for agent:
  - When to store memory (decisions, preferences, patterns, summaries)
  - How to name memories (`<most_important>_<less_important>_<lesser>`)
  - When to search (before making decisions, when user references past work)
  - How consolidation works
  - How to read memory files directly
  - Memory types (preference, decision, pattern, summary)
  - Update-first principle (don't duplicate)
- **Depends on:** Task 7
- **Acceptance:** Skill loads, agent follows memory best practices

### Task 9: Update `@unipi/core` Constants
- Add memory-related constants to `packages/core/constants.ts`:
  - `MEMORY_TOOLS` — tool names
  - `MEMORY_COMMANDS` — command names
  - `MEMORY_DIRS` — directory paths
  - `MEMORY_DEFAULTS` — default limits, dimensions
- Add memory events to `packages/core/events.ts`:
  - `MEMORY_STORED` — memory created/updated
  - `MEMORY_DELETED` — memory removed
  - `MEMORY_SEARCHED` — memory search performed
  - `MEMORY_CONSOLIDATED` — consolidation completed
- **Depends on:** Task 1
- **Acceptance:** Constants export correctly, no breaking changes

### Task 10: Update `unipi` Meta-Package
- Add `@unipi/memory` to root `package.json` dependencies
- Add to `pi.extensions` and `pi.skills` arrays
- Update README with memory module docs
- **Depends on:** Tasks 7, 8
- **Acceptance:** `pi install npm:unipi` includes memory module

### Task 11: Test Cross-Project Search
- Create test project A with memories
- Create test project B with different memories
- Verify project-scoped search only returns project A memories
- Verify global search returns memories from both projects
- Verify `/unipi:global-memory-list` shows project prefixes
- **Depends on:** Tasks 5, 6
- **Acceptance:** Cross-project isolation works, global search works

### Task 12: Documentation
- Update root README with memory module overview
- Create `packages/memory/README.md` with:
  - Install instructions
  - Tool reference
  - Command reference
  - Memory file format
  - Configuration
- Update `docs/conventions.md` with memory directory layout
- **Depends on:** Task 10
- **Acceptance:** Docs cover install, usage, configuration

## Acceptance Criteria

1. `pi install npm:unipi` includes memory module
2. `/unipi:memory-process "User prefers tabs over spaces"` stores memory
3. `/unipi:memory-search "tabs"` returns the stored memory
4. `/unipi:global-memory-list` shows memories with project prefixes
5. Agent automatically stores memories during compaction
6. Agent sees memory titles at session start
7. `memory_store` tool works for agent autonomous use
8. `memory_search` tool returns ranked results with snippets
9. Hybrid search (vector + fuzzy) returns better results than either alone
10. Cross-project isolation: project A memories don't appear in project B search
11. Global search works across all projects
12. Memory files are human-readable and git-trackable
13. `npx tsc --noEmit` passes for memory package

## Decision Rationale

- **SQLite + sqlite-vec:** Embedded, zero infra, proven in Node.js ecosystem via `better-sqlite3`
- **Markdown files:** Human-readable, editable, git-trackable, matches skill format
- **Two-tier:** Vector for fast semantic retrieval, markdown for browsing/editing
- **Hybrid search:** Vector alone misses exact matches, fuzzy alone misses semantic similarity
- **LLM embeddings:** No extra dependency, fallback to fuzzy ensures memory works without embeddings
- **Update-first:** Prevents memory duplication, keeps memory clean

## Assumptions

| Assumption | Status | Evidence |
|------------|--------|----------|
| `better-sqlite3` + `sqlite-vec` work together | **Verified** | sqlite-vec examples show `better-sqlite3` dependency |
| LLM can generate usable embeddings via prompt | **Unverified** | May be unreliable. Fuzzy fallback covers this. |
| SQLite WAL handles concurrent pi sessions | **Bedrock** | Well-tested for concurrent readers + single writer |
| `before_agent_start` can inject memory without bloat | **Bedrock** | Titles-only, proven pattern in `@unipi/workflow` sandbox injection |
| `session_before_compact` event available | **Verified** | Documented in pi extensions.md |
| Memory files accessible cross-project | **Bedrock** | Absolute path `~/.unipi/memory/`, no cwd dependency |

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM embeddings unreliable | Medium | Fuzzy fallback ensures memory works. Vector is enhancement, not requirement. |
| `better-sqlite3` native build fails on some platforms | Medium | Document build prerequisites. Consider WASM fallback later. |
| Memory bloat (storing too much) | Low | Agent skill teaches update-first. Consolidation is selective, not exhaustive. |
| Concurrent write conflicts | Low | SQLite WAL + retry logic. Single writer at a time. |
| sqlite-vec extension loading fails | Low | Graceful fallback to fuzzy-only search. Log warning. |

## Phased Implementation

### Phase 1: Storage Layer + Core
**Exit criteria:** Can create DB, store memory, retrieve memory, list all memories

### Phase 2: Tools + Commands
**Exit criteria:** All tools and commands registered, basic store/search/delete works

### Phase 3: Session Integration
**Exit criteria:** Memory injected at start, consolidation on compaction works

### Phase 4: Polish + Docs
**Exit criteria:** Skill written, docs complete, cross-project tested, npm publishable

## References

- Brainstorm: `docs/brainstorms/2026-04-26-unipi-memory-brainstorm.md`
- sqlite-vec: https://github.com/asg017/sqlite-vec
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- commit-memory-mcp: https://github.com/JussMor/commit-memory-mcp (sqlite-vec pattern)
- pi compaction: `@mariozechner/pi-coding-agent/docs/compaction.md`
- pi extensions: `@mariozechner/pi-coding-agent/docs/extensions.md`
- @unipi/core: `packages/core/` (events, constants, utils)
