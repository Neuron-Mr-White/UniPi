# Unipi

All-in-one extension suite for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Install

**All-in-one:**
```bash
pi install npm:unipi
```

**Granular:**
```bash
pi install npm:@unipi/workflow
pi install npm:@unipi/ralph
```

## Packages

| Package | Description |
|---------|-------------|
| `@unipi/core` | Shared utilities, event types, constants |
| `@unipi/workflow` | Structured development workflow commands |
| `@unipi/ralph` | Long-running iterative development loops |
| `unipi` | Meta-package — installs all of the above |

## Commands

All commands use `/unipi:` prefix:

| Command | Package | Description |
|---------|---------|-------------|
| `/unipi:brainstorm` | workflow | Collaborative discovery |
| `/unipi:plan` | workflow | Strategic planning |
| `/unipi:work` | workflow | Execute plan |
| `/unipi:review-work` | workflow | Review what was built |
| `/unipi:consolidate` | workflow | Merge findings |
| `/unipi:worktree-create` | workflow | Create git worktree |
| `/unipi:consultant` | workflow | Expert panel review |
| `/unipi:quick-work` | workflow | Fast single-task execution |
| `/unipi:gather-context` | workflow | Research codebase |
| `/unipi:document` | workflow | Generate docs |
| `/unipi:scan-issues` | workflow | Find bugs, anti-patterns |
| `/unipi:worktree-merge` | workflow | Merge worktree back |

## Development

```bash
npm install
npm run typecheck
```

## License

MIT
