---
title: "Unipi Extension Startup Performance — Debug Report"
type: debug
date: 2026-04-30
severity: high
status: root-caused
---

# Unipi Extension Startup Performance — Debug Report

## Summary
`unipi` (pi with 15 sub-extensions + mimo) starts in **33.8s**, while bare `pi --no-extensions` starts in **0.45s** — a **75x slowdown**. The root cause is three compounding bottlenecks: WSL2 cross-filesystem I/O, jiti transpilation of 456 `.ts` files, and cumulative module initialization cost.

## Expected Behavior
Unipi should start in under 1-2 seconds, close to bare pi's startup speed.

## Actual Behavior
| Configuration | Cold/Warm | Time |
|---|---|---|
| `pi --no-extensions --no-skills --print ""` | Warm | **454ms** |
| `pi --no-extensions --no-skills --print "test"` | Warm | **2,900ms** (includes LLM call) |
| unipi (on `/mnt/d/`) | Warm | **33,841ms** |
| unipi (on `/tmp/`, Linux FS) | Warm | **8,921ms** |
| unipi bundled (1.2MB .js, on `/tmp/`) | Warm | **3,155ms** |
| unipi bundled + minified (627KB .js, on `/tmp/`) | Warm | **3,413ms** |
| pi + workflow only (2 .ts files, on `/tmp/`) | Warm | **510ms** |
| pi + memory only (8 .ts files, on `/tmp/`) | Warm | **520ms** |
| pi + compactor only (75 .ts files, on `/tmp/`) | Warm | **960ms** |

### Per-bottleneck contribution:
- **WSL2 `/mnt/d/` cross-filesystem I/O**: +24,920ms (74% of overhead)
- **jiti transpilation of 342 runtime `.ts` files**: +5,766ms (17% of overhead)
- **Cumulative module init + native module loading**: +2,700ms (8% of overhead)

## Reproduction Steps
1. Run `time pi --no-extensions --no-skills -e /mnt/d/home/pi-extensions/unipi/packages/unipi/index.ts -e /mnt/d/SkyWalker/others/mimo-extension/extensions/index.ts --print ""`
2. Observe 30+ second startup
3. Compare with `time pi --no-extensions --no-skills --print ""` (~0.5s)

## Environment
- OS: WSL2 (Linux 6.6.87.2-microsoft-standard-WSL2) on Windows
- Node: 24.14.1 (via mise)
- pi: latest, loaded via jiti TypeScript transpiler
- Extension source: `/mnt/d/` (Windows NTFS mounted via 9p/DrvFs)
- Cache: `/tmp/jiti/` (Linux tmpfs, 3,317 cached files)

## Root Cause Analysis

### Failure Chain
1. `pi` process starts, parses CLI flags, discovers extensions
2. jiti loads each extension file → for `.ts` files, transpiles via jiti's built-in transform
3. **Bottleneck 1**: Reading 456 `.ts` files from `/mnt/d/` (Windows NTFS via 9p) — each `readFileSync` call crosses the WSL2/Windows filesystem boundary
4. jiti computes source hash, checks `/tmp/jiti/` cache (hit or miss)
5. **Bottleneck 2**: On cache miss, jiti transpiles TS → JS (~1-5ms per file). On cache hit, reads cached JS from `/tmp/jiti/`. But it still reads the original source file from `/mnt/d/` every time
6. V8 compiles each module (`new Module` + `vm.runInThisContext`) — 342 modules
7. Module evaluation executes top-level code, resolves imports, loads native `.node` modules (`better-sqlite3`, `sqlite-vec`, etc.)
8. **Bottleneck 3**: All 15 sub-extensions are eagerly imported in `unipi/index.ts`. Each registers commands, tools, event handlers. Native modules load synchronously on import

### Root Cause
**Primary (74%):** The unipi extension source resides on `/mnt/d/` (Windows NTFS mounted via WSL2 9p/DrvFs). Every file read crosses the VM boundary, incurring ~50-100ms per file for large dependency chains. With 456 `.ts` files, this adds up to 25+ seconds of pure filesystem overhead.

**Secondary (17%):** jiti transpiles TypeScript on-the-fly. While jiti has a filesystem cache at `/tmp/jiti/`, it **still reads every source file** from disk to compute the cache key hash. The actual transpilation is usually cached (3,317 files in cache), but the initial read+hash is unavoidable.

**Tertiary (8%):** 15 sub-extensions are **eagerly imported** in `packages/unipi/index.ts`. Module evaluation runs top-level code including native module loading (`better-sqlite3`, `sqlite-vec`). This adds ~2.7s even after bundling and running on Linux FS.

### Evidence
- File: `/mnt/d/home/pi-extensions/unipi/packages/unipi/index.ts:27-41` — Eagerly imports all 15 sub-extensions
- File: `/mnt/d/home/pi-extensions/unipi/packages/unipi/` — 456 `.ts` files across packages
- `find /mnt/d/home/pi-extensions/unipi/packages -name "*.ts" | wc -l` → 456 files
- jiti cache at `/tmp/jiti/` contains 3,317 cached transpiled files but doesn't eliminate source reads
- Moving to Linux FS (`/tmp/`) reduces startup from 33.8s → 8.9s (3.8x faster)
- Pre-bundling with esbuild further reduces from 8.9s → 3.2s (2.8x faster)
- Combined: 33.8s → 3.2s (10.6x faster, but still 7x slower than bare pi)

