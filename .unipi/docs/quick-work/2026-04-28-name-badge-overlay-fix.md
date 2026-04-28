---
title: "Name Badge Overlay Fix & Kanboard Integration"
type: quick-work
date: 2026-04-28
---

# Name Badge Overlay Fix & Kanboard Integration

## Task
1. Fix name badge overlay rendering (opaque bg, text in frame)
2. Add kanboard name-gen command for badge generation
3. Add hook on initial user message for auto badge generation (configurable)

## Changes

- `packages/utility/src/tui/name-badge.ts`: Redesigned badge to render as a proper bordered box with opaque background using `theme.bg("customMessageBg", ...)`. Changed from single-line `┌─ Best ─┐` to 3-line box:
  ```
  ╭──────────╮
  │   Best   │
  ╰──────────╯
  ```

- `packages/core/constants.ts`: Added `NAME_GEN: "name-gen"` to `KANBOARD_COMMANDS`

- `packages/core/events.ts`: Added `BADGE_GENERATE_REQUEST` event and `UnipiBadgeGenerateRequestEvent` payload type

- `packages/kanboard/commands.ts`: Added `/unipi:name-gen` command that emits `BADGE_GENERATE_REQUEST` event and sends hidden LLM message to generate session name. Added `/unipi:kanboard-settings` command with TUI overlay for configuring auto badge generation.

- `packages/kanboard/index.ts`: Added `input` event hook that triggers badge generation on first user message. Added `isAutoBadgeGenEnabled()` config check reading from `~/.pi/agent/settings.json` under `unipi.kanboard.autoBadgeGen` (defaults to true)

- `packages/utility/src/index.ts`: Added listener for `BADGE_GENERATE_REQUEST` event to show badge overlay when requested by other modules

- `packages/kanboard/tui/settings-overlay.ts`: New settings TUI component with toggle for auto badge generation, matching ask-user settings pattern

- `packages/autocomplete/src/constants.ts`: Added `unipi:name-gen` and `unipi:kanboard-settings` command entries with kanboard category and description

- `packages/utility/src/tui/name-badge-state.ts`: Fixed overlay hide — was calling `overlayHandle.close()` which doesn't exist. Changed to use `overlayHandle.hide()` (pi-tui API). This fixes the badge persisting after toggle to disabled.

## Verification
- TypeScript compiles cleanly (`npx tsc --noEmit` — no errors)

## Notes
- Auto badge generation on first message is configurable via `~/.pi/agent/settings.json`:
  ```json
  { "unipi": { "kanboard": { "autoBadgeGen": false } } }
  ```
- The badge overlay uses `theme.bg("customMessageBg", ...)` for opaque background matching the theme
- The `BADGE_GENERATE_REQUEST` event enables cross-module communication between kanboard and utility
