---
name: compactor-detail
description: Full compactor reference — tool parameters, anti-patterns, sandbox languages, context budget, workflows.
---

# Compactor — Full Reference

## Tool Parameter Reference

### compact
```
compact(dryRun?: boolean)
```
Agent-facing compaction request. Use `dryRun: true` to preview estimated message reduction without compacting.

For user-triggered immediate compaction, prefer the slash command `/unipi:lossless-compact`.

### session_recall
```
session_recall(query: string, mode?: "bm25" | "regex", limit?: number, offset?: number, expand?: boolean)
```
Search current session history. BM25 is default; regex is fallback. The recall path prefers Pi's append-only session branch so it can find messages that are no longer present in live LLM context after compaction.

Deprecated alias: `vcc_recall`.

### sandbox
```
sandbox(language: string, code: string, timeout?: number)
```
Run code in a sandboxed environment. Only stdout enters context. 100MB output cap. 30s default timeout.

Deprecated alias: `ctx_execute`.

### sandbox_file
```
sandbox_file(language: string, path: string, timeout?: number)
```
Execute a file. File content is injected as `FILE_CONTENT`.

Deprecated alias: `ctx_execute_file`.

### sandbox_batch
```
sandbox_batch(items: Array<{ type: "execute", language: string, code: string, timeout?: number }>)
```
Run multiple sandbox executions and return a single combined result.

Deprecated alias: `ctx_batch_execute`.

### compactor_stats
```
compactor_stats()
```
Dashboard: session events, compactions, tokens saved, compression ratio, sandbox runs, and search queries.

Deprecated alias: `ctx_stats`.

### compactor_doctor
```
compactor_doctor()
```
Diagnostics: config file, session DB, and available runtimes (node, python3, bash).

Deprecated alias: `ctx_doctor`.

### context_budget
```
context_budget()
```
Estimate remaining context tokens and percent full. Uses Pi's live context usage when available and includes percentage auto-compaction guidance when enabled.

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

## Anti-Patterns

1. **Don't compact in a tight loop.** Use `context_budget` first and compact at natural break points.
2. **Don't use `session_recall` for project-wide code search.** It searches the conversation/session. Use CocoIndex (`cocoindex_search`) for indexed files when installed.
3. **Don't use `sandbox` for file operations.** Use normal file tools for reads/writes; sandbox is for computation or quick scripts.
4. **Don't use empty or vague recall queries.** Search for specific filenames, issue numbers, commands, or decisions.
5. **Don't compact mid-thought if avoidable.** Finish the current step, then compact.

## Workflow Patterns

### Before Complex Work
1. `context_budget` — check pressure.
2. `session_recall("goal files decisions")` — recover relevant prior context.
3. `compact(dryRun: true)` — preview if context is tight.
4. `/unipi:lossless-compact` or `compact` at a clean boundary.

### Diagnose Compactor Health
1. `compactor_doctor` — check config, DB, runtimes.
2. Fix reported issues.
3. `compactor_stats` — verify counters and savings.

### Long Session Recovery
1. `session_recall(query)` — find older details hidden by compaction.
2. `context_budget` — decide whether another compaction is needed.
3. `compactor_stats` — confirm compactions/savings are recorded.

### Project Search
Compactor no longer owns project content indexing. Use the CocoIndex package if installed:
1. `/unipi:cocoindex-init`
2. `/unipi:cocoindex-update`
3. `cocoindex_search(query)`
