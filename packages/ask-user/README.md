# @pi-unipi/ask-user

Structured user input for decision gates. When the agent needs you to pick between options — which database, which approach, which files to change — it calls `ask_user` instead of guessing.

Three input modes: single-select (pick one), multi-select (toggle several), freeform (type your own). The agent presents the question, you answer, it continues.

## Commands

Ask-user has no user commands. It's an agent tool package — the agent calls it when it needs input.

## Special Triggers

All workflow skills detect ask-user and use it for decision gates. Instead of the agent deciding on its own, it presents options and waits for your input. This happens naturally during brainstorm, plan, work, and other skills when the agent faces ambiguity.

For workflow handoffs, options can use `action: "new_session"` with a `prefill`. Selecting one opens a launcher where **Compact & run** queues the prefill after compaction (or a short fallback) and **Run directly** queues it immediately. If automatic queuing fails, the prefill is placed in the editor for you to submit manually.

The bundled skill guides the agent to use `ask_user` for high-stakes decisions — architecture choices, database selection, naming decisions, anything with lasting impact.

## Agent Tool

| Tool | Description |
|------|-------------|
| `ask_user` | Structured user input with options |

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | string | required | The question to ask |
| `context` | string? | — | Additional context shown before question |
| `options` | array? | [] | Multiple-choice options |
| `allowMultiple` | boolean? | false | Enable multi-select mode |
| `allowFreeform` | boolean? | true | Allow freeform text input |
| `timeout` | number? | — | Auto-dismiss after N ms |

### Example

```typescript
ask_user({
  question: "Which database should we use?",
  options: [
    { label: "PostgreSQL", description: "Reliable, feature-rich" },
    { label: "SQLite", description: "Simple, serverless" },
  ],
})
```

### `new_session` Handoffs

```typescript
ask_user({
  question: "Continue with implementation?",
  options: [
    {
      label: "Proceed to work",
      value: "work",
      action: "new_session",
      prefill: "/unipi:work specs:2026-05-06-feature-plan.md",
    },
    { label: "Done for now", value: "done", action: "end_turn" },
  ],
  allowFreeform: false,
})
```

When the user chooses a `new_session` option:

| Launcher choice | Behavior |
|-----------------|----------|
| 🧹 Compact & run | Starts context compaction, returns immediately, then queues/submits the prefill as a follow-up message from the compaction callback or a short fallback timer |
| ▶ Run directly | Queues/submits the prefill immediately as a follow-up message |
| ✕ Cancel | Cancels the handoff; no message is queued |

The tool result is rendered as `queued compact → ...` or `queued direct → ...`. If automatic delivery fails, ask-user falls back to editor prefill and warns you to press Enter.

### History Expansion

Completed `ask_user` calls stay readable in chat history. The collapsed result shows the selected answer; press Ctrl+O on the tool result to expand the original question, context, and options that were presented.

### Keyboard Controls

| Mode | Keys |
|------|------|
| Single-select | Up/Down navigate, Enter select, Esc cancel |
| Multi-select | Up/Down navigate, Space toggle, Enter submit, Esc cancel |
| Freeform | Type text, Enter submit, Esc back |

### TUI Display

**Single-select:**
```
─────────────────────────────
 Which approach should we use?
─────────────────────────────
 > Option A
   Option B
   Option C
   Type something...

 Up/Down navigate, Enter select, Esc cancel
─────────────────────────────
```

**Multi-select:**
```
─────────────────────────────
 Which features to enable?
─────────────────────────────
 > [x] Logging
   [ ] Metrics
   [x] Tracing
   [ ] Type something...

 Up/Down navigate, Space toggle, Enter submit, Esc cancel
─────────────────────────────
```

## Configurables

Ask-user has no configuration. Input mode is determined by the `allowMultiple` and `allowFreeform` parameters the agent passes.

## License

MIT
