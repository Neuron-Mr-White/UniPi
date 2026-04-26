---
name: worktree-list
description: "List all unipi worktrees. Shows branch, path, and status."
---

# Listing Worktrees

List all git worktrees created by unipi.

## Boundaries

**This skill MAY:** read filesystem (ls, read), grep for git info.
**This skill MAY NOT:** edit anything, create worktrees, merge branches, run bash.

## Command Format

```
/unipi:worktree-list
```

No arguments. Lists all unipi worktrees.

---

## Process

### Phase 1: Discover Worktrees

1. `ls .unipi/worktrees/` — list worktree directories
2. For each directory:
   - Read `.unipi/worktrees/<branch>/.git` file to get gitdir path
   - Check for uncommitted changes: `ls .unipi/worktrees/<branch>/` and read key files
3. If `.unipi/worktrees/` doesn't exist or is empty → no worktrees

**Exit:** List of worktrees discovered.

### Phase 2: Determine Status

For each worktree directory:

1. Check if `HEAD` file exists in gitdir
2. Check for modified files by reading directory listing
3. Determine status:
   - **clean** — no uncommitted changes
   - **dirty** — has uncommitted changes

### Phase 3: Present

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

### Phase 4: Suggest Actions

Based on state:
- If dirty worktrees exist → suggest reviewing or committing
- If clean worktrees exist → suggest working or merging
- Always available: `/unipi:worktree-create`, `/unipi:worktree-merge`

---

## Notes

- Only shows worktrees under `.unipi/worktrees/`
- Ignores worktrees in other locations
- Status: `clean` = no uncommitted changes, `dirty` = has changes
- No bash required — uses ls, read, grep for all discovery
