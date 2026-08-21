---
name: compactor-stats
description: Stats display — context savings, session metrics, compactions, sandbox and recall/search counters.
---

# Compactor Stats

Display and interpret compactor statistics.

## Commands and Tools

- `/unipi:compact-stats` — user-facing dashboard
- `compactor_stats` tool — agent-callable stats
- `ctx_stats` tool — deprecated alias

## Metrics Explained

| Metric | Description |
|--------|-------------|
| **Session events** | Events tracked for the current session in the compactor session DB |
| **Compactions** | Number of compaction events recorded |
| **Tokens saved** | Estimated tokens freed by compaction, using Pi token counts when available and DB fallbacks otherwise |
| **Compression ratio** | Approximate before/kept ratio from stored compaction stats |
| **Sandbox runs** | Agent sandbox executions recorded in runtime counters/DB |
| **Search queries** | Session recall/search queries recorded in runtime counters/DB |

## Health Indicators

- **Compactions > 0** on long sessions = compaction is happening.
- **Tokens saved > 0** after compaction = savings were recorded.
- **Sandbox runs** increasing = sandbox tool usage is tracked.
- **Search queries** increasing = recall/search activity is tracked.

## Reading Stats

```text
📊 Compactor Stats
Session events: 42
Compactions: 3
Tokens saved: 15000
Sandbox runs: 7
Search queries: 15
```

This means:

- 42 events are tracked for the session.
- 3 compactions saved roughly 15K tokens.
- 7 sandbox executions and 15 recall/search queries were recorded.

Project content indexing stats are not owned by compactor; use `read`/`bash` (rg) for file search.
