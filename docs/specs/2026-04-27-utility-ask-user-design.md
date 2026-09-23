---
title: "Utility + Ask-User — @pi-unipi/utility & @pi-unipi/ask-user Extensions"
type: brainstorm
date: 2026-04-27
---

# Utility + Ask-User — @pi-unipi/utility & @pi-unipi/ask-user

## Problem Statement

### Problem 1: Agent Stalls Need Clean Continuation
When the pi agent stops unexpectedly (hits a limit, finishes a turn, or the user wants it to keep going), the only way to resume is for the user to type "continue" — which adds a new user message to the conversation context. This pollutes the transcript with a no-op message and consumes context tokens. The user wants a way to tell the agent "continue from where you left off" without injecting any user-side text into the context.

**Root need:** A mechanism to trigger the next agent turn without adding a user message.

### Problem 2: No Built-in Structured User Input Tool
Pi has no built-in way for the agent to ask the user structured questions (multiple choice, multi-select, freeform) with a polished interactive UI. The agent must ask in free-form text and parse the user's response, which is slow, inconsistent, and error-prone. Several community extensions solve this (pi-ask-user, pi-ask-tool, pi-mono-extensions/ask-user-question) but none are part of the Unipi suite.

**Root need:** An `ask_user` tool that provides interactive, structured user input with single-select, multi-select, and freeform options — integrated into the Unipi ecosystem.

## Context

**Existing patterns in Unipi:**
- `@pi-unipi/web-api`: Provider registry, settings TUI, tool registration with TypeBox schemas, info-screen integration
- `@pi-unipi/memory`: Tool + command registration pattern, skill bundling, session lifecycle management
- `@pi-unipi/ralph`: `pi.sendUserMessage()` with `deliverAs: "steer"` for continuing agent work without user input
- `@pi-unipi/btw`: `pi.sendUserMessage()` with `deliverAs: "followUp"` for queuing messages
- `@pi-unipi/core`: `UNIPI_EVENTS.MODULE_READY` for module discovery, constants for commands/tools

**Reference implementations studied:**
- `edlsh/pi-ask-user` (46⭐): Single/multi-select with overlay mode, freeform, timeout, custom rendering, bundled skill
- `devkade/pi-ask-tool` (9⭐): Tab-based multi-question flow with inline notes, structured schema
- `emanuelcasco/pi-mono-extensions/ask-user-question`: Radio/checkbox/text form controls
- Pi examples: `question.ts` (simple select), `questionnaire.ts` (tab-based multi-question)

**Key insight from references:**
- `edlsh/pi-ask-user` is the most mature and feature-complete — overlay mode, responsive layout, timeout, skill integration
- `devkade/pi-ask-tool` has nice tab-based multi-question flow but is more complex
- Pi's built-in `question.ts` and `questionnaire.ts` examples show the TUI patterns we need
- All use `ctx.ui.custom()` for interactive UI

## Chosen Approach

### For `/unipi:continue` (Utility):
**Approach A: Command + Tool — `pi.sendUserMessage()` with `deliverAs: "steer"`**
- Register a `/unipi:continue` command
- When invoked, use `pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "steer" })` to trigger the next agent turn
- The prompt tells the agent "continue from where you left off" — but it's sent as a steer message, not a user message
- Also register a `continue_task` tool so the agent can call it programmatically
- Store the last continue prompt in session state so repeated continues don't bloat context

**Why not other approaches:**
- Approach B (custom message type): Would require the agent to recognize it, no better than steer
- Approach C (tool-only): Less discoverable for users; command is more ergonomic
- Approach D (modify system prompt): Too invasive, affects all turns

### For `ask_user` (Ask-User):
**Approach A: Single tool with multiple modes — `ask_user`**
- One tool: `ask_user` with parameters for question, options, allowMultiple, allowFreeform, timeout
- Single-question mode: simple options list (like `question.ts` example)
- Multi-question mode: tab-based navigation (like `questionnaire.ts` example)
- Custom rendering for tool call and result
- Bundled skill that nudges the agent to use `ask_user` for high-stakes decisions
- Overlay mode support via `ctx.ui.custom({ overlay: true })`

**Why not other approaches:**
- Approach B (separate tools per mode): Too many tools, harder to discover
- Approach C (full tab-based multi-question only): Overkill for simple single questions
- Approach D (copy edlsh exactly): Would duplicate mature work; better to learn from it and build a focused Unipi-native version

## Why This Approach

