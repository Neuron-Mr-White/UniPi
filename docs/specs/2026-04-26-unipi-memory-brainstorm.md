---
title: "Unipi Memory — Persistent Cross-Session Memory with Vector Search"
type: brainstorm
date: 2026-04-26
participants: [user, MiMo]
related:
  - docs/brainstorms/2026-04-26-unipi-architecture-brainstorm.md
  - docs/plans/2026-04-26-feat-unipi-phase1-plan.md
  - @unipi/core (events, constants, utils)
---

# Unipi Memory — Persistent Cross-Session Memory with Vector Search

## Problem Statement

Agent forgets everything between sessions. User preferences, project decisions, coding style, architectural patterns — all lost on restart. Agent repeats questions, re-discovers patterns, wastes context on rediscovery.

Two distinct problems:
1. **Recall** — "What did we decide about auth?" (semantic search across past sessions)
2. **Identity** — "This user prefers TypeScript, uses tabs, likes functional style" (persistent profile)

Additionally, conversation summaries from compaction are ephemeral — they exist only in the session file and vanish when context is compacted again. Memory should capture and preserve these insights long-term.

## Context

**Existing patterns:**
- Pi compaction generates structured summaries (Goal/Progress/Decisions/Next Steps) but they're session-scoped, not cross-session
- `context_tag`/`context_checkout` manage in-session context but don't persist across sessions
- `@unipi/core` provides event bus for module discovery, shared constants, utilities
- `sqlite-vec` (npm, v0.1.9) — native SQLite vector extension, zero infra, MIT/Apache
- `better-sqlite3` (npm, v12.9.0) — fast native SQLite binding for Node.js
- Skills use frontmatter + markdown — human-readable, machine-parseable

**Constraints:**
- Must work offline (embedded DB, no remote services)
- Must not add startup latency (lazy init)
- Must be cross-platform (macOS, Linux, Windows via Node.js native)
- Must degrade gracefully if sqlite-vec/better-sqlite3 unavailable (markdown-only fallback)

## Chosen Approach

**Two-tier storage:** SQLite + sqlite-vec for vector search, markdown files for human-readable memory. Both tiers stay in sync. Vector DB provides fast semantic retrieval; markdown provides browsable, editable, version-controllable memory.

## Why This Approach

- **SQLite + sqlite-vec:** Embedded, zero infra, proven by commit-memory-mcp and ageflow/learning-sqlite in same ecosystem
- **Markdown files:** Human-readable, editable, git-trackable, matches skill format agent already understands
- **Two-tier:** Best of both — vector search for recall, markdown for browsing/editing
- **Lazy init:** DB opened on first tool call, not at session start

**Alternatives rejected:**
- **Markdown-only (no vector):** No semantic search, agent must read all files to find relevant memory
- **Vector-only (no markdown):** Not human-readable, can't git-track, can't manually edit
- **LanceDB:** Heavier dependency, Rust native, less Node.js ecosystem maturity than sqlite-vec
- **ChromaDB:** Python-based, requires server or heavy WASM, overkill for embedded use

## Key Design Decisions

### Q1: Storage Layout — RESOLVED

**Decision:** Two parallel stores with sync

```
~/.unipi/memory/
├── global/
│   ├── memory.db              # Global vector DB (all projects)
│   └── *.md                   # Global memory files
└── <project_name>/
    ├── memory.db              # Project vector DB
    └── *.md                   # Project memory files
```

**Project name derivation:** `sanitize(cwd)` — replace non-alphanumeric with `_`, collapse repeats. Same as `@unipi/core` sanitize function.

**Rationale:** Project isolation (different projects don't pollute each's vector space), global cross-project search via `global_list_memory`, human files alongside DB.

### Q2: Memory File Format — RESOLVED

**Decision:** Skill-like markdown with YAML frontmatter

```markdown
---
title: auth_jwt_prefer_refresh_tokens
tags: [auth, jwt, preferences]
project: my-app
created: 2026-04-26T10:00:00Z
updated: 2026-04-26T15:30:00Z
type: preference | decision | pattern | summary
---

# Auth: Prefer Refresh Tokens

User prefers short-lived access tokens (15min) with long-lived refresh tokens (30d).
Always implement token rotation on refresh.

## Context
Set during auth module implementation on 2026-04-26.
User explicitly said "I hate long-lived tokens, they feel insecure."
```

**Naming convention:** `<most_important>_<less_important>_<lesser>` — matches vector title and filename. Examples:
- `auth_jwt_prefer_refresh_tokens`
- `db_postgres_use_connection_pooling`
- `style_typescript_strict_mode_always`
- `arch_api_versioning_v2_breaking`

**Rationale:** Agent understands skill format. Frontmatter provides metadata for filtering. Title naming makes vector search results instantly meaningful.

### Q3: Vector Schema — RESOLVED

**Decision:** Single `memories` table per DB

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,            -- JSON array
  project TEXT,
  type TEXT,            -- preference | decision | pattern | summary
  created TEXT,
  updated TEXT,
  embedding BLOB       -- sqlite-vec vector
);

