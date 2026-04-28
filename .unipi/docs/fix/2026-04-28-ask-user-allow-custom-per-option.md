---
title: "ask_user per-option allowCustom — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# ask_user per-option allowCustom — Quick Fix

## Bug
In single-select mode, pressing Enter on any option immediately submits the selection with no way to add a custom comment. Options like "Partially — let me clarify" or "No — different idea" should allow the user to elaborate before submitting.

## Root Cause
The single-select Enter handler unconditionally returned `kind: "selection"` without checking whether the option needed custom text input. There was no per-option mechanism to request text input — only the global `allowFreeform` flag which adds a separate "Custom response" option.

## Fix
Added a per-option `allowCustom` flag. When set on an option:

- **Single-select**: pressing Enter enters text input mode instead of submitting immediately. After the user types their note and presses Enter, the response is returned as `kind: "combined"` with both the selection and the text.
- **Multi-select**: toggling the option on enters text input mode. The text is stored per-option and included in the combined response on submit.
- Options without `allowCustom` behave exactly as before (immediate select/submit).
- The UI shows `(add note)` hint on options with `allowCustom` that don't yet have text.

### Files Modified
- `packages/ask-user/types.ts` — Added `allowCustom?: boolean` to `AskUserOption` and `NormalizedOption`
- `packages/ask-user/tools.ts` — Added `allowCustom` to TypeBox schema, type assertion, and normalization
- `packages/ask-user/ask-ui.ts` — Added per-option custom text tracking (`optionCustomTexts` Map), `editTarget` state to distinguish freeform vs per-option editing, updated Enter/Space handlers and render logic
- `packages/ask-user/skills/ask-user/SKILL.md` — Documented `allowCustom` option property and added usage example

## Verification
- TypeScript compiles cleanly (`npx tsc --noEmit` — no errors)
- Single-select with `allowCustom`: Enter → edit mode → type text → Enter → combined response
- Single-select without `allowCustom`: Enter → immediate selection (unchanged)
- Multi-select with `allowCustom`: Space → edit mode → type text → Enter submits all
- Escape in edit mode cancels text input, keeps option selected

## Notes
- `allowCustom` defaults to `false` — fully backward compatible
- Per-option custom texts are stored in a `Map<string, string>` keyed by option value
- In single-select, submitting text auto-submits the entire form (no extra Enter needed)
