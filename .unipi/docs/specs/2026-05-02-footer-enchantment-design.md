---
title: "Footer Enchantment — TPS, Colors, UX Regrouping, Help, Interactivity"
type: brainstorm
date: 2026-05-02
---

# Footer Enchantment

## Problem Statement

The footer package works functionally (41 segments, event-driven, settings TUI) but feels lifeless and confusing. Five interrelated issues:

1. **No TPS** — Can't see how fast the model is generating, the most interesting live metric
2. **No footer-help** — With text icons, segments are cryptic; no guide for users
3. **No color personality** — Flat, monochrome appearance; needs a distinctive palette
4. **Scattered layout** — Segments jumbled linearly, no visual grouping or hierarchy
5. **Stale/cryptic timer** — Session timer label unclear, no current clock, feels frozen

Additionally, footer settings are split between command args (`/unipi:footer sep:pipe`, `/unipi:footer icon:nerd`) and a partial TUI (only group/segment toggles). Needs unification.

## Context

- **Footer package** (`@pi-unipi/footer`) is fully implemented: 9 segment groups, 41 segments, `FooterRegistry` + `FooterRenderer`, event-driven updates with 1s timer + 33ms debounce, settings TUI with two-tab layout
- **Color infrastructure** exists: `SemanticColor` (30 names), `ColorScheme`, `DEFAULT_COLOR_MAP`, `applyColor()` supporting pi theme tokens + hex via raw ANSI
- **pi-powerline-footer** (reference) uses pink `#d787af` model, teal `#00afaf` path, rainbow for high thinking levels, foreground-only colors
- **Thinking level colors** in pi-powerline-footer: off/minimal/low/medium use theme tokens, high/xhigh use per-character rainbow gradient
- **Segment data** is already event-driven and cached in `FooterRegistry`; TPS derivation needs new tracking logic
- **Timer** fires correctly (1s `setInterval`) but only drives `session_duration` and `time` segments; no current clock segment exists

## Chosen Approach

**Cohesive Redesign** — Address all 5 concerns + settings unification as a single interdependent design. The footer's modular architecture (independent segments, registry pattern, renderer cache) makes it natural to redesign as one piece.

## Why This Approach

1. **Interdependency** — Colors inform grouping (zone families), grouping informs layout (3-zone), TPS needs fresh data (timer fix), help needs clear labels (segment naming)
2. **Visual coherence** — Designing palette + layout + TPS tiers together ensures they look intentional
3. **Architecture supports it** — Each segment is self-contained; touching layout, colors, data, and help doesn't tangle concerns
4. **Single plan** — One implementation plan instead of 5 fragmented ones

**Alternatives rejected:**
- **Bottom-Up (fix data first)** — Would produce functional but ugly intermediate states; TPS data needs to know where it's displayed
- **Top-Down (visuals first)** — Risks painting into a corner if TPS data flow requires layout changes

## Design

### 1. Zone-Based Layout (UX Regrouping)

Replace flat linear segment sequence with 3-zone layout:

```
┌─ LEFT ZONE ───────────┬─ CENTER ZONE ──────────────────────┬─ RIGHT ZONE ──────┐
│  ses:model │ git:main  │  ↑ 42 t/s · avg 38 │ ctx 45% │ tok 12.4k │  14:32:07 │ 0:37 │
│  wrk:plan             │  cost $0.42 │ mem 86 │ comp 7     │                   │
└───────────────────────┴─────────────────────────────────────┴───────────────────┘
```

| Zone | Alignment | Purpose | Segments |
|------|-----------|---------|----------|
| **Left** (Identity) | Left | "Who am I, where am I, what am I doing" | model, git, session_name, workflow_command |
| **Center** (Metrics) | Center-fill | "How is it going" | tps, context_pct, tokens_total, cost, memory, compactor, mcp, ralph, kanboard, notify |
| **Right** (Time) | Right | "How long" | clock (wall time), duration (session) |

**Secondary row** (narrow terminals):
- Spills overflow from center zone
- Same zone grouping, wrapped to second `setWidget`

