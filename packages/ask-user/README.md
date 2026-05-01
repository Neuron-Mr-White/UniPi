# @pi-unipi/ask-user

Structured user input for decision gates. When the agent needs you to pick between options — which database, which approach, which files to change — it calls `ask_user` instead of guessing.

Three input modes: single-select (pick one), multi-select (toggle several), freeform (type your own). The agent presents the question, you answer, it continues.

## Commands

Ask-user has no user commands. It's an agent tool package — the agent calls it when it needs input.

## Special Triggers

All workflow skills detect ask-user and use it for decision gates. Instead of the agent deciding on its own, it presents options and waits for your input. This happens naturally during brainstorm, plan, work, and other skills when the agent faces ambiguity.

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
