---
name: auto
description: "Full pipeline — brainstorm → plan → work → review → merge. One command, end to end."
---

# Auto Pipeline

Run the complete development pipeline from idea to merged code. This skill is self-contained — it includes all the logic needed to execute each phase without loading other skills.

## Command Format

```
/unipi:auto <string(greedy)>(optional) plan:<path>(optional) specs:<path>(optional)
```

- `string(greedy)` — what to build (triggers full pipeline from brainstorm)
- `plan:<path>` — existing plan to execute (skips brainstorm + plan, starts at work)
- `specs:<path>` — existing spec to plan from (skips brainstorm, starts at plan)
- No args → ask user what to do

## Pipeline Stages

```
brainstorm → plan → work → review → merge
```

Each phase must complete before the next begins. User can intervene at any gate.

---

## Phase 1: Determine Entry Point

Based on args:

**If `string(greedy)` provided (no plan/specs):**
→ Start at Phase 2 (Brainstorm). Full pipeline.

**If `specs:<path>` provided (no plan):**
→ Start at Phase 3 (Plan). Skip brainstorm.

**If `plan:<path>` provided:**
→ Start at Phase 4 (Work). Skip brainstorm + plan.

**If no args:**
→ Ask user:
1. "What do you want to build?" → brainstorm
2. "I have a spec, plan from it" → provide spec path
3. "I have a plan, execute it" → provide plan path
4. "I have a plan, just review + merge" → provide plan path

**Exit:** Entry point determined. Pipeline scope clear.

---

## Phase 2: Brainstorm

### 2.1: Explore Context

1. Run read-only commands to understand current state:
   ```
   find . -type f -name "*.ts" | head -20
   ls -la src/
   cat package.json
   git log --oneline -10
   ```
2. Identify relevant files and patterns
3. Note existing conventions

### 2.2: Ask Clarifying Questions

Ask **one question at a time**:
1. "What problem are we actually solving?"
2. "Who has this problem and when?"
3. "What does success look like?"

Prefer multiple choice when natural options exist.

### 2.3: Propose Approaches

Propose 2-3 approaches with trade-offs:
- What each optimizes for (speed, flexibility, simplicity)
- What each costs (complexity, maintenance, time)
- Recommendation with reasoning

Present conversationally. Ask user to choose.

### 2.4: Design

Once approach chosen, present design in sections:
- Architecture / components
- Data flow
- Error handling
- Testing approach

Ask after each section if it looks right.

### 2.5: Write Spec

Create `.unipi/docs/specs/YYYY-MM-DD-<topic>-design.md`:

```markdown
---
title: "{Topic}"
type: brainstorm
date: YYYY-MM-DD
---

# {Topic}

## Problem Statement
{The actual problem, reframed}

## Context
{Key findings from exploration}

## Chosen Approach
{High-level description}

## Why This Approach
{Decision rationale, alternatives rejected}

## Design
{Architecture, components, data flow}

## Implementation Checklist
- [ ] Task 1 — description
- [ ] Task 2 — description
- [ ] Task 3 — description

## Open Questions
{Questions for planning phase}

## Out of Scope
{Explicitly excluded}
```

### 2.6: Self-Review

Before presenting:
1. Any "TBD", "TODO", incomplete sections? Fix them.
2. Do sections contradict each other?
3. Could any requirement be interpreted two ways? Pick one.

### 2.7: Design Gate

> "Spec written to `.unipi/docs/specs/YYYY-MM-DD-<topic>-design.md`. Please review and let me know if you want changes before we plan."

**WAIT for user approval.** If changes requested, make them and re-review.

**Exit:** User approves design. Proceed to Phase 3.

---

## Phase 3: Plan

### 3.1: Load Spec

1. Read the spec file (from Phase 2 or from `specs:` arg)
2. Understand: problem, approach, design, checklist

### 3.2: Ask Clarifying Questions

1. Review spec critically — identify concerns or gaps
2. If concerns: raise with user before proceeding
3. Ask about work branch:

> "Where should this work happen?"
> 1. **Main branch** — work directly on main (small/medium tasks, low risk)
> 2. **New branch** — isolated worktree (larger tasks, risky changes)

Record the decision for plan frontmatter.

### 3.3: Create Implementation Plan

Create `.unipi/docs/plans/YYYY-MM-DD-<topic>-plan.md`:

```markdown
---
title: "{Topic} — Implementation Plan"
type: plan
date: YYYY-MM-DD
workbranch: {branch-name}   # empty string = work on main branch
specs:
  - path/to/spec.md
---

# {Topic} — Implementation Plan

## Overview
{Brief summary of what this plan covers}

## Tasks

- unstarted: Task 1 — {Task Name}
  - Description: {What needs to be done}
  - Dependencies: {None, or list of tasks}
  - Acceptance Criteria: {How to verify done}
  - Steps:
    1. {Concrete step}
    2. {Concrete step}

- unstarted: Task 2 — {Task Name}
  - Description: ...
  - Dependencies: ...
  - Acceptance Criteria: ...
  - Steps: ...

## Sequencing
{Order of execution, dependency graph if complex}

## Risks
{Potential blockers or concerns}
```

**Task Status Lifecycle:**
| Status | Meaning |
|--------|----------|
| `unstarted:` | Not started |
| `in-progress:` | Being worked on |
| `completed:` | Done and verified |
| `failed:` | Attempted but failed |
| `awaiting_user:` | Needs user action |
| `blocked:` | Waiting on dependency |
| `skipped:` | Intentionally not doing |