**Implementation:**
- `FooterRenderer` gains zone-awareness: segments declare their zone via a new `zone: "left" | "center" | "right"` field
- Renderer groups segments by zone, measures widths, applies alignment padding
- Zone separators rendered with subtle dividers (configurable)

### 2. TPS (Tokens Per Second)

**New segment:** `tps` in the core group, placed first in center zone.

**Data derivation:**

1. **Live TPS** — Rolling 3-second window:
   - Maintain sliding buffer: `Array<{ timestamp: number, outputTokens: number }>`
   - On each session event containing output tokens, push to buffer, evict entries older than 3s
   - Compute: `TPS = (latestOutput - oldestOutput) / (now - oldestTimestamp)`
   - Buffer lives in `FooterRegistry` as a new data field

2. **Session average TPS:**
   - `totalOutputTokens / sessionDurationSeconds`
   - Tracked cumulatively from first token event

**Display behavior:**

| State | Display | Color |
|-------|---------|-------|
| Active generation (TPS > 0) | `↑ 42 t/s · avg 38` | Tier-based color for live, muted for avg |
| Idle (TPS = 0) | `avg 38 t/s` | Muted teal `#4a6a7a` |

**TPS color tiers:**

| Range | Color | Hex | Label |
|-------|-------|-----|-------|
| < 30 | Red | `#e06c75` | Slow |
| 30–50 | Amber | `#e5c07b` | Moderate |
| 50–100 | Teal | `#56d4bc` | Good |
| 100–200 | Green | `#82cc6f` | Fast |
| > 200 | Purple | `#c792ea` | Blazing |

**Data source:** `FooterRegistry` subscribes to session events (already done in `events.ts`). Extend the event handler to extract `message.usage.output_tokens` and feed the TPS buffer. No changes to other packages needed.

### 3. Color Palette

**Design philosophy:** Each zone has a tonal family. Within zones, segments use related hues. Key metrics get vivid accents. Degrades gracefully on limited-color terminals.

**Zone: Left (Identity)**

| Semantic | Hex | Purpose |
|----------|-----|---------|
| `model` | `#c792ea` | Soft purple — model name |
| `gitClean` | `#82cc6f` | Green — clean branch |
| `gitDirty` | `#e5c07b` | Amber — dirty branch |
| `session` | `#61afef` | Blue — session name |
| `workflowNone` | `#4a6a7a` | Muted teal — idle |

**Zone: Left — Workflow Type Colors**

| Types | Color | Hex |
|-------|-------|-----|
| brainstorm, debug, gather-context, quick-fix, quick-work, chore-create | Red | `#e06c75` |
| chore-execute, plan | Orange | `#d19a66` |
| work | Yellow | `#e5c07b` |
| review-work, review | Green | `#82cc6f` |
| worktree-* | Blue | `#61afef` |
| other | Purple | `#c792ea` |

**Zone: Center (Metrics)**

| Semantic | Hex | Purpose |
|----------|-----|---------|
| `tps` | tier-based | See TPS color tiers above |
| `tpsIdle` | `#4a6a7a` | Session avg when idle |
| `contextOk` | `dim` (theme) | Context < 70% |
| `contextWarn` | `#e5c07b` | Amber — context 70-90% |
| `contextError` | `#e06c75` | Red — context > 90% |
| `tokens` | `#abb2bf` | Silver — token counts |
| `cost` | `#d19a66` | Gold — cost |
| `memory` | `#61afef` | Blue — memory count |
| `compactor` | `#56b6c2` | Cyan — compaction stats |
| `mcp` | `#82cc6f` | Green — MCP status |
| `ralph` | `#e5c07b` | Amber — ralph loops |
| `kanboard` | `#c678dd` | Purple — kanboard |
| `notify` | `#56b6c2` | Cyan — notifications |

**Zone: Right (Time)**

| Semantic | Hex | Purpose |
|----------|-----|---------|
| `clock` | `#abb2bf` | Silver — wall clock |
| `duration` | `#61afef` | Blue — session duration |

