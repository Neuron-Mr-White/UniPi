---
title: "Notify TUI Theme & Paste Fix"
type: quick-work
date: 2026-04-28
---

# Notify TUI Theme & Paste Fix

## Task
Fix the `notify` package TUI to use the same styling/theme system as `@packages/info-screen/` and fix paste functionality in the Telegram setup wizard.

## Changes
- **tui/settings-overlay.ts**: Added theme support (`setTheme`, `requestRender`), replaced hardcoded ANSI codes with theme-aware helpers (`fg`, `bold`, `frameLine`, `ruleLine`, `borderLine`), wrapped content in bordered dialog UI.
- **tui/telegram-setup.ts**: Added theme support, replaced hardcoded ANSI with theme helpers, wrapped content in bordered dialog UI. Fixed paste by accepting multi-character input and filtering only valid token characters (`[0-9:A-Za-z_-]`), ignoring bracketed paste mode escape sequences.
- **commands.ts**: Updated both command handlers to pass `theme` and `requestRender` to overlay instances.

## Verification
- `npm run typecheck` passes with no errors
- All three files compile correctly

## Notes
- Pattern matches info-screen's TUI structure: bordered dialog with `┌─┐├─│└─┘` box drawing, theme-aware colors via `Theme.fg()` and `Theme.bold()`
- Paste fix handles both raw multi-char paste and bracketed paste mode (`\x1b[200~`) sequences
- No worktree used — changes on current branch
