---
title: "Milestone Auto-Update Noise — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Milestone Auto-Update Noise — Quick Fix

## Bug
The milestone auto-update hook (`session_shutdown` in `hooks.ts`) was emitting noisy warnings like:

```
[milestone] Could not auto-update "Create `packages/core/model-cache.ts` — read/write model cache to `~/.unipi/config/models-cache.json` — covered in Task 1" in phase "Implementation Checklist" — no exact match found
```

These warnings appeared every time a spec/plan file with an internal `## Implementation Checklist` was modified.

## Root Cause
The `extractNewCompletions` function extracts ALL newly checked `- [x]` items from modified workflow docs (specs, plans, quick-work) and attempts to match them against `MILESTONES.md` by phase name and item text.

However, spec files have internal **Implementation Checklist** sections with checkboxes that are NOT meant to sync with milestones. These items:
- Have different phase names (e.g. "Implementation Checklist" vs "Phase 3: Milestone & Kanban")
- Have extra suffixes like " — covered in Task 1"
- Are internal tracking, not milestone tracking

The code was logging a `console.warn` for every non-matching item, creating noise.

## Fix
Removed the `console.warn` in the `session_shutdown` hook. Now non-matching items are silently skipped, which is the correct behavior — only items that actually exist in MILESTONES.md get updated.

### Files Modified
- `packages/milestone/hooks.ts` — removed warning log when `updateItemStatus` returns false; now silently skips non-matching items

## Verification
- `cd packages/milestone && npx tsc --noEmit` — compiles cleanly
- The fix is minimal and focused — no behavior change for successfully matched items

## Notes
- A future enhancement could strip " — covered in Task N" suffixes before matching, but that's unnecessary complexity. The current behavior (silent skip) is correct because internal spec checklists should not auto-sync to milestones.
- The `updateItemStatus` function already does exact normalized matching; the issue was purely the noisy warning.
