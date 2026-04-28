---
title: "Brainstorm Missing ask_user References — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Brainstorm Missing ask_user References — Quick Fix

## Bug
The brainstorm skill described interactive Q&A with the user but didn't reference the `ask_user` tool for structured decision points, relying solely on conversational text even for scenarios (approach selection, section approvals) that are a natural fit for `ask_user`.

## Root Cause
The skill was written before `ask_user` existed or wasn't updated when the tool became available. It described "prefer multiple choice" behavior without pointing at the actual tool that implements it.

## Fix
Added explicit `ask_user` references at three decision-gating points:
- **Phase 2:** Use `ask_user` for structured decisions, keep conversational text for open-ended exploration
- **Phase 3:** Use `ask_user` with labeled options and descriptions when presenting approaches
- **Phase 4:** Use `ask_user` for approve/needs-changes/go-back checkpoints after each design section

### Files Modified
- `packages/workflow/skills/brainstorm/SKILL.md` — added `ask_user` references in Phases 2, 3, and 4

## Verification
Reviewed the full skill file to confirm changes are consistent and non-overlapping. Conversational flow preserved for exploration; `ask_user` added only for structured decision points.

## Notes
Open-ended questions like "what problem are we solving?" are better suited to conversational text — `ask_user` is reserved for moments where clear options exist.
