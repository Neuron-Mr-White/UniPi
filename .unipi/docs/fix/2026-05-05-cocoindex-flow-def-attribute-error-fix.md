---
title: "CocoIndex flow_def AttributeError — Fix Report"
type: fix
date: 2026-05-05
debug-report: .unipi/docs/debug/2026-05-05-cocoindex-flow-def-attribute-error-debug.md
status: fixed
---

# CocoIndex `flow_def` AttributeError — Fix Report

## Summary
Rewrote cocoindex pipeline from 0.x (flow_def) API to 1.0+ (App/fn/mount) API.

## Debug Report Reference
- Report: `.unipi/docs/debug/2026-05-05-cocoindex-flow-def-attribute-error-debug.md`
- Root Cause: CocoIndex v1.0 removed `flow_def`/`FlowBuilder`/`sources`/`transforms`/`targets` API entirely

## Changes Made

### Files Modified
- `.unipi/cocoindex/main.py` — Complete rewrite for v1.0+ API
- `packages/cocoindex/bridge.ts` — Updated template generator + added `resolveCocoindexBin()`
- `packages/cocoindex/README.md` — Updated architecture diagram, prerequisites, and API docs

### Key API Migration

| Old (0.x) | New (1.0+) |
|-----------|------------|
| `@cocoindex.flow_def("name")` | `coco.App(coco.AppConfig(name="name"), main_fn)` |
| `cocoindex.FlowBuilder` | `@coco.fn` + `coco.mount()` |
| `cocoindex.sources.LocalFile` | `localfs.walk_dir()` with `PatternFilePathMatcher` |
| `cocoindex.transforms.SplitRecursively` | Custom `@coco.fn` chunking function |
| `cocoindex.targets.LanceDB` | `lancedb.table_target()` + `coco.mount_target()` |
| No environment setup | `@coco.lifespan` async generator |
| No context management | `coco.ContextKey` + `builder.provide()` |

## Fix Strategy
1. Rewrote pipeline using `@coco.lifespan` (async) for environment setup + LanceDB connection
2. Used `@coco.fn` for memoized chunking and file processing
3. Used `coco.mount()` + `coco.mount_target()` for component management
4. Used `localfs.walk_dir` for file enumeration with `PatternFilePathMatcher`
5. Used `lancedb.TableTarget.declare_row(row=...)` for target state declarations
6. Added `resolveCocoindexBin()` fallback for when CLI isn't on PATH

## Verification

### Test Results
- ✓ Module loads without errors (`import main`)
- ✓ `cocoindex ls main.py` lists `local_unipi` app
- ✓ `cocoindex update main.py` — 604 files processed, 0 errors
- ✓ Incremental update — 604 reprocessed (memoized) in ~1s
- ✓ LanceDB data stored at `.unipi/cocoindex/.lancedb/`

### Regression Check
- ✓ Pipeline template generates correct v1.0+ code
- ✓ CLI binary resolution works with mise-installed Python
- ✓ README accurately documents new architecture

## Notes
- The `@coco.fn` decorator wraps functions and can cause Python scoping conflicts (e.g., function name used as loop variable). Fixed by renaming loop variable from `chunk_text` to `text`.
- `declare_row()` uses keyword-only argument (`row=`) — positional args fail.
- Async lifespan (`AsyncIterator[None]`) is required for `lancedb.connect_async()`.
