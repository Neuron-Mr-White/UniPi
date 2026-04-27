---
name: ask-user
description: >
  Interactive decision-gating tool for structured user input.
  Use ask_user when you need user confirmation, preferences, or decisions
  before proceeding with high-impact or ambiguous choices.
allowed-tools:
  - ask_user
---

# Ask User

Use the `ask_user` tool to collect structured input from the user.

## When to use ask_user

- Architectural trade-offs with high impact
- Requirements are ambiguous or conflicting
- Assumptions would materially change implementation
- User preferences needed (style, approach, priority)
- Confirming before destructive operations

## Decision Handshake Flow

1. Gather evidence and summarize context
2. Ask ONE focused question via `ask_user`
3. Wait for explicit user choice
4. Confirm the decision, then proceed

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | string | required | The question to ask |
| `context` | string? | — | Additional context shown before question |
| `options` | array? | [] | Multiple-choice options with labels, descriptions, values |
| `allowMultiple` | boolean? | false | Enable multi-select |
| `allowFreeform` | boolean? | true | Add "Type something..." option |
| `timeout` | number? | — | Auto-dismiss after N ms |

## Examples

Single choice:
```
ask_user({
  question: "Which database should we use?",
  options: [
    { label: "PostgreSQL", description: "Reliable, feature-rich" },
    { label: "SQLite", description: "Simple, serverless" }
  ]
})
```

Multi-select:
```
ask_user({
  question: "Which features to implement?",
  options: [
    { label: "Auth", value: "auth" },
    { label: "Cache", value: "cache" },
    { label: "Logging", value: "logging" }
  ],
  allowMultiple: true
})
```

With context:
```
ask_user({
  question: "Which approach?",
  context: "Current bottleneck: network I/O. Goal: reduce latency.",
  options: [
    { label: "Cache-first" },
    { label: "DB-first" }
  ]
})
```

Freeform only:
```
ask_user({
  question: "What should we name this module?",
  options: [],
  allowFreeform: true
})
```
