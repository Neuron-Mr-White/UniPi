---
title: "Footer Enchantment Fixes — TPS, Settings Reactivity, Emoji, UX"
type: brainstorm
date: 2026-05-02
---

# Footer Enchantment Fixes

## Problem Statement

The footer is unreliable. Five concrete bugs/gaps make it feel broken:

1. **TPS is inaccurate** — 1Hz polling of cumulative tokens across all messages. Fast generation (<1s) produces no data points. Session average includes tool execution idle time, making it artificially low.
2. **Settings don't react** — Preset, separator, and full labels changes are saved to disk but never applied to the running renderer. Three separate bugs.
3. **No-data segments look dead** — Ralph, MCP, and other data-driven segments hide when no events have occurred, making their toggle appear broken.
4. **Emoji style is inconsistent** — `EMOJI_ICONS` mixes real emoji (🤖🔧💡) with random Unicode symbols (⎇⊛→⌂◧⊗♮).
5. **Settings TUI missing keys** — No `j`/`k`, `l`, `Space` for toggle, `Esc` back-at-root-to-close.

## Context

- Footer package fully implemented: 9 groups, 41 segments, zone-based layout, settings TUI
- `TpsTracker` uses a 3-second sliding window fed by a 1-second `setInterval` that re-scans all session events
- `FooterRenderer` reads preset/separator from preset definition, ignoring saved settings overrides
- `FooterSegmentContext.labelMode` is passed but never consumed by any segment renderer
- Segment renderers return `{ visible: false }` when no data available — correct behavior but confusing UX when the segment was just toggled on
- `EMOJI_ICONS` was hand-curated without systematic emoji selection — some keys got Unicode symbols instead

## Chosen Approach

**Surgical fixes + TPS rewrite.** Each issue is a discrete, isolated fix. The TPS tracker gets a fundamental redesign; everything else is wiring bugs, dead code activation, and content fixes.

## Why This Approach

- Each bug has a clear root cause and a clear fix — no architectural redesign needed
- TPS rewrite is the only non-trivial change, and it's self-contained in `TpsTracker`
- Risk is low: fixes are in separate files/functions with no cross-dependencies

**Alternatives rejected:**
- **Full settings TUI rewrite** — Overkill. The TUI works; it just needs keybinding additions.
- **Event-driven TPS with pi core changes** — Would require modifying pi's event system. Per-message tracking from existing data is sufficient.

## Design

### 1. TPS Rewrite — Per-Message Generation Rate

**Current approach (broken):**
```
Every 1 second:
  scan ALL session events → sum output tokens → feed cumulative to TpsTracker
  TpsTracker computes: (cumulative_now - cumulative_3s_ago) / 3
```

Problems:
- 1Hz resolution means generation bursts <1s get one data point → can't compute rate
- Cumulative approach averages out speed variations
- Session average = total_output / wall_clock_time (includes tool execution idle)

**New approach: Per-message tracking**

```
On each timer tick (1s):
  Scan session events for NEW completed assistant messages
  For each new message:
    Record: { output_tokens, generation_start, generation_end }
    generation_start = when message first appeared streaming (no stopReason)
    generation_end = when stopReason appeared (completed)
  
  Live TPS = latest message's output / generation_duration
  Session Avg TPS = sum(all outputs) / sum(all generation_durations)
```

**Data structures:**

```typescript
interface MessageTpsRecord {
  /** Index in session branch for dedup */
  messageIndex: number;
  /** Output tokens from usage.output */
  outputTokens: number;
  /** When we first saw this message streaming (no stopReason) */
  startedAt: number;   // Date.now()
  /** When the message completed (stopReason present) */
  completedAt: number; // Date.now()
  /** Computed TPS for this message */
  tps: number;
}
```

**Generation duration tracking:**

1. On each 1s tick, iterate session branch events
2. Find assistant messages (role === "assistant")
3. Track a `lastSeenMessageCount` to detect new messages
4. When a new message appears WITHOUT stopReason → record `startedAt` as `Date.now()` (streaming started)
5. When the same message gains a stopReason → record `completedAt`, compute `tps = outputTokens / ((completedAt - startedAt) / 1000)`
6. If a message appears WITH stopReason already (fast completion between ticks) → estimate duration as `min(outputTokens / 100, 1)` seconds (assume at least 100 t/s as floor)

**Display:**

| State | Display | Color |
|-------|---------|-------|
| Active generation (streaming) | `↑ 42 T/S` | Tier color |
| Message just completed | `↑ 42 T/S · AVG 38` | Tier + idle |
| Idle (between messages) | `AVG 38 T/S` | Idle color |

**Session average:** `sum(outputTokens for all records) / sum(generationDurations for all records)`

This excludes all idle time (tool execution, user thinking) from the average.

### 2. Settings Reactivity Fixes

**Bug 2a: Preset changes don't apply**

In `settings-tui.ts` → `onAppearanceChange`:
```typescript
case "preset":
  this.settings.preset = newValue;
  break;
```