**Thinking Level Colors (optional segment, default off)**

| Level | Color | Hex |
|-------|-------|-----|
| off | `#4a6a7a` | Muted teal |
| minimal | `#56b6c2` | Cyan |
| low | `#61afef` | Blue |
| medium | `#c792ea` | Purple |
| high | `#d19a66` | Gold |
| xhigh | `#e06c75` | Red |

With **rainbow mode** option (per-character gradient for high/xhigh, matching pi-powerline-footer approach).

**Fallback chain:** Custom hex → pi theme color → raw ANSI 256 → no color.

**Implementation:**
- Update `DEFAULT_COLOR_MAP` in `theme.ts` with new palette
- Add new semantic color names for TPS tiers and workflow types
- Add `zone` field to `FooterSegment` type
- `applyColor()` already handles hex + theme tokens — no changes needed to color application logic
- User overrides via unified settings TUI (Appearance category) or `colors` key in settings

### 4. Footer-Help + Segment Labels

**`/unipi:footer-help` command** — Opens overlay listing enabled segments:

```
┌─ ? Footer Segment Guide ─────────────────────────────────────┐
│                                                                │
│  LEFT ZONE (Identity)                                          │
│    ses   Session model name                                    │
│    git   Current git branch + dirty/clean status               │
│    wrk   Active workflow command                               │
│                                                                │
│  CENTER ZONE (Metrics)                                         │
│    ↑ t/s Tokens per second — live during generation            │
│    ctx   Context window usage percentage                       │
│    tok   Total tokens used this session                        │
│    cost  Session cost in USD                                   │
│                                                                │
│  RIGHT ZONE (Time)                                             │
│    🕐   Current time (HH:MM:SS)                               │
│    dur   Session duration                                      │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  ↑↓ scroll · q close                                          │
└────────────────────────────────────────────────────────────────┘
```

- Shows only **currently enabled** segments
- Grouped by zone
- For each segment: icon + short label + description
- Scrollable for many segments
- Dismissible with Escape/q

**Full-label mode** — Setting to show descriptive labels instead of abbreviations:

| Mode | Example |
|------|---------|
| **Compact** (default) | `ses:sonnet │ git:main │ ↑ 42 │ ctx 45%` |
| **Labeled** | `Model: sonnet │ Branch: main │ TPS: 42 │ Context: 45%` |

Toggle in settings TUI → Appearance → "Show full labels"

**Implementation:**
- New command `/unipi:footer-help` registered in `commands.ts`
- Each `FooterSegment` gains a `description: string` field
- Overlay reads enabled segments from registry, groups by zone, renders with icons + labels
- Label mode: `FooterRenderer` checks setting, uses `label` instead of `shortLabel` when rendering

### 5. Timer & Time Segments

**Two time segments in Right zone:**

| Segment | Label | Format | Update Frequency |
|---------|-------|--------|-----------------|
| `clock` | `🕐` / `clk` | `HH:MM:SS` | Every 1s |
| `duration` | `dur` | `H:MM:SS` or `MM:SS` | Every 1s |

**Fix:** The existing 1s timer already fires (confirmed by user — `TIM 0:36` did update to `0:37`). The issue is:
1. No wall clock segment — add `clock` to core segments
2. Session duration label was cryptic (`TIM`) — rename to `dur` with clear format
3. Both segments read from the timer tick (no new timer needed)

**Implementation:**
- Add `clock` segment to `CORE_SEGMENTS` in `core.ts`
- Update `duration` segment format to `H:MM:SS` / `MM:SS`
- Ensure both segments are refreshed on every timer tick (already handled by `renderer.resetLayoutCache()` on timer)

### 6. Unified Settings TUI

Replace current two-tab layout + scattered command args with single unified overlay:

```
┌─ ⚙ Footer Settings ──────────────────────────────────────────┐
│                                                                │
│  ▸ Appearance         Preset: default, Sep: pipe, Icons: nerd │
│  ▸ Segments           9 groups, 41 segments                   │
│  ▸ Labels & Help      Compact labels, Help overlay            │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  ↑↓ navigate · Enter expand · q close                         │
└────────────────────────────────────────────────────────────────┘
```

