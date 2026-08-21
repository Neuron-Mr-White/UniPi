# pi-background-tasks Adoption (full)

Repo: /home/oi/Projects/Personal/archived/unipi
Task file: .unipi/ralph/pi-background-tasks-parity.md (this file)
Reference: /tmp/pi-background-tasks (re-clone from https://github.com/ismailsaleekh/pi-background-tasks if missing)

## Locked decisions (user)
- **Merge the WHOLE repo** — shell tasks, delegate, fusion, attested runs, anthropic attribution, infra.
- **In OUR style**: ~/.unipi paths, <ws>/.unipi/config dirs, /unipi:* command namespace, our panel/slot system (FleetView-style), our settings-overlay patterns.
- **Master feature toggle**: one config key (`enabled`, default true) that completely disables the module — no tools, no commands, no hooks, no UI when off.
- All commands AND settings mounted in our panel style (settings overlay in our TUI idiom).
- New conflicts → ASK USER. Purely mechanical → follow our conventions and note here.

## Non-negotiables (conventions)
- Storage: `~/.unipi/background-tasks/` for durable state; per-session runtime artifacts under OUR temp root (`os.tmpdir()/unipi-bg-tasks-<scope>/`). NEVER `.pi/tasks/`.
- Config: global `~/.unipi/config/background-tasks.json` + workspace `<root>/.unipi/config/background-tasks.json` (workspace wins), same layering as subagents.json.
- Env prefix: `UNIPI_BG_*` (replaces their `PI_BG_*`).
- Commands: `/unipi:bg`, `/unipi:bg-clear`, `/unipi:tasks`, `/unipi:bg-update`, `/unipi:jobs`, `/unipi:kill`, `/unipi:logs`, `/unipi:claude-cache`, `/unipi:fusion`, `/unipi:fusion-models` — registered in autocomplete constants.
- Tools: keep reference names (`bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `bg_delegate`, `bg_result`, `bg_run_pi_attested`, `fusion_reason`, `fusion_investigate`, `fusion_research`, `fusion_validate`) — no collision with ours; keeps their docs/skills prompt-compatible.
- UI: footer dock + task manager rendered through OUR widget/slot patterns (subagents FleetView precedent). No adoption of their TUI internals wholesale — adapt rendering to pi-tui components we already use.
- Skip list (mechanical): their `update-check.ts` (our updater module owns updates); their docs-freshness gate scripts (repo-infra only).
- Tests are the spec: port/adapt their test suites per phase.
- After each batch: `npx tsc --noEmit --skipLibCheck` must pass. After each phase: root `npm test` + package tests. Commit per phase.

## Package layout
New workspace package `packages/background-tasks` (`@pi-unipi/background-tasks`), mounted in `packages/unipi/index.ts` AFTER subagents (it may reuse subagents' pi-spawn hardening patterns but must not import it — keep standalone; duplicate small helpers instead).

## Phase 0 — Foundation
- [x] Scaffold package: package.json (pi.extensions entry), tsconfig, deps (typebox via root), src/index.ts skeleton honoring master `enabled` toggle (registers NOTHING when disabled)
- [x] Port parity-types: statuses, DIRS (OUR paths), event constants, config schema (all their keys + `enabled`) — src/types.ts
- [x] Config loader+validator: global+workspace layering, validateParityConfig w/ visible errors — src/config.ts
- [x] Port durable-fs.ts (400 lines, near-verbatim; rename error class) — src/durable-fs.ts
- [ ] Port common.ts helpers actually needed (json parse guards, id gen, name compaction) — src/common.ts; drop unused
- [ ] Tests: config.test.ts, durable-fs.test.ts (adapt theirs)

## Phase 1 — Shell task runtime
- [x] Port windows-taskkill.ts verbatim (env-prefix rename) — src/windows-taskkill.ts
- [x] Port registry.ts core: startTask/startManagedTask/resolveTask/status/logs/kill/retention/output caps (20MiB kill+fail, 50KiB bounded reads), shell policy POSIX+Windows w/ UNIPI_BG_SHELL — src/registry.ts (+ split if >800 lines)
- [x] Telemetry wrapping (isAgent pi -p interception → task-owned metrics) — src/telemetry-wrap.ts
- [x] Tests: core.test.ts, registry.test.ts, windows-taskkill.test.ts, posix-invariance.test.ts (adapt)

## Phase 2 — Delivery + UI + commands/tools (shell surface complete)
- [x] Completion delivery: notifyOnCompletion/triggerOnCompletion mapped onto OUR sendMessage followUp path (result-watcher pattern from subagents, local copy) — src/completion.ts
- [x] EventBus background-task-v1 (internal, our event constants) — src/eventbus.ts
- [x] Footer dock + task-manager overlay on OUR widget patterns (Shift↓ shortcut, ctrl+alt+c clear) — src/dock.ts, src/task-manager.ts
- [x] Tools: bg_run, bg_status, bg_logs, bg_kill, bg_run_pi_attested registration — src/tools.ts
- [x] Attested Pi runs (attested-pi-run.ts port) — src/attested-pi-run.ts
- [x] pi-launch hardening: resolvePiLaunch + Windows 8191-char cmdline guard — src/pi-launch.ts (standalone copy)
- [x] Commands: /unipi:bg, /unipi:bg-clear, /unipi:tasks, /unipi:bg-update, /unipi:jobs, /unipi:kill, /unipi:logs — src/commands.ts
- [x] Settings overlay (our TUI idiom): enabled, defaults, caps, shell policy — src/settings-overlay.ts
- [x] Tests: completion, dock, attested, pi-launch, extension-api tests (adapt)

## Phase 3 — Delegate
- [x] Context projection: visible-conversation-v2 ledger (frozen projection w/ omission receipts) — src/context/
- [x] Token budget (903 lines) — src/context/token-budget.ts
- [x] Seed schema v2 + delegate policy — src/delegate/seed.ts
- [x] Launch isolation (env stripping, stdin prompt, isolated sessions, guard extension) — src/delegate/launch.ts, runner.ts
- [x] Result package (hash-verified commit/adjudicate/retrieve) — src/delegate/result-package.ts, artifacts.ts
- [x] Budget + hook contract — src/delegate/budget.ts, hook-contract.ts
- [x] Child extension (delegate-child-extension.ts) + extensions/delegate-child.ts entry
- [x] Tools bg_delegate/bg_result wired; parent snapshot module
- [x] Tests: delegate-seed, delegate-budget, delegate-artifacts, delegate-launch, delegate-result-package, delegate-child-guard, visible-conversation, token-budget (adapt)

## Phase 4 — Fusion core
- [x] Types (1139) + workflows table (4 fixed workflows) — src/fusion/types.ts, workflows.ts
- [x] Config (449): five-slot models, persistence w/ revision-safe lock — src/fusion/config.ts
- [x] Context: session-projection v5 canonical input + clean-task input + omission ledger — src/fusion/context.ts, clean-context.ts
- [x] Prompts (345) + source-policy (257) + web-fetch (1060, caller-URL-only) — src/fusion/
- [x] Budget (1162) + evaluation (800, blind eval + repair) — src/fusion/
- [x] Orchestrator (1288): plan→barrier→3 candidates→anonymize→eval→repair→merge→commit — src/fusion/orchestrator.ts
- [x] Artifacts (965) + result-package (959) + output-contract + child-protocol — src/fusion/
- [x] pi-child (2373): fusion child runner — src/fusion/pi-child.ts
- [x] claude-cache (207) — src/fusion/claude-cache.ts
- [x] Tests: fusion-core, budget, evaluation, orchestrator, artifacts, context-prompts, web-fetch, golden-bytes/extraction-equivalence/high-cardinality (adapt) — 158/158 fusion tests

## Phase 5 — Fusion integration
- [x] fusion-extension.ts (1294): tools fusion_reason/investigate/research/validate + /unipi:fusion + /unipi:fusion-models
- [x] Model selector TUI on OUR overlay patterns — src/ui/fusion-model-selector.ts
- [x] fusion-child-extension.ts (1012) + extensions/fusion-child.ts entry
- [x] Managed-task registration through Phase 1 registry (durable preflight barrier, usage claim)
- [x] Renderer for fusion results (our renderResult idiom)
- [x] Tests: fusion-sdk, fusion-rpc, fusion-workflows, fusion-config, model-selector (adapt)

## Phase 6 — Anthropic attribution
- [x] Port anthropic-attribution.ts (1983) + path helper + extensions entry; EventBus claim protocol kept internal
- [x] /unipi:claude-cache command
- [x] Tests: anthropic-attribution.test.ts (adapt)

## Phase 7 — Integration + ship
- [ ] Mount in packages/unipi/index.ts (after subagents); bundled build passes
- [ ] Autocomplete constants: all /unipi:* commands
- [ ] Root package.json deps if needed; pack globs (agents/prompts/skills if any)
- [ ] README rewrite (our surface, our paths)
- [ ] Full verification: tsc + root npm test + package tests; bump version; npm publish; reinstall on PC; verify install tree

## Progress log
- Phase 6 COMPLETE: anthropic attribution wired. Source (1983 lines, provider-gated
  Claude Code OAuth subscription transport + exact-match prompt sanitization + cache
  retention) landed in Phase 3 as a dependency; this phase wired the extension entry
  order (extensions/anthropic-attribution.ts FIRST in package.json pi.extensions,
  matching reference), /unipi:claude-cache command (status/short/long/default w/
  session persistence via session_tree/session_start restore), EventBus duplicate-owner
  claim protocol preserved. Tests: anthropic-attribution 4. 388/388 total.
- Phase 5 COMPLETE: fusion integration. fusion-extension.ts ported (1294 ref lines) with
  tools fusion_reason/investigate/research/validate + /unipi:fusion + /unipi:fusion-models;
  model selector TUI (src/ui/fusion-model-selector.ts, 3 tests); managed-task registration
  through the registry (durable preflight barrier + usage claim); fusion result renderer.
  User reorganized RPC tests into src/__tests__/ layout (fusion-rpc 3 tests, all passing);
  scripted-provider suite + helpers ported into src/__tests__/scripted-provider + helpers
  (env UNIPI_BG_SCRIPTED_*, agent_settled->agent_end adaptation in output-recovery
  provider). unipi:bg-tasks command alias added (reference registers both tasks names).
  extensions/background-tasks.ts entry shim created for RPC tests. 384/384 tests.
- Phase 4 COMPLETE: fusion core + child extensions + full test suite. Fusion source
  files (types/workflows/config/context/clean-context/prompts/source-policy/web-fetch/
  budget/evaluation/orchestrator/artifacts/result-package/output-contract/child-protocol/
  pi-child/claude-cache) landed in Phase 3 as deps; this phase ported ALL fusion test
  suites (budget 34, evaluation 10, orchestrator 13, artifacts 12, context-prompts 24,
  web-fetch 21, claude-cache 9, config 9, workflows 4, v5-core 6, golden-bytes 2,
  extraction-equivalence 3, high-cardinality 6, validate-orchestrator 5, sdk 11) +
  fusion-child-extension.ts (1012) + delegate-child-extension.ts (978) + extensions/
  entry shims (fusion-child, delegate-child, anthropic-attribution).
  USER DECISION (2026-08-21): durable fusion + delegate artifacts live under the
  WORKSPACE .unipi/ dir (<cwd>/.unipi/fusion, <cwd>/.unipi/delegate) — not .pi/ and
  not the temp root (test roots set UNIPI_BG_TMP_DIR only for temp-root isolation).
  SDK adaptations: before_provider_headers + agent_settled registered defensively
  (our pi lacks them; agent_end fallback for settlement), tool_result usage defensive
  read. Env prefix UNIPI_BG_DELEGATE_* (launch + child extension). Extension path
  resolution ../../extensions. New dep: turndown@7.2.4. 381/381 tests.
- Phase 3 COMPLETE: full delegate subsystem ported — context projection
  (visible-conversation-v2 ledger w/ hash omission receipts), token-budget estimator,
  parent-snapshot, seed v2 construction+verification, launch preflight (hook-contract gate,
  route pinning, env stripping, stdin seed delivery), artifact store, result-package
  commit/adjudicate/retrieve, runner terminal evaluation + delivery decision. Delegate
  extension ported (delegate-extension.ts): bg_delegate + bg_result tools w/ renderers;
  Fusion result retrieval path included (fusion core files pulled forward as deps:
  types/workflows/config/context/clean-context/prompts/source-policy/web-fetch/budget/
  evaluation/orchestrator/artifacts/result-package/output-contract/child-protocol/
  pi-child/claude-cache). anthropic-attribution.ts copied (Phase 6 wires it).
  New dep: turndown 7.2.4 (+@types) for fusion web-fetch. hook-contract-evidence.json
  shipped. Tests: seed 21 + budget 18 + artifacts 24 + launch 32 + result-package 18 =
  113 new; 209/209 total.
- Phase 2 COMPLETE: full extension wiring in index.ts (master toggle gates everything;
  session_start/shutdown lifecycle; status-interval footer updates via ctx.ui.setStatus;
  shutdown kills running tasks). Tools ported verbatim w/ reference names (bg_run,
  bg_status, bg_logs, bg_kill, bg_run_pi_attested) + renderers. Commands in /unipi:*
  namespace (bg, tasks, bg-clear, jobs, logs, kill) + Shift↓ / ctrl+alt+c shortcuts.
  Task-manager overlay ported (task-manager.ts, 774 ref lines) with lazy dynamic import.
  EventBus extension-api ported (extension-api.ts, 548 lines) — channels renamed to
  unipi-background-tasks:*. Completion delivery flows through registry notifyCompletion ->
  pi.sendMessage(followUp + triggerTurn). attested-pi-run + pi-launch already landed in
  Phase 0/1 as type deps. /unipi:bg-update added (version report via @pi-unipi/core
  getInstalledPackageVersion; update instructions point at our umbrella package + updater).
  Settings overlay ADDED (src/settings-overlay.ts, mcp overlay precedent): master enabled
  toggle, delivery defaults, delegate mode/auto-deliver; mounted via /unipi:bg-settings.
  Autocomplete constants updated: background-tasks package (bg, bg-clear, bg-settings,
  bg-update, tasks, jobs, kill, logs, claude-cache) + missing subagents descriptions;
  autocomplete audit test 38/38. anthropic-attribution claude-cache command renamed to
  unipi:claude-cache (audit requires unipi: prefix). Fusion core files pulled forward as
  deps (artifacts/workflows/output-contract + full set); turndown.d.ts shim added.
  Subprocess-based tests (fusion-budget byte-identity, fusion-context-prompts subprocess,
  golden fixtures) re-pathed for OUR layout. Tests: 367/367, tsc clean.
- Phase 1 COMPLETE: full registry port (2452 ref lines) — startTask/startManagedTask/
  claimFusionUsage/startDelegateTask/startAttestedPiTask, resolveTask prefixes,
  stopTask/stopAllRunning (SIGTERM->SIGKILL escalation, Windows taskkill soft/force),
  20MiB output cap kill+fail, bounded log reads, telemetry ingestion + wrapped-agent
  activity transcripts, terminal publication gate/retry, notification w/ notified reset,
  retention pruning. windows-taskkill verbatim. Runtime dir -> OUR temp root
  ($TMPDIR/unipi-bg-tasks/<session>-<pid>-<nonce>, UNIPI_BG_TMP_DIR override) with a
  per-instance nonce (reference relied on per-cwd .pi/tasks). Env prefix UNIPI_BG_*;
  shell policy error unipi_bg_shell_invalid. Shared interfaces in child-process.ts.
  Tests: registry 30 + core 9 + win-taskkill 5 + durable-fs 25 + config 8 = 77/77.
- Phase 0 COMPLETE: package scaffolded (@pi-unipi/background-tasks), master `enabled` toggle
  gates the entry point, config layering (~/.unipi/config/background-tasks.json global +
  workspace override, workspace wins, corrupt layers warn not crash), types.ts ported from
  their common.ts (statuses, snapshots, delivery guidance, bg command parser, activity
  transcript), durable-fs verbatim, delegate/fusion/token-budget/visible-conversation/
  attested-pi-run/pi-launch type modules copied with flattened import paths. Adaptations:
  FusionUsage widened locally (our pi-ai Usage lacks `reasoning`), DEFAULT_MAX_BYTES defined
  locally (not exported by our core), ChildStdin shimmed as Writable. 33/33 tests
  (config 8 + durable-fs 25).

## Completion marker
Emit "pi-background-tasks adoption complete: all phases done, published."
