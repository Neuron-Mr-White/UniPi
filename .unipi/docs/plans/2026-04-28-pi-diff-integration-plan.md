---
title: "Pi-Diff Integration — Implementation Plan"
type: plan
date: 2026-04-28
workbranch: feat/pi-diff
specs:
  - .unipi/docs/specs/2026-04-28-pi-diff-integration-design.md
---

# Pi-Diff Integration — Implementation Plan

## Overview

Add Shiki-powered, syntax-highlighted diff rendering for `write` and `edit` tool output inside `@pi-unipi/utility`. Split the monolithic pi-diff reference (1626 lines) into focused modules under `src/diff/`. Gate tool registration behind a toggle in a unified settings system (`util-settings.json`). Consolidate badge and diff settings into a single `/unipi:util-settings` TUI command.

## Tasks

- completed: Task 1 — Unified Settings Foundation
  - Description: Create `src/diff/settings.ts` with `DiffSettings` interface, `readDiffSettings()`, `writeDiffSettings()`, `readUtilSettings()`, `writeUtilSettings()`. Implement migration from `badge.json` → `util-settings.json` on first read. Refactor `src/tui/badge-settings.ts` to delegate to the unified settings manager (thin wrappers over the `badge` section of `util-settings.json`).
  - Dependencies: None
  - Acceptance Criteria: `readDiffSettings()` returns defaults when no config exists; `readUtilSettings()` returns both badge and diff sections; migration imports `badge.json` into `util-settings.json` on first read and leaves old file in place; existing `readBadgeSettings()` callers still work unchanged; unit tests pass.
  - Steps:
    1. Create `src/diff/settings.ts` with `DiffSettings` interface (`enabled`, `theme`, `shikiTheme`, `splitMinWidth`), `UtilSettings` interface (badge + diff sections), read/write functions
    2. Implement migration logic: if `badge.json` exists but `util-settings.json` doesn't, import badge values, write `util-settings.json`
    3. Refactor `src/tui/badge-settings.ts` so `readBadgeSettings()` / `writeBadgeSettings()` / `updateBadgeSetting()` delegate to `readUtilSettings()` / `writeUtilSettings()`
    4. Add `UTIL_SETTINGS: "util-settings"` to `UTILITY_COMMANDS` in `packages/core/constants.ts`
    5. Write unit tests for settings read/write, migration, and badge delegation

- unstarted: Task 2 — Diff Theme System
  - Status: completed
  - Description: Create `src/diff/theme.ts` with 4 presets (default, midnight, subtle, neon), color resolution chain (env vars → per-color overrides → preset → auto-derive → hardcoded), hex ↔ ANSI conversion utilities, and `resolveDiffColors()` runtime resolution reading pi theme's `toolDiffAdded`/`toolDiffRemoved`.
  - Dependencies: Task 1 (reads settings for theme config)
  - Acceptance Criteria: All 4 presets return valid color objects; `resolveDiffColors()` falls back gracefully when no pi theme is available; hex ↔ ANSI conversion round-trips correctly; unit tests pass.
  - Steps:
    1. Create `src/diff/theme.ts` with `DiffPreset` interface and 4 built-in presets
    2. Implement `loadDiffConfig()` reading diff settings from util-settings.json
    3. Implement `applyDiffPalette()` with resolution chain: env vars → per-color overrides → preset → auto-derive → hardcoded
    4. Implement `resolveDiffColors(theme?)` reading pi theme's `toolDiffAdded`/`toolDiffRemoved`
    5. Implement `autoDeriveBgFromTheme()` mixing accent colors into `toolSuccessBg` base
    6. Add hex ↔ ANSI conversion utilities
    7. Write unit tests for presets, color resolution, and conversions

