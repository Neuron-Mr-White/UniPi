---
title: "@pi-unipi/milestone module not found — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# @pi-unipi/milestone module not found — Quick Fix

## Bug
Pi failed to load the unipi extension with:
```
Cannot find module '@pi-unipi/milestone'
Require stack: /mnt/d/home/pi-extensions/unipi/packages/unipi/index.ts
```

## Root Cause
The `@pi-unipi/milestone` package existed as a workspace in `packages/milestone/` and was listed in root `package.json` dependencies, but `npm install` was never run after it was added. This meant the workspace symlink in `node_modules/@pi-unipi/milestone` was never created — unlike all 14 other @pi-unipi packages which were properly linked.

## Fix
Ran `npm install` in the workspace root. This created the missing symlink:
```
node_modules/@pi-unipi/milestone -> ../../packages/milestone
```

### Files Modified
- `node_modules/@pi-unipi/milestone` — symlink created (not tracked in git, resolved by npm)

## Verification
- Confirmed symlink exists: `node_modules/@pi-unipi/milestone -> ../../packages/milestone`
- All 15 @pi-unipi packages now present in `node_modules/@pi-unipi/`

## Notes
This is a follow-up to `2026-04-28-milestone-package-not-registered-fix.md` which added milestone to all integration points (import, extensions, skills, dependencies) but did not run `npm install` to create the workspace symlink. Classic "forgot to npm install after adding a new workspace package" issue.
