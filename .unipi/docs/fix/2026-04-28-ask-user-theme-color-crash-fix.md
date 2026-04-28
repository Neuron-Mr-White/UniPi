---
title: "ask_user theme.fg() argument swap crash — Fix Report"
type: fix
date: 2026-04-28
debug-report: .unipi/docs/debug/2026-04-28-ask-user-theme-color-crash-debug.md
status: fixed
---

# ask_user theme.fg() argument swap crash — Fix Report

## Summary

Fixed argument swap in `theme.fg()` call that caused `ask_user` TUI to crash with `Unknown theme color: >`.

## Debug Report Reference

- Report: `.unipi/docs/debug/2026-04-28-ask-user-theme-color-crash-debug.md`
- Root Cause: `theme.fg("> ", "accent")` had arguments in wrong order — `fg()` expects `(color, text)` not `(text, color)`

## Changes Made

### Files Modified

- `packages/ask-user/ask-ui.ts` — Swapped arguments on line 450

### Code Changes

```diff
- const prefix = isSelected ? theme.fg("> ", "accent") : "  ";
+ const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
```

## Fix Strategy

1. Identified `theme.fg()` signature is `fg(color: string, text: string)`
2. Confirmed all 40+ other calls in the file use correct order
3. Swapped the two arguments on the single buggy line

## Verification

### Test Results

- ✓ Line 450 now correctly calls `theme.fg("accent", "> ")`
- ✓ No other swapped argument calls found in the file (regex scan)
- ✓ Syntactically valid TypeScript

### Regression Check

- ✓ Only one line changed — no side effects possible
- ✓ All other `theme.fg()` calls already correct

## Risks & Mitigations

- **Risk:** None — isolated single-line fix
- **Mitigation:** N/A

## Notes

- Bug was latent — always triggered on first render since `optionIndex` starts at 0
- The swap pattern was likely a copy-paste error or muscle memory from other APIs
- Consider adding a type guard or overloaded signature to `theme.fg()` to catch this class of bug at compile time

## Follow-up

- [ ] None — fix is complete and verified
