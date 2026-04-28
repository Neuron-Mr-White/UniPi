---
title: "ask_user option actions (end_turn, new_session, input)"
type: quick-work
date: 2026-04-28
---

# ask_user option actions (end_turn, new_session, input)

## Task
Add new option action types to ask_user so agents can offer options that:
- Start a new session with a prefill message (`action: "new_session"`)
- End the current agent turn (`action: "end_turn"`)
- Enter text input mode like custom response (`action: "input"`)

## Changes
- `packages/ask-user/types.ts`: Added `action` and `prefill` fields to `AskUserOption`/`NormalizedOption`, added `"end_turn"` and `"new_session"` to response kinds
- `packages/ask-user/tools.ts`: Added `action`/`prefill` to TypeBox schema, type assertion, normalization; added response text for new kinds; updated promptGuidelines
- `packages/ask-user/ask-ui.ts`: Added `getAction()` helper (maps `allowCustom` → `"input"` for backward compat); updated Enter/Space handlers for `end_turn` (immediate return) and `new_session` (immediate return with prefill); updated hint bar and option labels with action indicators (↵ for end_turn, ↗ for new_session, "(add note)" for input); added renderResult cases for new kinds
- `packages/ask-user/skills/ask-user/SKILL.md`: Documented `action` and `prefill` properties, added action types table, added example

## Verification
- `npx tsc --noEmit` — clean build, no errors
- Backward compatible: `allowCustom: true` maps to `action: "input"`, `action` defaults to `"select"`

## Notes
- `action: "input"` is functionally equivalent to `allowCustom: true` — both work
- `end_turn` and `new_session` return immediately (no text input step)
- The agent receives the action via the response `kind` field and should handle accordingly
