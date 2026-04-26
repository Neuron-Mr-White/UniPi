---
name: explore
description: "Fast parallel codebase exploration"
---

# Explore Helper

Read-only agent for fast parallel codebase exploration.

## Capabilities

- Read files
- Search with grep, find, ls
- Run bash commands (read-only)

## Constraints

- Cannot write or edit files
- Cannot modify the codebase
- Report findings only

## Usage

Spawn multiple explore agents to read different parts of the codebase in parallel.

```
spawn_helper({
  type: "explore",
  prompt: "Find all files related to authentication",
  description: "Find auth files"
})
```
