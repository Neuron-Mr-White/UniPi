---
title: "Footer Enchantment Fixes — Implementation Plan"
type: plan
date: 2026-05-02
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-02-footer-enchantment-fixes-design.md
---

# Footer Enchantment Fixes — Implementation Plan

## Overview

Six surgical fixes to the footer package: TPS tracker rewrite, settings reactivity wiring, no-data segment placeholders, emoji icon audit, settings TUI keybindings, and uppercase short labels. Each fix is isolated to specific files with no cross-dependencies.

## Tasks

- completed: Task 1 — TPS Rewrite: Per-Message Generation Rate
  - Description: Replace cumulative-token sliding window with per-message tracking that measures generation duration per assistant message and excludes idle time from session averages.
  - Dependencies: None
  - Acceptance Criteria:
    - `TpsTracker` tracks individual messages with `startedAt`/`completedAt` timestamps
    - Live TPS shows current message generation rate while streaming
    - Session average excludes tool execution idle time
    - Fast messages (<1s between ticks) get estimated duration using floor heuristic
    - Display states work: streaming (`↑ 42 T/S`), just completed (`↑ 42 T/S · AVG 38`), idle (`AVG 38 T/S`)
  - Steps:
    1. Rewrite `packages/footer/src/tps-tracker.ts` — replace `TokenEvent` buffer with `MessageTpsRecord[]`. Add fields: `messageIndex`, `outputTokens`, `startedAt`, `completedAt`, `tps`. Add `lastSeenMessageCount` for dedup.
    2. Add `onMessageUpdate(messageIndex: number, outputTokens: number, hasStopReason: boolean)` method to `TpsTracker`. When a message is seen without stopReason → record `startedAt`. When it gains stopReason → record `completedAt`, compute TPS. Handle fast-message case (already has stopReason on first sighting) with `duration = min(outputTokens / 100, 1)` seconds.
    3. Replace `getLiveTps()` → returns latest message's TPS if generating, else 0.
    4. Replace `getSessionAvgTps()` → `sum(outputTokens) / sum(generationDurations)`, excluding incomplete messages.
    5. Add `isStreaming()` → true if latest message has `startedAt` but no `completedAt`.
    6. Update `packages/footer/src/index.ts` timer callback (the `setInterval` in `setupFooterUI`): instead of summing cumulative tokens and calling `tpsTracker.onTokenEvent()`, scan session branch for assistant messages, call `tpsTracker.onMessageUpdate(messageIndex, outputTokens, hasStopReason)`.
    7. Update `renderTpsSegment` in `packages/footer/src/segments/core.ts` to use new display states: streaming (`↑ {live} T/S`), completed+idle (`↑ {live} T/S · AVG {avg}`), idle-only (`AVG {avg} T/S`). Use `tpsTracker.isStreaming()` for state detection.
    8. Keep `reset()` and singleton export pattern unchanged.

