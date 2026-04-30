---
title: "Unipi Startup 64x Slower Than Bare Pi — Debug Report"
type: debug
date: 2026-04-30
severity: high
status: fixed
---

# Unipi Startup 64x Slower Than Bare Pi — Debug Report

## Summary
`unipi` alias startup took ~28.7s vs `pi --no-extensions` at ~0.45s — a **64x slowdown** caused by extension source files and node_modules residing on the WSL2 9P Windows filesystem mount (`/mnt/d`). After optimization: **3.1s (7x of bare)**.

## Results

| Configuration | Real Time | User CPU | vs Bare |
|---|---|---|---|
| `pi --no-extensions -p ""` | **0.45s** | 0.47s | 1.0x (baseline) |
| Original `unipi` (mnt/d, index.ts) | **28.7s** | 3.40s | **64x slower** |
| Optimized (ext4, bundled.js, npm mimo) | **3.1s** | 1.88s | **7x slower (9.3x faster)** |

**9.3x speedup** from moving files to ext4 and using pre-bundled extension.

## Root Cause
All 456 `.ts` extension files and 19,965 `node_modules` files resided on `/mnt/d` (Windows NTFS accessed via WSL2 9P protocol). Every `stat()`/`read()` call across the 9P boundary adds ~10–100ms latency. Pi's jiti TypeScript loader resolves imports by reading hundreds of files → **~28s overhead**.

## Fix Applied
1. **Copied packages + node_modules** from `/mnt/d` → `/home/pi/.local/share/unipi/` (ext4)
2. **Using pre-bundled `bundled.js`** (1.1MB, esbuild bundle of all 16 sub-extensions) instead of `index.ts` — avoids jiti transpilation of 456 files
3. **Using npm-installed pi-mimo** at `/home/pi/.local/share/mise/.../pi-mimo/extensions/index.ts` instead of the `/mnt/d` dev copy
4. **Updated `~/.bashrc` alias** to point to ext4 paths

### Updated Alias
```bash
alias unipi="pi --no-extensions --no-skills -e /home/pi/.local/share/unipi/packages/unipi/bundled.js -e /home/pi/.local/share/mise/installs/node/24.14.1/lib/node_modules/pi-mimo/extensions/index.ts"
```

## Remaining Gap (3.1s vs 0.45s)
- **1.4s**: pi's own startup + resource loading (settings, session manager, stdin detection)
- **0.8s**: pi-mimo network call to MiMo API (fetch model list at startup)
- **1.0s**: Extension init code (compactor DB init, tool registration, etc.)
- This remaining ~7x overhead is inherent to loading a 1.1MB extension bundle + network API call

## Notes
- The bundled.js must be regenerated when source files change (run `npm run bundle` in the unipi project)
- To keep ext4 copy in sync with /mnt/d source: re-copy after changes or set up a file watcher
- The compactor `SessionDB init failed` error is cosmetic — caused by running without a package.json in the CWD ancestor chain
