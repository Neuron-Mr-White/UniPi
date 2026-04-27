---
title: "Configure Notify Skill + Gotify Setup Overlay"
type: quick-work
date: 2026-04-28
---

# Configure Notify Skill + Gotify Setup Overlay

## Task

Create a skill that teaches the agent how to help users configure notify settings, and implement an interactive Gotify setup overlay (matching the Telegram setup UX).

## Changes

- **`packages/notify/tui/gotify-setup.ts`** (new): Interactive TUI overlay with phases: instructions → server URL → app token → priority → test connection → success/failure. Pre-fills from existing config. Masks app token in display. Tests connection before saving.
- **`packages/notify/skills/configure-notify/SKILL.md`** (new): Skill documenting config structure, platform options, commands, validation rules, and agent workflow for reading/updating config.
- **`packages/core/constants.ts`**: Added `SET_GOTIFY: "notify-set-gotify"` to `NOTIFY_COMMANDS`.
- **`packages/notify/commands.ts`**: Imported `GotifySetupOverlay`, registered `/unipi:notify-set-gotify` command.
- **`packages/notify/index.ts`**: Added `unipi:notify-set-gotify` to MODULE_READY command list.

## Verification

- `npx tsc --noEmit` — clean compile, no errors.
- All references cross-checked: constants, commands, index.

## Notes

- Gotify overlay pre-fills from existing config (re-entry friendly)
- Connection test sends a real message before saving — user knows it works
- The `configure-notify` skill gives future agent sessions full context on config structure, paths, and commands without needing to re-read source
