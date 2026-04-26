---
title: "feat: Unipi Info Screen — Dashboard & Module Registry"
type: plan
date: 2026-04-26
status: complete
brainstorm: docs/brainstorms/2026-04-26-unipi-info-screen-brainstorm.md
confidence: high
---

# Unipi Info Screen — Dashboard & Module Registry

## Problem Statement

Pi's default boot screen shows a generic greeting with minimal useful information. Users need a centralized dashboard displaying system stats, module status, and extension data — configurable per-group and per-stat. External modules should register their own display groups.

## Target End State

- `/unipi:info` command opens a TUI overlay modal with tabbed groups
- Boot replaces pi's default greeting with the same dashboard
- 5 core groups always present: Overview, Usage, Tools, Extensions, Skills
- External modules (memory, subagents, ralph) register their own groups
- Two-level config: group visibility + per-stat visibility within groups
- Config persists in `~/.pi/agent/settings.json` under `unipi.info`
- Interactive settings editor via `/unipi:info-settings`

## Scope and Non-Goals

**In scope:**
- `@pi-unipi/info-screen` package (registry, TUI component, core groups)
- Config system (read/write settings)
- Boot integration (`session_start` overlay)
- `/unipi:info` and `/unipi:info-settings` commands
- Update memory, subagents, ralph to register info groups
- Usage stats from session file parsing

