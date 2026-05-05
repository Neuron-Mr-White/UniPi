# @pi-unipi/cocoindex

CocoIndex integration for Pi coding agent — AST-aware content indexing, semantic vector search, and incremental pipeline management.

## Overview

Replaces the compactor's FTS5-based content indexing with [CocoIndex](https://cocoindex.io/), providing:

- **AST-aware code chunking** — language-aware splitting for code files
- **Semantic vector search** — find content by meaning, not just keywords
- **Incremental indexing** — only reprocesses changed files (delta-only)
- **LanceDB storage** — zero-config, local file-based vector database
- **Shared embeddings** — reuses memory package's OpenRouter API key and model

## Prerequisites

1. **Python 3.10+**
2. **CocoIndex CLI**: `pip install cocoindex 'cocoindex[lancedb]'` (requires cocoindex >= 1.0)
3. **LanceDB SDK** (optional, for search): `npm install @lancedb/lancedb`
4. **Embedding API key** — configured via `/unipi:memory-settings`

## Quick Start

```
# 1. Initialize the pipeline (once per project)
/unipi:cocoindex-init

# 2. Index the project
/unipi:cocoindex-update

# 3. Search indexed content
cocoindex_search({ query: "how does authentication work?" })
```

## Architecture

```
Project files ──→ localfs.walk_dir (recursive)
                      │
                      ▼
              chunk_text (@coco.fn, memoized)
                      │
                      ▼
              LanceDB target (via ContextKey)
                      │
                      ▼
              Vector search → ranked results
```

Uses cocoindex v1.0+ App/fn/mount API with:
- `@coco.lifespan` for async environment setup (LanceDB connection)
- `@coco.fn` for memoized processing functions
- `coco.mount()` / `coco.mount_target()` for component management
- `localfs.walk_dir` for file enumeration
- `lancedb.TableTarget` for row-level target state management

## Tools

| Tool | Description |
|------|-------------|
| `cocoindex_search` | Search indexed content (semantic + full-text) |
| `cocoindex_status` | Check indexing status, freshness, doc count |

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:cocoindex-update` | Run incremental indexing |
| `/unipi:cocoindex-status` | Show pipeline status |
| `/unipi:cocoindex-init` | Scaffold default pipeline |
| `/unipi:cocoindex-settings` | View configuration |

## Configuration

- **Pipeline**: `.unipi/cocoindex/main.py` — auto-generated, fully customizable
- **Data store**: `.unipi/cocoindex/.lancedb/`
- **Embeddings**: `~/.unipi/memory/config.json` (shared with memory package)

## What Changed from FTS5

This package replaces compactor's content indexing subsystem:

| Feature | Before (FTS5) | After (CocoIndex) |
|---------|---------------|-------------------|
| Chunking | Heading/paragraph | AST-aware recursive |
| Search | BM25 + trigram | Vector + full-text |
| Incremental | No (full re-index) | Yes (delta-only) |
| Storage | SQLite FTS5 | LanceDB |

## Status

⚠️ **Experimental** — This is an `experiment/cocoindex` branch feature. Not yet merged to main.
