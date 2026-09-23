---
title: "ask_user theme.fg() argument swap crash — Debug Report"
type: debug
date: 2026-04-28
severity: high
status: root-caused
---

# ask_user theme.fg() argument swap crash — Debug Report

## Summary

`ask_user` TUI crashes with `Unknown theme color: >` when rendering options with a selected (highlighted) item.

## Expected Behavior

Options should render with `"> "` prefix for the selected item, styled with the `"accent"` color.

## Actual Behavior

Node.js throws `Error: Unknown theme color: >` and the process crashes.

## Reproduction Steps

1. Use `ask_user` with multiple options
2. Trigger the TUI render (options list appears)
3. Crash occurs on the first render pass when `optionIndex` matches an option

## Environment

- Pi TUI framework: `@mariozechner/pi-tui`
- Theme module: `@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js`
- File: `/mnt/d/home/pi-extensions/unipi/packages/ask-user/ask-ui.ts`

## Root Cause Analysis

### Failure Chain

1. `ask_user` is invoked with options (3 options, single-select)
2. `renderOptions()` is called during TUI render cycle
3. Line 450: `theme.fg("> ", "accent")` — arguments are **swapped**
4. `theme.fg(color, text)` receives `"> "` as `color` and `"accent"` as `text`
5. `this.fgColors.get("> ")` returns `undefined` (no theme color named `> `)
6. Throws `Error: Unknown theme color: >`

### Root Cause

**Argument order is swapped on line 450.**

The `theme.fg()` signature is `fg(color: string, text: string)`:

```js
fg(color, text) {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[39m`;
}
```

But line 450 calls it as:

```ts
const prefix = isSelected ? theme.fg("> ", "accent") : "  ";
//                                 ^^^^     ^^^^^^^
//                                 text?    color?   ← WRONG ORDER
```

Should be:

```ts
const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
//                                 ^^^^^^^  ^^^^
//                                 color    text       ← CORRECT
```

### Evidence

- **File:** `ask-ui.ts:450` — `theme.fg("> ", "accent")` (swapped args)
- **File:** `theme.js:275` — `fg(color, text)` signature definition
- All other 40+ calls in `ask-ui.ts` correctly use `theme.fg(color, text)` pattern

## Affected Files

- `packages/ask-user/ask-ui.ts` — the buggy call at line 450
- `@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js` — throws the error

## Suggested Fix

### Fix Strategy

1. Swap arguments on line 450 of `ask-ui.ts`:
   - `theme.fg("> ", "accent")` → `theme.fg("accent", "> ")`

### Risk Assessment

- **Risk:** None — isolated single-line fix, all other calls already correct
- **Verification:** Run `ask_user` with options, confirm selected item shows `"> "` in accent color

## Verification Plan

1. Invoke `ask_user` with 3+ options
2. Verify TUI renders without crash
3. Verify selected option shows `"> "` prefix in accent color
4. Verify arrow key navigation works

## Notes

- This is the **only** instance of swapped arguments in the file (40+ other calls are correct)
- The bug is latent — it only triggers when an option is visually selected (which is always the case on first render since `optionIndex` starts at 0)
