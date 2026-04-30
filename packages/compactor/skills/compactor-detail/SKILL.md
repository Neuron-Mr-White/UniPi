---
name: compactor-detail
description: Full compactor reference — tool parameters, anti-patterns, sandbox languages, FTS5 modes, workflows.
---

# Compactor — Full Reference

## Tool Parameter Reference

### compact
```
compact()
```
Trigger manual context compaction. Zero LLM — pure regex/text processing.
Returns stats after next `session_compact` event.

### session_recall
```
session_recall(query: string, mode?: "bm25" | "regex", limit?: number, offset?: number, expand?: boolean)
```
Search session history. BM25 is default (TF-IDF ranked). Regex is fallback.

### sandbox
```
sandbox(language: string, code: string, timeout?: number)
```
Run code in sandboxed env. Only stdout enters context. 100MB output cap. 30s default timeout.

### sandbox_file
```
sandbox_file(language: string, path: string, timeout?: number)
```
Execute file. Content injected as `FILE_CONTENT` variable.

### sandbox_batch
```
sandbox_batch(items: Array<{type: "execute", language, code} | {type: "search", query}>)
```
Atomic batch — all items run, results returned together.

### content_index
```
content_index(label: string, content?: string, filePath?: string, contentType?: "markdown"|"json"|"plain", chunkSize?: number)
```
Index content into FTS5. Provide either `content` or `filePath`. Auto-chunks by type.

### content_search
```
content_search(query: string, limit?: number, offset?: number)
```
Search FTS5 index. Returns ranked results with title, content, source, rank.

### content_fetch
```
content_fetch(url: string, label?: string, chunkSize?: number)
```
Fetch URL → markdown → index. Auto-indexes for later search.

### compactor_stats
```
compactor_stats()
```
Dashboard: session events, compactions, tokens saved, indexed docs, sandbox runs, search queries.

### compactor_doctor
```
compactor_doctor()
```
Diagnostics: config file, session DB, content store, runtimes (node, python3, bash).

### context_budget
```
context_budget()
```
Estimate remaining context tokens and % full. Returns guidance on whether to compact.

## Sandbox Language Reference

| Language | Binaries | Timeout | Notes |
|----------|----------|---------|-------|
| javascript | Bun/node | 30s | Default: Bun if available |
| typescript | Bun/node | 30s | Compiled via Bun transform |
| python | python3 | 30s | - |
| shell | bash | 30s | Pipelines supported |
| ruby | ruby | 30s | - |
| go | go | 30s | go run |
| rust | rustc+cargo | 30s | cargo script or rustc |
| php | php | 30s | - |
| perl | perl | 30s | - |
| r | Rscript | 30s | - |
| elixir | elixir | 30s | - |

## FTS5 Search Modes

| Mode | When To Use |
|------|-------------|
| **porter** | Exact term matching with stemming |
| **trigram** | Fuzzy/spelling errors, partial matches |
| **rrf** | Best overall (Reciprocal Rank Fusion of porter+trigram) |
| **fuzzy** | Auto-correction of misspellings from vocabulary |

Default: `rrf` (best general-purpose).

## Anti-Patterns

1. **Don't call `compact` in a tight loop.** It triggers the full compaction pipeline. Call once before complex work.
2. **Don't search without indexing.** `content_search` has nothing to search until you `content_index` or `content_fetch`.
3. **Don't use `sandbox` for file ops.** Use bash instead. Sandbox is for computation.
4. **Don't use `session_recall` with empty query.** It needs meaningful search terms.
5. **Don't index node_modules.** Stick to source files and documentation.
6. **Don't compact mid-task.** Wait for a natural break point.

## Workflow Patterns

### Research → Index → Search → Test
1. `content_fetch(url)` — index reference docs
2. `content_search(query)` — find relevant sections
3. `sandbox(lang, code)` — test hypotheses

### Diagnose → Fix → Verify
1. `compactor_doctor` — check system health
2. Fix issues (install runtimes, rebuild index)
3. `compactor_stats` — verify metrics

### Before Complex Work
1. `compact` — free up context
2. `content_index` — index relevant files
3. `session_recall("goals")` — load context

### After Long Session
1. `compactor_stats` — check savings
2. `compact` — compact if needed
3. `session_recall(topic)` — verify recall quality
