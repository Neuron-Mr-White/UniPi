# @pi-unipi/footer

Persistent status bar for the Unipi extension suite.

Subscribes to `UNIPI_EVENTS` and renders key stats from all unipi packages using pi's `setFooter` + `setWidget` APIs with responsive layout, presets, and per-segment toggling.

## Features

- **Persistent status bar** — always-visible footer showing key stats from all unipi packages
- **Segment groups** — organized by package (core, compactor, memory, MCP, ralph, workflow, kanboard, notify)
- **Presets** — default, minimal, compact, full, nerd, ascii
- **Responsive layout** — adjusts to terminal width with secondary row overflow
- **Per-segment toggling** — enable/disable individual segments or entire groups
- **Theme integration** — uses pi's theme system with semantic colors
- **Nerd Font support** — auto-detection with ASCII fallback
- **Separator styles** — powerline, powerline-thin, slash, pipe, dot, ascii

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  FooterRenderer (setFooter + setWidget)             │  ← Renders to screen
│  - Responsive layout (top + secondary rows)          │
│  - Preset system, separators, theming                │
├─────────────────────────────────────────────────────┤
│  FooterRegistry (segment groups)                     │  ← Manages segments
│  - Subscribes to UNIPI_EVENTS                       │
│  - Per-segment enable/disable                       │
│  - Reactive data caching                            │
├─────────────────────────────────────────────────────┤
│  Event Sources (existing packages)                   │  ← Data providers
│  - compactor, memory, workflow, ralph, mcp,          │
│    kanboard, notify, core                           │
└─────────────────────────────────────────────────────┘
```

## Usage

The footer is automatically enabled when unipi loads. Use commands to control it:

- `/unipi:footer` — toggle footer on/off
- `/unipi:footer <preset>` — switch preset (default, minimal, compact, full, nerd, ascii)
- `/unipi:footer sep:<style>` — change separator style (powerline, powerline-thin, slash, pipe, dot, ascii)
- `/unipi:footer icon:<style>` — change icon style (nerd, emoji, text)
- `/unipi:footer on` / `/unipi:footer off` — enable/disable explicitly
- `/unipi:footer-settings` — open settings TUI for per-group/per-segment toggles

## Segment Groups

| Group | Segments | Default | Data Source |
|-------|----------|---------|-------------|
| **core** | `model`, `thinking`, `path`, `git`, `context_pct`, `cost`, `tokens_total`, `tokens_in`, `tokens_out`, `session`, `hostname`, `time` | ON (except hostname, time, tokens variants) | pi SDK (ctx.sessionManager, footerData) |
| **compactor** | `session_events`, `compactions`, `tokens_saved`, `compression_ratio`, `indexed_docs`, `sandbox_runs`, `search_queries` | ON (key stats only) | `COMPACTOR_STATS_UPDATED` event |
| **memory** | `project_count`, `total_count`, `consolidations` | ON | `MEMORY_STORED`/`DELETED`/`CONSOLIDATED` events |
| **mcp** | `servers_total`, `servers_active`, `tools_total`, `servers_failed` | ON | `MCP_SERVER_STARTED`/`STOPPED`/`ERROR` events |
| **ralph** | `active_loops`, `total_iterations`, `loop_status` | ON | `RALPH_LOOP_START`/`END`/`ITERATION_DONE` events |
| **workflow** | `current_command`, `sandbox_level`, `command_duration` | ON | `WORKFLOW_START`/`END` events |
| **kanboard** | `docs_count`, `tasks_done`, `tasks_total`, `task_pct` | ON | Kanboard registry (direct read) |
| **notify** | `platforms_enabled`, `last_sent` | OFF | `NOTIFICATION_SENT` event |
| **status_ext** | `extension_statuses` | ON | `footerData.getExtensionStatuses()` |

## Presets

| Preset | Description | Key Segments |
|--------|-------------|-------------|
| `default` | Balanced view | model, thinking, path, git, context, cost + compactor + memory + ralph |
| `minimal` | Just the essentials | path, git, context |
| `compact` | Core + key stats | model, git, cost, context + compactor + memory |
| `full` | Everything | All segments from all groups |
| `nerd` | Maximum detail for Nerd Font users | full + hostname + time + session + extensions |
| `ascii` | Safe for any terminal | Core segments with ASCII icons |

## Configuration

Settings are stored in `~/.pi/agent/settings.json` under `unipi.footer`:

```json
{
  "unipi": {
    "footer": {
      "enabled": true,
      "preset": "default",
      "separator": "powerline-thin",
      "iconStyle": "nerd",
      "groups": {
        "compactor": {
          "show": true,
          "segments": {
            "session_events": true,
            "compactions": true,
            "tokens_saved": true,
            "compression_ratio": false,
            "indexed_docs": false,
            "sandbox_runs": false,
            "search_queries": false
          }
        },
        "memory": {
          "show": true,
          "segments": {
            "project_count": true,
            "total_count": true,
            "consolidations": false
          }
        }
      }
    }
  }
}
```

## Responsive Layout

```
Wide terminal (>120 cols):
  ┌─ model │ thinking │ path │ git │ context │ cost │ compactions │ tokens_saved │ project_count ─┐
  └──────────────────────────────────────────────────────────────────────────────────────────────┘

