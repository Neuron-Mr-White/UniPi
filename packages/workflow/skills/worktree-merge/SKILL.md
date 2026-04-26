---
name: worktree-merge
description: "Merge worktrees back to main branch. Multi-branch support with auto-suggest."
---

# Merging Worktrees

Merge completed worktree branches back into main.

## Boundaries

**This skill MAY:** run git merge, git branch, git worktree commands, ask user for confirmation.
**This skill MAY NOT:** edit code, implement features, force push.

## Command Format

```
/unipi:worktree-merge <branch>(multiple,optional) <string(greedy)>(optional)
```

- `<branch>` — one or more branches to merge (auto-suggested from worktree-list)
- `string(greedy)` — optional context (e.g., "merge all clean worktrees" or "merge auth first")
- If no branches provided → agent lists worktrees and asks user to select

---

## Process

### Phase 1: Resolve Target Branch

1. Check for `main` branch
2. If no `main`, check for `master`
3. If neither exists:
   > "No main or master branch found. Which branch should I merge into?"
   - Ask user for target branch

**Exit:** Target branch identified (e.g., `main`).

### Phase 2: Resolve Source Branches

If branches provided in args:
1. Verify each branch exists
2. Check for uncommitted changes in worktree
3. Warn if dirty: "Branch `feat/auth` has uncommitted changes. Commit first?"

If no branches provided:
1. List all unipi worktrees
2. Show status (clean/dirty)
3. Ask user to select which to merge

**Exit:** Source branch(es) confirmed, all clean.

### Phase 3: Merge

For each source branch:

1. Switch to target branch (`git checkout main`)
2. Merge source branch (`git merge feat/auth`)
3. Handle conflicts if any:
   - Report conflicts clearly
   - Ask user how to resolve
   - Don't force-merge
4. If merge succeeds:
   - Remove worktree (`git worktree remove .unipi/worktrees/feat/auth`)
   - Delete branch if user confirms (`git branch -d feat/auth`)

### Phase 4: Report

Summary:
```
Merged 2 worktrees into main:
✓ feat/auth — merged successfully, worktree removed
✓ fix/login-bug — merged successfully, worktree removed
```

Or if issues:
```
Merged 1 of 2 worktrees:
✓ feat/auth — merged successfully
✗ fix/login-bug — CONFLICT in src/auth.ts, needs manual resolution
```

### Phase 5: Suggest Next

After merge:
- If all merged → suggest `/unipi:consolidate` to capture learnings
- If conflicts remain → suggest resolving and retrying
- If partial merge → suggest `/unipi:worktree-merge` for remaining

---

## Notes

- Merges are standard git merges — no rebasing by default
- Worktree removal keeps filesystem clean
- Branch deletion is optional — ask user
- Conflicts require human intervention — don't force
- Order matters if branches depend on each other
