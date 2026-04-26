---
name: worktree-merge
description: "Merge worktree branches back to main. Gathers context from specs/plans, merges, cleans up."
---

# Worktree Merge

Merge completed worktree branches into main. Gather context from docs before merging.

## Process

### Phase 1: Gather Context

Before merging, read existing specs and plans to understand what each worktree was implementing:

1. Read all files in `.unipi/docs/specs/` (if exists)
2. Read all files in `.unipi/docs/plans/` (if exists)
3. Build a map: branch → what it was working on

This context helps during merge conflicts and in the final report.

### Phase 2: Resolve Target Branch

1. Check for `main` branch: `git branch --list main`
2. If not found, check `master`: `git branch --list master`
3. If neither exists, ask user for target branch

### Phase 3: Resolve Source Branches

**If branches provided in args:**
- Verify each branch exists: `git branch --list <name>`
- Check worktree status for each

**If no branches provided:**
- List all worktrees: `git worktree list`
- Filter to `.unipi/worktrees/` paths only
- Show each with status (clean/dirty via `git status`)
- Ask user which to merge

### Phase 4: Merge Each Branch

For each source branch (in dependency order if specs indicate ordering):

1. **Checkout target:** `git checkout main`
2. **Merge:** `git merge <branch> --no-edit`
3. **If conflict:**
   - Report which files conflict
   - Reference the spec/plan context: "This branch was working on: <description>"
   - Ask user how to resolve (do NOT force merge)
   - Skip to next branch if user says so
4. **If success:**
   - Remove worktree: `git worktree remove .unipi/worktrees/<branch-name>`
   - Delete branch: `git branch -d <branch>`
   - Log success with context: "Merged: <what it was doing>"

### Phase 5: Report

```
Merge Summary:
✓ feat/auth — merged (auth system implementation from specs/auth-system.md)
✓ fix/login-bug — merged (login fix from plans/bugfix-login.md)
✗ feat/dashboard — CONFLICT in src/dashboard.ts, skipped

Worktrees cleaned: 2 removed
Branches deleted: 2
```

### Phase 6: Suggest Next

- If all merged cleanly → suggest `/unipi:consolidate` to save learnings
- If conflicts remain → suggest resolving and retrying `/unipi:worktree-merge`
- If specs/plans exist for merged work → suggest `/unipi:document` to update docs

## Important

- ALWAYS read specs/plans before merging — context prevents bad conflict resolution
- NEVER force push or force merge
- Ask user before destructive operations (branch deletion)
- If a worktree has uncommitted changes, warn and skip
