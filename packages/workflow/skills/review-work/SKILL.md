---
name: review-work
description: "Review work — check task completion, run lint/build, mark reviewer remarks. Use after /unipi:work completes."
---

# Reviewing Work

Review what was built, verify task completion, run codebase checks, add reviewer remarks.

## Boundaries

**This skill MAY:** read codebase, run checks (lint, build, test, docker), write reviewer remarks to plan docs, run bash for git operations (checkout worktree branch).
**This skill MAY NOT:** edit code, implement features, create new files.

## Command Format

```
/unipi:review-work plan:<path>(optional) <string(greedy)>(optional)
```

- `plan:<path)` — specific plan to review (auto-suggested)
- `string(greedy)` — scope (e.g., "only review auth tasks" or "just check builds")
- If no plan provided → agent finds latest plan or asks user
- Runs in current session (or worktree session if still active)

---

## Phase 1: Load Plan & Switch Branch

1. If `plan:` arg provided, read that plan
2. If not, list plans in `.unipi/docs/plans/` and ask user
3. Read plan fully — understand tasks, acceptance criteria, current status
4. **Read `workbranch:` from plan frontmatter:**
   - If `workbranch:` exists and is not empty → switch to that branch/worktree
   - If `workbranch:` missing or empty → review on current branch (main)
   - To switch: `git checkout {workbranch}` or use worktree path

**Exit:** On correct branch. Plan loaded.

---

## Phase 2: Check Task Completion

For each task in plan:

1. Read acceptance criteria
2. Verify against actual implementation
3. Determine status:
   - **Done** — all criteria met → `completed:`
   - **Partially Done X/Y** — some steps complete, others not
   - **Unstarted** — nothing done → `unstarted:`
   - **Failed** — attempted but broken → `failed:`
   - **Awaiting User** — needs user action → `awaiting_user:`
   - **Blocked** — waiting on dependency → `blocked:`
   - **Skipped** — intentionally not done → `skipped:`

If `string(greedy)` scope provided, only check matching tasks.

---

## Phase 3: Run Codebase Checks

Run project's verification suite:

1. **Lint** — `npm run lint` or equivalent
2. **Type check** — `tsc --noEmit` or equivalent
3. **Tests** — `npm test` or equivalent
4. **Build** — `npm run build` or equivalent
5. **Docker** — `docker build .` if Dockerfile exists

Report results. If any fail:
- Note which checks failed
- Identify which tasks are affected
- Don't fix — just report

---

## Phase 4: Write Reviewer Remarks

Add `REVIEWER-REMARK` at the **end of the plan document**, behind a divider:

```markdown
---

## Reviewer Remarks

REVIEWER-REMARK: Partially Done 3/5
- Tasks 1-3 complete, verified against acceptance criteria
- Task 4 stuck: API endpoint returns 500, needs investigation
- Task 5 unstarted: depends on Task 4

Codebase Checks:
- ✓ Lint passed
- ✓ Type check passed
- ✗ Tests failed: 2 failing in auth.test.ts
- ✓ Build passed
- ✓ Docker build passed
```

### Status Format

```
REVIEWER-REMARK: <Done | Partially Done X/Y | Unstarted>
```

Followed by description explaining the status.

---

## Phase 5: Handoff

Based on review results:

**If all tasks done and checks pass:**

*If `workbranch` is set (worktree):*
> "All tasks complete and verified. Ready to merge back to main."
```
/unipi:worktree-merge
```

*If `workbranch` is empty (main branch):*
> "All tasks complete and verified. Changes already on main — no merge needed."
```
/unipi:consolidate
```

Either way, user can consolidate learnings:
```
/unipi:consolidate
```

**If tasks incomplete or checks fail:**
> "Tasks remaining and/or checks failing. Continue work?"

*If `workbranch` is set:*
```
/unipi:work worktree:<branch> specs:<plan-path>
```

*If `workbranch` is empty (main):*
```
/unipi:work specs:<plan-path>
```

**If scoped review complete:**
> "Scoped review complete. Run full review or continue work?"
```
/unipi:review-work plan:<plan-path>  (full review)
/unipi:work specs:<plan-path>        (continue work)
```

---

## Notes

- Reviewer remarks append to end of plan — don't modify existing content
- Check results are factual — report pass/fail, don't diagnose
- This is a checkpoint, not a fix pass — work continues via `/unipi:work`
