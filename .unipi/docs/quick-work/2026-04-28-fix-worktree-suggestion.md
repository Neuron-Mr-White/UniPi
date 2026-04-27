---
title: "Fix worktree suggestion for nested structures"
type: quick-work
date: 2026-04-28
---

# Fix worktree suggestion for nested structures

## Task
Fix `suggestWorktrees()` function in `packages/workflow/commands.ts` that only read one level deep in `.unipi/worktrees/`, causing it to return "feat" instead of actual branch names like "compactor" or "notify" when worktrees were nested.

## Changes
- `packages/workflow/commands.ts`: Rewrote `suggestWorktrees()` to recursively scan for actual git worktrees by looking for `.git` files and extracting branch names from the gitdir path.

## Verification
- TypeScript compilation: `npx tsc --noEmit` passes cleanly
- The function now correctly discovers nested worktrees like `.unipi/worktrees/feat/compactor` and extracts "compactor" as the branch name

## Technical Details

**Before:** Only scanned immediate children of `.unipi/worktrees/`:
```
.unipi/worktrees/
├── feat/          ← returned "feat" (wrong!)
│   ├── compactor/
│   └── notify/
```

**After:** Recursively scans for `.git` files and extracts branch names:
```
.unipi/worktrees/feat/compactor/.git  → reads "gitdir: .../worktrees/compactor" → returns "compactor"
.unipi/worktrees/feat/notify/.git     → reads "gitdir: .../worktrees/notify"    → returns "notify"
```

## Notes
- This fixes the bug where `worktree-merge` would receive "feat" as input and fail to find a matching branch
- The fix handles both flat (`.unipi/worktrees/feat-auth`) and nested (`.unipi/worktrees/feat/auth`) structures
- Skips `node_modules` and `.git` directories during recursion
