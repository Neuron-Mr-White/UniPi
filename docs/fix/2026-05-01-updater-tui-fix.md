---
title: "Updater TUI Overlays — Interactivity & Design Fix"
type: quick-fix
date: 2026-05-01
---

# Updater TUI Overlays — Interactivity & Design Fix

## Bug
The readme, changelog, and update-available TUI overlays in the updater package had two classes of issues:

1. **Interactivity**: `data.toLowerCase()` was used on raw key input, which broke arrow key sequences (`\x1b[B` → `\x1b[b`) and uppercase keys like `G` (go-to-bottom).
2. **Design**: Raw ANSI escape codes (`\x1b[1m`, `\x1b[7m`, `\x1b[36m`) were used instead of the `theme` API, resulting in inconsistent styling that didn't match other packages' TUI overlays.

## Root Cause
The updater overlays were written before the `Key`/`matchesKey` utilities and `Theme` API were standardized across the codebase. They used:
- `data.toLowerCase()` which corrupts escape sequences
- Hardcoded ANSI color codes instead of `theme.fg()`, `theme.bold()`, `theme.bg()`
- Custom `trunc()`/`padVisible()` instead of `truncateToWidth()`/`visibleWidth()` from `@mariozechner/pi-tui`
- Simple `─` dividers instead of proper box drawing (`╭╮╰╯│├┤`)

## Fix
Aligned all three overlays with the patterns used by `info-screen`, `mcp/settings-overlay`, and other well-structured TUI components:

- Replaced `data.toLowerCase()` + manual string comparison with `matchesKey(data, Key.xxx)` from `@mariozechner/pi-tui`
- Replaced raw ANSI codes with `theme.fg()`, `theme.bold()`, `theme.bg()` using the `Theme` parameter
- Replaced custom `trunc()` with `truncateToWidth()` from `@mariozechner/pi-tui`
- Added proper box drawing frame (`╭╮╰╯│├┤`) matching other overlays
- Removed `pendingG` double-key timeout pattern in favor of direct `g`/`G` handling

### Files Modified
- `packages/updater/src/tui/readme-overlay.ts` — Full rewrite of key handling, styling, and layout
- `packages/updater/src/tui/changelog-overlay.ts` — Full rewrite of key handling, styling, and layout
- `packages/updater/src/tui/update-overlay.ts` — Full rewrite of key handling, styling, and layout

## Verification
- `npx tsc --noEmit` passes with zero errors
- Key handling now uses `matchesKey(data, Key.escape|up|down|enter)` which properly handles Kitty protocol and legacy sequences
- `G` (shift+g) now correctly triggers go-to-bottom (was broken by `toLowerCase()`)
- Styling now uses theme colors (`accent`, `success`, `warning`, `error`, `muted`, `text`, `selectedBg`) for consistency

## Notes
- The `update-overlay.ts` retains async install logic — only the UI/input layer was changed
- `settings-overlay.ts` in the same package was already using theme correctly, so it was not modified

---

## Follow-up: Theme-aware Markdown Rendering

### What was added
Updated `renderMarkdown()` to accept an optional `Theme` parameter. When provided, it uses the full `Markdown` component from `@mariozechner/pi-tui` with `getMarkdownTheme()` from `@mariozechner/pi-coding-agent` for proper syntax highlighting, list nesting, tables, and themed styling.

### Files Modified
- `packages/updater/src/markdown.ts` — Added theme-aware rendering path using `Markdown` component
- `packages/updater/src/tui/readme-overlay.ts` — Passes `theme` to `renderMarkdown()`
- `packages/updater/src/tui/changelog-overlay.ts` — Uses `renderMarkdown()` for detail view instead of inline rendering
- `packages/updater/src/tui/update-overlay.ts` — Uses `renderMarkdown()` for changelog body content
