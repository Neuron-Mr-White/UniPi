# @pi-unipi/memory

Persistent memory that survives across sessions. Stores facts, preferences, and decisions with semantic vector search, so the agent remembers what you told it last week.

**Backend: [MemPalace](https://github.com/mempalace/mempalace)** — auto-installed via `uv` on first load, with verified, resumable, incremental migration of existing markdown memories. Detection, ping, and migration run off the startup path, so loading the package never blocks the first prompt.

Two storage tiers: MemPalace (or SQLite) for vector similarity search, markdown files for a durable human-readable copy you can edit by hand. Project-scoped memories stay separate per codebase, global memories are accessible everywhere.

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
~/.unipi/memory/                 # UniPi memory root (markdown tier)
├── .mempalace-install           # Cached MemPalace venv detection
├── .mempalace-migrated          # Legacy migration marker (seeds the ledger once)
├── .mempalace-ledger.json       # Record-level sync ledger (project/id -> content hash)
├── .mempalace-ping-verified     # Recent-ping cache (skips the cold-start ping)
├── global/
│   └── *.md                   # Global memory files (durable, human-readable)
└── <project_name>/
    └── *.md                   # Project memory files (durable, human-readable)

~/.mempalace/palace/             # MemPalace palace (vector backend)
```

## MemPalace backend

MemPalace is the sole vector backend; the markdown files are the durable,
human-readable tier and the migration source. On load, the memory package:
1. Detects MemPalace; if missing and `uv` is available, runs
   `uv tool install mempalace` once (caches the venv python path in
   `~/.unipi/memory/.mempalace-install`).
2. Marks the backend active immediately, then does everything else
   **off the startup path** so time-to-first-input is never blocked: a
   background task pings the bridge (skipped when recently ping-verified) and
   runs an incremental catch-up.
3. Catch-up is driven by a record-level ledger
   (`~/.unipi/memory/.mempalace-ledger.json`) mapping `project/id` to the
   sha256 of the markdown bytes last confirmed in the palace. Only records whose
   bytes differ from the ledger are upserted, so an ordinary write never
   triggers a full re-scan. `store()` updates the ledger only after a confirmed
   upsert; a pre-existing `.mempalace-migrated` marker seeds the ledger once.
   Legacy files are never deleted or mutated.

Records contended by a running MemPalace daemon's mine lock are recorded as
**deferred** (never as failures) and retried with exponential backoff, so the
catch-up always converges instead of re-running every boot. When a daemon is
reachable and actively mining, the background catch-up stands down for the
session rather than fighting the lock.

Memory operations invoke the packaged Python bridge
(`bridge/mempalace_bridge.py`); startup-path work uses the async, non-blocking
variant. Both the standalone memory package and the all-in-one umbrella tarball
ship and resolve this bridge. The first MemPalace use on a machine also
downloads the default ONNX embedding model (~80MB, cached at
`~/.cache/chroma/onnx_models/`).

### Forcing re-detection / re-migration

```bash
rm ~/.unipi/memory/.mempalace-install    # re-detect MemPalace next session
rm ~/.unipi/memory/.mempalace-ledger.json  # force a full verified catch-up pass next session
```

### Backend override

Set `UNIPI_MEMPALACE_BACKEND` to force a MemPalace backend
(`sqlite_exact`, `qdrant`, `pgvector`, default `chroma`).

### Embedder identity

MemPalace enforces embedder identity. If a palace was created with a
different embedding model, writes are rejected — the package then falls
back to SQLite for that session. Use `mempalace palace set-embedder`
intentionally to realign, then remove the install cache to re-detect.

## Dependencies

- `mempalace` (Python, auto-installed via `uv`) — primary backend
- `better-sqlite3` — SQLite fallback database
- `sqlite-vec` — Vector search extension (fallback)
- `js-yaml` — YAML frontmatter parsing
- `@pi-unipi/core` — Shared utilities

## License

MIT
