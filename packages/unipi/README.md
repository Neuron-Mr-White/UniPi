# Unipi

All-in-one extension suite for the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install npm:unipi
```

Or install individual packages:

```bash
pi install npm:@unipi/workflow   # Workflow commands
pi install npm:@unipi/ralph      # Ralph loops
```

## What's Included

| Package | Description |
|---------|-------------|
| `@unipi/core` | Shared utilities, event types, constants |
| `@unipi/workflow` | 12 structured development commands |
| `@unipi/ralph` | Long-running iterative development loops |

## Commands

### Workflow

| Command | Description |
|---------|-------------|
| `/unipi:brainstorm` | Collaborative discovery |
| `/unipi:plan` | Strategic planning |
| `/unipi:work` | Execute plan |
| `/unipi:review-work` | Review what was built |
| `/unipi:consolidate` | Merge findings, update docs |
| `/unipi:worktree-create` | Create git worktree |
| `/unipi:consultant` | Expert panel review |
| `/unipi:quick-work` | Fast single-task execution |
| `/unipi:gather-context` | Research codebase |
| `/unipi:document` | Generate docs |
| `/unipi:scan-issues` | Find bugs, anti-patterns |
| `/unipi:worktree-merge` | Merge worktree back |

### Ralph

| Command | Description |
|---------|-------------|
| `/unipi:ralph start <name>` | Start a ralph loop |
| `/unipi:ralph stop` | Pause current loop |
| `/unipi:ralph resume <name>` | Resume a paused loop |
| `/unipi:ralph status` | Show all loops |

## How It Works

**Workflow** provides structured development commands that guide the LLM through brainstorming, planning, implementing, and reviewing work.

**Ralph** enables long-running iterative tasks. Start a loop, the LLM works through iterations, reflects periodically, and completes when done.

**Core** provides shared infrastructure — event types, constants, utilities — so modules can discover each other without tight coupling.

## Module Discovery

Modules announce their presence via `pi.events`. When `@unipi/workflow` detects `@unipi/ralph`, it enables loop integration in `/unipi:work`. Each module works standalone.

## Development

```bash
git clone https://github.com/Neuron-Mr-White/unipi.git
cd unipi
npm install
npm run typecheck
```

## License

MIT