Narrow terminal (<120 cols):
  ┌─ model │ thinking │ path │ git │ context │ cost ───────────────────────────────────────────────┐
  └─ compactions │ tokens_saved │ project_count │ ralph │ workflow ────────────────────────────────┘
```

## Separator Styles

| Style | Look | Description |
|-------|------|-------------|
| `powerline` | ◀ ▶ | Thick powerline arrows |
| `powerline-thin` |   | Thin powerline arrows (default) |
| `slash` | / | Slash separator |
| `pipe` | \| | Pipe separator |
| `dot` | · | Middle dot separator |
| `ascii` | > < | ASCII angle brackets |

## Icon Styles

Three icon styles are available, controlled by `/unipi:footer icon:<style>` or the `iconStyle` setting:

| Style | Description | Example |
-------|-------------|--------|
| `nerd` | Nerd Font glyphs (default, requires Nerd Font terminal) |  , ,  |
| `emoji` | Unicode emoji/symbols (works on most terminals) | ⚡, ◧, $] |
| `text` | Plain text abbreviations (works everywhere, most compact) | evt, cmp, $] |

When `iconStyle` is not explicitly set, the footer auto-detects Nerd Font support and
defaults to `nerd` if available, `emoji` otherwise.

## Error Handling

- **Event subscription failures:** Each handler wrapped in try/catch — one failing handler doesn't break others
- **Data provider failures:** Segments hide when data unavailable (graceful degradation)
- **Config parse failures:** Fall back to default preset with warning
- **Module loading order:** Footer works even if packages load after it — late-arriving events update cache

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm tsc --noEmit
```

## Package Structure

```
packages/footer/
├── index.ts          # Re-exports
├── types.ts          # Re-exports from src/types.ts
├── package.json      # Package manifest
├── tsconfig.json     # TypeScript config
├── README.md         # This file
├── src/
│   ├── index.ts          # Extension entry point
│   ├── types.ts          # Type definitions
│   ├── config.ts         # Settings load/save
│   ├── events.ts         # Event subscription wiring
│   ├── commands.ts       # Command registration
│   ├── presets.ts        # Preset definitions
│   ├── registry/         # FooterRegistry
│   │   └── index.ts
│   ├── rendering/        # Rendering engine
│   │   ├── renderer.ts   # FooterRenderer class
│   │   ├── separators.ts # Separator system
│   │   ├── theme.ts      # Theme color resolution
│   │   └── icons.ts      # Icon system with Nerd Font detection
│   ├── segments/         # Segment implementations
│   │   ├── core.ts       # Core segments (model, path, git, etc.)
│   │   ├── compactor.ts  # Compactor segments
│   │   ├── memory.ts     # Memory segments
│   │   ├── mcp.ts        # MCP segments
│   │   ├── ralph.ts      # Ralph segments
│   │   ├── workflow.ts   # Workflow segments
│   │   ├── kanboard.ts   # Kanboard segments
│   │   ├── notify.ts     # Notify segments
│   │   └── status-ext.ts # Extension statuses segment
│   └── tui/
│       └── settings-tui.ts # Settings overlay TUI
└── tests/               # Unit tests
    ├── separators.test.ts
    ├── registry.test.ts
    ├── config.test.ts
    ├── segments.test.ts
    └── events.test.ts
```
