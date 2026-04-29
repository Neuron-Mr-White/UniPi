---
title: "Notify Recap & Agent-End Fix — Implementation Plan"
type: plan
date: 2026-04-29
workbranch: ""
specs:
  - .unipi/docs/specs/2026-04-29-notify-recap-design.md
---

# Notify Recap & Agent-End Fix — Implementation Plan

## Overview

Fix the agent_end notification to show meaningful messages instead of generic text, and add a configurable "Recap" feature that summarizes the last assistant message using a selectable LLM model.

## Tasks

- completed: Task 1 — Update types.ts with recap config
  - Description: Add `RecapConfig` interface and `recap` field to `NotifyConfig`
  - Dependencies: None
  - Acceptance Criteria: `NotifyConfig` has `recap: { enabled: boolean; model: string }` field
  - Steps:
    1. Add `RecapConfig` interface with `enabled: boolean` and `model: string`
    2. Add `recap: RecapConfig` to `NotifyConfig` interface

- completed: Task 2 — Update settings.ts with recap defaults
  - Description: Add recap to `DEFAULT_CONFIG` and `mergeWithDefaults`
  - Dependencies: Task 1
  - Acceptance Criteria: Default config has `recap: { enabled: false, model: "openrouter/openai/gpt-oss-20b" }`, and `mergeWithDefaults` handles it
  - Steps:
    1. Add `recap` to `DEFAULT_CONFIG` with `enabled: false, model: "openrouter/openai/gpt-oss-20b"`
    2. Update `mergeWithDefaults` to merge `recap` field

- completed: Task 3 — Add NOTIFY_COMMANDS.RECAP_MODEL constant
  - Description: Register the new command constant in core
  - Dependencies: None
  - Acceptance Criteria: `NOTIFY_COMMANDS` has `RECAP_MODEL: "notify-recap-model"` entry
  - Steps:
    1. Add `RECAP_MODEL: "notify-recap-model"` to `NOTIFY_COMMANDS` in `packages/core/constants.ts`

- completed: Task 4 — Create summarize.ts with recap API call
  - Description: Implement `summarizeLastMessage()` that calls OpenRouter API
  - Dependencies: Task 1
  - Acceptance Criteria: Function takes message text + API key, returns summarized string, handles errors gracefully with fallback
  - Steps:
    1. Create `packages/notify/summarize.ts`
    2. Implement `summarizeLastMessage(messageText: string, apiKey: string): Promise<string>`
    3. Use `fetch` to call `POST https://openrouter.ai/api/v1/chat/completions`
    4. System prompt: "Summarize this in one concise sentence for a push notification. Reply with ONLY the summary."
    5. Max tokens: 100, timeout: 10s
    6. On error/timeout, return truncated original message (first 100 chars)

- completed: Task 5 — Fix buildEventMessage for agent_end and implement recap logic
  - Description: Update events.ts to handle agent_end with session name and recap
  - Dependencies: Tasks 1, 2, 4
  - Acceptance Criteria: agent_end sends session-name-based message when recap off, sends summarized message when recap on
  - Steps:
    1. Update `registerEventListeners` signature to accept `pi` (ExtensionAPI) reference
    2. Change `agent_end` handler to use custom logic instead of `buildEventMessage`
    3. If `config.recap.enabled`: get last assistant message → call `summarizeLastMessage` → send `"{sessionName}: {recap}"` or just `"{recap}"`
    4. If not: send `"{sessionName} - Agent is complete"` or `"Agent is complete"`
    5. Get API key via `pi.modelRegistry.getApiKeyForProvider("openrouter")`

- completed: Task 6 — Create recap model selector TUI component
  - Description: New TUI overlay for selecting recap model from cached models
  - Dependencies: Task 1
  - Acceptance Criteria: Shows filtered model list, allows selection, saves to config
  - Steps:
    1. Create `packages/notify/tui/recap-model-selector.ts`
    2. Load cached models via `readModelCache()` from `@pi-unipi/core`
    3. Filter to `openrouter` provider models
    4. Render interactive list with current selection highlighted
    5. On Enter: save selected model to config, close overlay
    6. Default highlight: `openrouter/openai/gpt-oss-20b`

- completed: Task 7 — Update settings overlay with recap section
  - Description: Add Recap tab/section to the existing settings overlay
  - Dependencies: Tasks 2, 6
  - Acceptance Criteria: Settings overlay has a "Recap" section with toggle and model selector
  - Steps:
    1. Add "recap" to `Section` type
    2. Add Recap tab alongside Platforms and Events tabs
    3. Render recap section with: enabled toggle, current model display
    4. On model selection: open recap model selector overlay
    5. Update `maxItems` for recap section

- completed: Task 8 — Register notify-recap-model command
  - Description: Add the command to open recap model selector directly
  - Dependencies: Tasks 3, 6
  - Acceptance Criteria: `/unipi:notify-recap-model` opens the model selector overlay
  - Steps:
    1. Import `RecapModelSelectorOverlay` in `commands.ts`
    2. Register command using `pi.registerCommand` with `NOTIFY_COMMANDS.RECAP_MODEL`
    3. Add to module ready event's commands array in `index.ts`

- completed: Task 9 — Register command in autocomplete constants
  - Description: Add the new command to autocomplete suggestions
  - Dependencies: Task 8
  - Acceptance Criteria: `unipi:notify-recap-model` appears in autocomplete with description
  - Steps:
    1. Add `"unipi:notify-recap-model": "notify"` to category map
    2. Add `"unipi:notify-recap-model": "Select model for notification recaps"` to descriptions

- completed: Task 10 — Build and verify
  - Description: Run build to ensure no type errors
  - Dependencies: Tasks 1-9
  - Acceptance Criteria: `npm run build` passes with no errors
  - Steps:
    1. Run `npm run build` from project root
    2. Fix any type errors
    3. Verify all imports resolve

## Sequencing

```
Task 1 (types) ─────────────┐
Task 3 (constants) ─────────┤
                             ├─→ Task 4 (summarize.ts) ─→ Task 5 (events.ts fix)
Task 2 (settings defaults) ─┤                                    │
                             ├─→ Task 6 (model selector TUI) ─┬──┤
                             │                                 │  │
                             └─→ Task 7 (settings overlay) ────┘  │
                                                                  │
Task 8 (command registration) ←───────────────────────────────────┘
Task 9 (autocomplete) ← Task 8
Task 10 (build verify) ← All tasks
```

## Risks

- OpenRouter API key might not be configured → fallback to truncated message
- AgentMessage type structure may vary → extract text content defensively
- Model selector needs to handle empty cache gracefully

---

## Reviewer Remarks

REVIEWER-REMARK: Done
- All 10 tasks completed and verified against acceptance criteria
- Typecheck passes with no errors
- Committed as c91550a

Codebase Checks:
- ✓ Type check passed (`npm run typecheck`)
- ✓ All imports resolve
