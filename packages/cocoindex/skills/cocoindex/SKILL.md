---
name: cocoindex
description: "CocoIndex content indexing and search — use when you need to search indexed project content or trigger re-indexing"
---

# CocoIndex Skill

## When to Use CocoIndex

Use CocoIndex tools and commands when you need to:

1. **Search indexed project content** — use `cocoindex_search` instead of `content_search` or `ctx_search`
2. **Trigger re-indexing** — use `/unipi:cocoindex-update` after significant code changes
3. **Initialize indexing** — use `/unipi:cocoindex-init` for new projects

## Key Differences from Old FTS5 Content Store

| Aspect | Old (FTS5) | New (CocoIndex) |
|--------|-----------|-----------------|
| Chunking | Heading/paragraph split | AST-aware code, recursive text |
| Search | BM25 + trigram fuzzy | Semantic vector + full-text |
| Incremental | Full re-index every time | Delta-only (changed files) |
| Scale | Small corpus | Multi-GiB, parallel |
| Store | SQLite FTS5 | LanceDB |

## Tools

### `cocoindex_search`
Search indexed content. It uses semantic vector search when the LanceDB table has vectors, LanceDB full-text search when an inverted index exists, and a lexical fallback for older text-only indexes.

```
cocoindex_search({ query: "how authentication works", limit: 10 })
```

Returns results with `title`, `content`, `source`, `rank`, `contentType`, and `matchLayer`.

### `cocoindex_status`
Check indexing status — pipeline configured, last run, doc count, CLI availability.

```
cocoindex_status({})
```

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:cocoindex-update` | Run `cocoindex update` on current project |
| `/unipi:cocoindex-status` | Show indexing status |
| `/unipi:cocoindex-init` | Scaffold a default pipeline |
| `/unipi:cocoindex-search <query>` | Search indexed codebase semantically |
| `/unipi:cocoindex-settings` | Show configuration |

## Prerequisites

1. **Python 3.10+** with `cocoindex` installed:
   ```bash
   pip install cocoindex
   pip install 'cocoindex[lancedb]'
   ```

2. **Pipeline initialized** — run `/unipi:cocoindex-init` once per project

3. **Embedding config** — CocoIndex reuses the memory package's embedding settings:
   - API key from `~/.unipi/memory/config.json`
   - Same model and dimensions for cross-system search

## Architecture

```
Project files → LocalFile source → SplitRecursively → EmbedText → LanceDB
                                                                              ↓
Agent query ──────────────────────────────→ vector search → ranked results
```

- Pipeline defined in `.unipi/cocoindex/main.py` (auto-generated, customizable)
- Data stored in `.unipi/cocoindex/.lancedb/`
- Search queries LanceDB directly via Node.js SDK (no CLI round-trip)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "CLI not found" | `pip install cocoindex` |
| "Pipeline not initialized" | `/unipi:cocoindex-init` |
| "Search unavailable" | `npm install @lancedb/lancedb` |
| "No results" | Run `/unipi:cocoindex-update` first |
| Embedding errors | Check `~/.unipi/memory/config.json` API key |
