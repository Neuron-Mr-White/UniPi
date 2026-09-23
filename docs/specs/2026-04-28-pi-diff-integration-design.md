---
title: "Pi-Diff Integration into Utility Package"
type: brainstorm
date: 2026-04-28
---

# Pi-Diff Integration into Utility Package

## Problem Statement

The default `write` and `edit` tool output in Pi is plain text — no syntax highlighting, no diff coloring, no split-view comparison. This makes it hard to visually scan what changed. The open-source `@heyhuynhgiabuu/pi-diff` (MIT) project solves this with Shiki-powered, syntax-highlighted diffs in split and unified views. We want to adopt this functionality into `@pi-unipi/utility` as a toggle-able feature, integrated into a consolidated settings TUI.

## Context

**Reference project:** `@heyhuynhgiabuu/pi-diff` — MIT licensed, 1626-line single-file pi extension. Wraps `write` and `edit` tools with Shiki-powered diff rendering. Features:
- Split view (side-by-side) for `edit` tool, auto-falls back to unified on narrow terminals
- Unified view (stacked single-column) for `write` tool overwrites
- Word-level emphasis on changed characters
- LRU cache (192 entries) for Shiki highlights
- Large diff fallback (skip highlighting above 80k chars)
- Theme presets (default, midnight, subtle, neon) + per-color overrides + auto-derive from pi theme
- Dependencies: `diff` (v7), `@shikijs/cli` (v4)

**Current utility package:** Has badge settings stored in `.unipi/config/badge.json`, managed via `BadgeSettingsTui` overlay and `/unipi:badge-settings` command. Settings will be consolidated into a single `/unipi:util-settings` command and unified config file.

**No existing diff code** in the utility package — this is greenfield within the package.

## Chosen Approach

Add diff rendering as a sub-module inside `@pi-unipi/utility` under `src/diff/`. Split the monolithic pi-diff source into focused modules for maintainability. Gate the write/edit tool registration behind a toggle in a unified settings system. When disabled, default Pi tools run unchanged. When enabled, enhanced tools with Shiki diffs are registered at session start.

## Why This Approach

- **Inside utility (not separate package):** Keeps the extension suite consolidated. Diff is a presentation enhancement, not an independent system.
- **Split into modules:** The 1626-line single file is navigable but not maintainable. Separate files for theme, parsing, highlighting, rendering, and the extension wrapper make each concern independently understandable.
- **Toggle at init time:** Tool registration happens once at extension load. The toggle controls whether enhanced tools are registered. Clean, no runtime overhead when disabled.
- **Direct dependencies:** `diff` and `@shikijs/cli` are small, MIT-licensed, and essential. No point in optional/peer complexity.
- **Consolidated settings:** Badge and diff settings in one config file and one TUI command. Eliminates settings fragmentation.

## Design

### Module Structure

```
packages/utility/src/diff/
├── settings.ts       # Diff settings: type, defaults, read/write from util-settings.json
├── theme.ts          # Diff presets, color resolution chain, auto-derive from pi theme
├── parser.ts         # structuredPatch → DiffLine[] parsing, word diff analysis
├── highlighter.ts    # Shiki ANSI singleton, LRU cache, pre-warm, language detection
├── renderer.ts       # renderSplit(), renderUnified(), injectBg(), ANSI utilities
└── wrapper.ts        # write/edit tool wrapping — execute, renderCall, renderResult
```

### Config Migration & Unified Settings

**New config file:** `.unipi/config/util-settings.json`

```json
{
  "badge": {
    "autoGen": true,
    "badgeEnabled": true,
    "agentTool": true,
    "generationModel": "inherit"
  },
  "diff": {
    "enabled": true,
    "theme": "default",
    "shikiTheme": "github-dark",
    "splitMinWidth": 150
  }
}
```

**Migration:** On first read, if `.unipi/config/badge.json` exists but `util-settings.json` doesn't, import badge values into the new format and write `util-settings.json`. Old file left in place (not deleted) for safety.

