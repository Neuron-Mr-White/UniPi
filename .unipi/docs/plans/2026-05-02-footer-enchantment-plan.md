---
title: "Footer Enchantment — Implementation Plan"
type: plan
date: 2026-05-02
workbranch:
specs:
  - .unipi/docs/specs/2026-05-02-footer-enchantment-design.md
---

# Footer Enchantment — Implementation Plan

## Overview

Transform the footer from functional-but-lifeless to vibrant and informative. Five interdependent changes: zone-based layout, TPS segment, color palette, footer-help overlay, and unified settings TUI. The footer's modular architecture (independent segments, registry pattern, renderer cache) supports cohesive redesign without tangling concerns.

**Key insight for TPS data source:** No new events needed. The existing `getUsageStats()` pattern in `core.ts` already iterates `sessionManager.getBranch()` for per-message token counts. TPS derives from timestamp deltas on these messages — a pure footer-internal calculation.

## Tasks

- completed: Task 1 — Type System & Segment Metadata
  - Description: Extend FooterSegment and SemanticColor types to support zones, descriptions, short labels, and all new color semantics. Assign metadata to all 41 existing segments.
  - Dependencies: None
  - Acceptance Criteria: TypeScript compiles clean. Every segment has zone, description, and shortLabel. New SemanticColor entries compile and have defaults in DEFAULT_COLOR_MAP.
  - Steps:
    1. Add `zone: "left" | "center" | "right"` to `FooterSegment` type in `types.ts`
    2. Add `description: string` to `FooterSegment` type
    3. Add `shortLabel: string` to `FooterSegment` type (compact display name, e.g. "ses", "tps", "ctx")
    4. Add new SemanticColor union members: `tpsSlow`, `tpsModerate`, `tpsGood`, `tpsFast`, `tpsBlazing`, `tpsIdle`, `clock`, `duration`, `gitClean`, `gitDirty`, `session`, `workflowNone`, `workflowDebug`, `workflowChoreExec`, `worktree`
    5. Add placeholder entries for all new SemanticColor names in `DEFAULT_COLOR_MAP` (theme.ts) — exact hex values come in Task 2
    6. Add zone + description + shortLabel to all 41 segments across `core.ts`, `compactor.ts`, `memory.ts`, `mcp.ts`, `ralph.ts`, `workflow.ts`, `kanboard.ts`, `notify.ts`, `status-ext.ts`
    7. Zone assignments per spec: Left (model, git, session, current_command), Center (tps, context_pct, tokens_total, cost, all compactor/memory/mcp/ralph/kanboard/notify metrics), Right (clock, duration)
    8. Verify TypeScript compiles: `npx tsc --noEmit` from footer package

- completed: Task 2 — Color Palette
  - Description: Replace the current theme-token-only palette with the spec's hex-based zone-family colors. All visual personality lives here.
  - Dependencies: Task 1 (new SemanticColor entries)
  - Acceptance Criteria: `DEFAULT_COLOR_MAP` contains all hex values from spec. `applyColor()` correctly resolves them (already works for hex). Workflow segments render with command-type colors.
  - Steps:
    1. Update `DEFAULT_COLOR_MAP` in `theme.ts` with all hex values from the spec:
       - Left zone: model `#c792ea`, gitClean `#82cc6f`, gitDirty `#e5c07b`, session `#61afef`, workflowNone `#4a6a7a`
       - Workflow type colors: red/orange/yellow/green/blue/purple per command category
       - Center zone: tps tier colors (slow→red, moderate→amber, good→teal, fast→green, blazing→purple), tpsIdle `#4a6a7a`, context thresholds, tokens `#abb2bf`, cost `#d19a66`, memory `#61afef`, compactor `#56b6c2`, mcp `#82cc6f`, ralph `#e5c07b`, kanboard `#c678dd`, notify `#56b6c2`
       - Right zone: clock `#abb2bf`, duration `#61afef`
       - Thinking levels: off `#4a6a7a`, minimal `#56b6c2`, low `#61afef`, medium `#c792ea`, high `#d19a66`, xhigh `#e06c75`
    2. Update the git segment in `core.ts` to use `gitClean` vs `gitDirty` based on branch dirty state (check `footerData.getGitDirty()`)
    3. Update session segment to use `session` semantic color
    4. Verify rendering: hex colors produce correct ANSI codes via existing `applyColor()`

