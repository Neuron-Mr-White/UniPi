---
title: "Ask-User Question Text Truncation — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Ask-User Question Text Truncation — Quick Fix

## Bug
Long question and context text in the ask-user widget was truncated with "..." instead of wrapping to multiple lines. When questions or context exceeded the box width, the text was cut off, making it unreadable.

## Root Cause
The `render` function in `ask-ui.ts` used `truncateToWidth` for the question and context lines via the `add` helper. This single-line truncation cut off long text instead of wrapping it across multiple lines.

## Fix
Added a new `addWrapped` helper that uses `wrapTextWithAnsi` (from `@mariozechner/pi-tui`) to wrap long text across multiple lines before rendering. The question and context now use `addWrapped` instead of `add`.

### Files Modified
- `packages/ask-user/ask-ui.ts` — Added `wrapTextWithAnsi` import; added `addWrapped` helper; changed question/context rendering to use wrapping instead of truncation.

## Verification
- Typecheck passes (`npx tsc --noEmit --skipLibCheck` — no errors)
- The fix is minimal: only question and context text wrapping changed; options, hints, and other elements remain unchanged.

## Notes
- The `addWrapped` function wraps text to `innerWidth` and still applies `truncateToWidth` per-line as a safety net for edge cases (e.g., ANSI codes causing width miscalculation).
- Option descriptions are still single-line truncated (via `add`) — this is intentional for the options section layout.
