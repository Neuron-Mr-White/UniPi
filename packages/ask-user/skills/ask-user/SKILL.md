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
| `allowFreeform` | boolean? | true | Add "Custom response" checkable option |
| `timeout` | number? | — | Auto-dismiss after N ms |

### Option Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `label` | string | required | Display label |
| `description` | string? | — | Description shown below label |
| `value` | string? | label | Value returned when selected |
| `allowCustom` | boolean? | false | Allow user to add custom text for this option (shorthand for `action: "input"`) |
| `action` | string? | "select" | Special action: `"select"`, `"input"`, `"end_turn"`, `"new_session"` |
| `prefill` | string? | — | Prefill message for `"new_session"` action |

### Action Types

| Action | Behavior |
|--------|----------|
| `"select"` | Normal selection (default). Returns immediately. |
| `"input"` | Enters text input mode. Returns `combined` response with selection + text. |
| `"end_turn"` | Signals end of agent turn. Returns `end_turn` response kind. |
| `"new_session"` | Starts a handoff. Returns `new_session` response kind with optional `prefill`. Shows a launcher overlay offering **Compact & run** (compact first, then queue/submit the prefill) or **Run directly** (queue/submit immediately). The current LLM follow-up is aborted after a successful queue or editor fallback. |

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

Combined (multi-select + freeform):
```
ask_user({
  question: "Which features and what custom feature?",
  options: [
    { label: "Auth", value: "auth" },
    { label: "Cache", value: "cache" }
  ],
  allowMultiple: true,
  allowFreeform: true
})
```
User can check "Auth", "Cache", and "Custom response" to type additional features.

With per-option custom text:
```
ask_user({
  question: "Does this look right?",
  options: [
    { label: "Yes", value: "yes" },
    { label: "Partially", value: "partial", allowCustom: true },
    { label: "No", value: "no", allowCustom: true }
  ],
  allowFreeform: false
})
```
Selecting "Partially" or "No" enters text input so the user can explain what needs to change.

With end_turn and new_session actions:
```
ask_user({
  question: "How would you like to proceed?",
  options: [
    { label: "Looks good, proceed", value: "proceed" },
    { label: "I want changes", value: "changes", action: "input" },
    { label: "Done for now", value: "done", action: "end_turn" },
    { label: "Start fresh", value: "new", action: "new_session", prefill: "Let's redesign the..." }
  ],
  allowFreeform: false
})
```
- "Looks good" returns immediately with selection
- "I want changes" enters text input mode for the user to explain
- "Done for now" signals the agent to end its turn
- "Start fresh" opens the launcher; **Compact & run** or **Run directly** queues the prefill message automatically

## Session Launcher

When a user selects a `new_session` option, a secondary launcher overlay appears with three choices:

| Choice | Behavior |
|--------|----------|
| 🧹 Compact & run | Starts `ctx.compact()` without waiting in the tool spinner, then queues/submits the prefill as a follow-up message after compaction or a short fallback timer |
| ▶ Run directly | Queues/submits the prefill immediately as a follow-up message, without compaction |
| ✕ Cancel | Cancels the session launch; no prefill is queued |

The prefill can be a slash command (for example `/unipi:work specs:...`) or any non-empty message. If automatic delivery fails, ask_user places the prefill in the editor and warns the user to press Enter. This two-step flow lets the user manage context window usage before starting a new task while avoiding unnecessary LLM follow-up in the old session.
