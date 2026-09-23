---
title: "Workflow Core Dependency Mismatch — Quick Fix"
type: quick-fix
date: 2026-05-07
---

# Workflow Core Dependency Mismatch — Quick Fix

## Bug
Running `/unipi:brainstorm` failed during the workflow extension `before_agent_start` hook with:

```text
(0 , _core.getBlockedToolsForLevel) is not a function
```

The traceback pointed at `@pi-unipi/workflow/index.ts` where workflow imports `getBlockedToolsForLevel` from `@pi-unipi/core`.

## Root Cause
`@pi-unipi/workflow@2.0.0` still declared `@pi-unipi/core` as `^0.1.6`. In an installed all-in-one package, npm installed a nested `@pi-unipi/core@0.1.16` under workflow. That old core version did not export `getBlockedToolsForLevel`, so the workflow extension imported `undefined` and crashed.

`@pi-unipi/ralph@2.0.0` also still declared `@pi-unipi/core` as `^0.1.0`, producing the same stale nested-core risk.

## Fix
Updated internal package dependencies to require the current v2 core so npm can dedupe workflow and ralph to `@pi-unipi/core@2.0.0` instead of installing incompatible nested 0.1.x copies.

### Files Modified
- `packages/workflow/package.json` — changed `@pi-unipi/core` dependency from `^0.1.6` to `^2.0.0`.
- `packages/ralph/package.json` — changed `@pi-unipi/core` dependency from `^0.1.0` to `^2.0.0`.
- `package-lock.json` — refreshed dependency metadata.

## Verification
- Ran `npm install --package-lock-only`.
- Ran `npm ls @pi-unipi/core @pi-unipi/workflow @pi-unipi/ralph --all`; all internal packages now dedupe to `@pi-unipi/core@2.0.0` with no invalid dependency ranges.
- Ran `npm run typecheck` successfully.

## Notes
Existing installed copies of `@pi-unipi/unipi` need to be reinstalled/updated or the Pi process restarted after installing the fixed package for the module cache and dependency tree to refresh.