**Non-goals:**
- Modifying pi core
- Real-time streaming (polling for boot is fine)
- Custom themes (use pi's existing theme system)
- GUI — everything stays in TUI

## Proposed Solution

Registry-centric architecture. Central `InfoRegistry` holds all groups. Core groups register at startup. External modules call `registerGroup()`. TUI overlay renders the dashboard with tab navigation.

### Architecture

```
@pi-unipi/info-screen/
├── index.ts          # Extension entry, boot + command registration
├── registry.ts       # InfoRegistry singleton — group registration, config
├── config.ts         # Settings read/write (unipi.info in settings.json)
├── core-groups.ts    # Core group registrations (Overview, Usage, Tools, Extensions, Skills)
├── usage-parser.ts   # Session file parser for usage stats
├── tui/
│   ├── info-overlay.ts    # Main TUI Component — tabbed overlay
│   ├── tab-bar.ts         # Tab navigation component
│   └── group-renderer.ts  # Renders a group's stats
├── settings/
│   └── settings-tui.ts    # Interactive settings editor
└── package.json
```

### Data Flow

```
Boot / /unipi:info
  → InfoRegistry collects all registered groups
  → TUI overlay opens with tabs
  → Each tab calls group.dataProvider()
  → Stats rendered in tab content area
  → User navigates with ←/→, dismisses with q/Esc
```

### External Module Registration

```typescript
// In @pi-unipi/memory/index.ts
import { infoRegistry } from "@pi-unipi/info-screen";

infoRegistry.registerGroup({
  id: "memory",
  name: "Memory",
  icon: "🧠",
  priority: 60,
  config: {
    showByDefault: true,
    stats: [
      { id: "total", label: "Total Memories", show: true },
      { id: "types", label: "By Type", show: true },
      { id: "storage", label: "Storage Size", show: true },
    ],
  },
  dataProvider: async () => ({
    total: { value: "42", detail: "across 3 projects" },
    types: { value: "12 pref, 18 decision, 12 pattern" },
    storage: { value: "1.2 MB" },
  }),
});
```

## Implementation Tasks

### Phase 1: Core Registry & Config

- [x] **1.1** Create `@pi-unipi/info-screen` package structure (package.json, tsconfig.json)
- [x] **1.2** Implement `InfoRegistry` class — `registerGroup()`, `getGroups()`, `updateGroupData()`, `getConfig()`, `setConfig()`
- [x] **1.3** Implement config system — read/write `unipi.info` in `~/.pi/agent/settings.json`
- [x] **1.4** Add `INFO_SCREEN` constant to `@pi-unipi/core/constants.ts`

### Phase 2: Core Groups

- [x] **2.1** Implement `core-groups.ts` — register Overview, Usage, Tools, Extensions, Skills groups
- [x] **2.2** Implement `usage-parser.ts` — parse `~/.pi/agent/sessions/` JSONL files for token/cost/model data (reference tmustier's approach)
- [x] **2.3** Overview group: pi version, session info, active modules, environment
- [x] **2.4** Tools group: tool count, tools by source (built-in vs registered), tool types
- [x] **2.5** Extensions group: installed extensions, versions, status, source (npm/git/local)
- [x] **2.6** Skills group: loaded skills count, by source, categories

### Phase 3: TUI Overlay

- [x] **3.1** Implement `InfoOverlay` TUI Component — tabbed layout with `render(width) → string[]`
- [x] **3.2** Implement tab bar — ←/→ navigation, group names as tabs
- [x] **3.3** Implement group renderer — renders stats for active tab
- [x] **3.4** Add keyboard handling — Tab/←/→ switch tabs, q/Esc close
- [x] **3.5** Handle narrow terminals — responsive layout, fallback for <60 cols

### Phase 4: Boot & Command Integration

- [x] **4.1** Register `/unipi:info` command — opens TUI overlay
- [x] **4.2** Implement lazy render at boot — wait for `unipi:module:ready` events (2s timeout), then show overlay
- [x] **4.3** Implement `/unipi:info-settings` command — interactive settings editor

### Phase 5: External Module Updates

- [x] **5.1** Update `@pi-unipi/memory` — register "Memory" group with stats
- [x] **5.2** Update `@pi-unipi/subagents` — register "Subagents" group with stats
- [x] **5.3** Update `@pi-unipi/ralph` — register "Ralph" group with stats

### Phase 6: Config & Polish

- [x] **6.1** Settings TUI — interactive group visibility toggles
- [x] **6.2** Settings TUI — per-stat visibility within groups
- [x] **6.3** Auto-dismiss timeout option (configurable, default 30s)
- [x] **6.4** Export `infoRegistry` from `@pi-unipi/info-screen` for external use

## Acceptance Criteria

- [ ] `/unipi:info` opens TUI overlay with tabbed groups
- [ ] All 5 core groups display correct data
- [ ] Memory, subagents, ralph groups appear when their modules are loaded
- [ ] Tab navigation works (←/→ to switch, q/Esc to close)
- [ ] Boot replaces pi's default greeting with the dashboard
- [ ] Config persists across sessions in `~/.pi/agent/settings.json`
- [ ] `/unipi:info-settings` allows toggling group visibility
- [ ] Per-stat visibility config works within groups
- [ ] Narrow terminal (<60 cols) shows graceful fallback
- [ ] External modules can register groups via `infoRegistry.registerGroup()`

## Decision Rationale

**Registry-centric over event-scatter:** Single source of truth. Config lives in one place. External modules get a clean API. Events are for discovery, not data delivery.

**Lazy render over immediate:** Solves module load order. All groups available at render time. 2s timeout prevents infinite wait.

**TUI overlay over inline:** Matches pi's existing pattern (powerline-footer). Modal behavior is familiar. No inline rendering complexity.

**Settings in `~/.pi/agent/settings.json`:** Follows powerline-footer's established pattern. User-editable. Pi's settings system handles this.

## Constraints and Boundaries

- All groups must have `id`, `name`, `icon`, `priority`, `config`, `dataProvider`
- `dataProvider` is async — must handle errors gracefully
- Config changes take effect on next overlay open (no live re-render of open overlay)
- External modules must import `@pi-unipi/info-screen` — circular dependency avoided by registry being standalone
- Boot overlay has 2s max wait for module announcements

## Assumptions

| Assumption | Status | Evidence |
|------------|--------|----------|
| Session files contain usage data | ✅ Verified | tmustier's `/usage` extension parses them successfully |
| `ctx.ui.custom()` works on boot | ⚠️ Unverified | powerline-footer uses it, but needs testing during `session_start` |
| External modules can import `@pi-unipi/info-screen` | ✅ Verified | npm workspaces allow cross-package imports |
| `~/.pi/agent/settings.json` writable | ✅ Verified | powerline-footer writes to it |
| Session file format is stable | ⚠️ Unverified | Pi may change format — parser should handle gracefully |

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| Session file format changes | Usage stats break | Parser returns empty data on parse errors, logs warning |
| Module load order affects boot | Groups missing | Lazy render with 2s timeout, show what's available |
| TUI overlay conflicts with powerline-footer | Visual glitch | Test with powerline-footer installed, use overlay positioning |
| Settings corruption | Config lost | Read with try/catch, fallback to defaults |
| Boot delay too long | Poor UX | 2s max timeout, show partial results if timeout hit |

## References

- Brainstorm: `docs/brainstorms/2026-04-26-unipi-info-screen-brainstorm.md`
- Architecture: `docs/brainstorms/2026-04-26-unipi-architecture-brainstorm.md`
- powerline-footer welcome overlay: https://github.com/nicobailon/pi-powerline-footer
- tmustier usage extension: https://github.com/tmustier/pi-extensions/tree/main/usage-extension
- Pi TUI docs: `~/.pi/agent/.../docs/tui.md`
- Pi extensions docs: `~/.pi/agent/.../docs/extensions.md`

## Next Steps

1. Start `/work` to implement Phase 1 (core registry & config)
2. Test `ctx.ui.custom()` during `session_start` for boot overlay
3. Decide on session parser approach (own implementation vs wrapping tmustier's)
