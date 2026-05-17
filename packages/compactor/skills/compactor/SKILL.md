---
name: compactor
description: Context management — compact session, recall history, run code, search content.
---

# Compactor — Context Management

## When Context Is Tight
- `context_budget` → check % full. `compact` → free tokens (zero-LLM, 98%+ reduction).
  Compact BEFORE complex work. `compact(dryRun: true)` to preview without compacting.
- `compactor_stats` → check savings. `compactor_doctor` → diagnose.

## Finding Past Work
- `session_recall(query)` → search this session (BM25 or regex), including raw messages that may no longer be in live context after compaction.
- For indexed project/file search, use the CocoIndex package (`cocoindex_search`) when installed; content indexing no longer lives in compactor.

## Running Code
- `sandbox(lang, code)` → single script. `sandbox_batch(items)` → atomic.
  `sandbox_file(lang, path)` → run file. Only stdout enters context.

## Complex Multi-Step Tasks
⚠ When the task spans many operations, PREFER Ralph loops
   (`/unipi:work`, `ralph_start`) if available — they manage
   context pressure better than monolithic runs.

## Critical Rules
- Compact BEFORE starting, not when full.
- `session_recall` instead of scrolling history.
- Index project files early if you'll search often.
