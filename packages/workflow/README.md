# @pi-unipi/workflow

20 slash commands that take work from idea to shipped code. Each command loads a skill file that tells the agent exactly what to do — brainstorm, plan, execute, review, or fix.

The core loop: brainstorm an idea, plan the implementation, execute in a worktree, review the result, consolidate what you learned. Everything else supports this cycle.

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

## Typical Flow

```
brainstorm → plan → work → review-work → consolidate
    ↑                                        │
    └────────────────────────────────────────┘
```

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

For small tasks that skip the full flow:

```bash
/unipi:quick-work fix typo in README
```

### Research and Advisory

```bash
/unipi:gather-context how we handle errors
/unipi:consultant should we use GraphQL or REST?
/unipi:document the auth module
/unipi:research TypeScript 5.0 migration path
/unipi:scan-issues focus on security
```

### Bug Fixing

```bash
# Full debug flow
/unipi:debug TypeError in auth middleware
/unipi:fix debug:2026-04-28-auth-typeerror-debug

# Quick fix for simple bugs
/unipi:quick-fix fix null check in user validation
```

### Chores

```bash
/unipi:chore-create push to github main
/unipi:chore-execute chore:push-github-main
```

### Worktree Management

```bash
/unipi:worktree-create feat/new-feature
/unipi:worktree-list
/unipi:worktree-merge feat/new-feature
```

## Special Triggers

Workflow skills detect installed packages and enhance their behavior automatically. This is the coexists system — each package adds capabilities without requiring configuration.

| Package Present | Skills Affected | What Changes |
|-----------------|-----------------|--------------|
| `@pi-unipi/ask-user` | All skills | Structured user input for decisions |
| `@pi-unipi/subagents` | brainstorm, document, gather-context, review-work, scan-issues, work | Parallel execution with file locking |
| `@pi-unipi/mcp` | All skills | MCP server tools available |
| `@pi-unipi/web-api` | research, gather-context, consultant | Web search and page reading |
| `@pi-unipi/compactor` | All skills (main agent) | Context tools available |
| `@pi-unipi/ralph` | work, review-work | Ralph loop for 3+ tasks |

When `@pi-unipi/ask-user` is installed, skills use `ask_user` for decision gates — presenting options instead of guessing. When `@pi-unipi/subagents` is installed, investigation skills spawn parallel agents to explore code faster.

The footer package subscribes to workflow events (`WORKFLOW_START`, `WORKFLOW_END`) to show current command and duration. Info-screen displays workflow state in its dashboard.

## How Skills Work

Each command maps to a skill file in `packages/workflow/skills/{name}/SKILL.md`. When you run `/unipi:brainstorm`, Pi loads the brainstorm skill and follows its instructions.

Skills define:
- What the agent should do step by step
- What tools to use (subagents, web search, ask-user)
- What output to produce (specs, plans, reviews)
- Where to save results (`.unipi/docs/`)

The agent reads the skill, executes the steps, and produces artifacts in the `.unipi/` directory.

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

## Configuration

Workflow has no configuration. Skills are static files — the agent follows them as-is. Behavior changes come from which packages are installed (see Special Triggers above).

## License

MIT
