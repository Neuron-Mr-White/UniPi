> **📄 Full diagnosis**: memory `pi_startup_23s_usage_parser_event_loop_starvation`
> **📄 Outcome + gotchas**: memory `pi_startup_optimization_ralph_progress`

# Goal — ✅ COMPLETE

Cut pi startup from **23,121ms → ~600ms** WITHOUT breaking functionality.
**Achieved: 23,121ms → 745ms (−96.8%, 31× faster).**

Repos: `/home/oi/Projects/Personal/unipi`, `/home/oi/Projects/Personal/pi-omniroute-bridge`.

## RESULT

| Metric | Before | After |
|---|---|---|
| Full stack TOTAL | **23,121ms** | **745ms** |
| `createAgentSessionRuntime` | ~1,900ms | ~500ms |
| `interactiveMode.init` | ~21,100ms | ~240ms |
| Cold start (no usage cache) | ~18,368ms | **758ms** (== warm) |
| Floor (`pi -ne`) | 57–87ms | 57–87ms |

Goal was ~600ms; landed at 745ms, within ~660ms of the no-extension floor.
Cold == warm because the parser is now genuinely async — a cold cache rebuild
no longer blocks startup at all.

## Per-fix ledger

| # | Fix | After | Δ | Commit |
|---|---|---|---|---|
| — | baseline | 23,121ms | — | — |
| 3 | getPiVersion without subprocess | — | −710ms* | `4eff58c` |
| 1 | Usage cache + streaming + yielding | 5,734ms | **−17,387ms** | `e7c8d0b` |
| 4a | Memory TTL cache + deferred orphan sync | 3,938ms | −1,796ms | `be84879` |
| 4b | Async MemPalace bridge | 2,230ms | −1,708ms | `78b0374` |
| 2 | Lazy tabs + idle prefetch + bootMode | 1,681ms | −549ms | `2185551` |
| 6 | omniroute timeout + non-blocking sync | 1,651ms | ~0 (robustness) | `20f56f5` (other repo) |
| 5 | Prebuilt esbuild bundle | **779ms** | −902ms | `a2bb121` |
| | final (instrumentation removed) | **745ms** | | |

\*Fix 3 verified via `syncBlock` (340ms→1ms, 370ms→0ms); `total` was too noisy at 23s scale.

**Fix 1 alone was 78% of the win.**

## Checklist — all done

### Fix 3 — getPiVersion ✅
- [x] Removed hardcoded mise path for node 24.14.1 + `execSync("pi --version")` fallback
- [x] Shared `getPiVersion()` in `@pi-unipi/core`, per-process cached. **Must `realpathSync(process.argv[1])`** — PATH binary is a mise symlink
- [x] Removed a second broken copy in `@pi-unipi/utility` (resolved against `process.cwd()`)
- [x] Double-`overview` run was the registry's 5s cache TTL expiring during the 23s startup; self-resolved once startup got fast, and the version cache makes both calls free
- [x] typecheck + tests + sync + benchmark + commit

### Fix 1 — Incremental usage cache ✅
- [x] `~/.unipi/cache/usage-stats.json`, keyed mtime+size, `CACHE_VERSION`, write-then-rename
- [x] Stores **raw per-file records**, not aggregates — dedup is cross-file and order-dependent
- [x] Record = `[ts, hashTokens, countedTokens, cost, modelIdx, counted]`. `counted` is separate because the original claims the dedup hash **before** the `input>0||output>0||cost>0` filter, so zero-usage messages still suppress later duplicates
- [x] Streaming line reader (largest session file is 213MB)
- [x] `parseUsageStatsAsync()` yields via `setImmediate` every 25 re-parsed files; both dataProviders use it
- [x] **Byte-identical on all 8 metrics** vs old impl on a frozen 2.6GB snapshot; invalidation tested on add/append/delete/corruption
- [x] typecheck + tests + sync + benchmark + commit

### Fix 2 — Lazy tabs + idle prefetch ✅
- [x] Active tab only at boot; others prefetch after 1,500ms; fetch on first tab-switch
- [x] `syncGroups()` no longer fetches (it runs every render — would have defeated laziness)
- [x] Module announcements no longer re-fetch panels when no overlay is on screen
- [x] `bootTimeoutMs` wired to a real auto-close timer (was read and never used), clamped 0.5–30s, any keypress cancels
- [x] **Tri-state `bootMode`** (`on`/`auto-close`/`off`) per user request, with legacy `showOnBoot` migration (true→"on", false→"off")
- [x] Verified tabs show real data on switch; updater's "—" placeholder is pre-existing (own async version check), confirmed identical under old eager code
- [x] typecheck + tests + sync + benchmark + commit