**`src/diff/settings.ts`** — exports:
- `DiffSettings` interface
- `readDiffSettings(): DiffSettings` — reads from util-settings.json, returns defaults if missing
- `writeDiffSettings(partial: Partial<DiffSettings>)` — merges and writes
- `readUtilSettings()` / `writeUtilSettings()` — full unified settings read/write, used by TUI

**Refactor `src/tui/badge-settings.ts`:** The `readBadgeSettings()` / `writeBadgeSettings()` functions delegate to the unified settings manager. Existing callers continue to work — the functions become thin wrappers that read/write the `badge` section of `util-settings.json`.

### Diff Settings Type

```typescript
interface DiffSettings {
  /** Enable Shiki-powered diff rendering for write/edit tools */
  enabled: boolean;
  /** Diff theme preset: "default" | "midnight" | "subtle" | "neon" */
  theme: string;
  /** Shiki syntax theme name */
  shikiTheme: string;
  /** Minimum terminal columns for split view */
  splitMinWidth: number;
}
```

### Tool Registration Flow

```
Extension init (src/index.ts)
  ├── readDiffSettings()
  ├── if diffSettings.enabled:
  │     registerEnhancedWriteTool(pi, cwd)
  │     registerEnhancedEditTool(pi, cwd)
  └── if !diffSettings.enabled:
        (default write/edit tools remain unchanged)
```

The wrapper module (`src/diff/wrapper.ts`) exports two functions:
- `registerEnhancedWriteTool(pi, cwd)` — gets `createWriteTool` from SDK, wraps execute + renderCall + renderResult
- `registerEnhancedEditTool(pi, cwd)` — gets `createEditTool` from SDK, wraps execute + renderCall + renderResult

Both follow the same pattern as pi-diff: read old content before write, delegate to original, compute diff, store in `result.details`, render asynchronously in `renderResult`.

### Rendering Pipeline

Preserved from pi-diff exactly:

```
Old content ──┐
              ├── diff.structuredPatch() → DiffLine[]
              ├── Shiki codeToANSI() with LRU cache
              ├── injectBg() composites diff bg under syntax fg
              ├── wordDiffAnalysis() for character-level emphasis
              └── renderSplit() or renderUnified() → ANSI string
New content ──┘
```

### Module Details

**`theme.ts`** — Color system
- `DiffPreset` interface and 4 built-in presets (default, midnight, subtle, neon)
- `loadDiffConfig()` — reads diff settings from util-settings.json
- `applyDiffPalette()` — resolves colors: env vars → per-color overrides → preset → auto-derive → hardcoded
- `resolveDiffColors(theme?)` — runtime resolution reading pi theme's `toolDiffAdded`/`toolDiffRemoved`
- `autoDeriveBgFromTheme()` — mixes accent colors into `toolSuccessBg` base
- Hex ↔ ANSI conversion utilities

**`parser.ts`** — Diff parsing
- `parseDiff(oldContent, newContent, ctx=3): ParsedDiff` — wraps `diff.structuredPatch`, returns `DiffLine[]` with line numbers
- `wordDiffAnalysis(a, b)` — single `Diff.diffWords()` call returning similarity score + character ranges
- `DiffLine`, `ParsedDiff` interfaces
- Hunk separator logic

**`highlighter.ts`** — Shiki integration
- Singleton Shiki highlighter with pre-warm on module load
- `hlBlock(code, language): Promise<string[]>` — LRU-cached ANSI highlighting
- `normalizeShikiContrast(ansi)` — bumps low-contrast Shiki foregrounds
- Language detection from file extension (`EXT_LANG` map)
- Constants: `CACHE_LIMIT=192`, `MAX_HL_CHARS=80_000`

**`renderer.ts`** — ANSI diff rendering
- `renderUnified(diff, language, max, dc)` — stacked single-column view
- `renderSplit(diff, language, max, dc)` — side-by-side view with auto-fallback
- `shouldUseSplit(diff, tw, max)` — heuristic: terminal width, wrap ratio, code column width
- `injectBg(ansiLine, ranges, baseBg, hlBg)` — composites diff backgrounds into Shiki ANSI
- ANSI utilities: `strip()`, `fit()`, `wrapAnsi()`, `ansiState()`, `lnum()`, `stripes()`
- Terminal width detection: `termW()`
- Adaptive wrap: `adaptiveWrapRows()`
- Constants: `MAX_PREVIEW_LINES=60`, `MAX_RENDER_LINES=150`, `SPLIT_MIN_WIDTH=150`, `SPLIT_MIN_CODE_WIDTH=60`