Fix: After saving, call `state.renderer.setPreset(newValue)` and trigger re-render.
The settings TUI needs a reference to the renderer (or a callback).

**Bug 2b: Separator overridden by preset**

In `renderer.ts` → `computeLayout`:
```typescript
const presetDef = getPreset(this.presetName);
// ...
const sepDef = getSeparator(presetDef.separator);  // ← uses preset's separator
```

Fix: Use `settings.separator` when a non-default value is saved:
```typescript
const settings = loadFooterSettings();
const sepStyle = settings.separator;  // User's saved separator wins
const sepDef = getSeparator(sepStyle);
```

Remove `separator` from `PresetDef` entirely — separator is a user preference, not a preset property. Presets should only define which segments appear and in what order.

**Bug 2c: Full labels dead code**

`ctx.labelMode` is set in `renderSegment()` but no segment renderer reads it. The `withIcon()` helper always uses the icon + text.

Fix: Update segment rendering to check `ctx.labelMode`:
- `compact` mode: `icon shortLabel:value` (current behavior)
- `labeled` mode: `label: value` (full label, no icon)

Add a helper function:
```typescript
function formatSegmentLabel(
  ctx: FooterSegmentContext,
  segmentId: string,
  shortLabel: string,
  fullLabel: string,
  value: string,
): string {
  if (ctx.labelMode === "labeled") {
    return `${fullLabel}: ${value}`;
  }
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${shortLabel}:${value}` : `${shortLabel}:${value}`;
}
```

Update all segment renderers to use this helper instead of `withIcon()`.

### 3. No-Data Segment Display

**Rule:** When a segment is toggled ON but has no data, show an explicit state instead of hiding:

| Segment Group | No-Data Display |
|---------------|-----------------|
| Ralph (no loop) | `🔁 RL OFF` |
| Ralph (active but no iteration data) | `🔁 RL 0` |
| MCP (no servers) | `🖥️ MCP 0` |
| MCP (servers but no tools) | `🖥️ MCP 1/0` |
| Memory (no entries) | `🧠 MEM 0` |
| Compactor (no events) | `⚡ CMP 0` |
| Kanboard (no docs) | `KB 0` |
| Notify (no platforms) | `NTF OFF` |

All in **muted color** (dim/gray).

**Implementation:** Each segment renderer currently returns `{ visible: false }` when no data. Change to return `{ content: applyColor("muted", "RL OFF", ...), visible: true }` when the group is enabled in settings but data is empty.

Need a helper to check if a group/segment is enabled:
```typescript
import { isSegmentEnabled } from "../config.js";

