# @pi-unipi/memory

Persistent memory that survives across sessions. Stores facts, preferences, and decisions in SQLite with vector search, so the agent remembers what you told it last week.

Two storage tiers: SQLite + sqlite-vec for vector similarity search, markdown files for human-readable memories you can edit by hand. Project-scoped memories stay separate per codebase, global memories are accessible everywhere.

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

## Special Triggers

At session start, the agent sees memory titles injected into context. This gives it a summary of what it should remember without loading full memory content.

During compaction (if `@pi-unipi/compactor` is installed), memories are auto-extracted from the conversation. The `memory-consolidate` command also triggers this manually.

Memory registers with the info-screen dashboard, showing project memory count, total count, and consolidation count. The footer subscribes to `MEMORY_STORED`, `MEMORY_DELETED`, and `MEMORYCONSOLIDATED` events to display memory stats.

## Agent Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `memory_store` | Project | Store or update a memory |
| `memory_search` | Project | Search memories by query |
| `memory_delete` | Project | Delete memory by ID or title |
| `memory_list` | Project | List all project memories |
| `global_memory_store` | Global | Store or update global memory |
| `global_memory_search` | Global | Search global memories |
| `global_memory_list` | Global | List all global memories |

The agent uses `memory_store` when it learns something worth remembering — a user preference, a technical decision, a code pattern. `memory_search` is used to recall relevant context before answering questions.

## Memory Format

Memories are markdown files with YAML frontmatter:

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

### Naming Convention

Format: `<most_important>_<less_important>_<lesser>`

Examples:
- `auth_jwt_prefer_refresh_tokens`
- `db_postgres_use_connection_pooling`
- `style_typescript_strict_mode_always`

## Configurables

Memory has no configuration file. Storage paths are fixed:

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

- `better-sqlite3` — SQLite database
- `sqlite-vec` — Vector search extension
- `js-yaml` — YAML frontmatter parsing
- `@pi-unipi/core` — Shared utilities

## License

MIT
