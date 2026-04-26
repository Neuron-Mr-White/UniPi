# @unipi/memory

Persistent cross-session memory with vector search for Pi coding agent.

## Features

- **Two-tier storage:** SQLite + sqlite-vec for vector search, markdown files for human-readable memory
- **Project-scoped + global memory:** Each project gets its own DB, global memories accessible cross-project
- **Hybrid search:** Vector similarity + fuzzy text matching for best recall
- **Session injection:** Agent sees memory titles at session start
- **Auto-consolidation:** Memories extracted during compaction
- **Update-first:** Prevents memory duplication

## Installation

```bash
# All-in-one (includes memory)
pi install npm:unipi

# Standalone
pi install npm:@unipi/memory
```

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store/update memory (project scope) |
| `memory_search` | Search memories (project scope) |
| `memory_delete` | Delete memory by ID or title |
| `memory_list` | List all project memories |
| `global_memory_store` | Store/update memory (global scope) |
| `global_memory_search` | Search global memories |
| `global_memory_list` | List all global memories |

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:memory-process <text>` | Analyze text and store extracted memories |
| `/unipi:memory-search <term>` | Search project memories |
| `/unipi:memory-consolidate` | Consolidate session into memory |
| `/unipi:memory-forget <title>` | Delete a memory by title |
| `/unipi:global-memory-process <text>` | Analyze text and store to global |
| `/unipi:global-memory-search <term>` | Search global memories |
| `/unipi:global-memory-list` | List all global memories |

## Memory File Format

Memories are stored as markdown with YAML frontmatter:

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

## Naming Convention

**Format:** `<most_important>_<less_important>_<lesser>`

Examples:
- `auth_jwt_prefer_refresh_tokens`
- `db_postgres_use_connection_pooling`
- `style_typescript_strict_mode_always`

## Storage Layout

```
~/.unipi/memory/
├── global/
│   ├── memory.db              # Global vector DB
│   └── *.md                   # Global memory files
└── <project_name>/
    ├── memory.db              # Project vector DB
    └── *.md                   # Project memory files
```

## Dependencies

- `better-sqlite3` - SQLite database
- `sqlite-vec` - Vector search extension
- `js-yaml` - YAML frontmatter parsing
- `@unipi/core` - Shared utilities
