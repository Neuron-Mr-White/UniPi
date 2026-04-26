# @pi-unipi/ralph

Long-running iterative development loops for [Pi coding agent](https://github.com/badlogic/pi-mono).

Start a loop, the agent works through iterations, reflects periodically, and completes when done. State persists across sessions.

## Install

```bash
pi install npm:@pi-unipi/ralph
```

Or as part of the full suite:
```bash
pi install npm:unipi
```

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

## Tools

| Tool | Description |
|------|-------------|
| `ralph_start` | Start a ralph loop (called by agent) |
| `ralph_done` | Signal iteration complete (called by agent) |

## How It Works

1. **Start** — creates a task file in `.unipi/ralph/` and begins iteration loop
2. **Iterate** — agent works on task, updates progress, calls `ralph_done`
3. **Reflect** — optional reflection prompts at configurable intervals
4. **Complete** — agent emits `COMPLETE` marker or max iterations reached
5. **Persist** — state saved to disk, survives session restarts

```
start → iterate → done → iterate → ... → complete
  ↑                                        │
  └──── resume ────────────────────────────┘
```

## Task File Format

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

## State Storage

```
.unipi/ralph/
├── loop-name.state.json    ← active/paused state
├── loop-name.md            ← task file
└── archive/
    └── loop-name.*         ← archived loops
```

## Integration

- **@pi-unipi/core** — event types, constants, utilities
- **@pi-unipi/info-screen** — registers info group showing loop status

## License

MIT
