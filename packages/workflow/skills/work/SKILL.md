---
name: work
description: "Execute plan — implement in worktree, test, commit on done. Resumable across sessions."
---

# Executing Plans

Load plan, review critically, execute tasks, commit when complete.

## Boundaries

**This skill MAY:** read/write code in worktree, read/write `.unipi/docs/`, run tests, commit, create worktree.
**This skill MAY NOT:** modify files outside worktree, merge branches, deploy.

## Command Format

```
/unipi:work worktree:<branch>(optional) specs:<path>(multiple,optional) <string(greedy)>(optional)
```

- `worktree:<branch>` — branch to work on (auto-suggested, agent asks if not provided)
- `specs:<path>` — plan(s) to execute (auto-suggested, agent asks if not provided)
- `string(greedy)` — scope guidance (e.g., "only task 1 and 2")
- **Recommended: new session** — this command switches pi's internal worktree

## Sandbox

- **Read/Write:** full access within worktree directory
- **Write:** `.unipi/docs/` for progress tracking
- **Cannot:** modify files outside worktree

---

## Phase 1: Resolve Args

If args not provided, ask user interactively:

1. **Worktree:**
   - "Do you want to work on current branch or create a worktree?"
   - If worktree: "What branch name?" (suggest based on spec topic)
   - Create worktree if not exists
   - **After creating/confirming worktree:** write `workbranch: {branch-name}` to the plan file frontmatter

2. **Specs:**
   - List available plans in `.unipi/docs/plans/`
   - "Which plan(s) to execute?"
   - Can select multiple

3. **Scope:**
   - If `string(greedy)` provided, use to scope tasks
   - Otherwise execute all incomplete tasks

**Exit:** Worktree set, plan(s) loaded, scope defined.

---

## Phase 2: Review Plan

1. Read plan file(s)
2. Review critically — identify questions or concerns
3. If concerns: raise with user before starting
4. Identify task status: `unstarted:` (pending), `in-progress:` (started), `completed:` (done), `failed:` (needs investigation), `awaiting_user:` (needs user action), `blocked:` (waiting on dependency), `skipped:` (deferred)

**Exit:** Plan reviewed, ready to execute.

---

## Phase 3: Execute Tasks

For each task in order, skip `completed:`, `skipped:`, and `awaiting_user:` tasks:

### If `unstarted:`
1. Change `unstarted:` to `in-progress:` in plan
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified in acceptance criteria
4. Change `in-progress:` to `completed:` when complete
5. Update plan file with progress

### If `in-progress:`
1. Continue from where it left off
2. Follow remaining steps
3. Change to `completed:` when done

### If `failed:`
1. Read failure notes
2. Investigate root cause
3. Fix and re-verify
4. Change to `completed:` when fixed, or keep `failed:` if still broken

### If `awaiting_user:`
1. Remind user what's needed
2. Wait for user response
3. Resume when user provides input

### If `blocked:`
1. Check if blocker is resolved
2. If resolved → change to `unstarted:` and continue
3. If still blocked → skip and move to next task

### When to Stop and Ask

**STOP immediately when:**
- Hit blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps
- You don't understand an instruction
- Verification fails repeatedly

Ask for clarification rather than guessing.

### When to Revisit Earlier Steps

**Return to review when:**
- Partner updates plan based on feedback
- Fundamental approach needs rethinking

Don't force through blockers — stop and ask.

---

## Phase 4: Commit Progress

After each task or group of tasks:
1. Stage changes
2. Commit with descriptive message referencing task name
3. Continue to next task

Don't wait until end to commit — incremental commits are safer.

---

## Phase 5: Complete

When all tasks are `completed:`:

1. Run final verification (tests, lint, build)
2. Commit all remaining changes
3. Inform user:

> "All tasks complete. Worktree: `feat/<branch>`. Recommend reviewing before merge."

Suggest next step:
```
/unipi:review-work plan:<plan-path>
```

**Recommend starting a new session** for review.

---

## Resumability

If user runs `/unipi:work` and plan has `completed:` or `in-progress:` tasks:
1. Read plan
2. Identify first `unstarted:` task
3. Ask user: "Resume from Task N: {name}?"
4. Continue from there

If user provides scope string, only execute matching tasks.

---

## Notes

- Agent reads plan regardlessly on start — finds what's incomplete
- Worktree isolation: changes don't affect main branch until merge
- Each worktree session is independent — no coordination with other worktrees
