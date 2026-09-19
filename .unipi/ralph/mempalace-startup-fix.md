# MemPalace startup fix — full stack (L0–L4) → v2.20.5

Repo: `/home/oi/Projects/Personal/archived/unipi`. Do NOT publish or push inside this loop — implementation + tests only; release is a separate chore.

## Context (already diagnosed, do not re-benchmark from scratch)
Startup blocks ~8.2s on a synchronous `spawnSync` MemPalace migrate that runs on the memory `session_start` path and never converges. Full root cause + numbers: memory `startup_9s_mempalace_migrate_daemon_lock_regression`. Approved plan + file map + acceptance: memory `mempalace_startup_fix_plan_L0_L4_full_stack`. Read BOTH before editing.

Key facts:
- `packages/memory/storage.ts` `MemoryStorage.init()` → `tryInitMempalace()` runs `runBridge("ping")` then `runBridge("migrate", …)` synchronously.
- Bridge `packages/memory/bridge/mempalace_bridge.py` `migrate()` does per-record `collection.upsert()`; MemPalace's `mine_palace_lock` is a non-blocking flock, so contended upserts raise `MineAlreadyRunning`, counted as `failed`, so `markMigrated` (requires `failed===0`) never advances → full re-run every boot.
- `getMemorySourceFingerprint()` hashes every `memory.db` + `*.md` by size+mtime, so any memory write invalidates the marker.
- The daemon exposes an HTTP job queue (`/jobs`, `submit_job`) — reference only; never edit site-packages.
- `store()` already upserts to the palace immediately, so new memories are already synced; migrate is only legacy/out-of-band catch-up.

## Progress log
- **Iter 1 (L0 DONE, commit 232f734):** `init()` now non-blocking — cheap install check + optimistic `mempalaceInstall`, then `void backgroundVerifyAndMigrate()` (single-flight) runs ping+migrate via `runBridgeAsync`; added `child.unref()` in `runBridgeAsync`. Deleted `tryInitMempalace`. Verified: `tsc` clean; memory tests 12/12 (`npx tsx --test packages/memory/tests/*.ts`; note: package has no `npm test` script); startup TOTAL **1327ms** (init 800ms) with marker still stale, was ~9.5s. NOTE: `sidekick` tool launcher is erroring (0 tool calls) — implementing/verifying directly until it recovers.

