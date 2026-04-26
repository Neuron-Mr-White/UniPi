# Unipi Conventions

## `.unipi/` Directory Layout

All unipi runtime artifacts, generated docs, and project-level config live under `.unipi/` in the project root. This keeps unipi state separate from source code and standard project files.

```
.unipi/
├── docs/                   # Generated and authored docs (tracked in git)
│   ├── brainstorms/        # Brainstorm session outputs
│   ├── plans/              # Implementation plans
│   ├── decisions/          # Architecture Decision Records (ADRs)
│   └── reports/            # Audit reports, review outputs
├── config/                 # Project-level unipi config (tracked in git)
│   ├── modules.yaml        # Enabled modules and their settings
│   └── workflows.yaml      # Custom workflow definitions
├── ralph/                  # Ralph loop state (NOT tracked in git)
│   ├── {name}.md           # Task files
│   ├── {name}.state.json   # Loop state
│   └── archive/            # Completed loops
└── cache/                  # Temporary cache (NOT tracked in git)
```

### Rules

| Path | Tracked? | Purpose |
|------|----------|---------|
| `.unipi/docs/` | Yes | Brainstorms, plans, decisions, reports |
| `.unipi/config/` | Yes | Project-level configuration |
| `.unipi/ralph/` | No | Ralph loop state (task files, loop state, archives) |
| `.unipi/cache/` | No | Temporary files, caches |

### Why `.unipi/`?

- **Dot prefix:** Hidden by default, doesn't clutter `ls`
- **Single root:** All unipi artifacts in one place, easy to `.gitignore` state selectively
- **Convention over config:** No settings needed — modules know where to write
- **Clean separation:** Source code stays clean, project context lives alongside

### Migration from `docs/`

Existing `docs/brainstorms/` and `docs/plans/` are the canonical locations during Phase 1 development. When unipi is installed as a package in other projects, it uses `.unipi/docs/` automatically.

### Module Responsibilities

Each module writes to its designated paths:

| Module | Writes to | Reads from |
|--------|-----------|------------|
| `@unipi/workflow` | `.unipi/docs/brainstorms/`, `.unipi/docs/plans/` | `.unipi/docs/` |
| `@unipi/ralph` | `.unipi/ralph/` | `.unipi/ralph/` |
| `@unipi/memory` | `~/.unipi/memory/<project>/` | `~/.unipi/memory/` |
| `@unipi/settings` (future) | `.unipi/config/` | `.unipi/config/` |

### Memory Directory

Memory is stored globally in `~/.unipi/memory/`, not in `.unipi/`:

```
~/.unipi/memory/
├── global/
│   ├── memory.db              # Global vector DB
│   └── *.md                   # Global memory files
└── <project_name>/
    ├── memory.db              # Project vector DB
    └── *.md                   # Project memory files
```

Project name is derived from the last directory segment of the project path.

### .gitignore Template

```gitignore
# Unipi runtime state — not tracked
.unipi/ralph/
.unipi/cache/

# Unipi docs and config — tracked
# .unipi/docs/
# .unipi/config/
```