**Continue:**
- `sendUserMessage` with `deliverAs: "steer"` is the pi-native way to inject a message mid-stream without user input
- Command makes it discoverable (`/unipi:continue`)
- Tool makes it callable by the agent itself
- Minimal complexity, zero context pollution

**Ask-User:**
- Single tool with mode switching keeps the API surface small
- Tab-based UI for multi-question, simple list for single-question — best UX for each case
- Custom rendering makes the TUI polished
- Skill integration follows Unipi patterns (like memory, ralph, btw)
- No external dependencies beyond `@pi-unipi/core` and pi's built-in TUI

## Design

### Architecture

```
packages/
├── utility/
│   ├── index.ts           # Extension entry
│   ├── commands.ts        # /unipi:continue command
│   ├── tools.ts           # continue_task tool
│   ├── constants.ts       # UTILITY_COMMANDS, UTILITY_TOOLS
│   └── README.md
├── ask-user/
│   ├── index.ts           # Extension entry
│   ├── tools.ts           # ask_user tool registration
│   ├── ask-ui.ts          # TUI components (single-select, multi-select, overlay)
│   ├── types.ts           # TypeScript types for ask_user
│   ├── commands.ts        # /unipi:ask-user-settings (optional)
│   ├── skills/
│   │   └── ask-user/
│   │       └── SKILL.md   # Bundled skill
│   └── README.md
└── unipi/                 # Meta-package (update)
    └── index.ts           # Add utility + ask-user imports
```

### @pi-unipi/utility — Continue

#### Commands

**`/unipi:continue`**
- Description: "Continue the agent from where it left off without adding user context"
- Handler:
  1. Check if agent is idle — if so, send steer message immediately
  2. If agent is busy, queue as follow-up (or notify user to wait)
  3. Send `pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "steer" })`
- The `CONTINUE_PROMPT` text: `"Continue from where you left off. Proceed with the next step."`

#### Tools

**`continue_task`**
- Name: `continue_task`
- Label: "Continue Task"
- Description: "Signal that the agent should continue working on the current task without waiting for user input. Use when the agent has finished one step and should proceed to the next."
- Parameters: `Type.Object({})` — no parameters
- execute: Sends steer message with continue prompt
- promptSnippet: "Continue working on the current task without user input"
- promptGuidelines: ["Use continue_task when you finish a step and need to proceed to the next without waiting for the user."]

#### Constants (add to @pi-unipi/core)

```typescript
// In packages/core/constants.ts
export const UTILITY_COMMANDS = {
  CONTINUE: "continue",
} as const;

export const UTILITY_TOOLS = {
  CONTINUE: "continue_task",
} as const;
```

#### Module Event

On `session_start`, emit:
```typescript
emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
  name: MODULES.UTILITY,  // add to MODULES in core
  version: VERSION,
  commands: [`unipi:${UTILITY_COMMANDS.CONTINUE}`],
  tools: [UTILITY_TOOLS.CONTINUE],
});
```

---

### @pi-unipi/ask-user — Ask User

#### Tool: `ask_user`

**Parameters (TypeBox schema):**
```typescript
Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  context: Type.Optional(Type.String({ description: "Additional context shown before the question" })),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ description: "Display label" }),
        description: Type.Optional(Type.String({ description: "Optional description" })),
        value: Type.Optional(Type.String({ description: "Value returned when selected (defaults to label)" })),
      }),
      { description: "Multiple-choice options (omit for freeform-only)" }
    )
  ),
  allowMultiple: Type.Optional(Type.Boolean({ description: "Enable multi-select mode (default: false)" })),
  allowFreeform: Type.Optional(Type.Boolean({ description: "Allow freeform text input (default: true)" })),
  timeout: Type.Optional(Type.Number({ description: "Auto-dismiss after N milliseconds" })),
})
```

**Result shape:**
```typescript
interface AskUserResponse {
  kind: "selection" | "freeform" | "cancelled";
  selections?: string[];      // For selection kind
  text?: string;              // For freeform kind
  comment?: string;           // Optional user comment
}

interface AskUserDetails {
  question: string;
  context?: string;
  options: { label: string; description?: string; value: string }[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  response: AskUserResponse;
}
```

**Behavior:**
1. If `!ctx.hasUI` (non-interactive mode): Return error
2. If no options provided and `allowFreeform === false`: Return error
3. If single question + `allowMultiple === false`: Show simple options list (like `question.ts`)
4. If `allowMultiple === true` or multiple questions: Show tab-based interface (like `questionnaire.ts`)
5. If `allowFreeform === true`: Add "Type something..." option
6. If `timeout` specified: Auto-dismiss after N ms, return cancelled
7. Escape key cancels the flow