function shouldShowPlaceholder(groupId: string, segmentId: string): boolean {
  return isSegmentEnabled(groupId, segmentId);
}
```

### 4. Emoji Style Audit & Fix

**Current problems in `EMOJI_ICONS`:**

| Key | Current | Problem | Fix |
|-----|---------|---------|-----|
| `git` | ⎇ | Unicode branching symbol, not emoji | 🔀 (twisted rightwards arrows) or 📂 |
| `tokens` | ⊛ | Operator symbol | 📊 or 🔢 |
| `tokensIn` | → | Arrow | ⬇️ |
| `tokensOut` | ← | Arrow | ⬆️ |
| `session` | # | Hash symbol | 📋 or 📑 |
| `hostname` | ⌂ | House symbol | 🏠 |
| `tps` | ↑ | Arrow | ⚡ |
| `context` | 🗄️ | OK emoji | Keep ✓ |
| `platformsEnabled` | ♮ | Music symbol | 🔔 |
| `sessionEvents` | ⚡ | OK but same as tps | 📈 |
| `compactions` | ◧ | Geometric shape | 🗜️ |
| `tokensSaved` | 💲 | OK | Keep ✓ |
| `compressionRatio` | ⇄ | Arrow | 📐 |
| `indexedDocs` | ☰ | Trigram | 📑 |
| `sandboxRuns` | ▶ | Triangle | ▶️ (proper emoji variant) |
| `searchQueries` | ⊗ | Circled times | 🔍 |
| `consolidations` | 🧠 | Same as memory | 🔄 |
| `serversTotal` | 🖥️ | OK | Keep ✓ |
| `serversActive` | ● | Dot | 🟢 |
| `serversFailed` | ⚠️ | OK | Keep ✓ |
| `tasksDone` | ✓ | Check mark | ✅ |
| `tasksTotal` | ☐ | Ballot box | 📋 |
| `taskPct` | % | Percent sign | 📊 |
| `lastSent` | ⏱ | OK | Keep ✓ |
| `extensionStatuses` | ▦ | Square with fill | 🧩 |
| `cost` | 💲 | OK | Keep ✓ |

**Rule for emoji set:** Every icon must be an actual Unicode emoji that renders as a colored glyph on modern terminals (not a symbol/dingbat). Test criteria: does it appear in the standard emoji list?

### 5. Settings TUI Keybinding Additions

**Current keybindings:**
- `Tab` / `Shift+Tab` → cycle sections
- `Escape` / `q` → close
- `Enter` → drill into group
- `←` / `Backspace` / `h` → back from segments
- `↑` / `↓` / `Space` → delegated to `SettingsList`

**Additions needed:**

| Key | Action | Context |
|-----|--------|---------|
| `j` | Move down | All sections |
| `k` | Move up | All sections |
| `l` | Enter / drill down | Segments section, at group level |
| `Space` | Toggle on/off | Segments section |
| `Escape` | Back (if in drill-down) or close (if at root) | All |
| `q` | Close from any level | All |
| `h` | Back (same as ←) | Segments drill-down |
| `/` | Search | Segments section |

**Implementation:** Add these key handlers in `FooterSettingsOverlay.handleInput()` before delegating to `SettingsList`.

### 6. Uppercase Segment Titles

All segment `shortLabel` values should be uppercase. Current lowercase ones:

| Segment | Current | Fixed |
|---------|---------|-------|
| model | `mdl` | `MDL` |
| api_state | `api` | `API` |
| tool_count | `tls` | `TLS` |
| git | `git` | `GIT` |
| tps | `tps` | `TPS` |
| context_pct | `ctx` | `CTX` |
| cost | `cst` | `CST` |
| tokens_total | `tok` | `TOK` |
| tokens_in | `tin` | `TIN` |
| tokens_out | `tout` | `TOUT` |
| session | `ses` | `SES` |
| hostname | `hst` | `HST` |
| clock | `clk` | `CLK` |
| duration | `dur` | `DUR` |
| thinking_level | `thk` | `THK` |
| session_events | `evt` | `EVT` |
| compactions | `cmp` | `CMP` |
| tokens_saved | `svd` | `SVD` |
| compression_ratio | `rat` | `RAT` |
| indexed_docs | `idx` | `IDX` |
| sandbox_runs | `sbx` | `SBX` |
| search_queries | `qry` | `QRY` |
| project_count | `mem` | `MEM` |
| consolidations | `cns` | `CNS` |
| servers_total | `srv` | `SRV` |
| servers_active | `act` | `ACT` |
| servers_failed | `err` | `ERR` |
| active_loops | `rl` | `RL` |
| total_iterations | `itr` | `ITR` |
| loop_status | `sts` | `STS` |
| current_command | `wrk` | `WRK` |
| sandbox_level | `sbx` | `SBX` |
| command_duration | `cdur` | `CDUR` |
| docs_count | `doc` | `DOC` |
| tasks_done | `dne` | `DNE` |
| tasks_total | `tsk` | `TSK` |
| task_pct | `pct` | `PCT` |
| platforms_enabled | `ntf` | `NTF` |
| last_sent | `lst` | `LST` |
| extension_statuses | `ext` | `EXT` |

## Implementation Checklist

- [x] Rewrite `TpsTracker` — per-message tracking with generation duration, exclude idle time from averages — covered in Task 1
- [x] Update `index.ts` timer to detect new/complete messages instead of summing cumulative totals — covered in Task 1
- [x] Add TPS display for streaming state (no stopReason yet) — covered in Task 1
- [x] Fix preset reactivity — settings TUI calls `renderer.setPreset()` after save — covered in Task 2
- [x] Fix separator reactivity — renderer reads `settings.separator` not `preset.separator` — covered in Task 2
- [x] Remove `separator` from `PresetDef` type and all preset definitions — covered in Task 2
- [x] Fix full labels — add `formatSegmentLabel()` helper, update all 41 segment renderers — covered in Task 2
- [x] Add no-data placeholders to Ralph, MCP, Memory, Compactor, Kanboard, Notify segments — covered in Task 3
- [x] Audit and fix all `EMOJI_ICONS` entries — replace Unicode symbols with proper emoji — covered in Task 4
- [x] Add `j`/`k`/`l`/`Space`/`Esc` keybindings to settings TUI overlay — covered in Task 5
- [x] Uppercase all segment `shortLabel` values across all 9 segment files — covered in Task 6
- [ ] Test TPS accuracy against manual timing
- [ ] Test all settings TUI toggles take immediate visual effect
- [ ] Test emoji rendering in terminal without Nerd Font

## Open Questions

1. **TPS fast-message floor** — When a message completes between timer ticks (appears fully formed), we need to estimate generation duration. Using `outputTokens / 100` as a floor (assuming 100 t/s minimum) is a heuristic. Is there a better approach?
2. **Separator preset coupling** — Currently presets define their own separator. Removing this means changing `PresetDef`. Should presets define a *recommended* separator that's overridden by user settings, or should presets not touch separator at all?

## Out of Scope

- **Zone layout changes** — Zone-based layout works; no changes needed
- **Color palette changes** — Colors are fine; no changes needed
- **New segments** — No new segments being added
- **Pi core changes** — No modifications to pi's event system or session manager
- **Settings TUI visual redesign** — Layout works; only keybinding additions
