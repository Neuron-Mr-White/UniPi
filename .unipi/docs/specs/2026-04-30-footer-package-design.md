---
title: "Footer Package — Persistent Status Bar for Unipi"
type: brainstorm
date: 2026-04-30
---

# Footer Package — Persistent Status Bar for Unipi

## Problem Statement

The unipi monorepo has ~21 packages emitting events (MODULE_READY, COMPACTOR_STATS_UPDATED, MEMORY_STORED, etc.) but no persistent, always-visible status surface. The info-screen package provides an overlay dashboard, but users must explicitly open it to see stats. We need a persistent footer/status bar that shows key stats from all unipi packages at a glance, inspired by pi-powerline-footer's architecture.

Additionally, the footer functionality conceptually belongs in its own package — separating the "always-visible status bar" concern from the "overlay dashboard" concern.

## Context

- **info-screen** (`@pi-unipi/info-screen`) is an overlay dashboard with tabbed groups (Overview, Usage, Tools, Extensions, Skills). It uses `ctx.ui.custom()` for its TUI overlay. The "footer" within info-screen is just the bottom bar of the overlay (navigation hints, scroll position, timestamps) — not a persistent status bar. The overlay's bottom bar remains as part of info-screen's UI; the new footer package provides a separate persistent status bar using pi's `setFooter` + `setWidget` APIs.
- **pi's SDK** provides `ctx.ui.setFooter(factory)` for persistent footers and `ctx.ui.setWidget(key, factory, { placement })` for rendering above/below the editor.
- **pi-powerline-footer** (reference: `/tmp/pi-powerline-footer/`) is a sophisticated implementation using setFooter + setWidget with: preset system, powerline separators, responsive multi-row layout, Nerd Font auto-detection, custom items from extension statuses, theming via theme.json.
- **UNIPI_EVENTS** are already emitted by all packages — the footer can subscribe without requiring changes to existing packages.
- **All unipi packages** emit `MODULE_READY` events. Key packages emit specific events: `COMPACTOR_STATS_UPDATED`, `MEMORY_STORED/DELETED/CONSOLIDATED`, `MCP_SERVER_STARTED/STOPPED/ERROR`, `RALPH_LOOP_START/END/ITERATION_DONE`, `WORKFLOW_START/END`, `NOTIFICATION_SENT`.

## Chosen Approach

**Centralized Event Subscription (Approach A):** The footer package subscribes to `UNIPI_EVENTS` and collects data from all packages itself. It organizes stats into segment groups (core, compactor, memory, mcp, ralph, workflow, kanboard, notify) — each group's segments are individually togglable. No changes needed to existing packages.

## Why This Approach

1. **Zero-touch integration** — works immediately by subscribing to events already emitted by all packages
2. **Single source of truth** — footer owns all rendering logic, no distributed segment registrations
3. **Simpler** — one data path, one renderer, one config system
4. **Sufficient** — packages don't need to know about the footer; the footer just listens

**Alternatives rejected:**
- **Registry Pattern (Approach B):** Requires changes to ALL existing packages to register segments. Complex module loading timing. Rejected because events are already standardized.
- **Hybrid (Approach C):** Two data paths (events + registration) add complexity without sufficient benefit. Rejected because the event-based approach covers all current needs.

## Design

### Architecture

Three-layer architecture:

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

**Key design choice:** The footer IS the registry. Unlike info-screen where packages register groups into a registry, the footer package defines segment groups centrally and subscribes to events to populate them. No changes needed to existing packages.

### Segment Groups & Data Model

Each segment group represents a package or concern. Groups contain individual segments, each togglable.