### Fix 4 — Memory Python bridge ✅
- [x] `listAllProjectsCachedAsync()` with 60s TTL for display-only counters; uncached path retained for tools/commands
- [x] Invalidated via existing `onStore` hook (fires on store **and** delete)
- [x] `syncOrphanedFiles()` moved from `session_start` to first `getStorage()`, still once per session
- [x] Added `runBridgeAsync` (`spawn`, not `spawnSync`) — `setTimeout` alone only moves the freeze past first paint, where it stalls typing
- [x] Verified async twins identical (33 project / 2,264 global); loop ticks 108× during a 1,102ms call
- [x] typecheck + tests + sync + benchmark + commit

### Fix 6 — omniroute hardening ✅
- [x] `AbortSignal.timeout(15_000)` on the models fetch (was unbounded)
- [x] `session_start` registers from disk cache first, then fires `maybeDailySync` in background
- [x] `hydrateOmniApiKey` called directly, since the sync no longer runs before return
- [x] Rebuilt `dist/`; verified 393 models register, expired-`lastSyncAt` sync completes without affecting startup, timeout aborts a hanging request
- [x] Committed in that repo (`20f56f5`)

### Fix 5 — Prebuilt bundle ✅
- [x] `scripts/build-bundle.mjs` (esbuild), `pi.extensions` → `packages/unipi/bundled.js`
- [x] Only `@pi-unipi` + relative imports bundled; all third-party external — this is what made the old bundle unsafe
- [x] Build self-scans for credential patterns and refuses to emit on a match
- [x] `build` / `prepare` (`--if-missing`) / `prepublishOnly`; script exits 0 in `--if-missing` so it can't break installs
- [x] `bundled.js` stays gitignored (build artifact); stale "third-party secrets" comment corrected
- [x] Declared `diff` at root devDeps — it lives in `packages/utility/node_modules/`, fine under jiti and when hoisted, unresolvable from a single in-repo bundle
- [x] Verified end-to-end via `npm pack` → sandbox install → run: 421 packages, **25 tools**, 0 errors, 917ms
- [x] Works in **both** layouts (repo 346ms, installed 501ms)

### Final ✅
- [x] Clean benchmark (`final` n=4: 757ms avg; `post-revert` n=2: 745ms)
- [x] Manual checks: overlay renders real data; auto-closes at 2s; memory tools + orphan sync work; `--list-models` shows 401 omniroute models; usage numbers byte-identical
- [x] Both repos clean; pi core `runner.js` restored byte-identical to backup
- [x] Delta report delivered

## Traded off / deferred

- **Lazy panels**: a tab opened within the first 1.5s may briefly show a loading state. Deliberate, per user decision.
- **Deferred orphan sync**: markdown added out-of-band appears on first memory tool use rather than at boot. No data loss.
- **`bootMode` default changed** to `auto-close` (2s). Existing `showOnBoot: true` users migrate to `"on"`, preserving their behaviour.
- **Not published** — per instruction. `prepublishOnly` is the one path only a real publish can fully exercise.

## Latent bugs fixed en route

- Overlay showed **"Pi Version: unknown"** — fallback regex required a `v` prefix pi no longer emits, so it paid 710ms *and* failed.
- `writeSettingsFile` used `require()` in an ESM module → threw whenever the settings dir didn't exist.
- `bootTimeoutMs` existed in config and was never connected to anything.
- Stale pi 0.81.1 install at `~/.local/lib/...` shadowed by mise 0.83.0 → moved to `/tmp/pi-stale-backup/` (user approved).

## Gotchas for future work

1. **`syncBlock` vs `total`** — only time-before-first-`await` identifies a culprit. `total` measures loop congestion and blames bystanders (how omniroute got blamed for 18.7s of someone else's CPU).
2. **Instrument to a file, never stderr** — TUI redraws corrupt interleaved output.
3. **Verify parsers against a frozen snapshot** (`PI_CODING_AGENT_DIR` / `UNIPI_DIR` overrides). Live sessions append while you test → false failures.
4. **`setTimeout` does not fix blocking** — it relocates the freeze. Break the work up or make it truly async.
5. **`pi.extensions` with two entries is not a fallback** — pi loads every entry that exists; both registered and all tools collided. Fallback to `<pkgroot>/index.ts` only fires when *all* listed entries are missing.
6. **`postinstall` breaks consumer installs** — `scripts/` isn't shipped. Use `prepare` + a script that exits 0.

## Harness

- `/tmp/pi-bench.sh <label> <runs>` → `/tmp/bench-results.tsv`
- `/tmp/test-local-install.sh` → pack, inspect tarball, secret-scan, sandbox install, run pi