- unstarted: Task 3 — Diff Parser
  - Status: completed
  - Description: Create `src/diff/parser.ts` with `parseDiff()` wrapping `diff.structuredPatch()`, `wordDiffAnalysis()` using `Diff.diffWords()`, and `DiffLine`/`ParsedDiff` interfaces. Add `diff` and `@types/diff` dependencies to `package.json`.
  - Dependencies: None
  - Acceptance Criteria: `parseDiff()` returns `DiffLine[]` with correct line numbers and hunk separators; `wordDiffAnalysis()` returns similarity score and character ranges; handles empty inputs gracefully; unit tests pass.
  - Steps:
    1. Add `"diff": "^7.0.0"` and `"@types/diff": "^7.0.2"` to `packages/utility/package.json`
    2. Create `src/diff/parser.ts` with `DiffLine` and `ParsedDiff` interfaces
    3. Implement `parseDiff(oldContent, newContent, ctx=3)` wrapping `diff.structuredPatch()`
    4. Implement `wordDiffAnalysis(a, b)` using `Diff.diffWords()` returning similarity + ranges
    5. Handle edge cases: empty inputs, identical content, very large diffs
    6. Write unit tests for parser and word diff analysis

- unstarted: Task 4 — Shiki Highlighter
  - Status: completed
  - Description: Create `src/diff/highlighter.ts` with singleton Shiki highlighter, LRU cache (192 entries), `hlBlock()` for cached ANSI highlighting, `normalizeShikiContrast()`, and language detection from file extension. Add `@shikijs/cli` dependency.
  - Dependencies: Task 3 (parser types used alongside)
  - Acceptance Criteria: Shiki highlighter initializes once; LRU cache evicts oldest entries at capacity; `hlBlock()` returns ANSI-highlighted lines; `normalizeShikiContrast()` bumps low-contrast foregrounds; language detection maps common extensions; large content (>80k chars) skips highlighting gracefully; unit tests pass.
  - Steps:
    1. Add `"@shikijs/cli": "^4.0.2"` to `packages/utility/package.json`
    2. Create `src/diff/highlighter.ts` with LRU cache implementation (capacity 192)
    3. Implement singleton Shiki highlighter with pre-warm on module load
    4. Implement `hlBlock(code, language): Promise<string[]>` with LRU caching
    5. Implement `normalizeShikiContrast(ansi)` for low-contrast foreground bumping
    6. Add `EXT_LANG` map for language detection from file extensions
    7. Add constants: `CACHE_LIMIT=192`, `MAX_HL_CHARS=80_000`
    8. Write unit tests for cache behavior, contrast normalization, language detection

- unstarted: Task 5 — Diff Renderer
  - Status: completed
  - Description: Create `src/diff/renderer.ts` with `renderSplit()`, `renderUnified()`, `injectBg()`, ANSI utilities (`strip()`, `fit()`, `wrapAnsi()`, `ansiState()`, `lnum()`, `stripes()`), `shouldUseSplit()`, `termW()`, `adaptiveWrapRows()`. This is the largest module — the visual engine.
  - Dependencies: Task 2 (theme colors), Task 3 (parser types), Task 4 (highlighter)
  - Acceptance Criteria: `renderSplit()` produces side-by-side ANSI output; `renderUnified()` produces stacked single-column output; `shouldUseSplit()` auto-falls back to unified on narrow terminals; `injectBg()` composites diff backgrounds under syntax foregrounds; ANSI utilities handle edge cases (zero-width, emoji, CJK); constants match spec (`MAX_PREVIEW_LINES=60`, `MAX_RENDER_LINES=150`, `SPLIT_MIN_WIDTH=150`); unit tests pass.
  - Steps:
    1. Create `src/diff/renderer.ts` with all ANSI utility functions: `strip()`, `fit()`, `wrapAnsi()`, `ansiState()`, `lnum()`, `stripes()`
    2. Implement `termW()` for terminal width detection
    3. Implement `injectBg(ansiLine, ranges, baseBg, hlBg)` for background compositing
    4. Implement `adaptiveWrapRows()` for smart line wrapping
    5. Implement `shouldUseSplit(diff, tw, max)` heuristic
    6. Implement `renderUnified(diff, language, max, dc)` — stacked single-column view
    7. Implement `renderSplit(diff, language, max, dc)` — side-by-side view with auto-fallback
    8. Add constants: `MAX_PREVIEW_LINES=60`, `MAX_RENDER_LINES=150`, `SPLIT_MIN_WIDTH=150`, `SPLIT_MIN_CODE_WIDTH=60`
    9. Write unit tests for renderers, ANSI utilities, background injection

