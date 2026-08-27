# @pi-unipi/footer

Persistent status bar at the bottom of the terminal. Shows live stats from all Unipi packages — compactor tokens saved, memory count, MCP status, Ralph loops, workflow state, kanboard tasks, notifications.

Subscribes to events from every package and renders segments using Pi's `setFooter` + `setWidget` APIs. Responsive layout adjusts to terminal width, with a secondary row for narrow terminals.

## Glance Footer (new in 2.12)

An experimental input surface, on by default and toggleable in `/unipi:footer-settings` → Appearance → **Glance Footer**:

```
╭─ 󰚩 UNIPI │  feat/footer-default-v2 │ ───────────────────────────╮
│ Type your prompt here...                                        │
╰─ 󰉋 unipi ────────────────────── 42%/1.0M │ GLM-5.3 │ thinking:high ─╯
              2 turn · 20 steps | 00:12:14 · tool 00:02 | 20ms avg ttft · 120 tok/s | 90% cache hit
```

- **Top border:** animated lolcat-gradient UNIPI brand + git branch (turns rainbow-frame animated while thinking is max/xhigh)
- **Bottom border:** workspace · context %/window · model · thinking level
- **Session strip:** turns/steps, wall + tool wall time, average TTFT, tok/s, cache hit % — colored per stat, honest across restarts (derived from persisted session timestamps when live hooks are unavailable; provider-reported `usage.output` anchors token counts whenever present)
- The classic segment status line is suppressed while glance mode is on; toggle it back for the classic footer

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:footer` | Toggle footer on/off |
| `/unipi:footer <preset>` | Switch preset (default, minimal, compact, full, nerd, ascii) |
| `/unipi:footer sep:<style>` | Change separator style |
| `/unipi:footer icon:<style>` | Change icon style (nerd, emoji, text) |
| `/unipi:footer on` / `/unipi:footer off` | Enable/disable explicitly |
| `/unipi:footer-settings` | Open settings TUI for per-group/per-segment toggles |

## Special Triggers

Footer subscribes to events from every Unipi package:

| Group | Events | Segments |
|-------|--------|----------|
| core | Pi SDK | model, thinking, path, git, context_pct, cost, tokens, session |
| compactor | Pi session data + `COMPACTOR_COMPACTED` | session_events, compactions, tokens_saved, compression_ratio |
| memory | `MEMORY_STORED`/`DELETED`/`CONSOLIDATED` | project_count, total_count, consolidations |
| mcp | `MCP_SERVER_STARTED`/`STOPPED`/`ERROR` | servers_total, servers_active, tools_total |
| ralph | `RALPH_LOOP_START`/`END`/`ITERATION_DONE` | active_loops, total_iterations, loop_status |
| workflow | `WORKFLOW_START`/`END` | current_command, sandbox_level, command_duration |
| kanboard | Direct registry read | docs_count, tasks_done, tasks_total, task_pct |
| notify | `NOTIFICATION_SENT` | platforms_enabled, last_sent |

Footer works even if packages load after it — late-arriving events update the cache.

## Presets

| Preset | Description |
|--------|-------------|
| `default` | Glance-era: UNIPI brand, model, thinking, directory, git \| context/tokens, tps, cost, clock |
| `classic` | The pre-2.12 balanced layout: model, api, tools, git \| tps, context, cost + compactor + memory + ralph |
| `minimal` | Essentials only: path, git, context |
| `compact` | Core + key stats: model, git, cost, context |
| `full` | Everything from all groups |
| `ascii` | Core segments with ASCII icons |

## Segment Groups

| Group | Default | Data Source |
|-------|---------|-------------|
| **core** | ON | Pi SDK (ctx.sessionManager, footerData) |
| **compactor** | ON | Live Pi session data; last-compaction event |
| **memory** | ON | `MEMORY_STORED`/`DELETED`/`CONSOLIDATED` events |
| **mcp** | ON | `MCP_SERVER_STARTED`/`STOPPED`/`ERROR` events |
| **ralph** | ON | `RALPH_LOOP_START`/`END`/`ITERATION_DONE` events |
| **workflow** | ON | `WORKFLOW_START`/`END` events |
| **kanboard** | ON | Kanboard registry (direct read) |
| **notify** | OFF | `NOTIFICATION_SENT` event |
| **status_ext** | ON | `footerData.getExtensionStatuses()` |

## Configurables

Settings in `~/.pi/agent/settings.json` under `unipi.footer`:

```json
{
  "unipi": {
    "footer": {
      "enabled": true,
      "preset": "default",
      "glanceMode": true,
      "separator": "powerline-thin",
      "iconStyle": "nerd",
      "colorMode": "auto",
      "groups": {
        "compactor": {
          "show": true,
          "segments": {
            "session_events": true,
            "compactions": true,
            "tokens_saved": true
          }
        }
      }
    }
  }
}
```

### Separator Styles

| Style | Look |
|-------|------|
| `powerline` | Thick powerline arrows |
| `powerline-thin` | Thin powerline arrows (default) |
| `slash` | / |
| `pipe` | \| |
| `dot` | Middle dot |
| `ascii` | > < |

### Icon Styles

| Style | Description |
|-------|-------------|
| `nerd` | Nerd Font glyphs (auto-detected) |
| `emoji` | Unicode symbols (works on most terminals) |
| `text` | Plain text abbreviations (works everywhere) |

When `iconStyle` is not set, footer auto-detects Nerd Font support and defaults to `nerd` if available, `emoji` otherwise.

### Color Mode

| Mode | Description |
|------|-------------|
| `auto` | Detect terminal support from environment (default) |
| `truecolor` | Force 24-bit ANSI color |
| `256` | Force xterm-256 color fallback |
| `none` | Disable footer color escapes |

`auto` uses truecolor where supported and downgrades to xterm-256 colors for terminals such as Apple Terminal that do not reliably render 24-bit color escapes.

### Responsive Layout

```
Wide terminal (>120 cols):
  model | thinking | path | git | context | cost | compactions | tokens_saved | project_count

Narrow terminal (<120 cols):
  Row 1: model | thinking | path | git | context | cost
  Row 2: compactions | tokens_saved | project_count | ralph | workflow
```

## License

MIT
