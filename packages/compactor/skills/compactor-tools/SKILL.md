---
name: compactor-tools
description: Reference card for all compactor tools — parameters, usage, examples.
---

# Compactor Tools Reference

## compact

Trigger manual context compaction.

```
compact()
```

- Returns compaction stats (summarized, kept, tokens estimated)
- Actual work done by `session_before_compact` hook
- Zero LLM calls — pure regex/text processing

## vcc_recall

Search session history using BM25 or regex.

```
vcc_recall(query: string, mode?: "bm25" | "regex", limit?: number, offset?: number, expand?: boolean)
```

- **query**: Search terms
- **mode**: `bm25` (default, ranked) or `regex` (pattern match)
- **limit**: Max results (default 10)
- **offset**: Pagination offset
- **expand**: Return full message content for hits

## ctx_execute

Run code in a sandboxed environment.

```
ctx_execute(language: string, code: string, timeout?: number)
```

**Supported languages:** javascript, typescript, python, shell, ruby, go, rust, php, perl, r, elixir

- Only stdout enters context (stderr filtered)
- 100MB output cap with process kill
- 30s default timeout
- Auto-detects Bun for JS/TS

## ctx_execute_file

Execute a file with content injected as `FILE_CONTENT`.

```
ctx_execute_file(language: string, path: string, timeout?: number)
```

## ctx_batch_execute

Run multiple commands atomically.

```
ctx_batch_execute(items: Array<ExecuteItem | SearchItem>)
```

- Execute items: `{ type: "execute", language, code, timeout? }`
- Search items: `{ type: "search", query, limit? }`

## ctx_index

Index content into FTS5 for fast search.

```
ctx_index(label: string, content?: string, filePath?: string, contentType?: "markdown"|"json"|"plain", chunkSize?: number)
```

- Provide either `content` or `filePath`
- Auto-chunks by content type
- Deduplicates by label

## ctx_search

Query indexed content.

```
ctx_search(query: string, limit?: number, offset?: number)
```

- Returns ranked results with title, content, source, rank
- Supports pagination via offset/limit

## ctx_fetch_and_index

Fetch URL → markdown → index.

```
ctx_fetch_and_index(url: string, label?: string, chunkSize?: number)
```

- Converts HTML to markdown
- Auto-indexes for later search

## ctx_stats

Context savings dashboard.

```
ctx_stats()
```

Returns: session events, compactions, tokens saved, indexed docs, sandbox runs, search queries.

## ctx_doctor

Diagnostics checklist.

```
ctx_doctor()
```

Checks: config file, session DB, content store, runtimes (node, python3, bash).