### 3.4: Update Spec Checkboxes

After plan is complete:
1. Read the source spec
2. For each checklist item covered by this plan, mark `[x]`
3. Leave items not covered as `[ ]`
4. Write updated spec back

**Semantics:** Spec `[x]` means "planned" (covered by a plan). It does NOT mean "done".

### 3.5: Self-Review

- [ ] Every task has clear acceptance criteria
- [ ] Dependencies are correct (no circular, no missing)
- [ ] Steps are bite-sized (agent can follow without guessing)
- [ ] Plan is focused enough for single work session

### 3.6: Plan Gate

Present plan summary to user.

**WAIT for user approval.** If changes requested, make them.

**Exit:** User approves plan. Proceed to Phase 4.

---

## Phase 4: Work

### 4.1: Setup

1. Read `workbranch` from plan frontmatter
2. If `workbranch` non-empty:
   - Create worktree: `git worktree add .unipi/worktrees/{branch} -b {branch}`
   - Work within worktree directory
3. If `workbranch` empty:
   - Work directly on current branch (main)

### 4.2: Execute Tasks

For each task in order, skip `completed:`, `skipped:`, and `awaiting_user:` tasks:

**If `unstarted:`:**
1. Change `unstarted:` to `in-progress:` in plan
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified in acceptance criteria
4. Change `in-progress:` to `completed:` when complete
5. Update plan file with progress

**If `in-progress:`:**
1. Continue from where it left off
2. Follow remaining steps
3. Change to `completed:` when done

**If `failed:`:**
1. Read failure notes
2. Investigate root cause
3. Fix and re-verify
4. Change to `completed:` when fixed, or keep `failed:` if still broken

**If `awaiting_user:`:**
1. Remind user what's needed
2. Wait for user response
3. Resume when user provides input

**If `blocked:`:**
1. Check if blocker is resolved
2. If resolved → change to `unstarted:` and continue
3. If still blocked → skip and move to next task

### 4.3: When to Stop and Ask

**STOP immediately when:**
- Hit blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps
- You don't understand an instruction
- Verification fails repeatedly

Ask for clarification rather than guessing.

### 4.4: Commit Progress

After each task or group of tasks:
1. Stage changes
2. Commit with descriptive message referencing task name
3. Continue to next task

Don't wait until end to commit — incremental commits are safer.

### 4.5: Work Complete

When all tasks are `completed:`:
1. Run final verification (tests, lint, build)
2. Commit all remaining changes

**Exit:** All tasks complete. Proceed to Phase 5.

---

## Phase 5: Review

### 5.1: Setup

1. Read `workbranch` from plan frontmatter
2. If `workbranch` exists and not empty → switch to that branch/worktree
3. If `workbranch` missing or empty → review on current branch (main)

### 5.2: Check Task Completion

For each task in plan:
1. Read acceptance criteria
2. Verify against actual implementation
3. Determine status:
   - **Done** — all criteria met → `completed:`
   - **Partially Done X/Y** — some steps complete, others not
   - **Unstarted** — nothing done
   - **Failed** — attempted but broken

### 5.3: Run Codebase Checks

Run project's verification suite:
1. **Lint** — `npm run lint` or equivalent
2. **Type check** — `tsc --noEmit` or equivalent
3. **Tests** — `npm test` or equivalent
4. **Build** — `npm run build` or equivalent
5. **Docker** — `docker build .` if Dockerfile exists

Report results. If any fail:
- Note which checks failed
- Identify which tasks are affected

### 5.4: Write Reviewer Remarks

Add `REVIEWER-REMARK` at the **end of the plan document**, behind a divider:

```markdown
---

## Reviewer Remarks

REVIEWER-REMARK: Done
- All tasks complete, verified against acceptance criteria

Codebase Checks:
- ✓ Lint passed
- ✓ Type check passed
- ✓ Tests passed
- ✓ Build passed
```

### 5.5: Review Gate

**If all tasks done and checks pass:**
→ Proceed to Phase 6

**If tasks incomplete or checks fail:**
> "Tasks remaining and/or checks failing. Continuing back to work phase."
→ Go back to Phase 4 with failure context

**Exit:** All checks pass. Reviewer remarks say Done. Proceed to Phase 6.

---

## Phase 6: Merge (if worktree)

### 6.1: Check Branch Strategy

If `workbranch` was set (worktree):
1. Load worktree-merge logic
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

✓ Brainstorm — .unipi/docs/specs/{spec}
✓ Plan — .unipi/docs/plans/{plan}
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

## Coexist Triggers

When packages are present, auto pipeline enhances:

| Package | Enhancement |
|---------|-------------|
| `@unipi/ask-user` | Use `ask_user` for decision gates |
| `@unipi/subagents` | Parallel task execution in work phase |
| `@unipi/mcp` | MCP tools available throughout |
| `@unipi/web-api` | Web research in brainstorm phase |
| `@unipi/ralph` | Ralph loop for 3+ tasks in work phase |

---

## Notes

- This skill is self-contained — no need to load other skills
- Gates between phases ensure user oversight
- Pipeline is resumable — can restart from any phase
- Worktree isolation protects main branch (skipped for small tasks)
- Auto command has `full` sandbox — all tools available