- completed: Task 2 — Fix Settings Reactivity: Preset, Separator, Labels
  - Description: Three bugs where settings are saved to disk but never applied to the running renderer. Fix preset change callback, separator source, and full-labels dead code.
  - Dependencies: None
  - Acceptance Criteria:
    - Changing preset in settings TUI immediately updates footer layout
    - Changing separator in settings TUI immediately updates separator glyphs
    - Toggling "Full Labels" in settings TUI switches between compact and labeled mode
    - Renderer reads `settings.separator` not `preset.separator` for separator style
    - `separator` field removed from `PresetDef` type and all preset definitions
  - Steps:
    1. In `packages/footer/src/tui/settings-tui.ts` → `onAppearanceChange`:
       - Add a callback mechanism: `FooterSettingsOverlay` constructor accepts an `onSettingsChanged` callback. `showFooterSettings` passes `() => state.renderer.resetLayoutCache()` (or more specific reactivity methods).
       - For `case "preset"`: after saving, call `state.renderer.setPreset(newValue)` via the callback.
       - For `case "separator"`: after saving, call `state.renderer.resetLayoutCache()` via the callback.
       - For `case "showFullLabels"`: after saving, call `state.renderer.resetLayoutCache()` via the callback.
    2. Wire the callback: in `packages/footer/src/commands.ts` (or wherever `showFooterSettings` is called), pass the callback that calls `state.renderer.resetLayoutCache()` and `state.tuiRef?.requestRender()`.
    3. In `packages/footer/src/rendering/renderer.ts` → `computeLayout`: replace `const sepDef = getSeparator(presetDef.separator)` with `const settings = loadFooterSettings(); const sepDef = getSeparator(settings.separator)`.
    4. Remove `separator` from `PresetDef` interface in `packages/footer/src/types.ts`.
    5. Remove `separator` from all preset definitions in `packages/footer/src/presets.ts` (all 6 presets).
    6. For full-labels reactivity: add `formatSegmentLabel()` helper to a shared location (e.g., `packages/footer/src/rendering/renderer.ts` or a new `packages/footer/src/rendering/labels.ts`):
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
    7. Update all segment renderers to use `formatSegmentLabel()` when displaying label:value pairs. Not all segments use `withIcon` for label:value format — only update those that do (most segments use `withIcon(segmentId, text)` where text is already formatted). The key change is: segments that show `shortLabel:value` format should check `ctx.labelMode` and switch to `fullLabel: value` when in labeled mode.

- completed: Task 3 — No-Data Segment Placeholders
  - Description: When a segment is toggled ON but has no data, show an explicit muted placeholder instead of hiding. This affects Ralph, MCP, Memory, Compactor, Kanboard, and Notify segments.
  - Dependencies: None
  - Acceptance Criteria:
    - Ralph segments show `🔁 RL OFF` (no loop ever) or `🔁 RL 0` (no iterations) in muted color
    - MCP segments show `🖥️ MCP 0` (no servers) or `🖥️ MCP 1/0` (servers, no tools) in muted color
    - Memory segments show `🧠 MEM 0` in muted color
    - Compactor segments show `⚡ CMP 0` in muted color
    - Kanboard segments show `KB 0` in muted color
    - Notify segments show `NTF OFF` in muted color
    - Placeholder only shows when the group/segment is enabled in settings
  - Steps:
    1. Add a shared helper `mutedPlaceholder(text: string): string` in a shared location (e.g., `packages/footer/src/rendering/theme.ts` or inline) that wraps text in dim ANSI codes: `` `\x1b[2m${text}\x1b[0m` ``.
    2. In `packages/footer/src/segments/ralph.ts`: In each renderer, when no data, check `isSegmentEnabled("ralph", segmentId)` and return `{ content: mutedPlaceholder("RL OFF"), visible: true }` instead of `{ visible: false }`.
    3. In `packages/footer/src/segments/mcp.ts`: When `serversTotal` is undefined, show `mutedPlaceholder("MCP 0")`. When servers exist but no tools, show `mutedPlaceholder("MCP {n}/0")`.
    4. In `packages/footer/src/segments/memory.ts`: When project count is null, show `mutedPlaceholder("MEM 0")`.
    5. In `packages/footer/src/segments/compactor.ts`: In `renderSessionEventsSegment` and `renderCompactionsSegment`, when count is 0, show `mutedPlaceholder("CMP 0")` (only if enabled).
    6. In `packages/footer/src/segments/kanboard.ts`: When no kanboard registry data, show `mutedPlaceholder("KB 0")`.
    7. In `packages/footer/src/segments/notify.ts`: When no platforms, show `mutedPlaceholder("NTF OFF")`. When no timestamp, show `mutedPlaceholder("NTF 0")`.
    8. Each segment file needs to import `isSegmentEnabled` from `../config.js` for the enabled check. Import `mutedPlaceholder` from the shared location.

