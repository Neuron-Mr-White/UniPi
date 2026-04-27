# @pi-unipi/utility

Utility commands and tools for the Pi coding agent — part of the Unipi suite.

## Features

### `/unipi:continue` Command

Continue the agent from where it left off **without adding a user message** to the conversation transcript.

```
/unipi:continue
```

This sends a "steer" message that tells the agent to proceed to the next step. Unlike typing "continue" yourself, this doesn't pollute the context with an extra user message.

### `continue_task` Tool

The agent can call this tool programmatically when it finishes a step and needs to proceed to the next without waiting for user input.

```
continue_task()
```

**When to use:** The agent has completed one step and should automatically proceed to the next.

## Installation

```bash
pi install npm:@pi-unipi/utility
```

Or install the full Unipi suite:

```bash
pi install npm:@pi-unipi/unipi
```

## How It Works

Both the command and tool use Pi's `sendUserMessage` API with `deliverAs: "steer"` to inject a continuation prompt without creating a user message in the transcript. This keeps the conversation clean while allowing the agent to continue working.

The default continue prompt is:

> Continue from where you left off. Proceed with the next step.

## Dependencies

- `@pi-unipi/core` — Shared constants and utilities
- `@mariozechner/pi-coding-agent` — Pi extension API
- `@sinclair/typebox` — Schema validation