**UI Modes:**

*Single-select (default):*
```
─────────────────────────────
 Which approach should we use?
─────────────────────────────
 > 1. Option A
   2. Option B
   3. Option C
   4. Type something...

 ↑↓ navigate • Enter select • Esc cancel
─────────────────────────────
```

*Multi-select:*
```
─────────────────────────────
 Which features to enable?
─────────────────────────────
 [✓] 1. Logging
 [ ] 2. Metrics
 [✓] 3. Tracing
 [ ] 4. Type something...

 ↑↓ navigate • Space toggle • Enter submit • Esc cancel
─────────────────────────────
```

*With context:*
```
─────────────────────────────
 Context: We are choosing a deploy target.

 Which environment?
─────────────────────────────
 > 1. staging
   2. production (Customer-facing)
   3. Type something...
─────────────────────────────
```

#### Custom Rendering

**renderCall:**
- Show tool name + question text
- Show option count and mode (single/multi)

**renderResult:**
- Show ✓ + selected option(s) or freeform text
- Show "Cancelled" if user cancelled
- Show "Timed out" if timeout reached

#### Commands

**`/unipi:ask-user-test`** (optional, for testing)
- Description: "Test the ask_user tool with a sample question"
- Handler: Runs a sample ask_user interaction

#### Skill: `ask-user`

```markdown
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
```

#### Constants (add to @pi-unipi/core)

```typescript
// In packages/core/constants.ts
export const ASK_USER_TOOLS = {
  ASK: "ask_user",
} as const;
```

#### Module Event

On `session_start`, emit:
```typescript
emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
  name: MODULES.ASK_USER,  // add to MODULES in core
  version: VERSION,
  commands: [],  // or ask-user-test if implemented
  tools: [ASK_USER_TOOLS.ASK],
});
```

---

### @pi-unipi/core Updates

Add to `constants.ts`:
```typescript
export const MODULES = {
  // ... existing
  UTILITY: "@pi-unipi/utility",
  ASK_USER: "@pi-unipi/ask-user",
  // ...
} as const;

export const UTILITY_COMMANDS = {
  CONTINUE: "continue",
} as const;

export const UTILITY_TOOLS = {
  CONTINUE: "continue_task",
} as const;

export const ASK_USER_TOOLS = {
  ASK: "ask_user",
} as const;
```

---

### @pi-unipi/unipi Meta-Package Updates

Update `packages/unipi/index.ts`:
```typescript
import utility from "@pi-unipi/utility";
import askUser from "@pi-unipi/ask-user";

export default function (pi: ExtensionAPI) {
  // ... existing imports
  utility(pi);
  askUser(pi);
}
```

Update `package.json`:
```json
{
  "dependencies": {
    // ... existing
    "@pi-unipi/utility": "*",
    "@pi-unipi/ask-user": "*"
  }
}
```

Update `pi.extensions` and `pi.skills` arrays in `package.json`.

---

## Error Handling

### Continue
- Agent busy: Queue as follow-up or notify user
- Agent idle: Send steer immediately
- No active session: Notify error

### Ask-User
- No UI available: Return error result with `isError: true`
- No options + no freeform: Return error
- Timeout: Return cancelled response
- User cancels: Return cancelled response
- Invalid parameters: Throw error (caught by pi, reported to LLM)

## Testing Strategy

### Manual Testing Checklist
- [ ] `/unipi:continue` when agent is idle → agent continues
- [ ] `/unipi:continue` when agent is busy → queues or notifies
- [ ] `continue_task` tool called by agent → agent continues
- [ ] `ask_user` single-select → user can pick, result returned
- [ ] `ask_user` multi-select → user can toggle multiple, submit
- [ ] `ask_user` freeform → user can type custom answer
- [ ] `ask_user` with context → context displayed above question
- [ ] `ask_user` timeout → auto-dismisses, returns cancelled
- [ ] `ask_user` cancel (Escape) → returns cancelled
- [ ] `ask_user` custom rendering → looks polished in TUI
- [ ] Skill loaded → agent uses ask_user for decisions
- [ ] Meta-package loads both → `pi install npm:unipi` gets everything
- [ ] Info-screen integration → modules show in dashboard

## Implementation Checklist

