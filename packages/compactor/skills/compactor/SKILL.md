---
name: compactor
description: Session recall and compaction — use when earlier parts of this session are missing from context, or after a compaction summary.
---

# Compactor

Compaction is automatic: when the context fills, it is replaced by a summary and the work carries on. Keep working through it.

## After a compaction

The summary opens with **Active Work** (the goal, ralph loop or kanboard task in flight) — treat it as authoritative and continue that work. Then come the user's requests, the latest state, decisions, files, commits and open errors.

## Recall

The full session history is kept. Reach for `session_recall` whenever a detail is missing:

- `session_recall(query: "redis cache decision")` — plain keywords work best.
- `#123`-style refs in the summary are entry indices: `session_recall(expand: [123])` returns the full content.
- `mode: "touched"` lists the files worked on; `scope: "all"` also covers edited or retried turns.

`context_budget` reports how full the context is.
