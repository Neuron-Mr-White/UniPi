---
title: "Unipi Info Screen — Dashboard & Module Registry"
type: brainstorm
date: 2026-04-26
participants: [user, MiMo]
related:
  - docs/brainstorms/2026-04-26-unipi-architecture-brainstorm.md
  - https://github.com/nicobailon/pi-powerline-footer
  - https://github.com/tmustier/pi-extensions/tree/main/usage-extension
  - https://github.com/tmustier/pi-extensions
---

# Unipi Info Screen — Dashboard & Module Registry

## Problem Statement

Pi's default boot screen shows a generic greeting with minimal useful information. Users need a centralized dashboard that displays system stats, module status, and extension data — configurable per-group and per-stat. External modules should be able to register their own display groups with custom data.

**Root need:** A configurable, live dashboard that replaces pi's default greeting, re-openable via `/unipi:info`, with an API for external modules to register their own groups.

## Context

**Existing patterns studied:**

- **pi-powerline-footer** (nicobailon): Welcome overlay with two-column box layout (logo + model info + tips + loaded counts + recent sessions). Custom status items via `ctx.ui.setStatus("key", "value")`. Settings persistence in `~/.pi/agent/settings.json`. Segment-based rendering with `render(ctx)` → `{ content, visible }`.
- **tmustier/pi-usage-extension**: Parses `~/.pi/agent/sessions/` JSONL files for token/cost/model data. No custom tracking needed — pi's session files contain everything.
- **@pi-unipi/core**: Existing event schema with `MODULE_STATUS_REQUEST/RESPONSE` events. Constants for module names, commands, tools.
- **Pi TUI**: `ctx.ui.custom()` for overlay rendering, `Component` interface with `render(width) → string[]`, overlay options for sizing/positioning.

**Key insight:** Session files in `~/.pi/agent/sessions/` are JSONL with assistant messages containing `usage` objects (input, output, cacheRead, cacheWrite, cost.total). This is the data source for usage stats — no custom tracking required.

## Chosen Approach

**Registry-centric architecture** with TUI overlay rendering. Central `InfoRegistry` holds all groups. Core groups register at startup. External modules call `registerGroup()` via the registry API. Info-screen renders as a TUI overlay modal, closed on `q`/`Esc`.

## Why This Approach

- **Registry-centric:** Single source of truth for all display data. Config lives in one place. Easy to add/remove groups. Testable.
- **TUI overlay:** Matches pi's existing pattern (powerline-footer does this). Modal behavior is familiar. No inline rendering complexity.
- **Lazy render at boot:** Waits for all modules to announce via `unipi:module:ready` events, then renders. Solves module load order problem.
- **Registry API over events:** External modules get a clean `registerGroup()` call with typed config + data provider. Events are for discovery, not data delivery.

## Subjective Contract

- **Target outcome:** Professional dashboard that feels native to pi. Clean, informative, configurable. Not a toy.
- **Anti-goals:** Cluttered display, mandatory all-groups-visible, hard-coded stats, slow boot delay.
- **References:** pi-powerline-footer welcome overlay, tmustier usage-extension table layout.
- **Anti-references:** Generic greeting screens, unconfigurable dashboards.
- **Tone:** Clean, minimal, data-focused. Powerline-inspired visual hierarchy.
- **Rejection criteria:** Boot delay > 2 seconds, missing groups that should be visible, config not persisting.

## Key Design Decisions

### Q1: Registry Architecture — RESOLVED

**Decision:** Central `InfoRegistry` singleton in `@pi-unipi/info-screen` package.

**Rationale:** Single source of truth. External modules import and call `registerGroup()`. Core groups register during module init. Config lives in registry.

**Alternatives considered:**
- Event-scatter (modules emit rendered strings) — harder to unify config/styling
- Shared object (all modules write to a global) — creates coupling

### Q2: Group Registration API — RESOLVED

**Decision:** External modules call:

```typescript
import { infoRegistry } from "@pi-unipi/info-screen";

infoRegistry.registerGroup({
  id: "memory",
  name: "Memory",
  icon: "🧠",
  priority: 60, // Lower = earlier in tab order
  config: {
    showByDefault: true,
    stats: [
      { id: "total", label: "Total Memories", show: true },
      { id: "types", label: "By Type", show: true },
      { id: "storage", label: "Storage Size", show: true },
      { id: "lastSearch", label: "Last Search", show: false },
    ],
  },
  dataProvider: async () => ({
    total: { value: "42", detail: "across 3 projects" },
    types: { value: "12 preference, 18 decision, 12 pattern" },
    storage: { value: "1.2 MB" },
    lastSearch: { value: "2 min ago" },
  }),
});
```

**Rationale:** Typed, testable, config-driven. Each stat can be shown/hidden. Data provider is async for live data.

