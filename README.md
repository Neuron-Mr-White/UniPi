# Unipi

18 packages that turn Pi into a full development workstation. Structured workflows, persistent memory, parallel agents, web research, notifications, context management, and a live status bar — all wired together through a shared event system.

One command installs everything:
```bash
pi install npm:@pi-unipi/unipi
```

## What You Get

**[Workflow](./packages/workflow/README.md)** — 20 commands that take ideas to shipped code. Brainstorm, plan, execute in worktrees, review, consolidate. The agent follows skill files step by step.

**[Ralph](./packages/ralph/README.md)** — Long-running loops that persist across sessions. Start a task, iterate through checklist items, resume after crashes. Progress tracked, state saved.

**[Memory](./packages/memory/README.md)** — SQLite + vector search stores facts, preferences, and decisions. Project-scoped and global. The agent remembers what you told it last week.

**[Compactor](./packages/compactor/README.md)** — Zero-LLM context engine. 6-stage pipeline hits 95%+ token reduction at zero API cost. Session continuity, sandbox execution, FTS5 search.

**[Subagents](./packages/subagents/README.md)** — Parallel execution with file locking. Spawn background agents to research, fix, or build while the main agent keeps going.

**[Web API](./packages/web-api/README.md)** — Web search, page reading, content summarization. Smart-fetch engine with browser-grade TLS fingerprinting — free, no API key. Paid providers as fallbacks.

**[MCP](./packages/mcp/README.md)** — Browse 7,800+ MCP servers, add them interactively. Tools from servers register automatically as Pi tools.

**[Notify](./packages/notify/README.md)** — Push notifications to native OS, Gotify, Telegram, or ntfy. Per-event platform routing. Configure once, get alerts everywhere.

**[Footer](./packages/footer/README.md)** — Persistent status bar showing live stats from every package. Responsive layout, presets, per-segment toggling.

**[BTW](./packages/btw/README.md)** — Side conversations that run in parallel. Ask questions without interrupting the main agent.

**[Ask User](./packages/ask-user/README.md)** — Structured input for decision gates. Single-select, multi-select, freeform. The agent asks instead of guessing.

**[Milestone](./packages/milestone/README.md)** — Track project goals across workflow cycles. MILESTONES.md stays in sync with specs, plans, and completed work.

**[Kanboard](./packages/kanboard/README.md)** — Web UI and TUI overlay for kanban boards. Parses all workflow documents into cards with progress indicators.

**[Info Screen](./packages/info-screen/README.md)** — Dashboard overlay showing module status, tools, and custom data groups.

**[Utility](./packages/utility/README.md)** — Environment info, diagnostics, cleanup, name badge, and Shiki-powered diff rendering.

**[Updater](./packages/updater/README.md)** — Checks npm for new versions on session start. Changelog browser and readme browser in TUI overlays.

**[Input Shortcuts](./packages/input-shortcuts/README.md)** — Keyboard shortcuts via vim-style chord overlay. Stash/restore, undo/redo, clipboard, thinking toggle.

## Architecture

Packages discover each other through events, not direct imports. Core defines the event types and constants. Every package emits `MODULE_READY` on load and subscribes to events it cares about.

```
┌─────────────────────────────────────────────────────────┐
│                        Core                             │
│              Events, Constants, Utilities                │
└───────────────────────┬─────────────────────────────────┘
                        │
    ┌───────────────────┼───────────────────┐
    │                   │                   │
    ▼                   ▼                   ▼
┌─────────┐       ┌──────────┐       ┌──────────┐
│ Workflow │       │ Compactor│       │  Memory  │
│  Skills  │       │  Engine  │       │  Store   │
└────┬─────┘       └────┬─────┘       └────┬─────┘
     │                  │                  │
     └──────────────────┼──────────────────┘
                        ▼
                  ┌──────────┐
                  │  Footer  │ ← Subscribes to all events
                  └──────────┘
```

Coexists triggers enhance behavior when packages are installed together. Workflow skills detect subagents and inject parallel strategies. All skills get MCP tools when MCP is installed. Web-api adds web research to investigation skills. Each package works standalone.

## Commands (Brief)

| Category | Prefix | Examples |
|----------|--------|----------|
| Workflow | `/unipi:` | brainstorm, plan, work, review-work, consolidate, quick-work, debug, fix |
| Ralph | `/unipi:ralph` | start, stop, resume, status |
| Memory | `/unipi:memory-` | process, search, consolidate, forget |
| Compactor | `/unipi:compact` | compact, stats, settings, preset |
| Notify | `/unipi:notify-` | settings, test, set-tg, set-ntfy |
| MCP | `/unipi:mcp-` | add, settings, sync, status |
| Web | `/unipi:web-` | settings, cache-clear |
| BTW | `/btw` | question, new, tangent, inject, summarize |
| Utility | `/unipi:` | env, doctor, status, cleanup, name-badge |
| Milestone | `/unipi:milestone-` | onboard, update |
| Kanboard | `/unipi:kanboard` | toggle, doctor |
| Footer | `/unipi:footer` | toggle, settings |
| Updater | `/unipi:` | readme, changelog, updater-settings |
| Info | `/unipi:info` | dashboard, settings |

## Agent Tools (Brief)

| Tool | Package | What It Does |
|------|---------|--------------|
| `ralph_start` / `ralph_done` | ralph | Loop control |
| `spawn_helper` / `get_helper_result` | subagents | Parallel agents |
| `memory_store` / `memory_search` / `memory_delete` | memory | Memory CRUD |
| `web_search` / `web_read` / `web_llm_summarize` | web-api | Web research |
| `notify_user` | notify | Push notifications |
| `ask_user` | ask-user | User input |
| `compact` / `session_recall` / `sandbox` | compactor | Context management |
| `ctx_batch` / `ctx_env` | utility | Batch execution, env info |

## Development

```bash
git clone https://github.com/Neuron-Mr-White/unipi.git
cd unipi
npm install
npm run typecheck
```

### Project Structure

```
unipi/
├── packages/
│   ├── core/           # Shared constants, events, utilities
│   ├── workflow/       # 20 skill-based commands
│   ├── ralph/          # Iterative loops
│   ├── memory/         # SQLite + vector search
│   ├── compactor/      # Context engine
│   ├── subagents/      # Parallel execution
│   ├── web-api/        # Web research
│   ├── mcp/            # MCP server integration
│   ├── notify/         # Push notifications
│   ├── footer/         # Status bar
│   ├── btw/            # Side conversations
│   ├── ask-user/       # Structured input
│   ├── milestone/      # Goal tracking
│   ├── kanboard/       # Kanban visualization
│   ├── info-screen/    # Dashboard overlay
│   ├── utility/        # Diagnostics, diff rendering
│   ├── updater/        # Auto-update, browsers
│   ├── input-shortcuts/ # Keyboard shortcuts
│   └── unipi/          # Umbrella package
├── .unipi/             # Runtime data (specs, plans, worktrees)
└── CHANGELOG.md
```

### Adding a Package

1. Create `packages/your-package/` with `package.json` and `index.ts`
2. Depend on `@pi-unipi/core` for constants and events
3. Emit `MODULE_READY` on load
4. Add to umbrella package dependencies and imports
5. Run `npm run typecheck`

### Running Tests

```bash
npm test
```

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `npm run typecheck` and `npm test`
5. Submit a pull request

Keep packages focused. One package, one responsibility. Use events for cross-package communication — no direct imports between packages.

## License

MIT
