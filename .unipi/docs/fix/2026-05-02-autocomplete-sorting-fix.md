---
title: "Autocomplete sorting — exact matches buried by fuzzy unipi items"
type: quick-fix
date: 2026-05-02
---

# Autocomplete Sorting — Exact Matches Buried by Fuzzy Unipi Items

## Bug
When typing `/new`, the autocomplete suggestions showed `unipi:review-work` (fuzzy match via n→e→w subsequence in "review-work") before the exact `new` command. Similarly, fuzzy-matched unipi commands always appeared before system commands regardless of match quality.

## Root Cause
The final assembly in `createEnchantedProvider` used a flat concatenation:
```ts
finalItems = [...enhancedUnipiItems, ...systemItems];
```
This placed ALL unipi items first, then ALL system items. Match quality was only considered within each group separately, not across groups.

## Fix
Replaced the flat concatenation with a cross-group merge that sorts all items (both unipi and system) by match quality first, then by source (non-unipi before unipi within the same quality tier).

### Sorting algorithm
1. **Match quality** (priority 0–2):
   - `0` = exact match — command name equals the query exactly
   - `1` = prefix match — command name starts with the query
   - `2` = fuzzy match — character subsequence match only
2. **Source** (within same quality tier):
   - Non-unipi commands first
   - Unipi commands second
3. **Original order** preserved for ties (stable sort)

### Files Modified
- `packages/autocomplete/src/provider.ts` — replaced flat `[...unipi, ...system]` concat with cross-group quality-based sort

## Verification
Simulated the sorting logic:
- `/new` → 1. `new` (exact), 2. `unipi:review-work` (fuzzy) ✓
- `/brainstorm` → 1. `unipi:brainstorm` (exact) ✓

## Notes
The internal sorting within `getEnhancedUnipiItems` (by package order, then alphabetical) is preserved via stable sort — unipi items at the same quality tier keep their internal order.
