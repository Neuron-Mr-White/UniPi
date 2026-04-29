---
title: "Workflow Convention Fixes & Sandbox Improvements"
type: brainstorm
date: 2026-04-29
---

# Workflow Convention Fixes & Sandbox Improvements

## Problem Statement

The `@pi-unipi/workflow` package has 10 convention inconsistencies: prefix mismatches between skill docs and autocomplete, sandbox levels that don't match skill capabilities, missing output directories, and documentation typos. These cause agent confusion and broken handoffs between workflow steps.

## Context

Gathered via `/unipi:gather-context` on 2026-04-29. Key findings:

1. `work` and `review-work` skills say `specs:<path>` but autocomplete returns `plan:<filename>` — prefix mismatch
2. `research` skill claims bash access but sandbox maps to `read_only` (no bash)
3. `gather-context` has no write access — can't save findings
4. `scan-issues` has no bash — limited investigation capability
5. `brainstorm` sandbox has bash but shouldn't need it
6. `debug` sandbox has no bash — can't run diagnostic commands
7. `full` sandbox missing `grep`, `find`, `ls`
8. README has typo `/ununi:worktree-merge`
9. `review-work` skill has typo `plan:<path)`
10. No `.unipi/docs/research/` or `.unipi/docs/context-gathered/` directories

## Chosen Approach

Fix all bugs, establish consistent prefix convention (`specs:` for spec files, `plan:` for plan files), redesign sandbox levels to match actual command needs, and add missing output directories.

## Why This Approach

- Prefix convention matches the natural workflow flow: brainstorm→specs→plan→plans→work
- Sandbox levels should reflect what each command actually needs, not arbitrary groupings
- Every command that produces output should have a dedicated directory
- Typos and mismatches erode trust in the system — fix them all at once

## Design

### Sandbox Levels (Proposed)

| Level | Purpose | Tools |
|-------|---------|-------|
| `read_only` | Pure research, no side effects | `read`, `grep`, `find`, `ls` |
| `research` | Deep investigation with web + history | `read`, `grep`, `find`, `ls`, `bash`, `web_search`, `web_read`, `web_fetch`, `batch_web_fetch`, `web_llm_summarize` |
| `brainstorm` | Explore + write specs only | `read`, `grep`, `find`, `ls`, `write`, `ask_user` |
| `write_unipi` | Read + write/edit docs only | `read`, `write`, `edit`, `grep`, `find`, `ls`, `ask_user` |
| `debug` | Diagnose, write debug report | `read`, `grep`, `find`, `ls`, `write`, `bash`, `ask_user` |
| `review` | Read code + run checks | `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `ask_user` |
| `full` | Everything | all tools |

### Command → Sandbox Level Mapping

| Command | Level |
|---------|-------|
| `brainstorm` | `brainstorm` |
| `plan` | `write_unipi` |
| `work` | `full` |
| `review-work` | `review` |
| `consolidate` | `write_unipi` |
| `worktree-create` | `full` |
| `worktree-list` | `read_only` |
| `worktree-merge` | `full` |
| `consultant` | `read_only` |
| `quick-work` | `full` |
| `gather-context` | `research` |
| `document` | `write_unipi` |
| `scan-issues` | `research` |
| `auto` | `full` |
| `debug` | `debug` |
| `fix` | `full` |
| `quick-fix` | `full` |
| `research` | `research` |
| `chore-create` | `write_unipi` |
| `chore-execute` | `full` |

### Prefix Convention

| Prefix | Content | Source |
|--------|---------|--------|
| `specs:` | Design spec files | `/unipi:brainstorm` output |
| `plan:` | Implementation plan files | `/unipi:plan` output |

Flow: `brainstorm` → `specs:*` → `plan` → `plan:*` → `work` → `plan:*` → `review-work`

### New Directories

- `.unipi/docs/research/` — research reports from `/unipi:research`
- `.unipi/docs/context-gathered/` — gathered context from `/unipi:gather-context`

## Implementation Checklist

- [x] Add `research` sandbox level to sandbox.ts
- [x] Update sandbox mappings for all commands in sandbox.ts
- [x] Add `RESEARCH` and `CONTEXT_GATHERED` to UNIPI_DIRS in constants.ts
- [x] Fix `work` skill: `specs:<path>` → `plan:<path>` in SKILL.md
- [x] Fix `review-work` skill: `specs:<path>` → `plan:<path>` and typo `plan:<path)` → `plan:<path>` in SKILL.md
- [x] Fix `research` skill: update sandbox references, add output path in SKILL.md
- [x] Fix `gather-context` skill: add write capability, add output path in SKILL.md
- [x] Fix `scan-issues` skill: update sandbox references in SKILL.md
- [x] Fix `brainstorm` skill: remove bash references in SKILL.md
- [x] Fix `debug` skill: add bash references in SKILL.md
- [x] Fix `auto` skill: update handoff path formats in SKILL.md
- [x] Fix `plan` skill: update handoff path format in SKILL.md
- [x] Fix README typo `/ununi:` → `/unipi:` in README.md
- [x] Update workflow index.ts sandbox injection messages
- [x] Add `suggestResearchFiles` and `suggestGatheredFiles` autocomplete to commands.ts
- [x] Add new directories to `initUnipiDirs` in core utils

## Open Questions

- Should `consolidate` get memory tools access in the sandbox?
- Should `debug` get web tools for researching error messages?

## Out of Scope

- Refactoring the sandbox filtering mechanism (pi.on tool_call filter)
- Adding sandbox enforcement for non-file tools (web, compactor, memory)
- Changing the command registration API