- completed: Task 3 — TPS Tracking & Segment + Clock & Duration
  - Description: Add TPS data derivation (sliding 3s window), the tps segment with tier coloring, a wall-clock segment, and update the duration segment label/format.
  - Dependencies: Task 1 (type fields), Task 2 (TPS tier colors)
  - Acceptance Criteria: TPS segment shows live rate during generation, session average when idle. Clock shows HH:MM:SS, duration shows H:MM:SS. Both update every second.
  - Steps:
    1. Create `packages/footer/src/tps-tracker.ts` — TpsTracker class:
       - `onTokenEvent(timestamp: number, outputTokens: number)` method
       - Sliding buffer: `Array<{ timestamp, outputTokens }>` capped at 3s window
       - `getLiveTps(): number` — rate from buffer
       - `getSessionAvgTps(): number` — totalOutput / sessionDuration
       - `isGenerating(): boolean` — true if buffer has entries within last 2s
       - `reset()` for session shutdown
    2. Wire TpsTracker into `index.ts` — call `onTokenEvent()` from the existing 1s timer tick by reading `getUsageStats()` and comparing output token deltas
    3. Add `tps` segment to `CORE_SEGMENTS` in `core.ts`:
       - Active: `↑ 42 t/s · avg 38` with tier-colored live, muted avg
       - Idle: `avg 38 t/s` in tpsIdle color
       - Color tier function: <30 red, 30-50 amber, 50-100 teal, 100-200 green, >200 purple
    4. Add `clock` segment to `CORE_SEGMENTS` — wall time `HH:MM:SS`, uses `clock` semantic color
    5. Update `time` segment → rename label to `dur`, change format to `H:MM:SS` / `MM:SS`, use `duration` semantic color
    6. Add `clock` and `tps` icons to all 3 icon sets in `icons.ts`
    7. Verify TPS updates during generation, clock/duration tick every second

- completed: Task 4 — Workflow Colors & Thinking Level Segment
  - Description: Wire up the spec's workflow command→color mapping and add the optional thinking level segment.
  - Dependencies: Task 2 (workflow colors in palette)
  - Acceptance Criteria: Workflow segment shows correct color per command type. Thinking level segment renders with 6-level colors. Rainbow mode option exists.
  - Steps:
    1. Update `getWorkflowSemanticColor()` in `workflow.ts` to match spec categories:
       - Red: brainstorm, debug, gather-context, quick-fix, quick-work, chore-create
       - Orange: chore-execute, plan
       - Yellow: work
       - Green: review-work, review
       - Blue: worktree-*
       - Purple: other
    2. Add `thinking_level` segment to `CORE_SEGMENTS` in `core.ts`:
       - Read thinking level from `piContext.model.thinkingLevel` or equivalent
       - Map to 6 semantic colors (off/minimal/low/medium/high/xhigh)
       - `defaultShow: false`
    3. Add `thinkingLevel` icon to all 3 icon sets
    4. Add rainbow mode option: when `thinkingLevel` is high/xhigh and rainbow setting is on, apply per-character rainbow gradient (reuse existing `rainbowText()` from `core.ts`)

- completed: Task 5 — Zone-Aware Renderer & Preset Updates
  - Description: Replace the flat linear segment layout with 3-zone rendering (left/center/right). Update all 6 presets to declare zones.
  - Dependencies: Task 1 (zone field on segments)
  - Acceptance Criteria: Footer renders in 3 visual zones with correct alignment. Overflow spills to secondary row per zone. Zone separators are configurable.
  - Steps:
    1. Update `PresetDef` type in `types.ts`: add `zoneOrder?: ("left" | "center" | "right")[]` and `zoneSeparator?: string` fields
    2. Add `labelMode: "compact" | "labeled"` to `FooterSettings` and `FooterSegmentContext`
    3. Refactor `FooterRenderer.computeLayout()`:
       - Group rendered segments by their `zone` field
       - Render left zone left-aligned, right zone right-aligned, center zone fills middle
       - Apply zone separator between zones (configurable, default `│` dimmed)
       - Calculate available width per zone: left + right measured, center gets remainder
    4. Update secondary row logic: overflow from each zone wraps to secondary, maintaining zone alignment
    5. Update all 6 presets in `presets.ts` to order segments by zone:
       - Default: Left [model, git], Center [tps, context_pct, tokens_total, cost, compactions], Right [clock, duration]
       - Adjust each preset per its current intent (minimal has fewer segments, etc.)
    6. Add `zoneSeparator` key to `FooterSettings` type and config
    7. Verify rendering at various terminal widths (80, 120, 200 columns)

