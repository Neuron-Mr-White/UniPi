# @pi-unipi/workflow

Structured development workflow commands for Pi coding agent.

## Overview

19 slash commands that guide work from idea to completion. Each command maps to a skill that instructs the agent on what to do.

## Commands

| Command | Description | Format |
|---------|-------------|--------|
| `/unipi:brainstorm` | Collaborative discovery, write design spec | `<string>` |
| `/unipi:plan` | Create implementation plan from specs | `specs:<path> <string>` |
| `/unipi:work` | Execute plan in worktree | `worktree:<branch> specs:<path> <string>` |
| `/unipi:review-work` | Review work, run checks, mark remarks | `plan:<path> <string>` |
| `/unipi:consolidate` | Save learnings, craft skills | `<string>` |
| `/unipi:worktree-create` | Create git worktree | `<string>` |
| `/unipi:worktree-list` | List all unipi worktrees | — |
| `/unipi:worktree-merge` | Merge worktrees to main | `<branch> <string>` |
| `/unipi:consultant` | Expert advisory | `<string>` |
| `/unipi:quick-work` | Fast single-task execution | `<string>` |
| `/unipi:gather-context` | Research codebase, prepare for brainstorm | `<string>` |
| `/unipi:document` | Generate documentation | `<string>` |
| `/unipi:scan-issues` | Find bugs, anti-patterns, security issues (passive scan) | `<string>` |
| `/unipi:debug` | Active bug investigation, root-cause analysis | `<string>` |
| `/unipi:fix` | Fix bugs using debug reports | `debug:<path> <string>` |
| `/unipi:quick-fix` | Fast bug fix without debug report | `<string>` |
| `/unipi:research` | Read-only research with bash access | `<string>` |
| `/unipi:chore-create` | Create reusable chore definition | `<string>` |
| `/unipi:chore-execute` | Execute a saved chore | `chore:<path> <string>` |

## Workflow

```
brainstorm → plan → work → review-work → consolidate
    ↑                                        │
    └────────────────────────────────────────┘
                    (loop)
```

### Typical Flow

```bash
# 1. Brainstorm an idea
/unipi:brainstorm redesign auth system

# 2. Create implementation plan
/unipi:plan specs:2026-04-26-auth-redesign-design

# 3. Execute plan in worktree
/unipi:work worktree:feat/auth specs:2026-04-26-auth-redesign-plan

# 4. Review what was built
/unipi:review-work plan:2026-04-26-auth-redesign-plan

# 5. Consolidate learnings
/unipi:consolidate
```

### Quick Tasks

```bash
# For small tasks that don't need full flow
/unipi:quick-work fix typo in README
```

### Research & Advisory

```bash
# Gather context before brainstorming
/unipi:gather-context how we handle errors

# Get expert advice
/unipi:consultant should we use GraphQL or REST?

# Generate documentation
/unipi:document the auth module

# Deep research with bash access
/unipi:research TypeScript 5.0 migration path

# Find issues (passive scan)
/unipi:scan-issues focus on security
```

### Bug Fixing

```bash
# Debug and fix a bug (full flow)
/unipi:debug TypeError in auth middleware
/unipi:fix debug:2026-04-28-auth-typeerror-debug

# Quick fix for simple bugs
/unipi:quick-fix fix null check in user validation
```

### Chores

```bash
# Create reusable chores
/unipi:chore-create push to github main
/unipi:chore-create publish package to npm

# Execute saved chores
/unipi:chore-execute chore:push-github-main
/unipi:chore-execute chore:publish-npm
```

### Worktree Management

```bash
# Create worktree
/unipi:worktree-create feat/new-feature

# List worktrees
/unipi:worktree-list

# Merge back to main
/ununi:worktree-merge feat/new-feature
```

## Directory Structure

```
.unipi/
├── docs/
│   ├── specs/          ← brainstorm output (design specs)
│   ├── plans/          ← plan output (implementation plans)
│   ├── generated/      ← document output (docs, guides)
│   ├── reviews/        ← review remarks (in plan docs)
│   ├── debug/          ← debug reports
│   ├── fix/            ← fix reports
│   ├── quick-work/     ← quick-work summaries
│   └── chore/          ← reusable chore definitions
├── memory/             ← consolidate memory
├── ralph/              ← ralph loop state
└── worktrees/          ← git worktrees
    ├── feat/auth/
    └── fix/login-bug/
```

## Integration

- **@pi-unipi/core** — shared constants, events, utilities
- **@pi-unipi/memory** — memory hooks for consolidate (optional)
- **@pi-unipi/subagents** — parallel research for gather-context, scan-issues (optional)
- **@pi-unipi/ralph** — loop integration for long-running tasks (optional)
- **@pi-unipi/ask-user** — structured user input for all skills (optional)
- **@pi-unipi/mcp** — MCP server tools for all skills (optional)
- **@pi-unipi/web-api** — web research for research-type skills (optional)
- **@pi-unipi/compactor** — compactor tools for main agent (optional)

See [docs/coexist-triggers.md](docs/coexist-triggers.md) for detailed integration behavior.

## Installation

```bash
npm install @pi-unipi/workflow
```

Add to pi settings:
```json
{
  "extensions": ["@unipi/workflow"]
}
```

## License

MIT