**Three expandable categories:**

| Category | Settings | Type |
|----------|----------|------|
| **Appearance** | Preset, Separator style, Icon style, Color scheme, Show full labels | Selector (cycle through options) |
| **Segments** | All 9 groups → per-group toggle → drill into per-segment toggle | Nested toggle |
| **Labels & Help** | Show full labels (always), Show zone headers, Help on startup | Toggle |

**Interactions:**
- `Enter` drills into category or cycles a value
- `Space` toggles on/off
- `←` / `Backspace` goes back
- `/` searches across all settings
- `q` / `Escape` closes

**Command changes:**
- `/unipi:footer` — remains for quick toggle on/off only
- `/unipi:footer-settings` — opens unified TUI (absorbs sep:, icon:, preset args)
- `/unipi:footer-help` — new command, opens help overlay
- Remove preset/sep/icon args from `/unipi:footer` command (moved to settings TUI)

## Implementation Checklist

- [x] Add `zone` field to `FooterSegment` type (left/center/right) and assign zones to all 41 segments — Task 1
- [x] Implement TPS tracking — sliding buffer in `FooterRegistry`, subscribe to session output token events — Task 3
- [x] Add `tps` segment to `CORE_SEGMENTS` with tier-based coloring — Task 3
- [x] Update `DEFAULT_COLOR_MAP` in `theme.ts` with new palette (zone families, TPS tiers, workflow types) — Task 2
- [x] Add workflow type color mapping (red/orange/yellow/green/blue/purple by command name) — Task 4
- [x] Add thinking level segment (optional, default off) with 6-level colors + rainbow mode — Task 4
- [x] Add `clock` segment to `CORE_SEGMENTS` (wall time, HH:MM:SS, 1s refresh) — Task 3
- [x] Update `duration` segment label from `TIM` to `dur`, format to `H:MM:SS`/`MM:SS` — Task 3
- [x] Add `description` field to `FooterSegment` type for help overlay — Task 1
- [x] Implement `/unipi:footer-help` command — overlay listing enabled segments by zone — Task 6
- [x] Add full-label mode toggle (compact vs labeled segment display) — Task 6
- [x] Implement zone-aware rendering in `FooterRenderer` — group by zone, apply alignment — Task 5
- [x] Redesign settings TUI — 3 categories (Appearance / Segments / Labels) replacing 2-tab layout — Task 7
- [x] Move preset/separator/icon settings from command args into settings TUI Appearance category — Task 7
- [x] Update `/unipi:footer` command to only handle toggle on/off — Task 7
- [x] Test TPS accuracy — verify rolling window calculation matches manual measurement — Task 3
- [x] Test timer reactivity — verify clock and duration update every second — Task 3
- [x] Test all color tiers — verify TPS, workflow, thinking colors render correctly — Task 4

## Open Questions

1. **Zone separator style** — Should zones be visually separated by a distinct character (e.g. `│` double bar) or just spacing? The current separator style applies between segments; zones might need a stronger divider.
2. **TPS buffer size** — 3-second window is proposed. Longer windows smooth more but respond slower. Is 3s the right balance?
3. **Rainbow thinking threshold** — Should rainbow apply to high only, or high + xhigh? Pi-powerline-footer applies to both.
4. **Settings TUI search** — Should search in the unified TUI search across all 3 categories simultaneously, or only within the current category?
5. **Label format** — For full-label mode, should it be `Model: sonnet` or `model: sonnet` (capitalized or lowercase)?

## Out of Scope

- **Background colors** — foreground-only for now (matching pi-powerline-footer approach)
- **Changes to other packages** — no modifications to compactor, memory, workflow, ralph, mcp, kanboard, or notify
- **Overlay/dashboard** — info-screen handles overlay concerns
- **Editor customizations** — no custom editor component
- **Responsive breakpoints** — exact column thresholds for 2-row layout (will tune during implementation)