**`wrapper.ts`** — Tool wrapping
- `registerEnhancedWriteTool(pi, cwd)` — wraps SDK `createWriteTool`:
  - `execute`: reads old content → delegates → stores diff in `result.details`
  - `renderCall`: streaming line count, Shiki preview for new files
  - `renderResult`: async diff rendering with invalidation
- `registerEnhancedEditTool(pi, cwd)` — wraps SDK `createEditTool`:
  - `execute`: extracts edit operations → delegates → stores edit info in `result.details`
  - `renderCall`: split-view preview of edit operations
  - `renderResult`: summary with line location
- Helper: `getEditOperations(input)` — normalizes single/multi edit params
- Helper: `summarizeEditOperations(operations)` — aggregated diff stats

### Settings TUI: `/unipi:util-settings`

**Replaces:** `/unipi:badge-settings` (kept as deprecated alias)

**File:** `src/tui/util-settings-tui.ts` — replaces `badge-settings-tui.ts`

**Structure:** Single TUI overlay with two navigable sections:

```
╭──────────────────────────────────────────────╮
│ ⚙ Utility Settings                           │
│ Configure badge and diff rendering           │
│                                              │
│ ── Badge ──                                  │
│ ▸ ● Auto generate                            │
│     Generate session name on first message   │
│   ● Badge enabled                            │
│     Show the name badge overlay              │
│   ● Agent tool                               │
│     Allow agents to call set_session_name    │
│   ⚙ Generation model: inherit               │
│     Model for badge name generation          │
│                                              │
│ ── Diff Rendering ──                         │
│   ○ Enabled                                  │
│     Shiki-powered syntax-highlighted diffs   │
│   ⚙ Theme: default                          │
│     Diff color preset                        │
│   ⚙ Shiki theme: github-dark                │
│     Syntax highlighting grammar              │
│                                              │
│ ↑↓ navigate • Space toggle • Esc save+close  │
╰──────────────────────────────────────────────╯
```

**Navigation:**
- `↑/↓` or `j/k` — navigate items across sections
- `Space` — toggle boolean settings
- `Enter` — open picker for model/theme settings
- `Esc` — save all changes and close

**Pickers:**
- **Generation model** — scrollable list from model cache (existing behavior)
- **Diff theme** — preset picker: default, midnight, subtle, neon
- **Shiki theme** — theme picker: github-dark, dracula, one-dark-pro, catppuccin-mocha, etc.

**Behavior:** All settings saved on close (Esc). Diff `enabled` toggle takes effect on next session restart (since tool registration happens at init).

### Command Registration Changes

| Command | Action |
|---------|--------|
| `/unipi:util-settings` | **New primary** — opens unified settings TUI |
| `/unipi:badge-settings` | **Deprecated alias** — opens `/unipi:util-settings` |
| `/unipi:badge-toggle` | Kept as CLI shorthand for badge-specific toggles |
| `/unipi:badge-name` | Unchanged |
| `/unipi:badge-gen` | Unchanged |

**Core constants update:** Add `UTIL_SETTINGS: "util-settings"` to `UTILITY_COMMANDS` in `@pi-unipi/core/constants.ts`.

### Dependencies Added to `package.json`

```json
{
  "dependencies": {
    "@pi-unipi/core": "*",
    "diff": "^7.0.0",
    "@shikijs/cli": "^4.0.2"
  },
  "devDependencies": {
    "@types/diff": "^7.0.2"
  }
}
```

### Files Changed / Created

**New files:**
- `src/diff/settings.ts` — diff settings type and I/O
- `src/diff/theme.ts` — color presets, resolution, auto-derive
- `src/diff/parser.ts` — diff parsing, word diff analysis
- `src/diff/highlighter.ts` — Shiki cache, language detection
- `src/diff/renderer.ts` — split/unified renderers, ANSI utilities
- `src/diff/wrapper.ts` — write/edit tool wrapping
- `src/tui/util-settings-tui.ts` — unified settings TUI overlay

