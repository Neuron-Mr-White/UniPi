---
name: plan
description: "Strategic planning — create implementation plan from brainstorm specs. Tasks, dependencies, acceptance criteria."
---

# Planning From Specs

Turn brainstorm decisions into an actionable implementation plan.

## Boundaries

**This skill MAY:** read specs, read codebase, ask questions, write plan document, update brainstorm checkboxes.
**This skill MAY NOT:** edit code, implement anything, run tests, deploy.

**NEVER write code during this skill. This is planning, not implementation.**

## Command Format

```
/unipi:plan specs:<path>(multiple,optional) <string(greedy)>(optional)
```

- `specs:<path>` — one or more brainstorm specs to plan from (auto-suggested)
- `string(greedy)` — optional scope guidance (e.g., "focus on API layer only")
- If no specs provided → agent asks user which spec to plan from
- Runs in current session, read-only sandbox + write to `.unipi/docs/`

## Sandbox

- **Read:** full codebase access for context
- **Write:** only `.unipi/docs/` directory

## Output Path

```
.unipi/docs/plans/YYYY-MM-DD-<topic>-plan.md
```

Committed to current branch.

---

## Phase 1: Load Specs

1. If `specs:` arg provided, read those spec files
2. If not provided, list available specs in `.unipi/docs/specs/` and ask user to choose
3. Read the spec(s) fully — understand problem, approach, design, checklist

**Exit:** Spec(s) loaded. Understand what to plan.

---

## Phase 2: Review & Ask

1. Review spec critically — identify concerns or gaps
2. If concerns: raise with user before proceeding
3. If `string(greedy)` provided: use it to scope planning (e.g., "focus on auth only")
4. Ask clarifying questions if needed (one at a time)

**Exit:** No blockers. Ready to plan.

---

## Phase 3: Create Implementation Plan

Structure the plan with heart of gold style:

```markdown
---
title: "{Topic} — Implementation Plan"
type: plan
date: YYYY-MM-DD
workbranch: {branch-name or empty if on main}
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

### Task Guidelines

- Each task should be **discrete and completable** in one session
- **Dependencies** must be explicit — task B can't start before task A
- **Acceptance criteria** must be verifiable — not "looks good" but "tests pass, builds clean"
- **Steps** are bite-sized — agent can follow without guessing
- Order tasks by dependency (foundational work first)

### Task Status Lifecycle

Tasks use prefixes to track progress:

| Status | Meaning |
|--------|----------|
| `unstarted:` | Not started |
| `in-progress:` | Being worked on |
| `completed:` | Done and verified |
| `failed:` | Attempted but failed, needs investigation |
| `awaiting_user:` | Needs user action (test, approve, provide input) |
| `blocked:` | Waiting on dependency or external factor |
| `skipped:` | Intentionally not doing (deferred, out of scope) |

---

## Phase 4: Update Brainstorm Checkboxes

After plan is complete:

1. Read the source brainstorm spec(s)
2. For each checklist item covered by this plan, mark `[x]`
3. Leave items not covered as `[ ]`
4. Write updated spec back

**Example:**
```markdown
## Implementation Checklist
- [x] Set up auth middleware — covered in Task 1
- [x] Create login endpoint — covered in Task 2
- [ ] Add OAuth support — deferred to next plan
- [ ] Rate limiting — out of scope
```

This creates the link between brainstorm and plan — plan covers some items, others remain for future plans.

**Semantics:** Spec `[x]` means "planned" (covered by a plan). It does NOT mean "done". Implementation progress is tracked in the plan file, not the spec.

---

## Phase 5: Review Plan

Self-check before presenting:

- [ ] Every task has clear acceptance criteria
- [ ] Dependencies are correct (no circular, no missing)
- [ ] Steps are bite-sized (agent can follow without guessing)
- [ ] String greedy scope respected (if provided)
- [ ] Plan is focused enough for single `/unipi:work` session

Do NOT re-read or re-edit the spec checkboxes — Phase 4 already wrote them.

---

## Phase 6: Present & Handoff

Present plan summary to user. Then ask:

1. **Proceed to /unipi:work** — Start implementing in a worktree
2. **Revise plan** — Adjust tasks or scope
3. **Done for now** — Return later

If user selects "Proceed to /unipi:work", suggest:
```
/unipi:work worktree:feat/<branch-name> specs:YYYY-MM-DD-<topic>-plan
```

Recommend starting a **new session** for work — it will switch pi's internal worktree.

---

## Resumability

If user runs `/unipi:plan` on an existing plan:
1. Read the plan — look for `completed:` tasks
2. Ask user if they want to add tasks, modify existing, or plan new scope