**Alternatives considered:**
- Simple key-value registration — too rigid for complex layouts
- Event-based data push — harder to coordinate with config

### Q3: Boot Behavior — RESOLVED

**Decision:** Lazy render — info-screen waits for all modules to announce via `unipi:module:ready` events (with 2s timeout), then renders the full dashboard as TUI overlay.

**Rationale:** Solves module load order problem. All groups available at render time. Timeout prevents infinite wait if module doesn't load.

**Alternatives considered:**
- Immediate render with late registration — groups appear/disappear jankily
- Two-phase render — confusing UX

### Q4: Config Storage — RESOLVED

**Decision:** `~/.pi/agent/settings.json` under `unipi.info` key, matching powerline-footer's pattern.

```json
{
  "unipi": {
    "info": {
      "showOnBoot": true,
      "bootTimeoutMs": 2000,
      "groups": {
        "overview": { "show": true },
        "usage": { "show": true, "stats": { "cost": true, "tokens": true, "models": true } },
        "tools": { "show": true },
        "extensions": { "show": true },
        "skills": { "show": true },
        "memory": { "show": true },
        "subagents": { "show": true },
        "ralph": { "show": true }
      }
    }
  }
}
```

**Rationale:** Follows established pattern. User-editable. Pi's settings system already handles this.

**Alternatives considered:**
- `.unipi/settings.json` — breaks pattern, separate file to manage
- SQLite — overkill for simple config

### Q5: Display Format — RESOLVED

**Decision:** TUI overlay modal with tab navigation. Groups displayed as tabs (cycling with ←/→). Each tab shows that group's stats. Closed on `q`/`Esc`.

**Rationale:** Familiar from powerline-footer and pi's existing overlay system. Tab navigation is simple and discoverable.

**Alternatives considered:**
- Single scrollable page — too long with many groups
- Split view — complex layout, terminal width constraints

### Q6: Live Data Updates — RESOLVED

**Decision:** External modules can call `infoRegistry.updateGroupData(groupId, data)` to push live updates. Info-screen re-renders when data changes (if overlay is open).

**Rationale:** Supports real-time stats (active ralph loops, subagent counts, memory operations). `ctx.ui.setStatus()` pattern from powerline-footer.

**Alternatives considered:**
- Polling — wasteful, delays
- Event-based — more complex, already have registry

### Q7: Core Groups — RESOLVED

**Decision:** Five core groups, always registered:

| Group | Data Source | Stats |
|-------|------------|-------|
| **Overview** | Pi internals | version, session info, uptime, active modules, environment |
| **Usage** | Session files (`~/.pi/agent/sessions/`) | tokens/day, tokens/week, tokens/month, cost, model breakdown |
| **Tools** | Pi's tool registry | tool count, tools by source (built-in vs registered), tool types |
| **Extensions** | Settings + filesystem | installed extensions, versions, status, source (npm/git/local) |
| **Skills** | Filesystem scan | loaded skills count, by source, categories |

**Rationale:** Data available from pi's built-in sources. No custom tracking needed for core groups.

**Alternatives considered:**
- More groups (memory, subagents, ralph) — these register themselves as external groups

### Q8: External Module Integration — RESOLVED

**Decision:** Existing unipi modules (memory, subagents, ralph) updated to call `infoRegistry.registerGroup()` on load.

Changes needed:
- `@pi-unipi/memory`: Register "Memory" group with stats (count, types, storage, last search)
- `@pi-unipi/subagents`: Register "Subagents" group with stats (active agents, config, concurrency)
- `@pi-unipi/ralph`: Register "Ralph" group with stats (active loops, iterations, status)

**Rationale:** Self-describing modules. Info-screen doesn't need to know about each module's internals.

**Alternatives considered:**
- Hard-coded groups in info-screen — breaks extensibility

## Open Questions

1. **Boot overlay dismiss:** Should it auto-dismiss after timeout (like powerline-footer's 30s), or stay until user presses a key?
2. **Tab rendering:** How should tabs look? Powerline-style segments, or traditional tab bar?
3. **Settings TUI:** The user mentioned "configure interactively using pi tui" — should we build a settings editor component, or use `/unipi:info-settings` command with select/confirm prompts?
4. **Session file parsing performance:** tmustier's usage-extension handles this. Should we depend on their package or implement our own parser?

## Out of Scope

- Modifying pi core
- Building a GUI — everything stays in pi's TUI
- Real-time streaming of usage data (polling is fine for boot dashboard)
- Custom themes for the info screen (use pi's existing theme system)

## Next Steps

1. `/plan` to create implementation plan from these decisions
2. Update `@pi-unipi/memory`, `@pi-unipi/subagents`, `@pi-unipi/ralph` to register info groups
3. Decide on session file parser approach (own vs tmustier's)
4. Build settings TUI for interactive configuration
