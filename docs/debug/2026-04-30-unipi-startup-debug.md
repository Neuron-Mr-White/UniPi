---
title: "Unipi 50x Startup Slowdown — Debug Report"
type: debug
date: 2026-04-30
severity: high
status: root-caused
---

# Unipi 50x Startup Slowdown — Debug Report

## Summary
`unipi` takes **26.7s** to start vs **0.49s** for bare `pi --no-extensions` — a **54x slowdown**. Root cause: pi's extension loader disables jiti module cache, forcing recompilation of 456 TypeScript files on every launch, compounded by slow WSL2 `/mnt/d` filesystem I/O.

## Expected Behavior
`unipi` should start in roughly the same time as bare `pi` (under 1s warm start), with only minor overhead for loading extensions.

## Actual Behavior
| Command | Time |
|---------|------|
| `pi --no-extensions --no-skills --help` | **0.49s** |
| `unipi --help` (both extensions) | **26.7s** |
| `unipi` (no mimo) | **25.4s** |
| `mimo` only (no unipi) | **0.9s** |
| Bundled unipi (from /tmp) + mimo | **1.2s** |

## Reproduction Steps
1. Run `time pi --no-extensions --no-skills --help`
2. Run `time pi --no-extensions --no-skills -e packages/unipi/index.ts -e ../mimo-extension/extensions/index.ts --help`
3. Observe the ~25s delta

## Environment
- **OS**: Linux 6.6.87.2-microsoft-standard-WSL2 (x86_64)
- **Node**: 24.14.1 (via mise)
- **Filesystem**: `/mnt/d` is drvfs (Windows NTFS mount) — slow metadata I/O
- **Pi**: @mariozechner/pi-coding-agent (latest)
- **Jiti**: @mariozechner/jiti 2.6.5 (pi's fork)

## Root Cause Analysis

### Failure Chain
1. Pi's extension loader creates a jiti instance to compile/load TypeScript extensions
2. **`moduleCache: false`** is set in jiti options (line 273 of `dist/core/extensions/loader.js`)
3. Every `import` triggers compilation from scratch — no in-memory cache
4. The unipi extension entry point (`packages/unipi/index.ts`) imports 16 subpackages
5. Each subpackage cascades into its own dependency tree — **456 TypeScript files total**
6. Each file requires: stat() for resolution → read() → parse → compile → eval
7. On `/mnt/d` drvfs, each metadata operation incurs WSL2→Windows IPC overhead
8. 456 files × compilation + slow I/O = **~25s startup penalty**

### Root Cause
**`moduleCache: false` in pi's extension loader prevents jiti from caching compiled modules across the import graph.** This is by design (to allow live extension edits without restart), but it's catastrophic for large extension suites on slow filesystems.

Secondary factor: **456 TypeScript files** in the unipi monorepo. The sheer number of modules amplifies the per-file compilation cost.

### Evidence
- **File**: `/home/pi/.local/share/mise/installs/node/24.14.1/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js:273`
  ```js
  const jiti = createJiti(import.meta.url, {
      moduleCache: false,  // <-- THIS
      ...
  });
  ```
- **File**: `packages/unipi/index.ts:17-32` — 16 subpackage imports
- **Count**: 456 `.ts` files across `packages/*`
- **Bundled test**: Single 1.1MB JS file loads in 1.2s vs 25.4s for unbundled

### Why MiMo is not the bottleneck
The miMo extension performs 2 HTTP API calls at startup, but these complete in <1s (the API is responsive). MiMo alone takes 0.9s.

### Why /mnt/d matters
The same bundled unipi file:
- From `/tmp` (tmpfs/ext4): **1.2s** 
- From `/mnt/d` (drvfs): **18.5s**
Even a single 1.1MB JS file is ~15x slower to load from the Windows mount.

## Affected Files
- `/home/pi/.local/share/mise/installs/node/24.14.1/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js` — jiti `moduleCache: false` (pi core, read-only)
- `packages/unipi/index.ts` — Entry point importing 16 subpackages
- `packages/*/*.ts` — 456 TypeScript files compiled on every start
- `~/.bashrc` — Alias pointing to unbundled TS entry on /mnt/d

## Suggested Fix

### Fix Strategy
1. **Pre-bundle unipi into a single JS file** using esbuild
2. **Output the bundle to the native Linux filesystem** (`~/.local/share/unipi/bundled.js`)
3. **Update the `unipi` alias** to load the bundled file instead of the TS entry
4. **Add a build script** to unipi's package.json for reproducible bundling
5. **Add a rebuild-on-change watcher** or git hook to keep the bundle in sync

### Why bundling fixes it
- Reduces 456 file imports → 1 file load
- Eliminates all jiti compilation overhead (bundle is plain JS)
- Placing on native ext4 avoids drvfs I/O penalty
- Expected result: **1.0–1.5s startup** (close to bare pi)

### Alternative considered
Patching pi's `moduleCache: false` to `true` would give a fast second startup but:
- Requires modifying pi's installed files (fragile across updates)
- First startup would still be slow (cold cache)
- Doesn't fix /mnt/d I/O issue
- **Verdict**: Bundling is more robust and works on first start

## Verification Plan
1. Build the bundle: `esbuild packages/unipi/index.ts --bundle ... --outfile=~/.local/share/unipi/bundled.js`
2. Update alias: `alias unipi="pi --no-extensions --no-skills -e ~/.local/share/unipi/bundled.js -e /mnt/d/SkyWalker/others/mimo-extension/extensions/index.ts"`
3. Run `time unipi --help` — expect ~1.0–1.5s
4. Run `unipi` interactively — verify all 16 modules load (check for errors)
5. Run `/unipi:ralph status`, `/unipi:btw`, etc. — verify commands work

## Related Issues
- MiMo extension should respect `--offline` / `PI_OFFLINE=1` flag (future optimization)
- Consider adding a `pi bundle` command for extension authors

## Notes
- The 456-file count includes test files; actual production imports may be ~300-350 files
- Jiti cache at `.jiti/` was empty (0 files), confirming no caching occurs
- WSL2 users with large codebases on `/mnt/*` should keep built artifacts on `/home/*` or `/tmp`
- The `--offline` flag does not prevent MiMo API calls (extension doesn't check for it)
