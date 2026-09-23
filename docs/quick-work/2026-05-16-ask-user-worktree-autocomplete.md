---
title: "Ask User History Expansion and Worktree Autocomplete Cache"
type: quick-work
date: 2026-05-16
---

# Ask User History Expansion and Worktree Autocomplete Cache

## Task
Fix two quick-work items:
- Ask user extension cannot Ctrl+O to expand what was previously answered and what the previous questions were.
- Worktree merge auto suggestion is slow and should be cached on first call.

## Changes
- `packages/ask-user/ask-ui.ts`: render ask_user results with collapsed answer plus a Ctrl+O hint, and expanded question/context/options details.
- `packages/ask-user/tools.ts`: persist richer ask_user result details (`context`, normalized options, mode flags) so expanded historical results have enough data to display prior questions and options.
- `packages/workflow/commands.ts`: memoize worktree autocomplete suggestions per current working directory so recursive worktree scanning is paid only once per session/cwd.

## Verification
- Ran `npm run typecheck`.
- Ran `npm test --workspace @pi-unipi/ask-user`.

## Notes
- Worktree suggestions are cached in-memory per cwd for the Pi process; restarting Pi refreshes them.
