---
title: "Autocomplete Ranking — System Commands & Exact Match Priority"
type: quick-fix
date: 2026-04-28
---

# Autocomplete Ranking — System Commands & Exact Match Priority

## Bug
Two issues with autocomplete item ranking:
1. System commands (non-unipi like `/compact`, `/status`, `/reload`) appeared *after* all unipi commands instead of first.
2. Exact matches within `unipi:<command>` names weren't prioritized — a fuzzy match ranked the same as an exact match.

## Root Cause
1. In `provider.ts`, the merge order was `[...enhancedUnipiItems, ...nonUnipiItems]`, placing unipi commands before system commands.
2. The sort function only considered boosted package, PACKAGE_ORDER, and alphabetical — no match-quality dimension existed.

## Fix

### Files Modified
- `packages/autocomplete/src/provider.ts` — Two changes:
  1. **Merge order reversed**: Changed to `[...nonUnipiItems, ...enhancedUnipiItems]` so system commands appear first.
  2. **Exact match priority added**: Added `getMatchPriority()` helper that scores matches as: exact (0) > prefix (1) > fuzzy (2). Inserted into sort between boosted-package check and PACKAGE_ORDER check.

## Verification
- `npx tsc --noEmit` passes with no errors.
- Ranking behavior: `/uni` → system commands first, then unipi commands with exact matches (e.g., no exact for "uni") sorted by package, then fuzzy. `/unipi:brain` → `unipi:brainstorm` (exact prefix) ranks before any fuzzy match like `unipi:brain`.

## Notes
- The `getMatchPriority` function uses case-insensitive comparison (matching `fuzzyMatch` behavior).
- For commands without the `unipi:` prefix (case B, e.g. `/uni`), the full command string is compared; for past-colon (case A), the short name is compared.
