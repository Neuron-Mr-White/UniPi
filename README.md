# Unipi

23 workspace packages that turn Pi into a full development workstation. Structured workflows, persistent memory, parallel agents, web research, notifications, context management, command autocomplete, and a live status bar — all wired together through a shared event system.

One command installs everything:
```bash
pi install npm:@pi-unipi/unipi
```

## Requirements

- **Pi (`@earendil-works/pi-coding-agent`) `^0.86.0`** — Unipi 3.0.0-alpha tracks the Pi 0.86 SDK (JSON-strict `ToolCall.arguments` / `ToolResultMessage.details`, `TranscriptContext` custom-provider inputs, native prompt-cache warming, per-model compaction budgets, `ctx.modelRegistry.stream()`). Older Pi releases (0.80–0.85) still load most extensions, but npm will flag the peer dependency mismatch; pin `@pi-unipi/*@<3.0.0` if you must stay on an older Pi.

## What You Get

**[Workflow](./packages/workflow/README.md)** — 20 commands that take ideas to shipped code. Brainstorm, plan, execute in worktrees, review, consolidate. The agent follows skill files step by step.

**[Long-Horizon](./packages/long-horizon/)** — Mode-gated long-horizon execution: `/goal` (one objective until verifiably true, propose+verify), `/ralph` (task-file iteration loops), `/swarm` (independent fan-out + synthesis), `/graph` (dependent multi-step work). A TypeSafe jev prompt judge routes each turn; one automation owner per session with park/resume; runaway-guard steering; token/turn/stall budgets.

**[Memory](./packages/memory/README.md)** — SQLite + vector search stores facts, preferences, and decisions. Project-scoped and global. The agent remembers what you told it last week.

**[Compactor](./packages/compactor/README.md)** — Zero-LLM context engine. 6-stage pipeline hits 95%+ token reduction at zero API cost. Session continuity, percentage auto-compaction, session recall, and sandbox execution.

**[Prefix-cache architecture](./docs/prefix-cache-architecture.md)** — Append-only request discipline, explicit cache epochs, deterministic tools, privacy-safe diagnostics, provider limitations, and bounded cold-epoch output.

**[Subagents](./packages/subagents/README.md)** — Parallel execution with file locking. Spawn background agents to research, fix, or build while the main agent keeps going.

**[Fusion](./packages/fusion/README.md)** — Run two models as one: a frontier lead delegates to a cheaper persistent sidekick that keeps its own context and shells, and stays in the loop while the sidekick works. Pair them from `/unipi:model`; `/unipi:fusion-stats` shows what the sidekick saved you.

**[Background Tasks](./packages/background-tasks/README.md)** — Long-running commands and delegate agents that survive the turn that started them, with a live dock, output capture, and a wake line while the agent waits on them.

