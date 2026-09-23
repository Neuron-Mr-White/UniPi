---
title: "ask-user notify integration"
type: quick-work
date: 2026-04-28
---

# ask-user notify integration

## Task
Add integration between ask_user and notify modules — when the agent pauses to ask the user a question, optionally send a notification via the notify system.

## Changes
- `packages/core/events.ts`: Added `ASK_USER_PROMPT` event and `UnipiAskUserPromptEvent` payload type
- `packages/ask-user/config.ts`: Added `notifyOnAsk` setting to `AskUserSettings` interface and defaults
- `packages/ask-user/settings-tui.ts`: Added "Notify when asking" toggle to settings overlay
- `packages/ask-user/tools.ts`: Emit `ASK_USER_PROMPT` event when `notifyOnAsk` is enabled and agent asks a question
- `packages/notify/events.ts`: Added `ask_user_prompt` to `BUILTIN_EVENTS` and message builder
- `packages/notify/settings.ts`: Added `ask_user_prompt` to default config (disabled by default)

## Verification
- Ran typecheck — passes
- Settings flow: ask_user settings TUI shows new toggle
- Event flow: emitEvent → notify dispatches to enabled platforms
- Two control points:
  1. `ask_user.notifyOnAsk` — controls whether event is emitted
  2. `notify.events.ask_user_prompt.enabled` — controls whether notification is sent

## Notes
- The ask_user `notifyOnAsk` setting defaults to `true` (event emitted)
- The notify `ask_user_prompt` event defaults to `disabled` (no notification sent)
- This dual-gate design lets users control at both ends: emission and consumption
- Notification message includes question text and optional context
