---
title: "Wire Ralph Loop Guidance into Work/Review Skills"
type: quick-work
date: 2026-04-30
---

# Wire Ralph Loop Guidance into Work/Review Skills

## Task
Wire up the ralph loop coexistence triggers into the `work` and `review-work`
skill prompt files, so the LLM gets contextual, actionable ralph loop guidance at
the right decision points — not just a shallow tool mention prefix.

## Changes
- `packages/workflow/skills/work/SKILL.md`: Added "Ralph Loop Decision" section at end
  of Phase 2 (after plan review). Agent counts non-completed tasks, offers a
  pre-populated `ralph_start({...})` template for 3+ non-trivial tasks. Added
  COMPLETE marker + `ralph_done` guidance at Phase 5 completion.
- `packages/workflow/skills/review-work/SKILL.md`: Added "Ralph Status Check" section
  after Phase 1. Agent checks `.unipi/ralph/` for matching loop state, reads
  state.json and task .md, includes loop context in reviewer remarks.

## Design Rationale
- **Baked into SKILL.md** rather than runtime TypeScript injection. The LLM
  evaluates the decision naturally at the right moment (after counting tasks
  in the plan) with full context. Avoids fragile plan-parsing in TypeScript.
- **Lightweight decision block** — a recommendation, not a command. Single
  template + skip path. No cognitive overhead for small plans.
- **Minimal diff** — 15 lines added to work skill, 6 lines to review-work.

## Verification
- Diff reviewed — correct markdown formatting, placed at correct phase boundaries
- No other skill files or command handlers modified
- Commit: `01bef93`

## Notes
- The shallow `ralphHint` in `commands.ts` ("Ralph detected. Use
  /unipi:ralph-start") stays as-is — it serves as an early awareness signal
  before the agent reaches the deeper decision block in Phase 2
- The `coexist-triggers.md` doc still describes the intended design; the
  SKILL.md edits implement it in practice
