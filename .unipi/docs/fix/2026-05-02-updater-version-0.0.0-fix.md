---
title: "Updater Shows 0.0.0 Instead of Installed Version — Fix Report"
type: fix
date: 2026-05-02
status: fixed
---

# Updater Shows 0.0.0 Instead of Installed Version — Fix Report

## Summary
Update overlay always showed `0.0.0 → <latest>` because the version detection used a hardcoded relative path (`../../..`) that only worked in the monorepo, not in npm-installed layout.

## Root Cause
`getInstalledVersion()` and related functions used `new URL("../../..", import.meta.url)` to walk up to the `@pi-unipi/unipi` package root. In the monorepo this resolves correctly (3 levels up from `packages/updater/src/`), but in the npm-installed layout the file is at `node_modules/@pi-unipi/unipi/node_modules/@pi-unipi/updater/src/`, so 3 levels up lands on a namespace directory with no `package.json`, falling back to `"0.0.0"`.

## Changes Made

### Files Modified
- `packages/core/utils.ts` — Added `findPackageRoot()` and `getInstalledPackageVersion()` helpers that walk up directories to find a package by name
- `packages/updater/src/checker.ts` — Replaced hardcoded `../../..` with `getInstalledPackageVersion(dir, "@pi-unipi/unipi")`
- `packages/updater/src/installer.ts` — Same fix for both before/after version reads
- `packages/updater/src/tui/changelog-overlay.ts` — Same fix for installed version display
- `packages/updater/src/readme.ts` — Fixed `resolveUnipiRoot()` to use `findPackageRoot()` by name instead of hardcoded relative path

### Fix Strategy
1. Added `findPackageRoot(startDir, packageName)` to `@pi-unipi/core` — walks up directories (max 10 steps) looking for a `package.json` with the matching `name` field
2. Added `getInstalledPackageVersion(startDir, packageName)` convenience wrapper
3. Replaced all `../../..` patterns in updater with the new helper, starting from `".."` (one level up) instead of `"../../.."`
4. This works in both monorepo and npm-installed contexts because it identifies the package by name, not by relative depth

## Verification

### Test Results
- ✓ TypeScript typecheck passes (`npx tsc --noEmit --skipLibCheck`)
- ✓ No remaining `../../..` patterns in updater source
- ✓ All 4 affected files updated consistently

### Regression Check
- ✓ `getPackageVersion()` (used by other packages) unchanged
- ✓ `readme.ts` local `getPackageVersion` function still works for per-package version reads
- ✓ `@pi-unipi/core` exports new functions automatically via `export * from "./utils.js"`

## Risks & Mitigations
- **Walk-up could find wrong package**: Mitigated by matching on `name` field explicitly — only `@pi-unipi/unipi` matches
- **Infinite loop**: Mitigated by `maxSteps = 10` bound and filesystem root detection
- **Fallback to 0.0.0**: If package not found, still returns "0.0.0" — same behavior as before, but now only on genuine failure

## Notes
- `readme.ts` also had the same `../../..` bug — discovered during fix and corrected
- The `changelog.ts` module receives `installedVersion` as a parameter from callers, so it didn't need changes itself

## Follow-up
- [ ] Publish new version to npm so users get the fix
- [ ] Clear user update cache if needed (`.pi/agent/unipi-update-cache.json`)
