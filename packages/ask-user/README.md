# @pi-unipi/ask-user

Structured user input tool for the Pi coding agent — part of the Unipi suite.

## Features

### `ask_user` Tool

Ask the user a question with structured options. Supports three modes:

- **Single-select** — Pick one option from a list
- **Multi-select** — Toggle multiple options, then submit
- **Freeform** — Type a custom answer

### Usage

The agent calls the tool when it needs user input:

```typescript
ask_user({
  question: "Which database should we use?",
  options: [
    { label: "PostgreSQL", description: "Reliable, feature-rich" },
    { label: "SQLite", description: "Simple, serverless" },
  ],
})
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | string | required | The question to ask |
| `context` | string? | — | Additional context shown before question |
| `options` | array? | [] | Multiple-choice options |
| `allowMultiple` | boolean? | false | Enable multi-select mode |
| `allowFreeform` | boolean? | true | Allow freeform text input |
| `timeout` | number? | — | Auto-dismiss after N ms |

### Keyboard Controls

| Mode | Keys |
|------|------|
| Single-select | ↑↓ navigate, Enter select, Esc cancel |
| Multi-select | ↑↓ navigate, Space toggle, Enter submit, Esc cancel |
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

 ↑↓ navigate • Enter select • Esc cancel
─────────────────────────────
```

**Multi-select:**
```
─────────────────────────────
 Which features to enable?
─────────────────────────────
 > [✓] Logging
   [ ] Metrics
   [✓] Tracing
   [ ] Type something...

 ↑↓ navigate • Space toggle • Enter submit • Esc cancel
─────────────────────────────
```

## Installation

```bash
pi install npm:@pi-unipi/ask-user
```

Or install the full Unipi suite:

```bash
pi install npm:@pi-unipi/unipi
```

## Bundled Skill

The package includes a skill that guides the agent to use `ask_user` for high-stakes decisions. The skill is automatically discovered when the extension loads.

## Dependencies

- `@pi-unipi/core` — Shared constants and utilities
- `@mariozechner/pi-coding-agent` — Pi extension API
- `@mariozechner/pi-tui` — TUI components
- `@sinclair/typebox` — Schema validation
