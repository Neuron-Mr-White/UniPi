---
name: work
description: "Execute plan — implement tasks, test, commit on done. Works in worktree or on main branch. Resumable."
---

# Executing Plans

Load plan, review critically, execute tasks, commit when complete.

## Boundaries

**This skill MAY:** read/write code, read/write `.unipi/docs/`, run tests, commit, create worktree.
**This skill MAY NOT:** merge branches, deploy.

**Worktree vs Main:**
- If `workbranch` in plan → work within worktree directory
- If `workbranch` empty → work directly on main branch (current directory)

## Command Format

```
/unipi:work worktree:<branch>(optional) specs:<path>(multiple,optional) <string(greedy)>(optional)
```

- `worktree:<branch>` — branch to work on (auto-suggested, agent asks if not provided)
- `specs:<path>` — plan(s) to execute (auto-suggested, agent asks if not provided)
- `string(greedy)` — scope guidance (e.g., "only task 1 and 2")
- **Recommended: new session** — this command switches pi's internal worktree

## Sandbox

- **Read/Write:** full access within worktree (or project root if on main)
- **Write:** `.unipi/docs/` for progress tracking

---

## Phase 1: Resolve Args

1. **Specs:**
   - If `specs:` arg provided, read those plan files
   - If not, list available plans in `.unipi/docs/plans/` and ask user
   - Can select multiple

2. **Read `workbranch` from plan frontmatter:**
   - If `workbranch:` is **non-empty** → use that branch/worktree
     - If worktree arg also provided → use worktree arg (override)
     - Create worktree if not exists: `git worktree add .unipi/worktrees/{branch} -b {branch}`
     - Work within worktree directory
   - If `workbranch:` is **empty or missing** → work on current branch (main)
     - No worktree creation needed
     - Edit files directly in project root
   - If neither plan nor args specify branch → ask user:
     > "Where should this work happen?"
     > 1. Current branch (main)
     > 2. New worktree (provide branch name)

3. **Scope:**
   - If `string(greedy)` provided, use to scope tasks
   - Otherwise execute all incomplete tasks

**Exit:** Branch/worktree resolved. Plan(s) loaded. Scope defined.

---

## Phase 2: Review Plan

1. Read plan file(s)
2. Review critically — identify questions or concerns
3. If concerns: raise with user before starting
4. Identify task status: `unstarted:` (pending), `in-progress:` (started), `completed:` (done), `failed:` (needs investigation), `awaiting_user:` (needs user action), `blocked:` (waiting on dependency), `skipped:` (deferred)

**Exit:** Plan reviewed, ready to execute.

### Ralph Loop Decision

Count the non-completed tasks (`unstarted:`, `in-progress:`, `failed:`). If you have the `ralph_start` tool available and 3+ non-trivial tasks remain, consider a ralph loop for resilience:

```
ralph_start({
  name: "{plan-topic}",
  taskContent: "# {Plan Title}\n\n{overview}\n\n## Goals\n- {goal1}\n- {goal2}\n\n## Checklist\n- [ ] {task1}\n- [ ] {task2}\n- [ ] {task3}",
  maxIterations: 50,
  itemsPerIteration: 2,
  reflectEvery: 5
})
```

**To skip:** Just proceed to Phase 3 and execute tasks directly. Ralph is a helper, not a requirement.

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
3. If using a ralph loop, emit `COMPLETE` and call `ralph_done` to cleanly exit
4. Inform user based on branch strategy:

**If working in worktree:**
> "All tasks complete. Worktree: `{branch}`. Recommend reviewing before merge."
```
/unipi:review-work plan:<plan-path>
```
**Recommend starting a new session** for review.

**If working on main branch:**
> "All tasks complete. All changes committed directly on main."
```
/unipi:review-work plan:<plan-path>
```
No merge needed — changes already on main.

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

- Agent reads plan on start — finds what's incomplete
- Worktree: changes don't affect main branch until merge (skip for small tasks)
- Main branch: changes committed directly, no merge needed
- Each worktree session is independent — no coordination with other worktrees
