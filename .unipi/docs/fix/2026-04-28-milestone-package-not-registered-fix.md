---
title: "Milestone Package Not Registered in Unipi — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Milestone Package Not Registered in Unipi — Quick Fix

## Bug
The `@pi-unipi/milestone` package exists in `packages/milestone/` but was not wired into the unipi all-in-one extension — missing from the entry point imports, pi extensions array, skills array, and dependencies.

## Root Cause
The milestone package was created but never added to the unipi integration points. Four registrations were missing.

## Fix
Added milestone to all required integration points:

### Files Modified
- `packages/unipi/index.ts` — Added `import milestone from "@pi-unipi/milestone"` and `milestone(pi)` call
- `package.json` `pi.extensions` — Added `"node_modules/@pi-unipi/milestone/index.ts"`
- `package.json` `pi.skills` — Added `"node_modules/@pi-unipi/milestone/skills"`
- `package.json` `dependencies` — Added `"@pi-unipi/milestone": "*"`

## Verification
- Verified all 4 entries present in both files
- Import/export pattern matches other packages (default export taking `ExtensionAPI`)

## Notes
- Compactor appears in root `pi.extensions` but is not imported in `unipi/index.ts` — separate pre-existing issue
