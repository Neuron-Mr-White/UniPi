---
title: "Command Registry Audit and BTW Commands"
type: quick-work
date: 2026-05-16
---

# Command Registry Audit and BTW Commands

## Task
Populate the command registry for all working commands, move BTW slash commands under `/unipi:*`, and make the registration workflow/chore harder to forget.

## Changes
- `packages/btw/extensions/btw.ts`: registered BTW commands as `/unipi:btw`, `/unipi:btw-new`, `/unipi:btw-tangent`, `/unipi:btw-clear`, `/unipi:btw-inject`, `/unipi:btw-summarize` using `UNIPI_PREFIX` and `BTW_COMMANDS`.
- `packages/core/constants.ts`: added `BTW_COMMANDS` and completed `COMPACTOR_COMMANDS` with `session-recall` and `compact-help`.
- `packages/autocomplete/src/constants.ts`: added BTW package metadata and commands, added missing compactor commands, and added missing `cocoindex` label.
- `packages/autocomplete/src/__tests__/command-registry.audit.test.ts`: added a registry audit test that scans registered package commands, rejects non-`unipi:` commands, and checks registry/descriptions/package labels.
- `README.md`, `packages/btw/README.md`, `packages/btw/skills/btw/SKILL.md`, `packages/btw/package.json`: updated BTW docs to `/unipi:btw*` commands.
- `.unipi/docs/chore/full-release.md`, `.unipi/docs/chore/register-extension.md`: replaced fragile manual command-registry checks with the new audit test in release/registration chores.

## Verification
- `npm --workspace packages/autocomplete test -- src/__tests__/command-registry.audit.test.ts`
- `npm --workspace packages/autocomplete test`
- `npm run typecheck`

## Notes
The audit currently verifies 88 registered `/unipi:*` commands mirrored in autocomplete constants and catches bare package commands such as the old `/btw:*` registrations.
