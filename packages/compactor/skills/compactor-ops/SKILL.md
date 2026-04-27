---
name: compactor-ops
description: Engineering ops orchestration — batch operations, project indexing, maintenance.
---

# Compactor Ops

Orchestrate batch operations, project indexing, and maintenance tasks.

## Project Indexing Workflow

When starting work on a new codebase:

1. **Index project files** — `/unipi:compact-index` or `ctx_index` for specific files
2. **Verify index** — `/unipi:compact-stats` to check chunk count
3. **Test search** — `/unipi:compact-search <term>` to verify quality

## Batch Code Execution

Use `ctx_batch_execute` for atomic multi-step operations:

```json
{
  "items": [
    { "type": "execute", "language": "shell", "code": "ls -la src/" },
    { "type": "execute", "language": "python", "code": "import ast; print('OK')" },
    { "type": "search", "query": "authentication module" }
  ]
}
```

## Maintenance Tasks

### Clear stale index
```
/unipi:compact-purge
/unipi:compact-index
```

### Reset configuration
```
/unipi:compact-preset balanced
```

### Full diagnostics
```
/unipi:compact-doctor
```

## Integration Patterns

### Before complex task
1. `/unipi:compact` — free up context
2. `/unipi:compact-index` — index relevant files
3. Start work with fresh context + indexed search

### After long session
1. `/unipi:compact-stats` — check savings
2. `/unipi:compact` — compact if needed
3. `/unipi:compact-recall <topic>` — verify recall quality

### Research workflow
1. `ctx_fetch_and_index` — index reference docs
2. `ctx_search` — find relevant sections
3. `ctx_execute` — test hypotheses in sandbox
