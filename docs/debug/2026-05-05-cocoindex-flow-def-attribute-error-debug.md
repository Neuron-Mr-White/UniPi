---
title: "CocoIndex flow_def AttributeError — Debug Report"
type: debug
date: 2026-05-05
severity: high
status: root-caused
---

# CocoIndex `flow_def` AttributeError — Debug Report

## Summary
`AttributeError: module 'cocoindex' has no attribute 'flow_def'` — pipeline `main.py` targets old cocoindex 0.x API but v1.0.3 is installed.

## Expected Behavior
`cocoindex update main.py` runs the indexing pipeline successfully.

## Actual Behavior
Import-time crash at `@cocoindex.flow_def("local_unipi")` — the decorator doesn't exist in cocoindex v1.0+.

## Root Cause

### Failure Chain
1. `cocoindex update` CLI loads user app at `.unipi/cocoindex/main.py`
2. Python imports `cocoindex` (v1.0.3)
3. At line 9: `@cocoindex.flow_def("local_unipi")` — `AttributeError`
4. Pipeline never starts

### Root Cause
Major API version incompatibility. CocoIndex 1.0 completely redesigned the API:
- Removed: `flow_def`, `FlowBuilder`, `sources`, `transforms`, `functions`, `targets` modules
- Added: `App`, `AppConfig`, `fn`, `mount`, `mount_target`, `lifespan`, `Environment`, `ContextKey`, `TargetState`

### Evidence
- Installed: `cocoindex==1.0.3` — `flow_def` not in `__all__`, not in any module
- Template in `bridge.ts` generated code using old API (flow_def, FlowBuilder, etc.)

## Affected Files
- `.unipi/cocoindex/main.py` — used old API
- `packages/cocoindex/bridge.ts` — template generator uses old API
- `packages/cocoindex/README.md` — documentation references old API

## Suggested Fix
Rewrite pipeline and template for cocoindex v1.0+ API.

### Fix Strategy
1. Rewrite `main.py` using App/fn/mount/lifespan pattern
2. Update `bridge.ts` template generator
3. Update README documentation
4. Add `resolveCocoindexBin()` to find CLI when not on PATH

## Verification Plan
1. Module loads without errors
2. `cocoindex ls main.py` lists the app
3. `cocoindex update main.py` processes files successfully
4. Incremental update skips already-processed files (memoization)
