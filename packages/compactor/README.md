# @pi-unipi/compactor

Context engine that keeps sessions lean. Compacts conversations, indexes code, searches history, and runs sandboxed code — all without burning LLM tokens on compaction.

The zero-LLM pipeline compresses context through 6 stages (normalize, filter, build sections, brief, format, merge) to hit 95%+ token reduction at zero API cost. Session continuity preserves context across compaction boundaries with XML resume snapshots.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:lossless-compact` | Immediate zero-LLM compaction with structured summary |
| `/unipi:session-recall` | Search session history (BM25 or regex) |
| `/unipi:content-index` | Index current project into FTS5 |
| `/unipi:content-search` | Search indexed content |
| `/unipi:content-purge` | Wipe all indexed content |
| `/unipi:compact-stats` | Context savings dashboard |
| `/unipi:compact-doctor` | Run diagnostics |
| `/unipi:compact-settings` | TUI settings overlay |
| `/unipi:compact-preset <name>` | Apply quick preset |
| `/unipi:compact-help` | Show detailed documentation |

> **Note:** `/unipi:compact` still works as a deprecated alias for `/unipi:lossless-compact`.

## Special Triggers

Compactor tools are available to the main agent when installed. All workflow skills can use compactor tools for context management.

UniPi can also trigger zero-LLM compaction at a configured context percentage. This extension-managed trigger is disabled by default and is separate from Pi core's `compaction.reserveTokens` behavior: Pi still keeps its own overflow safety net, while UniPi can compact earlier on very large context-window models.

Compactor registers with the info-screen dashboard, showing compaction count, tokens saved, compression ratio, and indexed documents. The footer subscribes to `COMPACTOR_STATSUPDATED` events to display compaction stats in the status bar.

## Agent Tools

| Tool | Family | Description |
|------|--------|-------------|
| `compact` | compaction | Trigger manual compaction (dryRun: true to preview) |
| `session_recall` | session | BM25 session history search |
| `sandbox` | sandbox | Run code in sandbox (11 languages) |
| `sandbox_file` | sandbox | Execute file via FILE_CONTENT |
| `sandbox_batch` | sandbox | Atomic batch of commands + searches |
| `content_index` | content | Chunk content to FTS5 index |
| `content_search` | content | Query indexed content |
| `content_fetch` | content | Fetch URL and index |
| `compactor_stats` | compactor | Context savings dashboard |
| `compactor_doctor` | compactor | Diagnostics checklist |
| `context_budget` | compactor | Estimate remaining context window |

## Two-Tier Skills

- **Tier 1** (`compactor`): ~175 tokens, always loaded. Routing and critical rules.
- **Tier 2** (`compactor-detail`): On-demand. Full tool reference, anti-patterns, sandbox languages, FTS5 modes, workflows.

## Configurables

Config lives at `~/.unipi/config/compactor/config.json`. Per-project overrides at `<project>/.unipi/config/compactor.json`.

### Presets

| Preset | Description |
|--------|-------------|
| `precise` | Code-heavy, minimal waste — compaction: full, pipeline: 2/6 on |
| `balanced` | Daily use (default) — all strategies moderate, pipeline: all on |
| `thorough` | Debug/audit — everything on, full transcript |
| `lean` | Quick fixes — compaction only, pipeline: all off |

Apply via `/unipi:compact-preset <name>`.

### Percentage Auto-Compaction

Disabled by default for backward compatibility. Enable it globally in `~/.unipi/config/compactor/config.json`, per project in `<project>/.unipi/config/compactor.json`, or through `/unipi:compact-settings` → Auto.

```json
{
  "autoCompaction": {
    "enabled": true,
    "thresholdPercent": 80,
    "cooldownMs": 60000,
    "repeatMinGrowthTokens": 4000,
    "notify": true
  }
}
```

- `thresholdPercent` uses Pi's live `ctx.getContextUsage()` percentage (0-100).
- `cooldownMs` prevents rapid repeated compaction attempts.
- `repeatMinGrowthTokens` allows long sessions to compact again later while avoiding immediate loops if usage remains above the threshold after compaction.
- `notify` controls user-visible notifications for UniPi-triggered compactions.

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

Tabbed settings interface (Presets / Strategies / Auto / Pipeline):
- `/` key opens search filter in Strategies tab
- Preset selection shows 3-line preview
- Per-project override checkbox (`o` key)
- Keyboard: left/right cycle modes, Space toggle, `s` save, Esc cancel

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

## License

MIT