## Affected Files
- `/mnt/d/home/pi-extensions/unipi/packages/unipi/index.ts` — Entry point that eagerly imports all 15 sub-extensions
- `/mnt/d/home/pi-extensions/unipi/packages/core/` — 5 runtime `.ts` files imported by every sub-extension
- `/mnt/d/home/pi-extensions/unipi/packages/compactor/` — 75 `.ts` files (largest single contributor)
- `/mnt/d/home/pi-extensions/unipi/packages/subagents/` — 118 `.ts` files (largest file count)
- `/mnt/d/home/pi-extensions/unipi/packages/memory/` — Uses `better-sqlite3` + `sqlite-vec` native modules
- `/mnt/d/SkyWalker/others/mimo-extension/extensions/index.ts` — Makes 2 HTTP fetch calls at startup
- `/home/pi/.bashrc` — Contains `alias unipi="pi --no-extensions --no-skills -e ..."`

## Suggested Fix

### Fix Strategy (multi-phase)

#### Phase 1: Immediate (copy to Linux FS) — saves ~25s, gets to ~8.9s
Copy the unipi source tree to `~/.pi/agent/extensions/unipi/` and update the alias:
```bash
cp -r /mnt/d/home/pi-extensions/unipi ~/.pi/agent/extensions/unipi
# Update alias in ~/.bashrc:
alias unipi="pi --no-extensions --no-skills -e ~/.pi/agent/extensions/unipi/packages/unipi/index.ts -e /mnt/d/SkyWalker/others/mimo-extension/extensions/index.ts"
```

#### Phase 2: Pre-bundle with esbuild — saves additional ~5.7s, gets to ~3.2s
Add a build script that bundles all extensions into a single .js file:
```bash
npx esbuild packages/unipi/index.ts \
  --bundle --platform=node --format=esm \
  --external:@mariozechner/pi-coding-agent \
  --external:typebox \
  --external:@mariozechner/pi-ai \
  --external:@mariozechner/pi-tui \
  --external:better-sqlite3 \
  --external:sqlite-vec \
  --outfile=dist/unipi-bundle.js
```
Then point the alias at the bundle:
```bash
alias unipi="pi --no-extensions --no-skills -e ~/.pi/agent/extensions/unipi/dist/unipi-bundle.js -e /mnt/d/SkyWalker/others/mimo-extension/extensions/index.ts"
```

#### Phase 3: Lazy-load non-critical extensions — saves ~1-2s, targets ~1s
Refactor `packages/unipi/index.ts` to use dynamic `import()` for extensions that aren't needed immediately (btw, webApi, kanboard, milestone, commandEnchantment, mcp, notify). Only eagerly load: workflow, ralph, memory, infoScreen, compactor, askUser, utility, subagents.

#### Phase 4: Bundle mimo extension too (minor)
Bundle the mimo extension or copy it to Linux FS. The HTTP calls at startup are async and don't block other extensions, so this is low priority.

### Risk Assessment
- **Copy drift**: If source on `/mnt/d/` is updated, the copy in `~/.pi/` becomes stale → Mitigation: add a sync script or symlink (WSL2 supports symlinks from Linux to Windows)
- **Bundle build step**: Must run build after any code change → Mitigation: add `mise run build` script, document in README
- **Lazy loading race conditions**: Extensions loaded dynamically may miss `session_start` event → Mitigation: fire synthetic events for late-loaded extensions
- **Native module compatibility**: `better-sqlite3` must be rebuildable if Node version changes → Mitigation: add `npm rebuild` to build script

## Verification Plan
1. Run `time pi --no-extensions --no-skills -e <optimized-path> --print ""` — expect < 2s
2. Run `time pi --no-extensions --no-skills -e <optimized-path> --print ""` — 5 times, all should be < 2s
3. Verify all slash commands work: `/unipi:brainstorm`, `/unipi:debug`, etc.
4. Verify memory tools work: `memory_search`, `memory_store`
5. Verify compactor commands work: `/unipi:compact`
6. Verify mimo models appear in model selector (Ctrl+P)

## Related Issues
- N/A (initial discovery)

## Notes
- jiti cache at `/tmp/jiti/` is effective for transpilation caching but doesn't eliminate source file reads
- The WSL2 9p filesystem has high latency for small file reads (~5-10ms per file vs ~0.1ms on ext4)
- Node.js 24.14.1 loads native `.node` modules synchronously; `better-sqlite3` + `sqlite-vec` add ~200-500ms each
- The `.d.ts` files in `node_modules/@types/node/` (109 files in core package) are NOT loaded at runtime — they only affect `find` counts, not actual startup time
- Minification of the bundle (627KB vs 1.3MB) did not improve startup time — V8 parsing overhead is negligible compared to module execution cost