-- Virtual table for vector search
CREATE VIRTUAL TABLE memories_vec USING vec0(
  embedding float[384]  -- or appropriate dimension
);
```

**Embedding model:** Use pi's existing LLM to generate embeddings via a simple prompt, or use a lightweight local model. If neither available, fall back to fuzzy text search on title+content.

**Rationale:** Simple schema, one table per scope, sqlite-vec handles vector similarity. Tags stored as JSON array for filtering.

### Q4: Injection at Session Start — RESOLVED

**Decision:** `before_agent_start` event injects titles-only memory list

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

**Rationale:** Titles only keeps context lean. Agent decides what to retrieve based on task. Global memories show project name prefix for cross-project discovery.

### Q5: Consolidation Trigger — RESOLVED

**Decision:** Auto on compaction + manual `/unipi:memory-consolidate`

**Auto-consolidation flow:**
1. Listen to `session_before_compact` event
2. Extract compaction summary (Goal/Progress/Decisions/Next Steps)
3. Use LLM to identify extractable memory items from summary
4. Update existing matching memories or create new ones
5. Return compaction summary unchanged (don't add to context)

**Manual consolidation:** `/unipi:memory-consolidate` — agent reviews current session, extracts memories, stores them.

**Rationale:** Auto-consolidation captures insights at the moment they're most fresh. Manual allows explicit memory curation.

### Q6: Memory Process Command — RESOLVED

**Decision:** `/unipi:memory-process <text>` — agent analyzes text, extracts memory items, stores/updates

**Agent behavior:**
1. Read the text provided
2. Identify memory-worthy items (preferences, decisions, patterns, summaries)
3. For each item:
   a. Check if similar memory exists (vector search + title match)
   b. If exists and relevant → update (merge new info, bump `updated` timestamp)
   c. If no match → create new memory file + vector entry
4. Report what was stored/updated

**Rationale:** Agent does the intelligence work (what's worth remembering), tools handle storage. Update-first prevents memory duplication.

### Q7: Memory Search — RESOLVED

**Decision:** Hybrid search — vector similarity + fuzzy text matching

**`/unipi:memory-search <term>`:**
1. Vector search: embed term, find top-5 similar memories
2. Fuzzy search: match term against titles and content (case-insensitive substring)
3. Merge results, deduplicate, rank by combined score
4. Return titles with snippets

**`/unipi:global-memory-search <term>`:**
1. Search across all project DBs + global DB
2. Return results with `[project_name]` prefix

**Rationale:** Vector alone misses exact title matches. Fuzzy alone misses semantic similarity. Combined gives best recall.

### Q8: Tools vs Commands — RESOLVED

**Decision:** Both tools and commands

| Interface | Purpose |
|-----------|---------|
| `memory_store` tool | Agent calls directly to save memory (from any context) |
| `memory_search` tool | Agent calls directly to retrieve memory |
| `/unipi:memory-process <text>` | Command that triggers agent analysis + store |
| `/unipi:memory-search <term>` | Command for manual search |
| `/unipi:memory-consolidate` | Command to consolidate session into memory |
| `/unipi:global-memory-process <text>` | Global scope store |
| `/unipi:global-memory-search <term>` | Global scope search |
| `/unipi:global-memory-list` | List all global memories with project prefixes |

**Rationale:** Tools for autonomous agent use (agent decides when to store/retrieve). Commands for user-initiated actions. Both use same underlying storage.

### Q9: Embedding Strategy — RESOLVED

**Decision:** Lazy embedding with fallback

**Primary:** Use pi's active LLM to generate embeddings via a dedicated embedding prompt:
```
Embed the following text as a dense vector for similarity search.
Return ONLY a JSON array of 384 floats, no other text.
Text: {text}
```

**Fallback:** If LLM embedding fails or is unavailable, use BM25-style fuzzy search on title + content only. Vector column remains NULL.

**Rationale:** No extra dependency for embedding model. LLM already available. Fuzzy fallback ensures memory still works without embeddings.

### Q10: Memory Skill — RESOLVED

**Decision:** `@unipi/memory/skills/memory/SKILL.md` — tells agent how to use memory tools

**Content:** When to store, when to search, naming conventions, how consolidation works, how to read memory files.

**Rationale:** Agent needs instructions on memory management best practices. Skill format matches existing pattern.

## Subjective Contract

- **Target outcome:** Agent feels like it "remembers" — brings up relevant past decisions without being asked, stores insights automatically, never loses important context
- **Anti-goals:** Memory bloat (storing everything), latency on startup, complex setup, requiring external services
- **References:** commit-memory-mcp (sqlite-vec pattern), ageflow/learning-sqlite (sqlite-vec storage), pi compaction (summary format)
- **Anti-references:** ChromaDB (too heavy), in-memory only (not persistent), cloud-vector-only (requires internet)

## Open Questions

1. **Embedding dimension:** 384 is common for small models. What dimension works best with LLM-generated embeddings? May need to test.
2. **Memory size limits:** How large can a single memory file get before it should be split? Default: 10KB per file, 1000 memories per project DB.
3. **Global vs project scope for auto-consolidation:** Should auto-consolidation always write to project scope, or sometimes to global (for user preferences that apply everywhere)?
4. **Concurrent access:** Multiple pi sessions on same project? sqlite-vec handles WAL mode, but need to test.
5. **Memory deletion:** How does agent delete outdated memories? Need a `memory_delete` tool or `/unipi:memory-forget` command.

## Out of Scope

- Remote/vector cloud services (Pinecone, Weaviate Cloud)
- Real-time embedding model (all embeddings via LLM prompt)
- Memory sharing between users (single-user only)
- Memory UI/TUI components (all CLI/tool based)
- Modifying pi core for memory integration

## Next Steps

1. `/plan` to create implementation plan for `@unipi/memory`
2. Scaffold `packages/memory/` with package.json, index.ts, tools.ts, commands.ts
3. Implement storage layer (sqlite-vec + markdown sync)
4. Implement tools (memory_store, memory_search, memory_delete)
5. Implement commands (process, search, consolidate, global variants)
6. Implement session_start injection (titles only)
7. Implement compaction hook (auto-consolidation)
8. Write SKILL.md for memory management
9. Test cross-project search
10. Publish `@unipi/memory` to npm