## Goals / checklist
- [x] **L0 — non-blocking init.** `init()` keeps only cheap work (dirs, cached `ensureMempalace()`, set `mempalaceInstall`); move ping+migrate into a single-flight background task (`runBridgeAsync`, fire-and-forget). Gate memory TOOL calls on a `ready` promise so the first keystroke never blocks. `session_start` must not `await` the bridge.
- [x] **L4 — ping hygiene.** (commit 4cda207) Added `runBridgeOutcome`/`runBridgeAsyncOutcome` → `{ok,result,error,transient}` + `isTransientBridgeError` (MineAlreadyRunning / "is held by"). `memPalaceCall`/`memPalaceCallAsync` invalidate the ping flag only on a genuine non-transient failure (also fixed: a legit `null` "not found" no longer wipes it). `runBridge`/`runBridgeAsync` are now thin wrappers. New unit tests; memory tests 14/14; tsc clean. These outcome variants are the foundation L1 uses for deferred-vs-failed.
- [x] **L1 — contention-aware marker.** (commit 3823060) Bridge: `MineAlreadyRunning` → `deferred`+`deferred_keys` (distinct from `failed`); `migrate` accepts `only:[keys]`. TS: `isMigrationComplete`=`failed===0 && verified+deferred===discovered`; `markMigrated` persists deferredKeys + attempts + `retryAfter` (backoff 15m/1h/6h/24h); `deferredRetryDue`/`bumpDeferredRetry` drive a targeted `--only` retry from the bg task; `normalizeMigrationResult` maps snake→camel. Verified on live palace: full migrate → failed:0 deferred:320 verified:3659 discovered:3979 (marker now advances). tsc clean; memory tests 19/19; py syntax+classifier OK.
- [x] **L2 — incremental ledger.** (commit 9f655ce) `.mempalace-ledger.json` maps project/id → sha256 of the exact .md bytes last confirmed in the palace. `scanMemorySources`+`ledgerDelta` target only changed/deferred keys (`--only`); `applyMigrationToLedger` advances only bridge `verified_keys`; `store()` records the ledger only on a confirmed upsert; `bootstrapLedgerFromLegacyMarker` seeds once from the old marker; bridge drops `memory.db` from discovery. Verified live: TS/py key parity exact (3978==3978, 0 diff); E2E boot1 890ms (full pass backgrounded) → ledger 3978/0-deferred → boot2 delta=1, 854ms (no full sweep). tsc clean; memory tests 25/25. State restored after benchmark.
- [x] **L3 — daemon-aware catch-up.** (commit cfb4456) `probeDaemon()` reads the palace's daemon `endpoint.json`+`token` (palace_key = sha256(realpath)[:24], honors `MEMPALACE_DAEMON_STATE_ROOT`) and hits `/health` with a short abortable timeout. Background catch-up stands down for the session when the daemon is reachable AND busy (active_job_id), letting L1/L2 backoff ride out the lock. **DEVIATION FROM LITERAL PLAN (needs review):** did NOT route writes through the daemon `/jobs` queue — the daemon has no idempotent record-upsert kind, and its only generic write (`mcp_tool`→`tool_add_drawer`) uses a CONTENT-addressed drawer id vs the bridge's SOURCE-URI id; routing through it would duplicate drawers and break get/delete/dedupe. Direct bridge stays the sole (correct-id) write path; no daemon ⇒ unchanged. Verified: unit tests (no-daemon / reachable+busy / idle / bad-token via stub HTTP server) + live probe of the real daemon (reachable:true busy:false, palace_key matched `059c0396…`). tsc clean; memory tests 27/27.
- [x] **Tests.** Memory suite covers: deferred-vs-failed classification, marker advance/backoff, ledger delta, snake→camel normalization, daemon probe (no-daemon/busy/idle/bad-token). 27 memory tests; TS/py key parity + py syntax checked live.
- [x] **Verify (FINAL GATE, iter 4).** `tsc --noEmit --skipLibCheck` clean. Full `npm test` across ALL workspaces EXIT=0 (0 failures anywhere; unipi root 57, background-tasks 202, subagents 279, image 193, footer 114, notify 100, compactor 89, fusion 92, web-api 54, utility 55, …). Startup benchmark from worst-case state (no ledger + stale marker), daemon reachable: 3 boots TOTAL **1066 / 858 / 1367 ms** (was ~9.5s); ledger converged to 3979 entries / 0 deferred → subsequent boots do a tiny delta, never a full sweep. Real state (`.mempalace-migrated`, ledger) backed up and restored; working tree clean (only ralph task files untracked).

## STATUS: COMPLETE — ready for review
Branch commits (uncommitted release; do NOT publish here): 232f734 (L0), 4cda207 (L4), 3823060 (L1), 9f655ce (L2), cfb4456 (L3). One flagged deviation: L3 does daemon-aware avoidance, not `/jobs` write-routing (unsafe id-scheme mismatch — see L3 note). Next: reviewer pass, then the separate full-release chore for v2.20.5.

## Guardrails
- Never edit MemPalace site-packages. Never delete/mutate user memory files or the palace.
- The startup benchmark tweaks real state (`.mempalace-migrated`); back it up and restore, as done during diagnosis.
- Keep the change mempalace-only (SQLite fallback is already removed).
- Do not run the full-release chore, do not `npm publish`, do not `git push`.
- Commit incrementally with focused messages; leave the working tree in a reviewable state.

## Done
Loop is complete when all checklist boxes pass, typecheck + memory tests are green, and the startup benchmark shows ~1s even under lock contention with migration converging across boots. Then STOP and report for review (release is handled separately).