- unstarted: Task 6 — Tool Wrapper
  - Status: completed
  - Description: Create `src/diff/wrapper.ts` with `registerEnhancedWriteTool()` and `registerEnhancedEditTool()` that wrap the default Pi tools. Each reads old content before write, delegates to original, computes diff, stores in `result.details`, renders asynchronously in `renderResult`. Also includes `getEditOperations()` and `summarizeEditOperations()` helpers.
  - Dependencies: Task 4 (highlighter), Task 5 (renderer), Task 1 (settings toggle)
  - Acceptance Criteria: `registerEnhancedWriteTool()` replaces write tool with diff-enhanced version; `registerEnhancedEditTool()` replaces edit tool with diff-enhanced version; disabled state leaves default tools unchanged; `getEditOperations()` normalizes single/multi edit params; diff stored in `result.details` for async rendering; unit tests pass.
  - Steps:
    1. Create `src/diff/wrapper.ts` with `registerEnhancedWriteTool(pi, cwd)` — gets createWriteTool from SDK, wraps execute + renderCall + renderResult
    2. Implement `registerEnhancedEditTool(pi, cwd)` — gets createEditTool from SDK, wraps execute + renderCall + renderResult
    3. Implement `getEditOperations(input)` helper normalizing single/multi edit params
    4. Implement `summarizeEditOperations(operations)` for aggregated diff stats
    5. Ensure read-before-write captures old content for diff computation
    6. Store diff data in `result.details` for async `renderResult` consumption
    7. Write unit tests for tool wrapping, edit operation parsing

- unstarted: Task 7 — Unified Settings TUI
  - Status: completed
  - Description: Create `src/tui/util-settings-tui.ts` replacing `badge-settings-tui.ts`. Single TUI overlay with two navigable sections: Badge (autoGen, badgeEnabled, agentTool, generationModel) and Diff Rendering (enabled, theme, shikiTheme). Include pickers for model, diff theme preset, and Shiki theme.
  - Dependencies: Task 1 (settings manager), Task 2 (theme presets for picker)
  - Acceptance Criteria: TUI renders two sections with correct settings; ↑↓ navigates across sections; Space toggles booleans; Enter opens pickers (model, diff theme, Shiki theme); Esc saves all changes and closes; settings persist to `util-settings.json`; `/unipi:badge-settings` still works as deprecated alias.
  - Steps:
    1. Create `src/tui/util-settings-tui.ts` extending the `Component` pattern from `badge-settings-tui.ts`
    2. Implement Badge section: autoGen toggle, badgeEnabled toggle, agentTool toggle, generationModel picker (reuse existing model list logic)
    3. Implement Diff Rendering section: enabled toggle, theme preset picker (default/midnight/subtle/neon), Shiki theme picker
    4. Implement picker modes for diff theme presets and Shiki themes
    5. Wire navigation: ↑↓ across all items in both sections, Space/Enter/Esc handlers
    6. Save all settings on close to `util-settings.json`
    7. Write unit tests for TUI state management