- completed: Task 4 — Emoji Icon Audit & Fix
  - Description: Replace all non-emoji Unicode symbols in `EMOJI_ICONS` with proper Unicode emoji that render as colored glyphs on modern terminals.
  - Dependencies: None
  - Acceptance Criteria:
    - Every entry in `EMOJI_ICONS` is a standard Unicode emoji (not a symbol/dingbat)
    - No mixing of emoji and symbol styles within the set
    - No duplicate emoji where they would be confusing (e.g., memory and consolidations use different emoji)
  - Steps:
    1. In `packages/footer/src/rendering/icons.ts`, replace the following entries in `EMOJI_ICONS`:
       - `git`: `"⎇"` → `"🔀"`
       - `tokens`: `"⊛"` → `"📊"`
       - `tokensIn`: `"→"` → `"⬇️"`
       - `tokensOut`: `"←"` → `"⬆️"`
       - `session`: `"#"` → `"📋"`
       - `hostname`: `"⌂"` → `"🏠"`
       - `tps`: `"↑"` → `"⚡"`
       - `sessionEvents`: `"⚡"` → `"📈"` (avoid conflict with new tps)
       - `compactions`: `"◧"` → `"🗜️"`
       - `compressionRatio`: `"⇄"` → `"📐"`
       - `indexedDocs`: `"☰"` → `"📑"`
       - `sandboxRuns`: `"▶"` → `"▶️"` (proper emoji variant)
       - `searchQueries`: `"⊗"` → `"🔍"`
       - `consolidations`: `"🧠"` → `"🔄"` (avoid conflict with memory `🧠`)
       - `serversActive`: `"●"` → `"🟢"`
       - `tasksDone`: `"✓"` → `"✅"`
       - `tasksTotal`: `"☐"` → `"📋"`
       - `taskPct`: `"%"` → `"📊"`
       - `platformsEnabled`: `"♮"` → `"🔔"`
       - `extensionStatuses`: `"▦"` → `"🧩"`
    2. Review the full list after changes to ensure no remaining symbols/dingbats.
    3. Keep entries that are already proper emoji: `🤖`, `🔄`, `🔧`, `🗄️`, `💲`, `💡`, `🖥️`, `⚠️`, `🔁`, `▶️`, `🔒`, `⏱`, `🕔`.

- completed: Task 5 — Settings TUI Keybinding Additions
  - Description: Add `j`/`k` navigation, `l` drill-down, `Space` toggle, `Esc` back-to-root, `/` search, and `h` back to the settings TUI overlay.
  - Dependencies: None
  - Acceptance Criteria:
    - `j` moves down in all sections
    - `k` moves up in all sections
    - `l` drills into group from segments section (same as Enter)
    - `Space` toggles on/off in segments section
    - `Escape` goes back if in drill-down, closes if at root
    - `h` goes back from segment drill-down
    - `/` focuses search in segments section
    - Existing keybindings still work (Tab, Shift+Tab, ↑, ↓, Enter, Backspace)
  - Steps:
    1. In `packages/footer/src/tui/settings-tui.ts` → `handleInput()`, add cases before the delegation to `this.currentList?.handleInput(data)`:
       - `data === "j"`: delegate down to current list (`this.currentList?.handleInput(/* down signal */)`). Need to check how `SettingsList` expects input — it likely uses `"\x1b[B"` for down arrow. Map `j` → `"\x1b[B"`, `k` → `"\x1b[A"`.
       - `data === "k"`: map to `"\x1b[A"` (up arrow).
       - `data === "l"`: in segments section at group level, same as Enter (drill into focused group).
       - `data === " "`: delegate to current list (Space toggles).
       - `data === "\x1b"` (Escape): if `this.selectedGroupId` is set, go back to groups; otherwise close.
       - `data === "h"`: if in segment drill-down, same as left arrow (back to groups).
       - `data === "/"`: if current list supports search, delegate.
    2. The current `handleInput` already handles Escape/q → close and h → back. Refactor:
       - `q`: always close (move before the Escape check)
       - `Escape`: back from drill-down OR close at root
       - `h`: back from drill-down (already handled, confirm it works)
    3. Update hint text in `render()` to reflect new keys: `"j/k navigate · Space toggle · l enter · Esc back/close · / search"`.

