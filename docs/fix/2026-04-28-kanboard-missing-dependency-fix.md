---
title: "kanboard missing from root package.json — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# kanboard missing from root package.json — Quick Fix

## Bug
Extension `packages/unipi/index.ts` failed to load with:
```
Cannot find module '@pi-unipi/kanboard'
```

## Root Cause
The `@pi-unipi/kanboard` package existed in `packages/kanboard/` but was never registered in the root `package.json`. Without being listed in `dependencies`, npm workspaces didn't symlink it into `node_modules/@pi-unipi/`, so the import resolved to nothing.

## Fix
Added `@pi-unipi/kanboard` to three places in root `package.json`:

### Files Modified
- `package.json` — Added `"@pi-unipi/kanboard": "*"` to `dependencies`
- `package.json` — Added `node_modules/@pi-unipi/kanboard/index.ts` to `pi.extensions` array
- `package.json` — Added `node_modules/@pi-unipi/kanboard/skills` to `pi.skills` array

Then ran `npm install` to create the workspace symlink.

## Verification
- Symlink exists: `node_modules/@pi-unipi/kanboard -> ../../packages/kanboard`
- Package contents accessible through symlink

## Notes
Other packages (`command-enchantment`, `milestone`, etc.) were already properly registered. `kanboard` was the only one missing — likely added to the workspace after the initial dependency list was set up.