- unstarted: Task 8 — Command & Extension Integration
  - Status: completed
  - Description: Update `src/commands.ts` to register `/unipi:util-settings` as primary command and deprecate `/unipi:badge-settings`. Update `src/index.ts` to read diff settings on init and gate enhanced tool registration. Update `README.md`.
  - Dependencies: Task 6 (wrapper), Task 7 (TUI), Task 1 (settings)
  - Acceptance Criteria: `/unipi:util-settings` opens unified settings TUI; `/unipi:badge-settings` redirects to `/unipi:util-settings`; diff tools registered when `enabled: true` in settings; default tools remain when `enabled: false`; `MODULE_READY` event includes diff commands if enabled; README documents diff feature and settings.
  - Steps:
    1. Update `src/commands.ts`: register `/unipi:util-settings` using `UtilSettingsTui`, add deprecation notice for `/unipi:badge-settings`
    2. Update `src/index.ts`: import `readDiffSettings`, conditionally call `registerEnhancedWriteTool()` and `registerEnhancedEditTool()` in session_start if enabled
    3. Update `ALL_COMMANDS` array in `src/index.ts` to include `util-settings`
    4. Update `README.md` with diff feature documentation, settings command, configuration options
    5. Update `packages/core/constants.ts` with `UTIL_SETTINGS` command constant (if not done in Task 1)

- unstarted: Task 9 — Unit Tests & Integration Verification
  - Status: completed
  - Description: Write comprehensive unit tests for all diff modules. Run full test suite. Verify integration: settings migration, tool registration gating, TUI rendering, diff output.
  - Dependencies: All previous tasks
  - Acceptance Criteria: All existing tests still pass; new diff module tests pass; settings migration tested end-to-end; tool registration gating verified (enabled/disabled states); `npm test` green across the package.
  - Steps:
    1. Write tests for `src/diff/settings.ts`: read/write, migration, defaults
    2. Write tests for `src/diff/theme.ts`: presets, color resolution, conversions
    3. Write tests for `src/diff/parser.ts`: parseDiff, wordDiffAnalysis, edge cases
    4. Write tests for `src/diff/highlighter.ts`: cache, contrast, language detection
    5. Write tests for `src/diff/renderer.ts`: renderSplit, renderUnified, ANSI utilities
    6. Write tests for `src/diff/wrapper.ts`: tool wrapping, edit operations
    7. Write tests for `src/tui/util-settings-tui.ts`: state management, save/load
    8. Run `npm test` and verify all pass
    9. Manual integration verification: enable diff, restart, trigger write/edit tool

## Sequencing

```
Task 1 (Settings) ─────────────────────────┐
Task 3 (Parser)  ──────────────────────────┤
                                            ├── Task 6 (Wrapper) ── Task 8 (Integration) ── Task 9 (Tests)
Task 2 (Theme) ── Task 5 (Renderer) ───────┤
                                            │
Task 4 (Highlighter) ──────────────────────┘
                         │
                    Task 7 (TUI) ──────────┘
```

- **Parallel-safe:** Tasks 1, 2, 3, 4 can start in parallel (no dependencies between them)
- **Sequential:** Task 5 needs 2+3+4; Task 6 needs 4+5+1; Task 7 needs 1+2; Task 8 needs 6+7+1; Task 9 needs all
- **Critical path:** Task 3 → Task 4 → Task 5 → Task 6 → Task 8 → Task 9

## Risks

1. **SDK tool wrapping API** — The spec assumes `createWriteTool`/`createEditTool` are available from the Pi SDK. These may not be exported. Mitigation: use `pi.registerTool()` to re-register with the same name, reading old content manually before delegating to the filesystem directly.

2. **Shiki initialization overhead** — Shiki highlighter startup can be slow (~200ms). Mitigation: singleton with pre-warm on module load, not on first diff render.

3. **Large diff performance** — Very large files (>80k chars) should skip Shiki highlighting. The spec handles this with `MAX_HL_CHARS=80_000` — ensure this is enforced early in the pipeline.

4. **Theme compatibility** — Pi themes may not define `toolDiffAdded`/`toolDiffRemoved`. Mitigation: `resolveDiffColors()` must have full fallback chain ending in hardcoded defaults.

5. **Settings migration race** — If two extension instances start simultaneously, both could try to migrate. Mitigation: atomic write with temp file + rename pattern.
