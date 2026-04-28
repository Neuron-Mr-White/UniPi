---
title: "Autocomplete ordering: unipi skills should appear before non-unipi — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Autocomplete ordering: unipi skills should appear before non-unipi — Quick Fix

## Bug
When using autocomplete for /unipi:* commands, non-unipi items (skills from other sources like pi-coding-agent) appeared before workflow and other unipi skills, even though workflow has highest priority in PACKAGE_ORDER.

## Root Cause
In the `getEnhancedUnipiItems` function, the merge order placed non-unipi items first:
```typescript
items: [...nonUnipiItems, ...enhancedUnipiItems]
```
This caused non-unipi skills to appear at the top of the autocomplete list, overriding the intended package ordering.

## Fix
Reversed the merge order so enhanced unipi items (sorted by PACKAGE_ORDER) appear first, followed by non-unipi items:
```typescript
items: [...enhancedUnipiItems, ...nonUnipiItems]
```

### Files Modified
- `packages/autocomplete/src/provider.ts` — Changed merge order in `getEnhancedUnipiItems` function (line ~268)

## Verification
- Typecheck passes (`npm run typecheck`)
- No test files found in autocomplete package

## Notes
- This ensures workflow skills (first in PACKAGE_ORDER) always appear at the top of autocomplete results
- Non-unipi items still appear but after all unipi items