### @pi-unipi/utility
- [x] Create `packages/utility/package.json` with proper metadata — covered in Task 2
- [x] Create `packages/utility/index.ts` — extension entry — covered in Task 2
- [x] Create `packages/utility/commands.ts` — `/unipi:continue` command — covered in Task 3
- [x] Create `packages/utility/tools.ts` — `continue_task` tool — covered in Task 4
- [x] Create `packages/utility/constants.ts` — local constants — covered in Task 2
- [x] Create `packages/utility/README.md` — covered in Task 2
- [x] Update `@pi-unipi/core` constants — add UTILITY to MODULES, commands, tools — covered in Task 1
- [ ] Test `/unipi:continue` command manually — deferred to implementation
- [ ] Test `continue_task` tool manually — deferred to implementation

### @pi-unipi/ask-user
- [x] Create `packages/ask-user/package.json` with proper metadata — covered in Task 5
- [x] Create `packages/ask-user/index.ts` — extension entry — covered in Task 5
- [x] Create `packages/ask-user/types.ts` — TypeScript interfaces — covered in Task 5
- [x] Create `packages/ask-user/tools.ts` — `ask_user` tool registration — covered in Task 6
- [x] Create `packages/ask-user/ask-ui.ts` — TUI components (single-select, multi-select) — covered in Task 7
- [x] Create `packages/ask-user/commands.ts` — optional test command — covered in Task 5
- [x] Create `packages/ask-user/skills/ask-user/SKILL.md` — bundled skill — covered in Task 8
- [x] Create `packages/ask-user/README.md` — covered in Task 5
- [x] Update `@pi-unipi/core` constants — add ASK_USER to MODULES, tools — covered in Task 1
- [ ] Test `ask_user` single-select manually — deferred to implementation
- [ ] Test `ask_user` multi-select manually — deferred to implementation
- [ ] Test `ask_user` freeform manually — deferred to implementation
- [ ] Test `ask_user` timeout manually — deferred to implementation
- [ ] Test skill integration manually — deferred to implementation

### @pi-unipi/unipi Meta-Package
- [x] Update `packages/unipi/index.ts` — import and register utility + ask-user — covered in Task 9
- [x] Update `packages/unipi/package.json` — add dependencies, pi.extensions, pi.skills — covered in Task 9
- [ ] Test meta-package loads all extensions — deferred to implementation
- [ ] Verify info-screen shows new modules — deferred to implementation

### Publishing
- [ ] Update root `package.json` version if needed — deferred to implementation
- [x] Run `npm run typecheck` — pass — covered in Task 10
- [x] Test all extensions work together — covered in Task 10
- [ ] Publish `@pi-unipi/utility` to npm — deferred to implementation
- [ ] Publish `@pi-unipi/ask-user` to npm — deferred to implementation
- [ ] Publish `@pi-unipi/unipi` meta-package to npm — deferred to implementation
- [ ] Push to GitHub — deferred to implementation
- [ ] Verify `pi install npm:unipi` works end-to-end — deferred to implementation

## Open Questions

1. **Continue prompt wording:** Should the continue prompt be configurable? (Default: "Continue from where you left off. Proceed with the next step.")
2. **Ask-user overlay mode:** Should we support overlay mode (floating dialog) from the start, or add it later?
3. **Ask-user timeout default:** Should there be a default timeout, or only when explicitly specified?
4. **Ask-user multi-question:** Should we support multiple questions in one tool call (tab flow), or keep it single-question only for v1?

## Out of Scope

- **Ask-user:** No inline note editing (like devkade's pi-ask-tool) — keep v1 simple
- **Ask-user:** No markdown context rendering with diagrams — plain text context only for v1
- **Ask-user:** No auto-"Other" option injection — explicit `allowFreeform` parameter
- **Utility:** No auto-continue detection (agent doesn't auto-detect when it should continue)
- **Both:** No settings TUI (utility has no config; ask-user may add later)
- **Both:** No provider-like registry pattern (not needed for these simple extensions)

## Decisions Made

1. **Continue uses `sendUserMessage` with `deliverAs: "steer"`** — This is the pi-native way to continue without user input. The message is injected as a steer, not a user message, so it doesn't appear in the transcript as user text.
2. **Ask-user is a single tool with mode switching** — Keeps API surface small. Single-question for simple cases, multi-select for complex cases.
3. **No overlay mode for v1** — Overlay mode is experimental in pi. Use full-screen `ctx.ui.custom()` for reliability.
4. **Skill bundles with ask-user** — Follows Unipi pattern (memory, ralph, btw all have skills). Skill nudges agent to use ask_user for high-stakes decisions.
5. **Both packages are independent** — Can be installed separately or via meta-package.
6. **Core constants updated** — MODULES, command names, tool names all live in `@pi-unipi/core` for consistency.
