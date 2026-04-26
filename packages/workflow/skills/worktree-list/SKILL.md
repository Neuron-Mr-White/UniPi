---
name: worktree-list
description: "List all unipi worktrees. Shows branch, path, and status."
---

# Listing Worktrees

List all git worktrees created by unipi.

## Boundaries

**This skill MAY:** run git worktree commands, read filesystem.
**This skill MAY NOT:** edit anything, create worktrees, merge branches.

## Command Format

```
/unipi:worktree-list
```

No arguments. Lists all unipi worktrees.

---

## Process

### Phase 1: Gather Worktrees

1. Run `git worktree list --porcelain`
2. Filter for worktrees under `.unipi/worktrees/`
3. For each worktree, collect:
   - Branch name
   - Path
   - HEAD commit
   - Whether it has uncommitted changes

### Phase 2: Present

Display in table format:

```
Worktrees:
┌──────────────────┬────────────────────────────────┬─────────┐
│ Branch           │ Path                           │ Status  │
├──────────────────┼────────────────────────────────┼─────────┤
│ feat/auth        │ .unipi/worktrees/feat/auth     │ clean   │
│ fix/login-bug    │ .unipi/worktrees/fix/login-bug │ dirty   │
└──────────────────┴────────────────────────────────┴─────────┘
```

If no worktrees:
> "No unipi worktrees. Create one with `/unipi:worktree-create`"

### Phase 3: Suggest Actions

Based on state:
- If dirty worktrees exist → suggest reviewing or committing
- If clean worktrees exist → suggest working or merging
- Always available: `/unipi:worktree-create`, `/unipi:worktree-merge`

---

## Notes

- Only shows worktrees under `.unipi/worktrees/`
- Ignores worktrees in other locations
- Status: `clean` = no uncommitted changes, `dirty` = has changes