| Group | Segments | Default | Data Source |
|-------|----------|---------|-------------|
| **core** | `model`, `thinking`, `path`, `git`, `context_pct`, `cost`, `tokens_total`, `tokens_in`, `tokens_out`, `session`, `hostname`, `time` | ON (except hostname, time) | pi SDK (ctx.sessionManager, ctx.model, footerData) |
| **compactor** | `session_events`, `compactions`, `tokens_saved`, `compression_ratio`, `indexed_docs`, `sandbox_runs`, `search_queries` | ON | `COMPACTOR_STATS_UPDATED` event + runtime counters |
| **memory** | `project_count`, `total_count`, `consolidations` | ON | `MEMORY_STORED`/`DELETED`/`CONSOLIDATED` events |
| **mcp** | `servers_total`, `servers_active`, `tools_total`, `servers_failed` | ON | `MCP_SERVER_STARTED`/`STOPPED`/`ERROR` events |
| **ralph** | `active_loops`, `total_iterations`, `loop_status` | ON | `RALPH_LOOP_START`/`END`/`ITERATION_DONE` events |
| **workflow** | `current_command`, `sandbox_level`, `command_duration` | ON | `WORKFLOW_START`/`END` events |
| **kanboard** | `docs_count`, `tasks_done`, `tasks_total`, `task_pct` | ON | Kanboard registry (direct read — kanboard doesn't emit events; footer reads from its global registry) |
| **notify** | `platforms_enabled`, `last_sent` | OFF | `NOTIFICATION_SENT` event |
| **status_ext** | `extension_statuses` | ON | `footerData.getExtensionStatuses()` |

**Toggle hierarchy:**
- Groups can be toggled as a whole
- Individual segments within a group can be toggled independently
- Presets override toggles (e.g., "minimal" preset disables most groups)

**Data flow:**
```
UNIPI_EVENTS → FooterRegistry.update(groupId, data)
                    ↓
              FooterRegistry.cache[groupId] = data
                    ↓
              requestRender() → renderer reads cache → renders segments
```

### Rendering & Layout

**Widget placement:**
- `setFooter(factory)` — registers footer, handles branch changes, returns minimal render
- `setWidget("footer-status", ...)` — main status bar (aboveEditor), renders all enabled segments
- `setWidget("footer-secondary", ...)` — overflow row (aboveEditor), shows when terminal is narrow

**Responsive behavior:**
```
Wide terminal (>120 cols):
  ┌─ top row: model │ thinking │ path │ git │ context │ cost │ tokens │ compactor │ memory ─┐
  └──────────────────────────────────────────────────────────────────────────────────────────┘

Narrow terminal (<120 cols):
  ┌─ top row: model │ thinking │ path │ git │ context │ cost ────────────────────────────────┐
  └─ secondary: compactor │ memory │ mcp │ ralph │ workflow ─────────────────────────────────┘
```

**Separator styles** (inherited from pi-powerline-footer):
- `powerline` — thick arrows (◀ ▶)
- `powerline-thin` — thin arrows ( ) (default)
- `slash` — ` / `
- `pipe` — ` | `
- `dot` — ` · `
- `ascii` — ` < > `

**Icon system:**
- Nerd Font glyphs when available (auto-detected for iTerm, WezTerm, Kitty, Ghostty, Alacritty)
- Unicode/ASCII fallback for other terminals
- No emoji — all icons use Nerd Font or Unicode symbols
- Configurable via theme.json overrides

**Theme integration:**
- Uses pi's theme system (`theme.fg(color, text)`)
- Supports hex colors via theme.json overrides
- Semantic colors per group: compactor=muted, memory=accent, mcp=success, ralph=warning, workflow=accent, kanboard=dim

**Segment rendering format:**
```
compactor group → [icon session_events: 42] │ [icon compactions: 7] │ [icon tokens_saved: 12.5k]
memory group    → [icon project: 5] │ [icon total: 68]
mcp group       → [icon servers: 3/4] │ [icon tools: 12]
```

Each segment renders as: `icon label: value` with optional detail in parentheses.

### Presets

| Preset | Description | Segments |
|--------|-------------|----------|
| `default` | Balanced view | core (model, thinking, path, git, context, cost) + compactor (compactions, tokens_saved) + memory (project_count) + ralph (loop_status) |
| `minimal` | Just the essentials | core (path, git, context) |
| `compact` | Core + key stats | core (model, git, cost, context) + compactor (compactions) + memory (total_count) |
| `full` | Everything | core (all) + compactor (all) + memory (all) + mcp (all) + ralph (all) + workflow (all) + kanboard (all) |
| `nerd` | Maximum detail for Nerd Font users | full + hostname + time + session + extension_statuses |
| `ascii` | Safe for any terminal | core (model, path, git, context, cost) with ASCII icons |

### Configuration

**Settings** in `~/.pi/agent/settings.json` under `unipi.footer`:

```json
{
  "unipi": {
    "footer": {
      "enabled": true,
      "preset": "default",
      "separator": "powerline-thin",
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

**Theme overrides** in footer package directory `theme.json`:

```json
{
  "colors": {
    "compactor": "muted",
    "memory": "#00afaf",
    "mcp": "success",
    "ralph": "warning"
  },
  "icons": {
    "folder": "",
    "branch": "",
    "model": ""
  }
}
```

### Commands

- `/unipi:footer` — toggle footer on/off
- `/unipi:footer <preset>` — switch preset (default, minimal, compact, full, nerd, ascii)
- `/unipi:footer-settings` — open settings (delegates to info-screen settings TUI pattern)

### Error Handling

- **Event subscription failures:** Each event handler wrapped in try/catch — one failing handler doesn't break others
- **Data provider failures:** Segments render "—" or hide when data unavailable (graceful degradation)
- **Git branch failures:** Cache null, retry on next render cycle
- **Config parse failures:** Fall back to default preset with warning
- **Module loading order:** Footer works even if packages load after it — events are replayed from registry cache

### Testing

- Unit tests for segment rendering (mock SegmentContext, verify output)
- Unit tests for registry (subscribe, update, cache invalidation)
- Unit tests for config parsing (valid/invalid/malformed settings)
- Integration tests for event flow (emit event → verify segment updates)
- Visual regression not feasible (terminal-dependent), but snapshot tests for segment output strings

### Performance

- Render debouncing (33ms) — batch rapid updates
- Cache TTL (5 seconds) — avoid re-rendering unchanged data
- Responsive layout caching (250ms) — recalculate only on resize or data change
- Lazy segment rendering — only render visible segments

## Implementation Checklist

- [x] Create `@packages/footer` package scaffold (package.json, index.ts, types.ts, README.md) — covered in Task 1
- [x] Update `@pi-unipi/core/constants.ts` — add `FOOTER` module name — covered in Task 1
- [x] Implement types: `FooterSegment`, `FooterGroup`, `FooterSegmentContext`, `FooterConfig`, `FooterSettings`, `SemanticColor`, `ColorScheme`, `SeparatorStyle`, `PresetDef` — covered in Task 2
- [x] Implement `FooterRegistry` class — segment group storage, event subscription, data caching, reactive updates — covered in Tasks 5-6
- [x] Implement config system — `loadFooterSettings()`, `saveFooterSettings()`, `getGroupSettings()`, `isSegmentEnabled()` — covered in Task 7
- [x] Implement theme system — `loadThemeConfig()`, `resolveColor()`, `applyColor()`, Nerd Font auto-detection, icon resolution — covered in Task 4
- [x] Implement separator system — `getSeparator()` for all styles (powerline, powerline-thin, slash, pipe, dot, ascii) — covered in Task 3
- [x] Implement core segments — model, thinking, path, git, context_pct, cost, tokens_total, tokens_in, tokens_out, session, hostname, time — covered in Task 8
- [x] Implement compactor segments — session_events, compactions, tokens_saved, compression_ratio, indexed_docs, sandbox_runs, search_queries — covered in Task 9
- [x] Implement memory segments — project_count, total_count, consolidations — covered in Task 10
- [x] Implement mcp segments — servers_total, servers_active, tools_total, servers_failed — covered in Task 11
- [x] Implement ralph segments — active_loops, total_iterations, loop_status — covered in Task 12
- [x] Implement workflow segments — current_command, sandbox_level, command_duration — covered in Task 13
- [x] Implement kanboard segments — docs_count, tasks_done, tasks_total, task_pct — covered in Task 14
- [x] Implement notify segments — platforms_enabled, last_sent — covered in Task 15
- [x] Implement status_ext segment — extension_statuses — covered in Task 15
- [x] Implement `FooterRenderer` — setFooter + setWidget integration, responsive layout (top + secondary rows), segment composition, separator rendering — covered in Task 17
- [x] Implement presets — default, minimal, compact, full, nerd, ascii — covered in Task 16
- [x] Implement `FooterExtension` entry point — register commands, subscribe to events, initialize renderer — covered in Task 18
- [x] Implement commands — `/unipi:footer` (toggle), `/unipi:footer <preset>`, `/unipi:footer-settings` — covered in Task 19
- [x] Implement settings TUI — per-group and per-segment toggles — covered in Task 20
- [x] Add unit tests for segment rendering — covered in Task 21
- [x] Add unit tests for registry (subscribe, update, cache) — covered in Task 21
- [x] Add unit tests for config parsing — covered in Task 21
- [x] Add integration tests for event flow — covered in Task 21
- [x] Update `@pi-unipi/core` exports if needed — covered in Task 1 (FOOTER module name) + Task 19 (FOOTER_COMMANDS)

## Open Questions

1. **Kanboard integration:** Kanboard doesn't emit events — the footer reads directly from kanboard's registry (globalThis.__unipi_kanboard_registry or similar). This creates a direct dependency but is pragmatic since kanboard is a stable package. If kanboard later emits events, the footer can switch to event-based subscription.
2. **Settings TUI:** Should the footer have its own settings TUI, or delegate to info-screen's settings TUI? (Own TUI is cleaner but duplicates code.)
3. **Module loading order:** If footer loads before other packages, it needs to handle late-arriving events gracefully. The registry pattern with reactive updates handles this, but need to verify timing.

## Out of Scope

- **Overlay/dashboard functionality** — info-screen handles all overlay concerns
- **Welcome screen** — out of scope (belongs to info-screen or a separate welcome package)
- **Working vibes** — out of scope (belongs to a separate vibes package or info-screen)
- **Bash mode** — out of scope (belongs to a separate bash-mode package or info-screen)
- **Editor stash** — out of scope
- **Custom editor component** — out of scope (pi-powerline-footer has a custom editor; we don't need one)
- **Changes to existing packages** — no modifications to compactor, memory, workflow, ralph, mcp, kanboard, or notify packages