**Modified files:**
- `src/index.ts` — add diff tool registration gated by settings toggle
- `src/commands.ts` — register `/unipi:util-settings`, deprecate `/unipi:badge-settings`
- `src/tui/badge-settings.ts` — refactor to delegate to unified settings manager
- `package.json` — add diff, @shikijs/cli, @types/diff dependencies
- `README.md` — document diff feature and new settings command

**Potentially modified (core):**
- `packages/core/constants.ts` — add `UTIL_SETTINGS` to `UTILITY_COMMANDS`

**Deprecated / replaced:**
- `src/tui/badge-settings-tui.ts` — replaced by `util-settings-tui.ts`

### Export Surface

The diff sub-module exports for testing and cross-package use:

```typescript
// src/diff/renderer.ts
export { renderSplit, renderUnified, parseDiff, normalizeShikiContrast } from "./renderer.js";

// src/diff/wrapper.ts
export { registerEnhancedWriteTool, registerEnhancedEditTool } from "./wrapper.js";

// src/diff/settings.ts
export { readDiffSettings, writeDiffSettings, type DiffSettings } from "./settings.js";
```

### Testing Strategy

- **Unit tests** for pure functions: `parseDiff`, `renderSplit`, `renderUnified`, `wordDiffAnalysis`, `injectBg`, `normalizeShikiContrast`, ANSI utilities
- **Settings tests**: read/write util-settings.json, migration from badge.json
- **Integration test**: verify tool registration gating (enabled vs disabled)
- Port existing pi-diff test patterns if any exist (the reference project uses vitest)

## Implementation Checklist

- [x] Create `src/diff/settings.ts` — DiffSettings type, read/write util-settings.json, migration from badge.json — covered in Task 1
- [x] Refactor `src/tui/badge-settings.ts` to delegate to unified settings manager — covered in Task 1
- [x] Create `src/diff/theme.ts` — presets, color resolution, auto-derive, hex/ANSI conversion — covered in Task 2
- [x] Create `src/diff/parser.ts` — parseDiff, wordDiffAnalysis, DiffLine/ParsedDiff types — covered in Task 3
- [x] Create `src/diff/highlighter.ts` — Shiki singleton, LRU cache, hlBlock, language detection, contrast normalization — covered in Task 4
- [x] Create `src/diff/renderer.ts` — renderSplit, renderUnified, injectBg, ANSI utilities, shouldUseSplit, terminal width — covered in Task 5
- [x] Create `src/diff/wrapper.ts` — registerEnhancedWriteTool, registerEnhancedEditTool, getEditOperations — covered in Task 6
- [x] Create `src/tui/util-settings-tui.ts` — unified settings TUI with badge + diff sections — covered in Task 7
- [x] Update `src/commands.ts` — register `/unipi:util-settings`, deprecate `/unipi:badge-settings` — covered in Task 8
- [x] Update `src/index.ts` — gate diff tool registration on settings, integrate with session lifecycle — covered in Task 8
- [x] Update `packages/core/constants.ts` — add UTIL_SETTINGS to UTILITY_COMMANDS — covered in Tasks 1/8
- [x] Update `package.json` — add diff, @shikijs/cli, @types/diff dependencies — covered in Tasks 3/4
- [x] Write unit tests for diff parser, renderer, settings, ANSI utilities — covered in Task 9
- [x] Update `README.md` — document diff feature, settings command, configuration — covered in Task 8

## Open Questions

- Should diff `enabled` toggle take effect immediately (hot-reload) or require session restart? Current design: restart. Hot-reload would require unregistering/re-registering tools at runtime, which may not be supported by pi's extension API.
- Should we export `__testing` like pi-diff does for downstream consumers? Likely yes — follows the same pattern for testability.

## Out of Scope

- Custom diff color overrides via `diffColors` in settings (pi-diff supports this, deferred to later)
- Environment variable overrides for diff colors (preserved from pi-diff but not documented as a primary config path)
- Standalone `@pi-unipi/diff` package — intentionally inside utility
- Hot-reload of diff toggle without session restart
