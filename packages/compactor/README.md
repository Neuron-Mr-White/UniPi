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
| `/unipi:session-recall` | Search session history (BM25 or regex) |
| `/unipi:content-index` | Index current project into FTS5 |
| `/unipi:content-search` | Search indexed content |
| `/unipi:content-purge` | Wipe all indexed content |
| `/unipi:compact-stats` | Context savings dashboard |
| `/unipi:compact-doctor` | Run diagnostics |
| `/unipi:compact-settings` | TUI settings overlay |
| `/unipi:compact-preset <name>` | Apply quick preset |
| `/unipi:compact-help` | Show detailed documentation |

## Agent Tools

| Tool | Family | Description |
|------|--------|-------------|
| `compact` | compaction | Trigger manual compaction (dryRun: true to preview) |
| `session_recall` | session | BM25 session history search |
| `sandbox` | sandbox | Run code in sandbox (11 languages) |
| `sandbox_file` | sandbox | Execute file via FILE_CONTENT |
| `sandbox_batch` | sandbox | Atomic batch of commands + searches |
| `content_index` | content | Chunk content → FTS5 index |
| `content_search` | content | Query indexed content |
| `content_fetch` | content | Fetch URL → index |
| `compactor_stats` | compactor | Context savings dashboard |
| `compactor_doctor` | compactor | Diagnostics checklist |
| `context_budget` | compactor | Estimate remaining context window |

## Two-Tier Skills

- **Tier 1** (`compactor`): ~175 tokens, always loaded. Routing + critical rules + Ralph awareness.
- **Tier 2** (`compactor-detail`): On-demand. Full tool reference, anti-patterns, sandbox languages, FTS5 modes, workflows.

## Configuration

Config lives at `~/.unipi/config/compactor/config.json`. Per-project overrides at `<project>/.unipi/config/compactor.json`.

### Presets

| Preset | Description |
|--------|-------------|
| `precise` | Code-heavy, minimal waste — compaction: full, pipeline: 2/6 on |
| `balanced` | Daily use (default) — all strategies moderate, pipeline: all on |
| `thorough` | Debug/audit — everything on, full transcript |
| `lean` | Quick fixes — compaction only, pipeline: all off |

Apply via `/unipi:compact-preset <name>`.

### Pipeline Features

| Feature | Description | Context |
|---------|-------------|---------|
| TTL Cache | Cache with time-based expiry | On Compaction |
| Auto Injection | Inject behavioral state after compaction | On Compaction |
| MMap Pragma | Use mmap for SQLite I/O | On Compaction |
| Proximity Reranking | Rerank search results by proximity | On Search |
| Timeline Sort | Sort session events chronologically | On Search |
| Progressive Throttling | Slow down indexing for large projects | On Index |

### TUI

Tabbed settings interface (Presets / Strategies / Pipeline):
- `/` key opens search filter in Strategies tab
- Preset selection shows 3-line preview
- Per-project override checkbox (`o` key)
- Keyboard: `←→` cycle modes, `Space` toggle, `s` save, `Esc` cancel

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
