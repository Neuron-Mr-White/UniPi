---
title: "Command Suggestion Ordering — Quick Fix"
type: quick-fix
date: 2026-04-29
---

# Command Suggestion Ordering — Quick Fix

## Bug
When typing slash commands in the input, the autocomplete suggestions showed commands in the wrong order:
1. `/gather-context` suggested `skill:gather-context` before `unipi:gather-context`
2. `/compact` suggested system's `/compact` before `/unipi:compact`
3. Skill commands (`skill:*`) appeared even when unipi equivalents existed

## Root Cause
The autocomplete provider in `packages/autocomplete/src/provider.ts` was merging items with system/skill commands BEFORE unipi commands:
```typescript
// Old code - wrong order
return {
  items: [...nonUnipiItems, ...enhancedUnipiItems],
  prefix: effectivePrefix,
};
```

## Fix
Modified the suggestion ordering logic to:
1. **Separate commands into three categories**: unipi, system, and skill commands
2. **Prioritize unipi commands first** in default mode
3. **Hide skill commands** when unipi equivalents exist (unless user explicitly types `/skill:`)
4. **Handle edge cases** when no unipi items match

### Files Modified
- `packages/autocomplete/src/provider.ts` — Reordered suggestion items to put unipi commands first, system commands second, and skill commands last (only shown when explicitly requested)

## Verification
- TypeScript compilation passes with no errors
- Logic correctly handles:
  - Normal queries: unipi commands appear first
  - Explicit `/skill:` queries: skill commands appear first
  - No unipi matches: system commands shown, skill commands hidden

## Notes
- Skill commands are now hidden by default since they duplicate unipi commands
- Users can still access skills via `/skill:*` prefix if needed
