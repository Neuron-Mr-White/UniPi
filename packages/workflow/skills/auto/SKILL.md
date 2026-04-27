---
name: auto
description: "Full pipeline — brainstorm → plan → work → review → merge. One command, end to end."
---

# Auto Pipeline

Run the complete development pipeline from idea to merged code.

## Command Format

```
/unipi:auto <description>(optional) plan:<path>(optional) specs:<path>(optional)
```

- `description` — what to build (triggers brainstorm first)
- `plan:<path>` — existing plan to execute (skips brainstorm + plan, starts at work)
- `specs:<path>` — existing spec to plan from (skips brainstorm, starts at plan)
- No args → ask user what to do

## Pipeline Stages

```
brainstorm → plan → work → review → merge
```

Each stage hands off to the next automatically. User can intervene at any gate.

---

## Phase 1: Determine Entry Point

Based on args:

**If `description` provided (no plan/specs):**
→ Start at brainstorm. Full pipeline.

**If `specs:<path>` provided (no plan):**
→ Start at plan. Skip brainstorm.

**If `plan:<path>` provided:**
→ Start at work. Skip brainstorm + plan.

**If no args:**
→ Ask user:
1. "What do you want to build?" → brainstorm
2. "I have a spec, plan from it" → provide spec path
3. "I have a plan, execute it" → provide plan path
4. "I have a plan, just review + merge" → provide plan path

**Exit:** Entry point determined. Pipeline scope clear.

---

## Phase 2: Brainstorm (if needed)

1. Load brainstorm skill content
2. Run full brainstorm flow — explore, question, design, write spec
3. Wait for user approval at design gate
4. On approval → proceed to plan

**Gate:** User must approve design before continuing.

---

## Phase 3: Plan (if needed)

1. Load plan skill content
2. Create implementation plan from spec
3. Present plan to user
4. On approval → proceed to work

**Gate:** User must approve plan before continuing.

---

## Phase 4: Work (if needed)

1. Read `workbranch` from plan frontmatter
2. If `workbranch` non-empty → create worktree, work within it
3. If `workbranch` empty → work directly on main branch
4. Load work skill content
5. Execute all tasks in the plan
6. Commit incrementally
7. On completion → proceed to review

**Gate:** All tasks must complete. If blocked → stop and ask.

---

## Phase 5: Review

1. Load review-work skill content
2. Read `workbranch` from plan — switch to branch if set, else review on main
3. Check task completion against acceptance criteria
4. Run codebase checks (lint, type check, test, build)
5. Write reviewer remarks to plan

**If review passes:** → proceed to merge (or skip if on main)
**If review fails:** → go back to work (Phase 4) with failure context

**Gate:** All checks must pass. Reviewer remarks must say Done.

---

## Phase 6: Merge (if worktree)

If `workbranch` was set (worktree):
1. Load worktree-merge skill content
2. Merge worktree branch back to main
3. Clean up worktree and branch
4. Run final verification on main

If `workbranch` was empty (main branch):
→ Skip merge — changes already on main.

**Exit:** Code on main. Worktree cleaned (if applicable).

---

## Phase 7: Summary

Report pipeline results:

```
Pipeline Complete: {topic}

✓ Brainstorm — {spec-path}
✓ Plan — {plan-path}
✓ Work — {N} tasks completed on {branch or "main"}
✓ Review — all checks passed
✓ Merge — {merged to main, worktree cleaned or "already on main"}

Artifacts:
- Spec: .unipi/docs/specs/{spec}
- Plan: .unipi/docs/plans/{plan}
```

Suggest next steps:
- `/unipi:consolidate` — save learnings
- `/unipi:scan-issues` — deeper code review
- `/unipi:document` — generate docs

---

## Interruption Handling

If any phase fails or user interrupts:

1. Record current phase and progress
2. Suggest resuming from the failed phase
3. Don't lose context — spec/plan/progress preserved

Example:
> "Pipeline paused at review phase. 3/5 tasks complete, tests failing.
> Resume with: `/unipi:auto plan:<plan-path>`"

---

## Notes

- Each phase loads its skill content dynamically
- Gates between phases ensure user oversight
- Pipeline is resumable — can restart from any phase
- Worktree isolation protects main branch (skipped for small tasks — work directly on main)
- Auto command has `full` sandbox — all tools available
