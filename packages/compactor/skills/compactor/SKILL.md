---
name: compactor
description: Routing decision tree for compactor — when to compact, search, index, or diagnose.
---

# Compactor Routing

Use this skill to decide which compactor action to take.

## Decision Tree

```
User wants to...
├── Reduce context / free tokens
│   └── /unipi:compact or `compact` tool
│
├── Find something from earlier in the session
│   └── /unipi:compact-recall <query> or `vcc_recall` tool
│
├── Run code safely
│   └── `ctx_execute` tool (single) or `ctx_batch_execute` (batch)
│
├── Index project files for search
│   └── /unipi:compact-index or `ctx_index` tool
│
├── Search indexed content
│   └── /unipi:compact-search <query> or `ctx_search` tool
│
├── Fetch and index a URL
│   └── `ctx_fetch_and_index` tool
│
├── View compactor stats
│   └── /unipi:compact-stats or `ctx_stats` tool
│
├── Diagnose issues
│   └── /unipi:compact-doctor or `ctx_doctor` tool
│
├── Change settings
│   └── /unipi:compact-settings (TUI overlay)
│   └── /unipi:compact-preset <name> (quick preset)
│
└── Wipe indexed content
    └── /unipi:compact-purge
```

## When to Compact

- Context window > 80% full
- Session has > 100 messages
- Before starting a complex multi-step task
- When the agent starts repeating itself

## When to Recall

- User references something from earlier
- Need to find a file path mentioned before
- Looking for a previous error or decision
- Searching for a specific code snippet

## When to Index

- Starting work on a large codebase
- Need fast search across many files
- Documentation or reference material
- Before a research-heavy task

## Presets

| Preset | Best For |
|--------|----------|
| `opencode` | Code-heavy work, minimal context waste |
| `balanced` | General use, good defaults |
| `verbose` | Maximum context preservation |
| `minimal` | Maximum token savings |