**[Web API](./packages/web-api/README.md)** — Web search, page reading, content summarization. Defaults to [wigolo](https://github.com/KnockOutEZ/wigolo), a local-first engine with multi-engine search and on-device reranking — $0/query, no API key. Plus a smart-fetch engine with browser-grade TLS fingerprinting. Paid providers as fallbacks, and auto-selection falls through when a provider is unavailable.

**[Image](./packages/image/README.md)** — Generate images from a text prompt and analyze existing ones. 34 image models, plus vision analysis on any model that accepts image input, with a customizable system prompt.

**[MCP](./packages/mcp/README.md)** — Browse 7,800+ MCP servers, add them interactively. Tools from servers register automatically as Pi tools.

**[Notify](./packages/notify/README.md)** — Push notifications to native OS, Gotify, Telegram, or ntfy. Per-event platform routing plus native focus suppression so alerts can stay quiet while Pi is already focused.

**[Footer](./packages/footer/README.md)** — Persistent status bar showing live stats from every package. Now with the Glance footer: a framed input box with an animated rainbow brand, git branch title, and a live session strip (turns, wall/tool time, TTFT, tok/s, cache hit). Responsive layout, presets, per-segment toggling.

**[BTW](./packages/btw/README.md)** — Side conversations that run in parallel. Ask questions without interrupting the main agent.

**[Ask User](./packages/ask-user/README.md)** — Structured input for decision gates. Single-select, multi-select, freeform. The agent asks instead of guessing.

**[Kanboard](./packages/kanboard/README.md)** — Web UI and TUI overlay for kanban boards. Parses all workflow documents into cards with progress indicators.

**[Info Screen](./packages/info-screen/README.md)** — Dashboard overlay showing module status, tools, and custom data groups.

**[Utility](./packages/utility/README.md)** — Environment info, diagnostics, cleanup, name badge, and Shiki-powered diff rendering.

**[Updater](./packages/updater/README.md)** — Checks npm for new versions on session start. Changelog browser and readme browser in TUI overlays.

**[Input Shortcuts](./packages/input-shortcuts/README.md)** — Keyboard shortcuts via vim-style chord overlay. Stash/restore, undo/redo, clipboard, thinking toggle.

**[Command Enchantment](./packages/autocomplete/README.md)** — Enhanced `/unipi:*` autocomplete with full command names, package tags, descriptions, colors, and registry audits that catch stale command docs before release.

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
| Long-Horizon | `/unipi:goal`, `/unipi:ralph`, `/unipi:swarm`, `/unipi:graph` | <prompt>, start, stop, status, resume, clear |
| Memory | `/unipi:memory-` | process, search, consolidate, forget |
| Compactor | `/unipi:` | lossless-compact, session-recall, compact-stats, compact-settings, compact-preset, compact-help |
| Notify | `/unipi:notify-` | settings, test, set-tg, set-ntfy |
| MCP | `/unipi:mcp-` | add, settings, sync, status |
| Web | `/unipi:web-` | settings, cache-clear |
| BTW | `/unipi:btw` | question, btw-new, btw-tangent, btw-inject, btw-summarize |
| Utility | `/unipi:` | env, doctor, status, cleanup, badge-name |
| Kanboard | `/unipi:kanboard` | toggle, doctor |
| Footer | `/unipi:footer` | toggle, settings |
| Updater | `/unipi:` | readme, changelog |
| Info | `/unipi:info` | dashboard, settings |

## Agent Tools (Brief)

| Tool | Package | What It Does |
|------|---------|--------------|
| `create_goal` / `get_goal` / `update_goal` | long-horizon | Goal propose+verify lifecycle |
| `todowrite` | long-horizon | Visible session plan |
| `ralph_done` / `loop_status` | long-horizon | Loop iteration + progress |
| `swarm_report` / `swarm_status` / `swarm_yield` | long-horizon | Fan-out supervision |
| `update_agent_graph` / `graph_output` / `view_agent_graph` | long-horizon | Dependent work graph |
| `spawn_helper` / `get_helper_result` | subagents | Parallel agents |
| `memory_store` / `memory_search` / `memory_delete` | memory | Memory CRUD |
| `web_search` / `multi_web_content_read` / `web_llm_summarize` | web-api | Web research |
| `image_generate` / `image_recognize` | image | Image generation and vision (recognize auto-hides while the session model has vision) |
| `notify_user` | notify | Push notifications |
| `sidekick` / `read_subagent` | fusion | Delegate to the persistent sidekick and collect its report |
| `bg_run` / `bg_status` / `bg_logs` / `bg_kill` / `bg_delegate` / `bg_result` | background-tasks | Long-running commands and background delegate agents |
| `ask_user` | ask-user | User input |
| `compact` / `session_recall` / `sandbox` | compactor | Context management |
| `ctx_env` | utility | Environment info |
| `set_session_name` | utility | Session name for badge |

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
│   ├── long-horizon/  # /goal /ralph /swarm /graph mode-gated execution
│   ├── memory/         # SQLite + vector search
│   ├── compactor/      # Context engine
│   ├── subagents/      # Parallel execution
│   ├── fusion/         # Lead + sidekick pairing
│   ├── background-tasks/ # Long-running tasks and delegates
│   ├── web-api/        # Web research
│   ├── image/          # Image generation and vision
│   ├── mcp/            # MCP server integration
│   ├── notify/         # Push notifications
│   ├── footer/         # Status bar
│   ├── btw/            # Side conversations
│   ├── ask-user/       # Structured input
│   ├── kanboard/       # Kanban visualization
│   ├── info-screen/    # Dashboard overlay
│   ├── utility/        # Diagnostics, diff rendering
│   ├── updater/        # Auto-update, browsers
│   ├── input-shortcuts/ # Keyboard shortcuts
│   ├── autocomplete/   # Enhanced command autocomplete
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
