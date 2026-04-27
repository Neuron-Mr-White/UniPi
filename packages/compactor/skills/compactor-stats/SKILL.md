---
name: compactor-stats
description: Stats display — context savings, session metrics, index health.
---

# Compactor Stats

Display and interpret compactor statistics.

## Commands

- `/unipi:compact-stats` — quick dashboard
- `ctx_stats` tool — detailed stats (agent-callable)

## Metrics Explained

| Metric | Description |
|--------|-------------|
| **Session events** | Total events tracked in current session |
| **Compactions** | Number of times context was compacted |
| **Tokens saved** | Estimated tokens freed by compaction |
| **Indexed docs** | Number of files/sources in FTS5 index |
| **Indexed chunks** | Total searchable chunks |
| **Sandbox runs** | Code executions in sandbox |
| **Search queries** | FTS5 searches performed |

## Health Indicators

- **Compactions > 0** on long sessions = working correctly
- **Indexed chunks > 0** = search available
- **Sandbox runs** = code execution active

## Reading Stats

```
📊 Compactor Stats
Session events: 42
Compactions: 3
Tokens saved: 15000
Indexed docs: 12 (48 chunks)
Sandbox runs: 7
Search queries: 15
```

This means:
- 42 tool calls/events tracked
- 3 compactions saved ~15K tokens
- 12 files indexed into 48 searchable chunks
- 7 code executions, 15 searches performed
