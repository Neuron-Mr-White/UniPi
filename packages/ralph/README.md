# @pi-unipi/ralph

Long-running iterative loops that persist across sessions. Start a loop, the agent works through tasks, calls `ralph_done` after each step, and reflects periodically. If the session crashes or you close Pi, the loop resumes where it left off.

Ralph is for work that takes more than one pass — migrating a codebase, implementing a multi-step feature, or processing a backlog. The agent iterates until the task is done or it hits the iteration limit.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:ralph start <name\|path>` | Start a new loop |
| `/unipi:ralph stop` | Pause current loop |
| `/unipi:ralph resume <name>` | Resume a paused loop |
| `/unipi:ralph status` | Show all loops |
| `/unipi:ralph cancel <name>` | Delete loop state |
| `/unipi:ralph archive <name>` | Move loop to archive |
| `/unipi:ralph clean [--all]` | Clean completed loops |
| `/unipi:ralph list --archived` | Show archived loops |
| `/unipi:ralph nuke [--yes]` | Delete all ralph data |

### Options

| Flag | Description |
|------|-------------|
| `--max-iterations N` | Stop after N iterations (default: 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint) |
| `--reflect-every N` | Reflect every N iterations |

## Special Triggers

The workflow `work` skill detects ralph and encourages loops when a plan has 3 or more subtasks. Instead of executing everything in one pass, the agent starts a ralph loop and iterates through the checklist.

Ralph registers with the info-screen dashboard, showing active loops, total iterations, and loop status. The footer package subscribes to `RALPH_LOOP_START`, `RALPH_LOOP_END`, and `RALPH_ITERATION_DONE` events to display loop stats in the status bar.

## How the Agent Uses Ralph

1. Agent calls `ralph_start` with a task description and checklist
2. Ralph creates a task file in `.unipi/ralph/` and begins the loop
3. Agent works on the first checklist item, then calls `ralph_done`
4. Ralph marks the item complete and returns the next iteration
5. At reflection intervals, the agent pauses to review progress
6. When all items are done (or max iterations reached), the loop ends

The `ralph_done` tool signals completion of one iteration. The agent decides what to do each iteration — ralph just tracks progress and persists state.

### Task File Format

Loops operate on markdown task files:

```markdown
# Task

Redesign the authentication system.

## Goals
- Migrate to JWT refresh tokens
- Add role-based access control

## Checklist
- [x] Design token rotation
- [ ] Implement refresh endpoint
- [ ] Add RBAC middleware
- [ ] Write tests

## Notes
Session 1: Completed token rotation design.
```

## Configurables

Loop behavior is controlled per-invocation via flags:

| Setting | Default | What It Does |
|---------|---------|--------------|
| `max-iterations` | 50 | Hard stop after N iterations |
| `items-per-iteration` | 3 | Hint for how many checklist items per pass |
| `reflect-every` | 5 | Iterations between reflection prompts |

These are set when starting a loop, not in a config file. Each loop can have different settings.

## State Storage

```
.unipi/ralph/
├── loop-name.state.json    ← active/paused state
├── loop-name.md            ← task file
└── archive/
    └── loop-name.*         ← archived loops
```

State persists across sessions. Close Pi, reopen, resume the loop — it picks up where it left off.

## License

MIT
