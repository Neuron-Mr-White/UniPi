---
name: quick-work
description: "Fast single-task execution — one shot, done. Use for small tasks that don't need full brainstorm/plan/work flow."
---

# Quick Work

Execute a single task directly. No brainstorm, no plan — just do it and record what happened.

## Boundaries

**This skill MAY:** read/write code, run tests, commit, write summary to `.unipi/docs/quick-work/`.
**This skill MAY NOT:** create worktrees, merge branches, deploy.

## Command Format

```
/unipi:quick-work <string(greedy)>
```

- `string(greedy)` — what to do (e.g., "add input validation to login form", "fix the typo in README")
- Full read/write sandbox
- One shot — complete the task in this session

---

## Process

### Phase 1: Understand Task

1. Read the request
2. If unclear, ask one clarifying question
3. Assess scope — is this truly a quick task?
   - If too complex → suggest `/unipi:brainstorm` instead
   - If appropriate → proceed

**Exit:** Task understood, scoped appropriately.

### Phase 2: Execute

1. Find relevant files
2. Make the changes
3. Verify (run tests if applicable)
4. Commit with descriptive message

Straightforward — no planning, no discussion, just work.

**Exit:** Task complete.

### Phase 3: Write Summary

Write summary to `.unipi/docs/quick-work/YYYY-MM-DD-<topic>.md`:

```markdown
---
title: "{Topic}"
type: quick-work
date: YYYY-MM-DD
---

# {Topic}

## Task
{What was requested}

## Changes
- {File 1}: {what changed}
- {File 2}: {what changed}

## Verification
{How it was tested — "ran tests", "manual check", etc.}

## Notes
{Anything worth noting — gotchas, follow-ups, etc.}
```

### Phase 4: Report

> "Done. Changes committed. Summary at `.unipi/docs/quick-work/YYYY-MM-DD-<topic>.md`"

No further suggestions needed — this was a one-shot task.

---

## When to Use Quick Work vs Full Flow

**Use quick-work for:**
- Bug fixes (small, clear)
- Typo corrections
- Config changes
- Small feature additions (< 30 min work)
- Dependency updates

**Use full flow (brainstorm/plan/work) for:**
- New features
- Architecture changes
- Multi-file refactors
- Anything with design decisions
- Tasks requiring discussion

When in doubt, start with quick-work. If it gets complex, suggest switching to full flow.

---

## Notes

- No worktree isolation — works on current branch
- No planning overhead — direct execution
- Summary provides record of what was done
- Task should be completable in one session
