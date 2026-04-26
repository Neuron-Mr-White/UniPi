---
name: ralph
description: >
  Long-running iterative development loops. Run arbitrarily-long tasks without
  diluting model attention. Triggers: ralph, ralph loop, iterative loop,
  long-running task, development loop.
---

# Ralph Loop

Long-running iterative development loops. Run complex tasks across multiple iterations with reflection checkpoints.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:ralph start <name> [options]` | Start a new loop |
| `/unipi:ralph stop` | Pause current loop |
| `/unipi:ralph resume <name>` | Resume a paused loop |
| `/unipi:ralph status` | Show all loops |
| `/unipi:ralph cancel <name>` | Delete loop state |
| `/unipi:ralph archive <name>` | Move loop to archive |
| `/unipi:ralph clean [--all]` | Clean completed loops |
| `/unipi:ralph list --archived` | Show archived loops |
| `/unipi:ralph nuke [--yes]` | Delete all ralph data |

## Tools

| Tool | Description |
|------|-------------|
| `ralph_start` | Start a ralph loop (LLM-callable) |
| `ralph_done` | Signal iteration complete, request next |

## Options

- `--max-iterations N` — Stop after N iterations (default: 50)
- `--items-per-iteration N` — Process N items per iteration
- `--reflect-every N` — Reflection checkpoint every N iterations

## How It Works

1. **Start** — Create a task file with goals and checklist
2. **Iterate** — LLM works on task, updates checklist, calls `ralph_done`
3. **Reflect** — Every N iterations, pause and assess progress
4. **Complete** — When done, LLM outputs `COMPLETE` marker

## Integration with Workflow

When `@unipi/workflow` is present:
- `/unipi:work` suggests ralph for large tasks
- Ralph loops emit events that workflow can track
- Ralph state is available to info-screen (when present)

## Task File Format

```markdown
# Task

{Description}

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2
- [x] Completed item

## Notes
{Progress notes}
```

## State

Loop state stored in `.unipi/ralph/` directory:
- `.unipi/ralph/{name}.md` — Task file
- `.unipi/ralph/{name}.state.json` — Loop state
- `.unipi/ralph/archive/` — Completed loops

## Tips

- Use `--items-per-iteration` for large checklists
- Use `--reflect-every 10` for long-running tasks
- Press ESC to pause, send message to resume
- Task file is updated each iteration — check it for progress