- completed: Task 6 — Footer-Help & Full-Label Mode
  - Description: Add `/unipi:footer-help` overlay and compact/labeled toggle. Both depend on the description and shortLabel fields from Task 1.
  - Dependencies: Task 1 (descriptions), Task 5 (zones for grouping)
  - Acceptance Criteria: `/unipi:footer-help` opens overlay showing enabled segments by zone with descriptions. Full-label mode switches segment display from `ses:sonnet` to `Model: sonnet`.
  - Steps:
    1. Add `FOOTER_HELP` to `FOOTER_COMMANDS` in `packages/core/constants.ts`
    2. Create `packages/footer/src/help.ts` — `showFooterHelp()` function:
       - Reads enabled segments from registry + settings
       - Groups by zone
       - Renders bordered overlay: zone headers, each segment shows icon + shortLabel + description
       - Uses pi's `ctx.ui.custom()` with overlay mode
       - Scrollable (vim keys + arrows), dismissible with Escape/q
    3. Register `/unipi:footer-help` command in `commands.ts`
    4. Add `showFullLabels: boolean` to `FooterSettings` type (default: false)
    5. In segment renderers, check `ctx.labelMode`: if `"labeled"`, use `segment.label` + ": " prefix; if `"compact"`, use `segment.shortLabel`
    6. Pass `labelMode` through `FooterSegmentContext` from renderer
    7. Load/save `showFullLabels` in config.ts
    8. Add help icon and icons for help-related UI

- unstarted: Task 7 — Unified Settings TUI & Command Cleanup
  - Description: Replace 2-tab settings TUI with 3-category unified layout. Simplify `/unipi:footer` to toggle-only. Move sep/icon/preset args into settings TUI.
  - Dependencies: Task 5 (zone settings), Task 6 (label settings)
  - Acceptance Criteria: `/unipi:footer-settings` opens 3-category TUI. `/unipi:footer` only toggles on/off. All appearance settings are in the TUI.
  - Steps:
    1. Redesign `FooterSettingsOverlay` in `settings-tui.ts`:
       - Replace `Section = "groups" | "segments"` with 3 categories: Appearance, Segments, Labels & Help
       - **Appearance**: preset (cycle), separator (cycle), icon style (cycle), show full labels (toggle)
       - **Segments**: existing group → segment drill-down (reuse current logic)
       - **Labels & Help**: show full labels always (toggle), show zone headers (toggle)
    2. Update `SettingItem` arrays for each category:
       - Appearance items use `values` array for cycle-through options
       - Segments items use existing on/off toggles
    3. Remove `sep:<style>`, `icon:<style>`, preset name, `on`, `off` argument handling from `/unipi:footer` command handler
    4. Simplify `/unipi:footer` handler: toggle on/off only (no args = toggle, `on` = enable, `off` = disable)
    5. Remove `getArgumentCompletions` from footer command (no more args)
    6. Verify all settings persist to `settings.json` correctly
    7. Verify `/unipi:footer-settings` → Appearance → change separator → footer updates live

## Sequencing

```
Task 1 (Types)
  ├── Task 2 (Colors)
  │     └── Task 4 (Workflow/Thinking colors)
  └── Task 3 (TPS + Clock/Duration) [also needs Task 2 colors]
  └── Task 5 (Zone Renderer) [needs Task 1 zones]
        └── Task 6 (Help + Labels) [needs Task 1 descriptions, Task 5 zones]
              └── Task 7 (Settings TUI + Commands) [needs Task 5, 6]
```

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7

Tasks 3 and 4 can be done in parallel after Task 2, but sequential is fine for clarity.

## Risks

1. **TPS accuracy** — Deriving TPS from `getBranch()` iteration may be expensive if called every second. Mitigation: cache the last-known output token count and only re-iterate on delta; or track incrementally via the 1s timer comparing current vs previous totals.

2. **Zone layout at narrow widths** — 3-zone layout with separators may not fit in 80-col terminals. Mitigation: fall back to flat layout below a configurable width threshold (e.g., 100 cols).

3. **Color terminal compatibility** — Spec uses 24-bit hex colors (ANSI 38;2;r;g;b). Not all terminals support this. Mitigation: `applyColor()` already handles the fallback chain; ensure `ColorScheme` entries can be overridden per-terminal.

4. **Settings TUI complexity** — 3-category layout with cycle-selectors is more complex than current 2-tab. Mitigation: pi-tui's `SettingsList` supports cycle values natively via the `values` array.

5. **Segment count bloat** — Adding tps, clock, duration, thinking_level brings core segments from 12 to 16. Mitigation: new segments are carefully scoped; presets control which appear by default.
