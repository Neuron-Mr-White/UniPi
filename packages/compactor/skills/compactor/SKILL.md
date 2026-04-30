---
name: compactor
description: Context management — compact session, recall history, run code, search content.
---

# Compactor — Context Management

## When Context Is Tight
- `compact` → free tokens (zero-LLM, 98%+ reduction). Compact BEFORE complex work.
- `compactor_stats` → check savings. `compactor_doctor` → diagnose.

## Finding Past Work
- `session_recall(query)` → search this session (BM25 or regex).
- `content_search(query)` → search indexed files/docs.
  → Index first: `content_index` or `content_fetch(url)`.

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
