---
name: worktree-create
description: "Create git worktree for parallel work. Agent-driven naming."
---

# Creating Worktrees

Create a git worktree for isolated parallel work.

## Boundaries

**This skill MAY:** run git worktree commands, ask user for branch name, suggest names.
**This skill MAY NOT:** edit code, run tests, implement features.

## Command Format

```
/unipi:worktree-create <string(greedy)>
```

- `string(greedy)` — description or desired branch name
- Agent asks user for exact name or suggests based on description

---

## Process

### Phase 1: Parse Input

1. Read the string input
2. Assess if it's a branch name or a description:
   - Branch name: `feat/auth`, `fix/login-bug` → use directly
   - Description: "add user authentication" → suggest name

### Phase 2: Name Resolution

**If clear branch name:**
> "Creating worktree on branch `feat/auth`. Confirm?"

**If description:**
> "Based on your description, I suggest: `feat/user-auth`. What name would you like?"

Let user confirm or provide different name.

### Phase 3: Create Worktree

1. Check if branch already exists (local or remote)
2. If exists: ask user if they want to reuse or create new
3. Create worktree:
   ```bash
   git worktree add .unipi/worktrees/<branch> -b <branch>
   ```
4. Verify creation succeeded

### Phase 4: Confirm

Report:
> "Worktree created: `.unipi/worktrees/<branch>` (branch: `<branch>`)"
> "To work in this worktree: `/unipi:work worktree:<branch> specs:<plan>`"

---

## Notes

- Worktrees stored in `.unipi/worktrees/` directory
- Each worktree is a full working copy with its own branch
- Multiple worktrees can exist for parallel work
- Use `/unipi:worktree-list` to see all worktrees
- Use `/unipi:worktree-merge` to merge back to main
