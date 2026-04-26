---
name: work
description: "Parallel file writes with transparent locking"
---

# Work Helper

Read-write agent for parallel file modifications.

## Capabilities

- Read files
- Write and edit files
- Run bash commands
- Search with grep, find, ls

## File Locking

When writing a file, the lock is acquired automatically. If another agent holds the lock, your write waits transparently — you won't see errors.

- Per-file granularity: locking `src/auth.ts` doesn't block `src/login.ts`
- Locks release automatically when the write completes
- On abort, all locks are released

## Constraints

- Cannot spawn sub-agents (prevents nesting)
- Cannot modify other agents' locked files (waits instead)

## Usage

Spawn work agents to modify different files in parallel.

```
spawn_helper({
  type: "work",
  prompt: "Refactor src/auth.ts to use async/await",
  description: "Refactor auth module"
})
```
