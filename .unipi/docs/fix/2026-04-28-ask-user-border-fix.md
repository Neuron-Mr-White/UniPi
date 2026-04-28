---
title: "Ask User TUI Missing Borders — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Ask User TUI Missing Borders — Quick Fix

## Bug
The ask-user TUI interfaces (`ask-ui.ts` and `settings-tui.ts`) rendered content with no box-drawing borders — just plain `─` horizontal lines or no borders at all. This looked inconsistent with the MCP TUI overlays which use proper `╭─╮│╰─╯` box borders.

## Root Cause
The ask-user render functions used `theme.fg("accent", "─".repeat(width))` for top/bottom separators and no vertical borders on content lines. The MCP overlays (`add-overlay.ts`, `settings-overlay.ts`) use the full box-drawing pattern with `padVisible()` for consistent padding.

## Fix
Applied the same border pattern used in `packages/mcp/src/tui/` to both ask-user TUI files:

### Files Modified
- `packages/ask-user/ask-ui.ts` — Added `visibleWidth` import, `padVisible` helper, `innerWidth` calculation, and `╭─╮│╰─╯` box borders wrapping all content lines
- `packages/ask-user/settings-tui.ts` — Same border pattern applied to the settings overlay component

### Pattern Applied
```typescript
const innerWidth = Math.max(40, width - 2);
const border = (s: string) => theme.fg("accent", s);
const add = (s: string) => lines.push(border("│") + padVisible(truncateToWidth(s, innerWidth), innerWidth) + border("│"));
const addEmpty = () => lines.push(border("│") + " ".repeat(innerWidth) + border("│"));
lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
// ... content lines via add()/addEmpty() ...
lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
```

## Verification
TypeScript compilation passes cleanly (`npx tsc --noEmit --skipLibCheck`).

## Notes
- `innerWidth = width - 2` accounts for the two `│` border characters
- `Math.max(40, ...)` ensures minimum usable width on narrow terminals
- `padVisible` uses `visibleWidth` from pi-tui to correctly handle ANSI escape codes