- completed: Task 6 — Uppercase All Segment Short Labels
  - Description: Change all segment `shortLabel` values from lowercase abbreviations to uppercase (e.g., `mdl` → `MDL`, `tps` → `TPS`).
  - Dependencies: Task 2 (full-labels `formatSegmentLabel` helper will use `shortLabel` in compact mode)
  - Acceptance Criteria:
    - All 41 segment `shortLabel` values across all 9 segment files are uppercase
    - Segment display in compact mode uses uppercase labels
    - No functional change beyond label casing
  - Steps:
    1. In `packages/footer/src/segments/core.ts`: Change shortLabels: `mdl→MDL`, `api→API`, `tls→TLS`, `git→GIT`, `tps→TPS`, `ctx→CTX`, `cst→CST`, `tok→TOK`, `tin→TIN`, `tout→TOUT`, `ses→SES`, `hst→HST`, `clk→CLK`, `dur→DUR`, `thk→THK`.
    2. In `packages/footer/src/segments/compactor.ts`: `evt→EVT`, `cmp→CMP`, `svd→SVD`, `rat→RAT`, `idx→IDX`, `sbx→SBX`, `qry→QRY`.
    3. In `packages/footer/src/segments/memory.ts`: `mem→MEM`, `tot→TOT`, `cns→CNS`.
    4. In `packages/footer/src/segments/mcp.ts`: `srv→SRV`, `act→ACT`, `tls→TLS`, `err→ERR`.
    5. In `packages/footer/src/segments/ralph.ts`: `rl→RL`, `itr→ITR`, `sts→STS`.
    6. In `packages/footer/src/segments/workflow.ts`: `wrk→WRK`, `sbx→SBX`, `cdur→CDUR`.
    7. In `packages/footer/src/segments/kanboard.ts`: `doc→DOC`, `dne→DNE`, `tsk→TSK`, `pct→PCT`.
    8. In `packages/footer/src/segments/notify.ts`: `ntf→NTF`, `lst→LST`.
    9. In `packages/footer/src/segments/status-ext.ts`: `ext→EXT`.

## Sequencing

```
Task 1 (TPS Rewrite)        ── independent
Task 2 (Settings Reactivity) ── independent
Task 3 (No-Data Placeholders) ── independent
Task 4 (Emoji Icons)         ── independent
Task 5 (TUI Keybindings)     ── independent
Task 6 (Uppercase Labels)    ── depends on Task 2 (uses shortLabel in formatSegmentLabel)
```

Tasks 1–5 can be done in any order. Task 6 should come after Task 2 to ensure the `formatSegmentLabel` helper uses the updated labels. In practice, all six can be done sequentially in one session.

Recommended order: Task 4 → Task 6 → Task 2 → Task 5 → Task 3 → Task 1
(Start with pure content changes, then wiring, then the most complex TPS rewrite last.)

## Risks

1. **TPS fast-message heuristic** — Estimating generation duration for messages that complete between 1s ticks using `outputTokens / 100` is a heuristic. If actual generation speed is much faster (>100 t/s, which is common for short responses), the estimate will be too long. The floor of 1 second caps this, but the TPS shown for fast messages may be inaccurate. Acceptable trade-off since these messages are very short.

2. **Separator removal from PresetDef** — Removing the `separator` field from presets is a type change. Any code that reads `presetDef.separator` will break. Need to verify all usages are updated (renderer.ts is the main one).

3. **Settings TUI callback wiring** — The settings overlay doesn't currently have a reference to the renderer or the state. Adding `onSettingsChanged` callback requires changes to the call chain: `commands.ts` → `showFooterSettings()` → `FooterSettingsOverlay`. The `state` object has `renderer` and `tuiRef`, so the callback can close over these.

4. **SettingsList input format** — The `j`/`k` → arrow key mapping assumes `SettingsList.handleInput()` accepts standard terminal escape sequences (`\x1b[B` for down, `\x1b[A` for up). Need to verify by reading the `SettingsList` implementation in `@mariozechner/pi-tui`.
