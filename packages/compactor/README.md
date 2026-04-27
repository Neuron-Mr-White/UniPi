# @pi-unipi/compactor

Context engine for Pi coding agent. Fuses zero-LLM compaction, session continuity, sandbox execution, FTS5 search, and tool display optimization into a single cohesive package.

## Features

- **Zero-LLM Compaction** — 6-stage pipeline (normalize → filter → build sections → brief → format → merge) achieves 95%+ token reduction with zero API cost
- **Session Continuity** — XML resume snapshots survive compaction, preserving context across session boundaries
- **Sandbox Execution** — 11 languages with process isolation, security hardening, and output capping
- **FTS5 Search** — Full-text search over indexed content with auto-chunking
- **Tool Display** — Mode-aware rendering for read, grep, find, ls, bash, edit, write tools

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:compact` | Manual compaction with stats |
| `/unipi:compact-recall` | Search session history |
| `/unipi:compact-stats` | Context savings dashboard |
| `/unipi:compact-doctor` | Run diagnostics |
| `/unipi:compact-settings` | TUI settings overlay |
| `/unipi:compact-preset <name>` | Apply quick preset |
| `/unipi:compact-index` | Index current project |
| `/unipi:compact-search` | Search indexed content |
| `/unipi:compact-purge` | Wipe all indexed content |

## Tools

| Tool | Description |
|------|-------------|
| `compact` | Trigger manual compaction |
| `vcc_recall` | BM25 session history search |
| `ctx_execute` | Run code, stdout enters context |
| `ctx_execute_file` | Process file via FILE_CONTENT |
| `ctx_batch_execute` | Atomic batch of commands + searches |
| `ctx_index` | Chunk content → FTS5 index |
| `ctx_search` | Query indexed content |
| `ctx_fetch_and_index` | Fetch URL → index |
| `ctx_stats` | Context savings dashboard |
| `ctx_doctor` | Diagnostics checklist |

## Configuration

Config lives at `~/.unipi/config/compactor/config.json`. Each of the 9 strategies can be toggled on/off and cycled through modes.

### Presets

| Preset | Description |
|--------|-------------|
| `opencode` | Maximal context preservation, minimal display |
| `balanced` | Moderate across all strategies |
| `verbose` | Everything visible, everything tracked |
| `minimal` | Only compaction + basic recall |

Apply via `/unipi:compact-preset <name>`.

## Architecture

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Compaction Core │  │ Session Engine  │  │ Display Engine  │
│ (zero-LLM)      │  │ (SQLite + XML)  │  │ (mode-aware)    │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
                    ┌─────────────────────┐
                    │   Config Manager    │
                    └─────────────────────┘
```

## Installation

Included in `@pi-unipi/unipi` metapackage. To use standalone:

```json
{
  "pi": {
    "extensions": ["node_modules/@pi-unipi/compactor/src/index.ts"]
  }
}
```

## License

MIT
